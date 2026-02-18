import { join, resolve } from 'path';
import { readFile, unlink } from 'fs/promises';
import type { Plan, PlanTask, AgentRole, AgentInfo, AgentStatus, ItemRepositoryConfig } from '@agent-orch/shared';
import { isSystemRole, isDevRole } from '@agent-orch/shared';
import { startAgent, getAgentsByItem, waitForAgentsByIds, sendLine, stopAgent } from './agent-service';
import { getPlan } from './planner-service';
import { getItemConfig } from './item-service';
import {
  startGitSnapshot,
  stopAllGitSnapshots,
} from './git-snapshot-service';
import { createDraftPrsForAllRepos } from './git-pr-service';
import { getWorkspaceRoot, getRepoWorkspaceDir, getItemEventsPath } from '../lib/paths';
import { ptyManager } from '../lib/pty-manager';
import { eventBus } from './event-bus';
import { appendJsonl } from '../lib/jsonl';
import { createReviewFindingsExtractedEvent, createStatusChangedEvent } from '../lib/events';

function getRoleDescription(role: string): string {
  const descriptions: Record<string, string> = {
    planner: 'Planning and architecture',
    review: 'Code review, testing, documentation, integration',
    'review-receiver': 'Receiving and processing PR review comments',
  };
  return descriptions[role] || `${role} development`;
}

const WORKER_PROMPT_TEMPLATE = `You are a {{role}} development agent working on implementing specific tasks from a development plan.

## Your Role: {{roleDescription}}

## Project Context

**Repository:** {{repoName}}
**Task ID:** {{taskId}}
**Task Title:** {{taskTitle}}

**Task Description:**
{{taskDescription}}

**Files to work on:**
{{files}}

**Dependencies:**
{{dependencies}}

## Instructions

1. Focus ONLY on the task assigned to you
2. Follow the existing code patterns and conventions in the repository
3. Write clean, well-documented code
4. Create or modify only the files necessary for your task
5. Do not modify files outside your task scope unless absolutely necessary
6. If you encounter blocking issues, document them clearly

## Completion

When your task is complete:
1. Ensure all code compiles/runs without errors
2. Write any necessary tests
3. Clean up any temporary files you created (e.g., debug logs, test outputs)
4. Commit your changes:
   a. FIRST run: git status --porcelain
   b. Review the output carefully - only files YOU intentionally modified should be committed
   c. If unexpected files appear:
      - Temporary files you created: delete them (rm <file>)
      - Files you didn't modify: do NOT add them
   d. Run: git add <only the files you intentionally modified>
   e. Run: git commit -m "feat(<scope>): <description>"

   IMPORTANT - Commit Rules:
   - NEVER use git add -A or git add .
   - Only commit files you actually modified for your task
   - Do NOT commit:
     * Temporary files (review_findings.json, plan.yaml, debug logs, etc.)
     * Lock files (yarn.lock, package-lock.json, go.sum, etc.) UNLESS you intentionally added/removed dependencies
     * Files you didn't modify
   - If you created any temporary files during your work, DELETE them before committing

5. Output "TASKS_COMPLETED" on a new line
6. Wait for further instructions from the orchestrator

Do NOT run /exit unless explicitly instructed by the orchestrator.

Start working on your assigned task now.`;

const REVIEW_PROMPT_TEMPLATE = `You are a code review agent reviewing the {{repoName}} repository. Your task is to review the code changes made by the development agents and provide actionable feedback.

## Your Role

Review the code for:
1. Code quality and best practices
2. Potential bugs or security issues
3. Performance concerns
4. Adherence to project conventions
5. Test coverage

## Output Format

After reviewing, output your findings as JSON in the following format:

\`\`\`json:review_findings.json
{
  "findings": [
    {
      "severity": "critical" | "major" | "minor",
      "file": "path/to/file.ts",
      "line": 42,
      "description": "Issue description",
      "suggestedFix": "How to fix",
      "targetAgent": "{{targetRole}}"
    }
  ],
  "overallAssessment": "pass" | "needs_fixes",
  "summary": "Overall summary"
}
\`\`\`

Then output "TASKS_COMPLETED" and wait for further instructions.

## Instructions

1. Examine all changed files in the workspace
2. Focus on critical and major issues first
3. Be specific about file paths and line numbers
4. Provide actionable fix suggestions
5. If no issues found, set overallAssessment to "pass"

Start your review now.`;

// Types for review findings
interface ReviewFinding {
  severity: 'critical' | 'major' | 'minor';
  file: string;
  line?: number;
  description: string;
  suggestedFix: string;
  targetAgent: string;
}

interface ReviewFindings {
  findings: ReviewFinding[];
  overallAssessment: 'pass' | 'needs_fixes';
  summary: string;
}

