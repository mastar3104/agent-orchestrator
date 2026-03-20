import { createHash, randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readdir, rename } from 'fs/promises';
import { join } from 'path';
import type {
  AgentStartedEvent,
  ItemEvent,
  Plan,
  PlanTask,
  StatusChangedEvent,
  TaskExecutionStatus,
  TaskProgressPhase,
} from '@agent-orch/shared';
import {
  getRepoTaskStatePath,
  getTaskStateArchiveDir,
  getTaskStateDir,
} from '../lib/paths';
import { readYamlSafe, stringifyYaml, writeYaml } from '../lib/yaml';

export interface RepoTaskStateTask {
  id: string;
  title: string;
  dependencies: string[];
  status: TaskExecutionStatus;
  currentPhase?: TaskProgressPhase;
  attempts: number;
  phaseBase?: string;
  reviewRounds?: number;
  reviewExhausted?: boolean;
  hooksExhausted?: boolean;
  lastStartedAt?: string;
  completedAt?: string;
  lastError?: string;
  commitHash?: string;
  filesModified?: string[];
}

export interface RepoTaskStateFile {
  version: string;
  itemId: string;
  repository: string;
  planFingerprint: string;
  createdAt: string;
  updatedAt: string;
  tasks: RepoTaskStateTask[];
}

export const INTERRUPTED_TASK_ERROR = 'Interrupted before completion';
export const AGENT_STOPPED_BEFORE_COMPLETION_ERROR = 'Agent stopped before completion';

const INTERRUPTIBLE_AGENT_ROLES = new Set(['engineer', 'developer', 'review']);

export interface ReconciledRepoTaskState {
  state: RepoTaskStateFile;
  mutated: boolean;
  interruptedInProgressTaskIds: string[];
  interruptedInReviewTaskIds: string[];
}

function cloneRepoTaskState(state: RepoTaskStateFile): RepoTaskStateFile {
  return {
    ...state,
    tasks: state.tasks.map((task) => ({
      ...task,
      dependencies: [...task.dependencies],
      filesModified: task.filesModified ? [...task.filesModified] : undefined,
    })),
  };
}

export function hasStaleExecutionStop(events: ItemEvent[], repoName: string): boolean {
  const agentRepoById = new Map<string, string>();
  const agentRoleById = new Map<string, string>();
  let staleStop = false;

  for (const event of events) {
    if (event.type === 'plan_created') {
      staleStop = false;
      continue;
    }

    if (event.type === 'agent_started' && event.agentId) {
      const started = event as AgentStartedEvent;
      if (started.repoName) {
        agentRepoById.set(started.agentId, started.repoName);
      }
      agentRoleById.set(started.agentId, started.role);
      if (started.repoName === repoName && INTERRUPTIBLE_AGENT_ROLES.has(started.role)) {
        staleStop = false;
      }
      continue;
    }

    if (event.type !== 'status_changed' || !event.agentId) {
      continue;
    }

    const statusChanged = event as StatusChangedEvent;
    const agentRepo = agentRepoById.get(event.agentId);
    const role = agentRoleById.get(event.agentId);
    if (agentRepo !== repoName || !role || !INTERRUPTIBLE_AGENT_ROLES.has(role)) {
      continue;
    }
    if (statusChanged.previousStatus === 'running' && statusChanged.newStatus === 'stopped') {
      staleStop = true;
    }
  }

  return staleStop;
}

export function reconcileStoppedRepoTaskState(state: RepoTaskStateFile): ReconciledRepoTaskState {
  const next = cloneRepoTaskState(state);
  const interruptedInProgressTaskIds: string[] = [];
  const interruptedInReviewTaskIds: string[] = [];

  for (const task of next.tasks) {
    if (task.status === 'in_progress') {
      task.status = 'failed';
      task.currentPhase = task.currentPhase || 'engineer';
      task.lastError = task.lastError || INTERRUPTED_TASK_ERROR;
      interruptedInProgressTaskIds.push(task.id);
      continue;
    }

    if (task.status === 'in_review') {
      interruptedInReviewTaskIds.push(task.id);
    }
  }

  return {
    state: next,
    mutated: interruptedInProgressTaskIds.length > 0,
    interruptedInProgressTaskIds,
    interruptedInReviewTaskIds,
  };
}

