import { mkdir, readdir, rm, symlink, cp, lstat } from 'fs/promises';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { nanoid } from 'nanoid';
import type {
  AgentInfo,
  ItemConfig,
  ItemRepositoryConfig,
  ItemSummary,
  ItemDetail,
  ItemEvent,
  ItemWorkflowJob,
  ItemWorkflowStage,
  ItemWorkflowSummary,
  RepoSummary,
  CreateItemRequest,
  Plan,
  PlanTask,
  RepoPhase,
  RepositoryConfig,
  PrCreatedEvent,
  ReviewReceiveCompletedEvent,
  RepoNoChangesEvent,
  TaskExecutionStatus,
  TaskProgressPhase,
  WorkflowJobStage,
  WorkflowStageId,
  WorkflowStageStatus,
} from '@agent-orch/shared';
import { getRepository, createRepository } from './repository-service';
import { sanitizeRepoAllowedTools } from '../lib/role-loader';
import { readYaml, writeYaml, readYamlSafe } from '../lib/yaml';
import { appendJsonl, readJsonl } from '../lib/jsonl';
import {
  getItemsDir,
  getItemDir,
  getItemConfigPath,
  getItemPlanPath,
  getItemEventsPath,
  getWorkspaceRoot,
  getRepoWorkspaceDir,
} from '../lib/paths';
import {
  createItemCreatedEvent,
  createCloneStartedEvent,
  createCloneCompletedEvent,
  createWorkspaceSetupStartedEvent,
  createWorkspaceSetupCompletedEvent,
  createErrorEvent,
} from '../lib/events';
import { deriveItemStatus, deriveRepoStatuses, getPendingApprovals, type RepoDerivedState } from './state-service';
import { getAgentsByItem, stopAgent } from './agent-service';
import { stopAllGitSnapshots } from './git-snapshot-service';
import { startPlanner, getPlan } from './planner-service';
import { readRepoTaskState, type RepoTaskStateFile, type RepoTaskStateTask } from './task-state-service';

export async function createItem(request: CreateItemRequest): Promise<ItemConfig> {
  const id = `ITEM-${nanoid(8)}`;
  const now = new Date().toISOString();

  if (!request.repositories || request.repositories.length === 0) {
    throw new Error('At least one repository must be provided');
  }

  // Resolve repository configurations
  const repositories: ItemRepositoryConfig[] = [];

  for (const repoInput of request.repositories) {
    let repoConfig: ItemRepositoryConfig;

    if (repoInput.repositoryId) {
      // Use saved repository
      const savedRepo = await getRepository(repoInput.repositoryId);
      if (!savedRepo) {
        throw new Error(`Repository not found: ${repoInput.repositoryId}`);
      }
      repoConfig = {
        name: repoInput.name,
        type: savedRepo.type,
        url: savedRepo.url,
        localPath: savedRepo.localPath,
        branch: repoInput.branch || savedRepo.branch,
        workBranch: repoInput.workBranch || `work/${id}/${repoInput.name}`,
        submodules: savedRepo.submodules,
        linkMode: savedRepo.linkMode,
        allowedTools: repoInput.allowedTools || savedRepo.allowedTools,
        hooks: savedRepo.hooks,
      };
    } else if (repoInput.repository) {
      // Use directly provided repository config
      repoConfig = {
        name: repoInput.name,
        type: repoInput.repository.type,
        url: repoInput.repository.url,
        localPath: repoInput.repository.localPath,
        branch: repoInput.repository.branch,
        workBranch: repoInput.repository.workBranch || `work/${id}/${repoInput.name}`,
        submodules: repoInput.repository.submodules,
        linkMode: repoInput.repository.linkMode,
        allowedTools: repoInput.allowedTools || repoInput.repository.allowedTools,
        hooks: repoInput.repository.hooks,
      };

      // Optionally save the repository for reuse
      if (repoInput.saveRepository && repoInput.repositoryName) {
        await createRepository({
          name: repoInput.repositoryName,
          type: repoInput.repository.type,
          url: repoInput.repository.url,
          localPath: repoInput.repository.localPath,
          branch: repoInput.repository.branch,
          submodules: repoInput.repository.submodules,
          linkMode: repoInput.repository.linkMode,
          directoryName: repoInput.name,
          allowedTools: repoConfig.allowedTools,
          hooks: repoConfig.hooks,
        });
      }
    } else {
      throw new Error(`Repository input for "${repoInput.name}" must have either repositoryId or repository`);
    }

    if (repoConfig.allowedTools && repoConfig.allowedTools.length > 0) {
      repoConfig.allowedTools = sanitizeRepoAllowedTools(repoConfig.name, repoConfig.allowedTools);
    }

    repositories.push(repoConfig);
  }

  const config: ItemConfig = {
    id,
    name: request.name,
    description: request.description,
    repositories,
    designDoc: request.designDoc,
    createdAt: now,
    updatedAt: now,
  };

  // Create directory structure
  const itemDir = getItemDir(id);
  await mkdir(itemDir, { recursive: true });
  await mkdir(getWorkspaceRoot(id), { recursive: true });

  // Write item config
  await writeYaml(getItemConfigPath(id), config);

  // Log item created event
  const event = createItemCreatedEvent(id);
  await appendJsonl(getItemEventsPath(id), event);

  return config;
}