const MAX_REVIEW_ITERATIONS = 3;

// Active dev agents: `${itemId}/${repoName}` -> agentId
const activeDevAgents = new Map<string, string>();

// パストラバーサル防止
function validateAgentWorkdir(agentWorkdir: string, workspaceRoot: string): void {
  const normalizedWorkdir = resolve(agentWorkdir);
  const normalizedWorkspace = resolve(workspaceRoot);

  if (!normalizedWorkdir.startsWith(normalizedWorkspace + '/') &&
      normalizedWorkdir !== normalizedWorkspace) {
    throw new Error(
      `Invalid agent workdir: ${agentWorkdir} is outside workspace ${workspaceRoot}`
    );
  }
}

// Worker起動 + git snapshot 開始
async function startWorkerAgentWithSnapshot(
  itemId: string,
  role: AgentRole,
  repoName: string,
  tasks: PlanTask[],
  plan: Plan,
  agentWorkdir: string,
  workspaceRoot: string
): Promise<AgentInfo> {
  validateAgentWorkdir(agentWorkdir, workspaceRoot);

  const agent = await startWorkerAgent(itemId, role, repoName, tasks, plan, agentWorkdir);

  await startGitSnapshot(itemId, agentWorkdir, agent.id);

  return agent;
}

export async function startWorkers(itemId: string): Promise<void> {
  const plan = await getPlan(itemId);
  if (!plan) {
    throw new Error(`No plan found for item ${itemId}`);
  }

  const itemConfig = await getItemConfig(itemId);
  if (!itemConfig) {
    throw new Error(`Item config not found for ${itemId}`);
  }

  const workspaceRoot = resolve(getWorkspaceRoot(itemId));

  // Start parent workspace root git snapshot
  await startGitSnapshot(itemId, workspaceRoot);

  // Group tasks by repository
  const tasksByRepo = new Map<string, PlanTask[]>();

  for (const task of plan.tasks) {
    const repoName = task.repository;
    if (!repoName) {
      console.warn(`[${itemId}] Task ${task.id} has no repository field, skipping`);
      continue;
    }
    const tasks = tasksByRepo.get(repoName) || [];
    tasks.push(task);
    tasksByRepo.set(repoName, tasks);
  }

  // Phase 1: Start dev workers for each repository in parallel
  const devPromises: Promise<AgentInfo>[] = [];
  const devAgentIds: string[] = [];

  for (const repo of itemConfig.repositories) {
    const repoTasks = tasksByRepo.get(repo.name);
    // Filter to only dev tasks (not review)
    const devTasks = repoTasks?.filter(t => isDevRole(t.agent)) || [];
    if (devTasks.length === 0) continue;

    const agentWorkdir = resolve(getRepoWorkspaceDir(itemId, repo.name));
    const promise = startWorkerAgentWithSnapshot(
      itemId, repo.role, repo.name, devTasks, plan, agentWorkdir, workspaceRoot
    ).then(agent => {
      // Track active dev agent
      activeDevAgents.set(`${itemId}/${repo.name}`, agent.id);
      devAgentIds.push(agent.id);
      return agent;
    });

    devPromises.push(promise);
  }

  // Wait for dev workers to complete
  if (devPromises.length > 0) {
    await Promise.all(devPromises);
    await waitForAgentsByIds(itemId, devAgentIds);
  }

  // Phase 2: Review Feedback Loop (per repository)
  for (const repo of itemConfig.repositories) {
    const repoTasks = tasksByRepo.get(repo.name);
    const reviewTasks = repoTasks?.filter(t => t.agent === 'review') || [];
    if (reviewTasks.length === 0) continue;

    const agentWorkdir = resolve(getRepoWorkspaceDir(itemId, repo.name));

    for (let iteration = 0; iteration < MAX_REVIEW_ITERATIONS; iteration++) {
      console.log(`[${itemId}/${repo.name}] Starting review iteration ${iteration + 1}/${MAX_REVIEW_ITERATIONS}`);

      // Delete stale review_findings.json
      try {
        await unlink(join(agentWorkdir, 'review_findings.json'));
      } catch {
        // File doesn't exist
      }

      // Start review agent for this repo
      const reviewAgent = await startWorkerAgentWithSnapshot(
        itemId, 'review', repo.name, reviewTasks, plan, agentWorkdir, workspaceRoot
      );
      await waitForAgentsByIds(itemId, [reviewAgent.id]);

      // Extract and analyze findings
      const findings = await extractReviewFindings(itemId, repo.name);

      // Publish review findings event
      if (findings) {
        const event = createReviewFindingsExtractedEvent(
          itemId,
          reviewAgent.id,
          repo.name,
          findings.findings,
          findings.overallAssessment,
          findings.summary
        );
        await appendJsonl(getItemEventsPath(itemId), event);
        eventBus.publish(itemId, event);
      }

      // Exit review agent
      await stopAgent(reviewAgent.id);

      // Check if review passed
      if (!findings || findings.overallAssessment === 'pass') {
        console.log(`[${itemId}/${repo.name}] Review passed on iteration ${iteration + 1}`);
        break;
      }

      // Last iteration - don't send feedback
      if (iteration === MAX_REVIEW_ITERATIONS - 1) {
        console.warn(`[${itemId}/${repo.name}] Max review iterations reached`);
        break;
      }

      console.log(`[${itemId}/${repo.name}] Review found ${findings.findings.length} issues`);

      // Send feedback to the dev agent for this repo
      const devAgentId = activeDevAgents.get(`${itemId}/${repo.name}`);
      if (devAgentId) {
        const devAgent = (await getAgentsByItem(itemId)).find(a => a.id === devAgentId);
        if (devAgent && (devAgent.status === 'running' || devAgent.status === 'waiting_orchestrator')) {
          const feedbackPrompt = buildFeedbackPrompt(findings.findings);
          await sendCommandToAgent(devAgent.id, feedbackPrompt);

          // Reset agent status to running
          const previousStatus = devAgent.status;
          devAgent.status = 'running';
          const statusEvent = createStatusChangedEvent(
            itemId,
            previousStatus,
            'running',
            devAgent.id
          );
          await appendJsonl(getItemEventsPath(itemId), statusEvent);
          eventBus.emit('event', { itemId, event: statusEvent });

          // Wait for dev agent to complete fixes
          await waitForAgentsByIds(itemId, [devAgent.id]);
        } else {
          console.warn(`[${itemId}/${repo.name}] Dev agent not available for feedback`);
        }
      } else {
        console.warn(`[${itemId}/${repo.name}] No active dev agent found for feedback`);
      }
    }
  }

  // Phase 3: Kill all remaining agents and create Draft PRs for all repos
  await killAllRemainingAgents(itemId);

  // Clear activeDevAgents for this item
  for (const repo of itemConfig.repositories) {
    activeDevAgents.delete(`${itemId}/${repo.name}`);
  }

  await createDraftPrsForAllRepos(itemId);
}