export function createArchiveTag(now: Date = new Date()): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '_')
    .replace(/\.\d{3}Z$/, `_${String(now.getMilliseconds()).padStart(3, '0')}`);
  const randomSuffix = randomBytes(3).toString('hex');
  return `${timestamp}_${randomSuffix}`;
}

export function createPlanFingerprint(plan: Plan): string {
  return createHash('sha256').update(stringifyYaml(plan)).digest('hex');
}

function buildTaskStateTask(task: PlanTask): RepoTaskStateTask {
  return {
    id: task.id,
    title: task.title,
    dependencies: [...(task.dependencies || [])],
    status: 'pending',
    attempts: 0,
  };
}

function buildRepoTaskState(
  itemId: string,
  repository: string,
  planFingerprint: string,
  tasks: PlanTask[],
  now: string
): RepoTaskStateFile {
  return {
    version: '1',
    itemId,
    repository,
    planFingerprint,
    createdAt: now,
    updatedAt: now,
    tasks: tasks.map(buildTaskStateTask),
  };
}

export async function readRepoTaskState(
  itemId: string,
  repoName: string
): Promise<RepoTaskStateFile | null> {
  return readYamlSafe<RepoTaskStateFile>(getRepoTaskStatePath(itemId, repoName));
}

export async function writeRepoTaskState(
  itemId: string,
  state: RepoTaskStateFile
): Promise<void> {
  await writeYaml(getRepoTaskStatePath(itemId, state.repository), state);
}

export async function reconcileStoppedRepoTaskStateForItem(
  itemId: string,
  repoName: string
): Promise<ReconciledRepoTaskState | null> {
  const state = await readRepoTaskState(itemId, repoName);
  if (!state) {
    return null;
  }

  const reconciled = reconcileStoppedRepoTaskState(state);
  if (reconciled.mutated) {
    await writeRepoTaskState(itemId, reconciled.state);
  }

  return reconciled;
}

export async function regenerateTaskStatesForPlan(
  itemId: string,
  plan: Plan
): Promise<RepoTaskStateFile[]> {
  const planFingerprint = createPlanFingerprint(plan);
  const now = new Date().toISOString();
  const tasksByRepo = new Map<string, PlanTask[]>();

  for (const task of plan.tasks) {
    const repoTasks = tasksByRepo.get(task.repository) || [];
    repoTasks.push(task);
    tasksByRepo.set(task.repository, repoTasks);
  }

  const states: RepoTaskStateFile[] = [];
  for (const [repoName, repoTasks] of tasksByRepo) {
    const state = buildRepoTaskState(itemId, repoName, planFingerprint, repoTasks, now);
    await writeRepoTaskState(itemId, state);
    states.push(state);
  }

  return states;
}

export async function archiveCurrentTaskStates(
  itemId: string,
  archiveTag: string = createArchiveTag()
): Promise<string[]> {
  const taskStateDir = getTaskStateDir(itemId);
  if (!existsSync(taskStateDir)) {
    return [];
  }

  const archivedPaths: string[] = [];
  const files = await readdir(taskStateDir);
  const stateFiles = files.filter((file) => file.endsWith('.yaml'));
  const archiveDir = getTaskStateArchiveDir(itemId);
  await mkdir(archiveDir, { recursive: true });

  for (const file of stateFiles) {
    const fromPath = join(taskStateDir, file);
    const archivePath = join(archiveDir, `${file.replace(/\.yaml$/, '')}_${archiveTag}.yaml`);
    await rename(fromPath, archivePath);
    archivedPaths.push(archivePath);
  }

  return archivedPaths;
}

export async function ensureTaskStatesForPlan(
  itemId: string,
  plan: Plan
): Promise<RepoTaskStateFile[]> {
  const repos = [...new Set(plan.tasks.map((task) => task.repository))];
  const expectedFingerprint = createPlanFingerprint(plan);
  const states: RepoTaskStateFile[] = [];

  let requiresRegeneration = false;
  for (const repoName of repos) {
    const state = await readRepoTaskState(itemId, repoName);
    if (!state || state.planFingerprint !== expectedFingerprint) {
      requiresRegeneration = true;
      break;
    }
    states.push(state);
  }

  if (!requiresRegeneration) {
    return states;
  }

  if (existsSync(getTaskStateDir(itemId))) {
    await archiveCurrentTaskStates(itemId);
  }

  return regenerateTaskStatesForPlan(itemId, plan);
}