export async function setupWorkspace(itemId: string): Promise<void> {
  const config = await getItemConfig(itemId);
  if (!config) {
    throw new Error(`Item ${itemId} not found`);
  }

  const eventsPath = getItemEventsPath(itemId);

  // Setup all repositories in parallel
  await Promise.all(
    config.repositories.map(repo => setupSingleRepo(itemId, repo, eventsPath))
  );

  // Auto-start planner after all repos are set up
  try {
    await startPlanner(itemId);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[${itemId}] Failed to auto-start planner: ${message}`);
    await appendJsonl(eventsPath, createErrorEvent(itemId, 'planner_autostart_failed', { stack: message, phase: 'planner' }));
  }
}

async function setupSingleRepo(
  itemId: string,
  repo: ItemRepositoryConfig,
  eventsPath: string
): Promise<void> {
  const repoDir = getRepoWorkspaceDir(itemId, repo.name);

  // Remove existing repo dir if it exists (for retry)
  if (existsSync(repoDir)) {
    try {
      const stats = await lstat(repoDir);
      if (stats.isSymbolicLink()) {
        await rm(repoDir);
      } else {
        await rm(repoDir, { recursive: true, force: true });
      }
    } catch {
      await rm(repoDir, { recursive: true, force: true });
    }
  }

  if (repo.type === 'local') {
    await setupLocalRepo(itemId, repo, repoDir, eventsPath);
  } else {
    await cloneRemoteRepo(itemId, repo, repoDir, eventsPath);
  }
}

async function setupLocalRepo(
  itemId: string,
  repo: ItemRepositoryConfig,
  repoDir: string,
  eventsPath: string
): Promise<void> {
  const localPath = repo.localPath;
  if (!localPath) {
    throw new Error(`localPath is required for local repository "${repo.name}"`);
  }

  if (!existsSync(localPath)) {
    throw new Error(`Local path does not exist: ${localPath}`);
  }

  const linkMode = repo.linkMode || 'symlink';

  // Log workspace setup started
  await appendJsonl(eventsPath, createWorkspaceSetupStartedEvent(itemId, repo.name, localPath, linkMode));

  try {
    if (linkMode === 'symlink') {
      await symlink(localPath, repoDir, 'dir');
    } else {
      await cp(localPath, repoDir, { recursive: true });
    }

    // Log workspace setup completed
    await appendJsonl(eventsPath, createWorkspaceSetupCompletedEvent(itemId, repo.name, true));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await appendJsonl(eventsPath, createWorkspaceSetupCompletedEvent(itemId, repo.name, false, message));
    throw error;
  }
}

async function cloneRemoteRepo(
  itemId: string,
  repo: ItemRepositoryConfig,
  repoDir: string,
  eventsPath: string
): Promise<void> {
  const url = repo.url;
  if (!url) {
    throw new Error(`url is required for remote repository "${repo.name}"`);
  }

  const workspaceRoot = getWorkspaceRoot(itemId);

  // Log clone started
  await appendJsonl(eventsPath, createCloneStartedEvent(itemId, repo.name, url));

  try {
    // Build git clone command - clone into repo.name subdirectory
    const args = ['clone'];
    if (repo.branch) {
      args.push('-b', repo.branch);
    }
    if (repo.submodules) {
      args.push('--recurse-submodules');
    }
    args.push(url, repo.name);

    // Execute git clone
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('git', args, {
        cwd: workspaceRoot,
        stdio: 'pipe',
      });

      let stderr = '';
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Git clone failed: ${stderr}`));
        }
      });

      proc.on('error', reject);
    });

    // Create work branch if specified
    if (repo.workBranch) {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('git', ['checkout', '-b', repo.workBranch!], {
          cwd: repoDir,
          stdio: 'pipe',
        });

        let stderr = '';
        proc.stderr?.on('data', (data) => {
          stderr += data.toString();
        });

        proc.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Failed to create work branch: ${stderr}`));
          }
        });

        proc.on('error', reject);
      });
    }

    // Log clone completed
    await appendJsonl(eventsPath, createCloneCompletedEvent(itemId, repo.name, true));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await appendJsonl(eventsPath, createCloneCompletedEvent(itemId, repo.name, false, message));
    throw error;
  }
}

/** @deprecated Use setupWorkspace instead */
export const cloneRepo = setupWorkspace;

export async function listItems(): Promise<ItemSummary[]> {
  const itemsDir = getItemsDir();

  if (!existsSync(itemsDir)) {
    return [];
  }

  const entries = await readdir(itemsDir, { withFileTypes: true });
  const items: ItemSummary[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('ITEM-')) {
      const config = await getItemConfig(entry.name);
      if (config) {
        const status = await deriveItemStatus(entry.name);
        const agents = await getAgentsByItem(entry.name);
        const pendingApprovals = await getPendingApprovals(entry.name);

        items.push({
          id: config.id,
          name: config.name,
          status,
          agentCount: agents.length,
          pendingApprovals: pendingApprovals.length,
          updatedAt: config.updatedAt,
        });
      }
    }
  }

  // Sort by most recently updated
  items.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return items;
}

export async function getItemConfig(itemId: string): Promise<ItemConfig | null> {
  const config = await readYamlSafe<ItemConfig>(getItemConfigPath(itemId));
  if (config && !config.repositories) {
    throw new Error(`Legacy item.yaml detected for ${itemId}: missing 'repositories' field. Please recreate this item.`);
  }
  return config;
}

const WORKFLOW_STAGE_LABELS: Record<WorkflowStageId, string> = {
  workspace: 'Workspace',
  planning: 'Planning',
  execution: 'Execution',
  publish: 'Publish',
  review_receive: 'Review Receive',
};

function isTaskRunning(status: TaskExecutionStatus): boolean {
  return status === 'in_progress' || status === 'in_review';
}

function mapTaskPhaseToRepoPhase(phase?: TaskProgressPhase): RepoPhase | undefined {
  if (!phase) return undefined;
  return phase;
}

function mapJobStageToRepoPhase(stage?: WorkflowJobStage): RepoPhase | undefined {
  if (stage === 'publish') return 'pr';
  if (stage === 'review_receive') return 'review_receive';
  return undefined;
}

export function buildWorkflowSummary(params: {
  config: ItemConfig;
  itemStatus: import('@agent-orch/shared').ItemStatus;
  plan: Plan | null;
  events: ItemEvent[];
  agents: AgentInfo[];
  repoStatuses: Map<string, RepoDerivedState>;
  prEvents: PrCreatedEvent[];
  noChangesEvents: RepoNoChangesEvent[];
  taskStates: Map<string, RepoTaskStateFile>;
}): ItemWorkflowSummary {
  const {
    config,
    itemStatus,
    plan,
    events,
    agents,
    repoStatuses,
    prEvents,
    noChangesEvents,
    taskStates,
  } = params;

  const prEventByRepo = new Map<string, PrCreatedEvent>();
  for (const event of prEvents) {
    prEventByRepo.set(event.repoName, event);
  }

  const noChangesByRepo = new Set(noChangesEvents.map((event) => event.repoName));
  const reviewReceiveCompletedByRepo = new Map<string, ReviewReceiveCompletedEvent>();
  for (const event of events) {
    if (event.type === 'review_receive_completed') {
      reviewReceiveCompletedByRepo.set(event.repoName, event);
    }
  }

  const workspaceRunningRepos = config.repositories.filter((repo) => {
    const derived = repoStatuses.get(repo.name);
    return derived?.status === 'running' && (
      derived.activePhase === 'clone' || derived.activePhase === 'workspace_setup'
    );
  });

  const workspaceHasError = config.repositories.some((repo) => {
    const derived = repoStatuses.get(repo.name);
    return derived?.status === 'error' && (
      derived.activePhase === 'clone' || derived.activePhase === 'workspace_setup'
    );
  });

  const workspaceCompleted = config.repositories.every((repo) => {
    if (repo.type === 'local') {
      return events.some((event) =>
        event.type === 'workspace_setup_completed' &&
        event.repoName === repo.name &&
        event.success
      );
    }
    return events.some((event) =>
      event.type === 'clone_completed' &&
      event.repoName === repo.name &&
      event.success
    );
  });

  const workspaceStageStatus: WorkflowStageStatus =
    workspaceHasError ? 'error'
      : workspaceRunningRepos.length > 0 ? 'running'
      : workspaceCompleted ? 'completed'
      : 'pending';

  const hasPlannerError = !plan && events.some((event) =>
    event.type === 'error' && event.phase === 'planner'
  );
  const plannerRunning =
    itemStatus === 'planning' ||
    agents.some((agent) => agent.role === 'planner' && (agent.status === 'starting' || agent.status === 'running'));
  const planningStageStatus: WorkflowStageStatus =
    plan ? 'completed'
      : plannerRunning ? 'running'
      : hasPlannerError ? 'error'
      : 'pending';

  const tasksByRepo = new Map<string, PlanTask[]>();
  for (const task of plan?.tasks || []) {
    const repoTasks = tasksByRepo.get(task.repository) || [];
    repoTasks.push(task);
    tasksByRepo.set(task.repository, repoTasks);
  }

  const jobs: ItemWorkflowJob[] = [];
  for (const [repoName, repoTasks] of tasksByRepo) {
    const repoState = repoStatuses.get(repoName);
    const taskStateById = new Map<string, RepoTaskStateTask>();
    const persistedState = taskStates.get(repoName);
    for (const taskState of persistedState?.tasks || []) {
      taskStateById.set(taskState.id, taskState);
    }

    const steps = repoTasks.map((task) => {
      const taskState = taskStateById.get(task.id);
      return {
        taskId: task.id,
        title: task.title,
        status: taskState?.status ?? 'pending',
        currentPhase: taskState?.currentPhase,
        attempts: taskState?.attempts ?? 0,
        reviewRounds: taskState?.reviewRounds,
        lastError: taskState?.lastError,
      };
    });

    const totalSteps = steps.length;
    const completedSteps = steps.filter((step) => step.status === 'completed').length;
    const failedSteps = steps.filter((step) => step.status === 'failed').length;
    const runningStep = steps.find((step) => isTaskRunning(step.status));
    const failedStep = steps.find((step) => step.status === 'failed');
    const hasTerminalPublish = prEventByRepo.has(repoName) || noChangesByRepo.has(repoName);

    let status: WorkflowStageStatus = 'pending';
    let activeStage: WorkflowJobStage | undefined;
    let currentTaskId = runningStep?.taskId ?? failedStep?.taskId;
    let currentPhase = runningStep?.currentPhase ?? failedStep?.currentPhase;

    if (repoState?.status === 'review_receiving') {
      status = 'running';
      activeStage = 'review_receive';
      currentTaskId = undefined;
      currentPhase = undefined;
    } else if (repoState?.status === 'error' && repoState.activePhase === 'review_receive') {
      status = 'error';
      activeStage = 'review_receive';
      currentTaskId = undefined;
      currentPhase = undefined;
    } else if (repoState?.status === 'error' && repoState.activePhase === 'pr') {
      status = 'error';
      activeStage = 'publish';
      currentTaskId = undefined;
      currentPhase = undefined;
    } else if (runningStep) {
      status = 'running';
      activeStage = 'execution';
    } else if (failedSteps > 0 || (
      repoState?.status === 'error' &&
      (repoState.activePhase === 'engineer' || repoState.activePhase === 'hooks' || repoState.activePhase === 'review')
    )) {
      status = 'error';
      activeStage = 'execution';
    } else if (totalSteps > 0 && completedSteps === totalSteps) {
      if (hasTerminalPublish) {
        status = 'completed';
      } else {
        status = 'running';
        activeStage = 'publish';
      }
    }

    jobs.push({
      repoName,
      status,
      activeStage,
      currentTaskId,
      currentPhase,
      totalSteps,
      completedSteps,
      failedSteps,
      steps,
    });
  }

  const totalSteps = jobs.reduce((sum, job) => sum + job.totalSteps, 0);
  const completedSteps = jobs.reduce((sum, job) => sum + job.completedSteps, 0);
  const failedSteps = jobs.reduce((sum, job) => sum + job.failedSteps, 0);
  const jobsByRepo = new Map<string, ItemWorkflowJob>(jobs.map((job) => [job.repoName, job]));
  const runningExecutionActivities = (plan?.tasks || []).flatMap((task) => {
      const job = jobsByRepo.get(task.repository);
      const step = job?.steps.find((candidate) => candidate.taskId === task.id);
      if (!job || !step || !isTaskRunning(step.status)) {
        return [];
      }
      return [{ repoName: task.repository, taskId: task.id, phase: step.currentPhase }];
    });

  const executionStageStatus: WorkflowStageStatus =
    !plan || totalSteps === 0 ? 'pending'
      : jobs.some((job) => job.activeStage === 'execution' && job.status === 'error') ? 'error'
      : runningExecutionActivities.length > 0 ? 'running'
      : completedSteps === totalSteps ? 'completed'
      : 'pending';

  const publishTargetRepos = jobs.map((job) => job.repoName);
  const publishStageStatus: WorkflowStageStatus =
    publishTargetRepos.length === 0 ? 'pending'
      : jobs.some((job) => job.activeStage === 'publish' && job.status === 'error') ? 'error'
      : publishTargetRepos.every((repoName) => prEventByRepo.has(repoName) || noChangesByRepo.has(repoName)) ? 'completed'
      : jobs.some((job) => job.activeStage === 'publish' && job.status === 'running') ? 'running'
      : 'pending';

  const prRepos = publishTargetRepos.filter((repoName) => prEventByRepo.has(repoName));
  const reviewReceiveRunningRepos = jobs.filter((job) => job.activeStage === 'review_receive' && job.status === 'running');
  const reviewReceiveHasError = jobs.some((job) => job.activeStage === 'review_receive' && job.status === 'error');
  const reviewReceiveCompleted = prRepos.length > 0 && prRepos.every((repoName) => {
    const prEvent = prEventByRepo.get(repoName);
    const completedEvent = reviewReceiveCompletedByRepo.get(repoName);
    if (!prEvent || !completedEvent) {
      return false;
    }
    return completedEvent.timestamp >= prEvent.timestamp;
  });

  const stages: ItemWorkflowStage[] = [
    { id: 'workspace', label: WORKFLOW_STAGE_LABELS.workspace, status: workspaceStageStatus },
    { id: 'planning', label: WORKFLOW_STAGE_LABELS.planning, status: planningStageStatus },
    { id: 'execution', label: WORKFLOW_STAGE_LABELS.execution, status: executionStageStatus },
    { id: 'publish', label: WORKFLOW_STAGE_LABELS.publish, status: publishStageStatus },
  ];

  if (prRepos.length > 0) {
    stages.push({
      id: 'review_receive',
      label: WORKFLOW_STAGE_LABELS.review_receive,
      status: reviewReceiveHasError ? 'error'
        : reviewReceiveRunningRepos.length > 0 ? 'running'
        : reviewReceiveCompleted ? 'completed'
        : 'pending',
      optional: true,
    });
  }

  const runningPublishRepos = jobs.filter((job) => job.activeStage === 'publish' && job.status === 'running');
  const planningActivityCount = planningStageStatus === 'running' ? 1 : 0;
  const totalRunningActivities =
    reviewReceiveRunningRepos.length +
    runningPublishRepos.length +
    runningExecutionActivities.length +
    planningActivityCount +
    workspaceRunningRepos.length;

  let currentActivity: ItemWorkflowSummary['currentActivity'];
  if (reviewReceiveRunningRepos.length > 0) {
    const primaryActivity = reviewReceiveRunningRepos[0];
    currentActivity = {
      repoName: primaryActivity.repoName,
      stage: 'review_receive',
      moreRunningCount: Math.max(totalRunningActivities - 1, 0) || undefined,
    };
  } else if (runningPublishRepos.length > 0) {
    const primaryActivity = runningPublishRepos[0];
    currentActivity = {
      repoName: primaryActivity.repoName,
      stage: 'publish',
      moreRunningCount: Math.max(totalRunningActivities - 1, 0) || undefined,
    };
  } else if (runningExecutionActivities.length > 0) {
    const primaryActivity = runningExecutionActivities[0];
    currentActivity = {
      repoName: primaryActivity.repoName,
      stage: 'execution',
      taskId: primaryActivity.taskId,
      phase: primaryActivity.phase,
      moreRunningCount: Math.max(totalRunningActivities - 1, 0) || undefined,
    };
  } else if (planningStageStatus === 'running') {
    currentActivity = {
      stage: 'planning',
      moreRunningCount: Math.max(totalRunningActivities - 1, 0) || undefined,
    };
  } else if (workspaceRunningRepos.length > 0) {
    currentActivity = {
      repoName: workspaceRunningRepos[0].name,
      stage: 'workspace',
      moreRunningCount: Math.max(totalRunningActivities - 1, 0) || undefined,
    };
  }

  return {
    stages,
    jobs,
    overall: {
      totalSteps,
      completedSteps,
      failedSteps,
      runningStepId: runningExecutionActivities[0]?.taskId,
    },
    currentActivity,
  };
}

export async function getItemDetail(itemId: string): Promise<ItemDetail | null> {
  const config = await getItemConfig(itemId);
  if (!config) {
    return null;
  }

  const status = await deriveItemStatus(itemId);
  const plan = await getPlan(itemId);
  const agents = await getAgentsByItem(itemId);
  const pendingApprovals = await getPendingApprovals(itemId);

  // Build RepoSummary[] from events + derived repo statuses
  const events = await readJsonl<import('@agent-orch/shared').ItemEvent>(getItemEventsPath(itemId));
  const prEvents = events.filter((e): e is PrCreatedEvent => e.type === 'pr_created');
  const noChangesEvents = events.filter((e): e is RepoNoChangesEvent => e.type === 'repo_no_changes');
  const repoStatusMap = await deriveRepoStatuses(itemId);
  const taskStates = new Map<string, RepoTaskStateFile>();
  for (const repoName of new Set((plan?.tasks || []).map((task) => task.repository))) {
    const taskState = await readRepoTaskState(itemId, repoName);
    if (taskState) {
      taskStates.set(repoName, taskState);
    }
  }
  const workflow = buildWorkflowSummary({
    config,
    itemStatus: status,
    plan,
    events,
    agents,
    repoStatuses: repoStatusMap,
    prEvents,
    noChangesEvents,
    taskStates,
  });
  const jobsByRepo = new Map<string, ItemWorkflowJob>(workflow.jobs.map((job) => [job.repoName, job]));

  const repos: RepoSummary[] = config.repositories.map(repo => {
    const prEvent = prEvents.filter(e => e.repoName === repo.name).pop();
    const hasNoChanges = noChangesEvents.some(e => e.repoName === repo.name);
    const derived = repoStatusMap.get(repo.name);
    const job = jobsByRepo.get(repo.name);
    const workflowPhase =
      job?.activeStage === 'execution'
        ? mapTaskPhaseToRepoPhase(job.currentPhase)
        : mapJobStageToRepoPhase(job?.activeStage);
    return {
      repoName: repo.name,
      prUrl: prEvent?.prUrl,
      prNumber: prEvent?.prNumber,
      noChanges: hasNoChanges,
      status: derived?.status ?? 'not_started',
      activePhase: workflowPhase ?? derived?.activePhase,
      inCurrentPlan: derived?.inCurrentPlan ?? false,
      lastErrorMessage: derived?.lastErrorMessage,
    };
  });

  return {
    ...config,
    status,
    plan: plan || undefined,
    agents,
    pendingApprovals,
    repos,
    workflow,
  };
}

export async function updateItem(
  itemId: string,
  updates: Partial<Pick<ItemConfig, 'name' | 'description' | 'designDoc'>>
): Promise<ItemConfig | null> {
  const config = await getItemConfig(itemId);
  if (!config) {
    return null;
  }

  const updated: ItemConfig = {
    ...config,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await writeYaml(getItemConfigPath(itemId), updated);
  return updated;
}

export async function deleteItem(itemId: string): Promise<boolean> {
  const itemDir = getItemDir(itemId);
  if (!existsSync(itemDir)) {
    return false;
  }

  // Stop all git snapshots for this item
  stopAllGitSnapshots(itemId);

  // Stop all agents for this item
  const agents = await getAgentsByItem(itemId);
  for (const agent of agents) {
    await stopAgent(agent.id);
  }

  await rm(itemDir, { recursive: true, force: true });
  return true;
}