export async function startWorkerForRole(
  itemId: string,
  role: AgentRole,
  repoName?: string
): Promise<void> {
  const plan = await getPlan(itemId);
  if (!plan) {
    throw new Error(`No plan found for item ${itemId}`);
  }

  const itemConfig = await getItemConfig(itemId);
  if (!itemConfig) {
    throw new Error(`Item config not found for ${itemId}`);
  }

  const workspaceRoot = resolve(getWorkspaceRoot(itemId));

  if (repoName) {
    // Start for specific repo
    const tasks = plan.tasks.filter(t => t.agent === role && t.repository === repoName);
    if (tasks.length === 0) {
      throw new Error(`No tasks found for role ${role} in repository ${repoName}`);
    }

    const agentWorkdir = resolve(getRepoWorkspaceDir(itemId, repoName));
    await startWorkerAgentWithSnapshot(itemId, role, repoName, tasks, plan, agentWorkdir, workspaceRoot);
  } else {
    // Start for all repos that have tasks for this role
    for (const repo of itemConfig.repositories) {
      const tasks = plan.tasks.filter(t => t.agent === role && t.repository === repo.name);
      if (tasks.length === 0) continue;

      const agentWorkdir = resolve(getRepoWorkspaceDir(itemId, repo.name));
      await startWorkerAgentWithSnapshot(itemId, role, repo.name, tasks, plan, agentWorkdir, workspaceRoot);
    }
  }
}

async function startWorkerAgent(
  itemId: string,
  role: AgentRole,
  repoName: string,
  tasks: PlanTask[],
  plan: Plan,
  workingDir: string
): Promise<AgentInfo> {
  const prompt = buildWorkerPrompt(role, repoName, tasks, plan);

  return await startAgent({
    itemId,
    role,
    repoName,
    prompt,
    workingDir,
  });
}

export async function stopWorkers(itemId: string): Promise<void> {
  stopAllGitSnapshots(itemId);
}

function buildWorkerPrompt(
  role: AgentRole,
  repoName: string,
  tasks: PlanTask[],
  plan: Plan
): string {
  if (role === 'review') {
    const taskDescriptions = tasks
      .map((task) => `### Task: ${task.id} - ${task.title}\n${task.description}`)
      .join('\n\n');

    // Find the dev role for this repo from the tasks
    const devTask = plan.tasks.find(t => t.repository === repoName && isDevRole(t.agent));
    const targetRole = devTask?.agent || repoName;

    return REVIEW_PROMPT_TEMPLATE
      .replace(/\{\{repoName\}\}/g, repoName)
      .replace(/\{\{targetRole\}\}/g, targetRole)
      + '\n\n## Task-Specific Review Instructions\n\n' + taskDescriptions;
  }

  const taskList = tasks
    .map((task) => {
      const deps =
        task.dependencies && task.dependencies.length > 0
          ? `Dependencies: ${task.dependencies.join(', ')}`
          : 'No dependencies';

      const files =
        task.files && task.files.length > 0
          ? `Files: ${task.files.join(', ')}`
          : 'No specific files assigned';

      return `### Task: ${task.id} - ${task.title}
${task.description}
${files}
${deps}`;
    })
    .join('\n\n');

  const allFiles = tasks.flatMap((t) => t.files || []);
  const filesStr =
    allFiles.length > 0 ? allFiles.join('\n- ') : 'No specific files assigned';

  const allDeps = tasks.flatMap((t) => t.dependencies || []);
  const depsStr =
    allDeps.length > 0 ? allDeps.join(', ') : 'No dependencies';

  return WORKER_PROMPT_TEMPLATE
    .replace('{{role}}', role)
    .replace('{{roleDescription}}', getRoleDescription(role))
    .replace('{{repoName}}', repoName)
    .replace('{{taskId}}', tasks.map((t) => t.id).join(', '))
    .replace('{{taskTitle}}', tasks.map((t) => t.title).join('; '))
    .replace('{{taskDescription}}', taskList)
    .replace('{{files}}', filesStr)
    .replace('{{dependencies}}', depsStr);
}

export async function getWorkerStatus(
  itemId: string
): Promise<{ role: AgentRole; repoName?: string; taskCount: number; status: string }[]> {
  const plan = await getPlan(itemId);
  const agents = await getAgentsByItem(itemId);
  const itemConfig = await getItemConfig(itemId);

  const result: { role: AgentRole; repoName?: string; taskCount: number; status: string }[] = [];

  if (itemConfig) {
    // Add dev and review roles per repo
    for (const repo of itemConfig.repositories) {
      // Dev tasks
      const devTaskCount = plan?.tasks.filter(t => t.repository === repo.name && isDevRole(t.agent)).length || 0;
      const devAgent = agents.find(a => a.repoName === repo.name && isDevRole(a.role));
      result.push({
        role: repo.role,
        repoName: repo.name,
        taskCount: devTaskCount,
        status: devAgent?.status || 'not_started',
      });

      // Review tasks
      const reviewTaskCount = plan?.tasks.filter(t => t.repository === repo.name && t.agent === 'review').length || 0;
      if (reviewTaskCount > 0) {
        const reviewAgent = agents.find(a => a.repoName === repo.name && a.role === 'review');
        result.push({
          role: 'review',
          repoName: repo.name,
          taskCount: reviewTaskCount,
          status: reviewAgent?.status || 'not_started',
        });
      }
    }
  }

  return result;
}

// Helper: Send command to an agent
async function sendCommandToAgent(agentId: string, command: string): Promise<boolean> {
  return sendLine(agentId, command);
}

// Helper: Signal agent to exit
async function signalAgentToExit(agentId: string): Promise<boolean> {
  return sendLine(agentId, '/exit');
}

// Helper: Kill all remaining agents
async function killAllRemainingAgents(itemId: string): Promise<void> {
  const agents = await getAgentsByItem(itemId);

  for (const agent of agents) {
    if (agent.status === 'running' || agent.status === 'waiting_orchestrator') {
      await stopAgent(agent.id);
    }
  }
}

// Helper: Extract review findings from a specific repo
async function extractReviewFindings(itemId: string, repoName: string): Promise<ReviewFindings | null> {
  const repoDir = getRepoWorkspaceDir(itemId, repoName);
  const findingsPath = join(repoDir, 'review_findings.json');

  try {
    const content = await readFile(findingsPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// Helper: Build feedback prompt from findings
function buildFeedbackPrompt(findings: ReviewFinding[]): string {
  const findingsText = findings.map((f, i) =>
    `${i + 1}. [${f.severity.toUpperCase()}] ${f.file}${f.line ? `:${f.line}` : ''}
   Issue: ${f.description}
   Fix: ${f.suggestedFix}`
  ).join('\n\n');

  return `## Review Feedback

The code reviewer found the following issues that need to be addressed:

${findingsText}

Please fix these issues and then output "TASKS_COMPLETED" when done.`;
}

// Run iterative review (exported for external use)
export async function runIterativeReview(itemId: string): Promise<void> {
  // This is now handled within startWorkers
  await startWorkers(itemId);
}
