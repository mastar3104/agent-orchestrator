import { join, resolve } from 'path';
import { readFile, unlink } from 'fs/promises';
import type { Plan, PlanTask, AgentRole, AgentInfo, AgentStatus } from '@agent-orch/shared';
import { startAgent, getAgentsByItem, waitForAgentsToComplete, sendInput } from './agent-service';
import { getPlan } from './planner-service';
import { getItemConfig } from './item-service';
import {
  startGitSnapshot,
  stopAllGitSnapshots,
} from './git-snapshot-service';
import { createDraftPr } from './git-pr-service';
import { getWorkspaceDir, getItemEventsPath } from '../lib/paths';
import { ptyManager } from '../lib/pty-manager';
import { eventBus } from './event-bus';
import { appendJsonl } from '../lib/jsonl';
import { createReviewFindingsExtractedEvent } from '../lib/events';

const WORKER_PROMPT_TEMPLATE = `You are a {{role}} development agent working on implementing specific tasks from a development plan.

## Your Role: {{roleDescription}}

## Project Context

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

const ROLE_DESCRIPTIONS: Record<AgentRole, string> = {
  planner: 'Planning and architecture',
  front: 'Frontend development - UI components, styling, client-side logic, React/Vue/Angular components, CSS, state management',
  back: 'Backend development - APIs, database operations, server-side logic, authentication, data processing',
  review: 'Code review, testing, documentation, integration - ensuring code quality, writing tests, creating documentation, integrating components',
};

const REVIEW_PROMPT_TEMPLATE = `You are a code review agent. Your task is to review the code changes made by the development agents and provide actionable feedback.

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
      "targetAgent": "front" | "back"
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
  targetAgent: 'front' | 'back';
}

interface ReviewFindings {
  findings: ReviewFinding[];
  overallAssessment: 'pass' | 'needs_fixes';
  summary: string;
}

// Maximum number of review iterations before giving up
const MAX_REVIEW_ITERATIONS = 3;

// パストラバーサル防止: agentWorkdir が workspaceDir 配下かを検証
function validateAgentWorkdir(agentWorkdir: string, workspaceDir: string): void {
  const normalizedWorkdir = resolve(agentWorkdir);
  const normalizedWorkspace = resolve(workspaceDir);

  if (!normalizedWorkdir.startsWith(normalizedWorkspace + '/') &&
      normalizedWorkdir !== normalizedWorkspace) {
    throw new Error(
      `Invalid agent workdir: ${agentWorkdir} is outside workspace ${workspaceDir}`
    );
  }
}

// ヘルパー: Worker起動 + そのworkdir用 git snapshot 開始
async function startWorkerAgentWithSnapshot(
  itemId: string,
  role: AgentRole,
  tasks: PlanTask[],
  plan: Plan,
  agentWorkdir: string,  // 絶対パス
  workspaceDir: string   // 検証用
): Promise<AgentInfo> {
  // パストラバーサル防止
  validateAgentWorkdir(agentWorkdir, workspaceDir);

  // PTY起動時のcwdもagentWorkdirに合わせる
  const agent = await startWorkerAgent(itemId, role, tasks, plan, agentWorkdir);

  // 各workerのworkdir用 git snapshot 開始（絶対パス）
  await startGitSnapshot(itemId, agentWorkdir, agent.id);

  return agent;
}

export async function startWorkers(itemId: string): Promise<void> {
  const plan = await getPlan(itemId);
  if (!plan) {
    throw new Error(`No plan found for item ${itemId}`);
  }

  const itemConfig = await getItemConfig(itemId);
  const workspaceDir = resolve(getWorkspaceDir(itemId)); // 絶対パス

  // 1. 親repo（workspace root）の git snapshot 開始
  await startGitSnapshot(itemId, workspaceDir);

  // Group tasks by agent role
  const tasksByRole = new Map<AgentRole, PlanTask[]>();

  for (const task of plan.tasks) {
    const role = task.agent as AgentRole;
    const tasks = tasksByRole.get(role) || [];
    tasks.push(task);
    tasksByRole.set(role, tasks);
  }

  // Phase 1: Start front and back workers (development phase)
  const devRoles: AgentRole[] = ['front', 'back'];
  const devPromises: Promise<AgentInfo>[] = [];
  const startedDevRoles: AgentRole[] = [];

  for (const role of devRoles) {
    const tasks = tasksByRole.get(role);
    if (tasks && tasks.length > 0) {
      // item.yaml の agents[].workdir を参照
      const agentConfig = itemConfig?.agentConfigs?.find(a => a.role === role);
      const agentWorkdir = agentConfig?.workdir
        ? resolve(join(workspaceDir, agentConfig.workdir))  // 絶対パス
        : workspaceDir;

      devPromises.push(
        startWorkerAgentWithSnapshot(itemId, role, tasks, plan, agentWorkdir, workspaceDir)
      );
      startedDevRoles.push(role);
    }
  }

  // Wait for development workers to complete
  if (devPromises.length > 0) {
    // Start agents first, then wait for completion
    await Promise.all(devPromises);
    await waitForAgentsToComplete(itemId, startedDevRoles);
  }

  // Phase 2: Review Feedback Loop
  const reviewTasks = tasksByRole.get('review');
  if (reviewTasks && reviewTasks.length > 0) {
    const agentConfig = itemConfig?.agentConfigs?.find(a => a.role === 'review');
    const reviewAgentWorkdir = agentConfig?.workdir
      ? resolve(join(workspaceDir, agentConfig.workdir))
      : workspaceDir;

    for (let iteration = 0; iteration < MAX_REVIEW_ITERATIONS; iteration++) {
      console.log(`[${itemId}] Starting review iteration ${iteration + 1}/${MAX_REVIEW_ITERATIONS}`);

      // 2a. Delete stale review_findings.json
      try {
        await unlink(join(workspaceDir, 'review_findings.json'));
      } catch {
        // File doesn't exist, which is fine
      }

      // 2b. Start review agent
      await startWorkerAgentWithSnapshot(
        itemId, 'review', reviewTasks, plan, reviewAgentWorkdir, workspaceDir
      );
      await waitForAgentsToComplete(itemId, ['review']);

      // 2c. Extract and analyze findings
      const findings = await extractReviewFindings(itemId);

      // 2c-2. Publish review findings event
      if (findings) {
        const agents = await getAgentsByItem(itemId);
        const reviewAgent = agents.find(a => a.role === 'review');
        if (reviewAgent) {
          const event = createReviewFindingsExtractedEvent(
            itemId,
            reviewAgent.id,
            findings.findings,
            findings.overallAssessment,
            findings.summary
          );
          // Log to JSONL
          await appendJsonl(getItemEventsPath(itemId), event);
          // Broadcast via EventBus
          eventBus.publish(itemId, event);
        }
      }

      // 2d. Exit review agent and wait for completion
      const agents = await getAgentsByItem(itemId);
      const reviewAgent = agents.find(a => a.role === 'review');
      if (reviewAgent) {
        await signalAgentToExit(reviewAgent.id);
        await waitForAgentsToComplete(itemId, ['review']);
      }

      // 2e. Check if review passed
      if (!findings || findings.overallAssessment === 'pass') {
        console.log(`[${itemId}] Review passed on iteration ${iteration + 1}`);
        break;
      }

      // Last iteration - don't send feedback
      if (iteration === MAX_REVIEW_ITERATIONS - 1) {
        console.warn(`[${itemId}] Max review iterations reached with ${findings.findings.length} unresolved issues`);
        break;
      }

      console.log(`[${itemId}] Review found ${findings.findings.length} issues requiring fixes`);

      // 2f. Group findings by target agent
      const findingsByTarget = new Map<'front' | 'back', ReviewFinding[]>();
      for (const finding of findings.findings) {
        const target = finding.targetAgent;
        const existing = findingsByTarget.get(target) || [];
        existing.push(finding);
        findingsByTarget.set(target, existing);
      }

      // 2g. Send feedback to dev agents
      const activeDevRoles: AgentRole[] = [];
      for (const [targetRole, roleFindings] of findingsByTarget.entries()) {
        const devAgent = await getRunningAgentByRole(itemId, targetRole);
        if (devAgent) {
          const feedbackPrompt = buildFeedbackPrompt(roleFindings);
          await sendCommandToAgent(devAgent.id, feedbackPrompt);
          activeDevRoles.push(targetRole);
          console.log(`[${itemId}] Sent ${roleFindings.length} findings to ${targetRole} agent`);
        } else {
          console.warn(`[${itemId}] No ${targetRole} agent available for feedback`);
        }
      }

      // 2h. Wait for dev agents to complete fixes
      if (activeDevRoles.length > 0) {
        await waitForAgentsToComplete(itemId, activeDevRoles);
      }
    }
  }

  // Phase 3: Signal all agents to exit and create Draft PR
  await signalAllAgentsToExit(itemId);
  await createDraftPr(itemId);
}

export async function startWorkerForRole(
  itemId: string,
  role: AgentRole
): Promise<void> {
  const plan = await getPlan(itemId);
  if (!plan) {
    throw new Error(`No plan found for item ${itemId}`);
  }

  const tasks = plan.tasks.filter((t) => t.agent === role);
  if (tasks.length === 0) {
    throw new Error(`No tasks found for role ${role}`);
  }

  const itemConfig = await getItemConfig(itemId);
  const workspaceDir = resolve(getWorkspaceDir(itemId));

  const agentConfig = itemConfig?.agentConfigs?.find(a => a.role === role);
  const agentWorkdir = agentConfig?.workdir
    ? resolve(join(workspaceDir, agentConfig.workdir))
    : workspaceDir;

  await startWorkerAgentWithSnapshot(itemId, role, tasks, plan, agentWorkdir, workspaceDir);
}

async function startWorkerAgent(
  itemId: string,
  role: AgentRole,
  tasks: PlanTask[],
  plan: Plan,
  workingDir: string  // 追加: agentWorkdir（絶対パス）
): Promise<AgentInfo> {
  const prompt = buildWorkerPrompt(role, tasks, plan);

  return await startAgent({
    itemId,
    role,
    prompt,
    workingDir,
  });
}

// Workers停止時にgit snapshotも停止
export async function stopWorkers(itemId: string): Promise<void> {
  // itemId配下のすべての git snapshot を一括停止
  stopAllGitSnapshots(itemId);
}

function buildWorkerPrompt(
  role: AgentRole,
  tasks: PlanTask[],
  plan: Plan
): string {
  // Use special review prompt for review role
  if (role === 'review') {
    // plan.yaml の review task description も含める
    const taskDescriptions = tasks
      .map((task) => `### Task: ${task.id} - ${task.title}\n${task.description}`)
      .join('\n\n');
    return REVIEW_PROMPT_TEMPLATE + '\n\n## Task-Specific Review Instructions\n\n' + taskDescriptions;
  }

  // Build task list
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

  // Build file list
  const allFiles = tasks.flatMap((t) => t.files || []);
  const filesStr =
    allFiles.length > 0 ? allFiles.join('\n- ') : 'No specific files assigned';

  // Build dependencies summary
  const allDeps = tasks.flatMap((t) => t.dependencies || []);
  const depsStr =
    allDeps.length > 0 ? allDeps.join(', ') : 'No dependencies';

  return WORKER_PROMPT_TEMPLATE
    .replace('{{role}}', role)
    .replace('{{roleDescription}}', ROLE_DESCRIPTIONS[role])
    .replace('{{taskId}}', tasks.map((t) => t.id).join(', '))
    .replace('{{taskTitle}}', tasks.map((t) => t.title).join('; '))
    .replace('{{taskDescription}}', taskList)
    .replace('{{files}}', filesStr)
    .replace('{{dependencies}}', depsStr);
}

export async function getWorkerStatus(
  itemId: string
): Promise<{ role: AgentRole; taskCount: number; status: string }[]> {
  const plan = await getPlan(itemId);
  const agents = await getAgentsByItem(itemId);

  const result: { role: AgentRole; taskCount: number; status: string }[] = [];

  const roles: AgentRole[] = ['front', 'back', 'review'];

  for (const role of roles) {
    const taskCount = plan?.tasks.filter((t) => t.agent === role).length || 0;
    const agent = agents.find((a) => a.role === role);

    result.push({
      role,
      taskCount,
      status: agent?.status || 'not_started',
    });
  }

  return result;
}

// Helper: Wait for a specific agent to reach a certain status
async function waitForAgentStatus(
  itemId: string,
  role: AgentRole,
  targetStatus: AgentStatus
): Promise<AgentInfo | null> {
  return new Promise((resolve) => {
    const checkInterval = setInterval(async () => {
      const agents = await getAgentsByItem(itemId);
      const agent = agents.find(a => a.role === role);

      if (agent && agent.status === targetStatus) {
        clearInterval(checkInterval);
        resolve(agent);
      }
    }, 1000);

    // Timeout after 30 minutes
    setTimeout(() => {
      clearInterval(checkInterval);
      resolve(null);
    }, 30 * 60 * 1000);
  });
}

// Helper: Wait for all agents of specified roles to reach a certain status
async function waitForAllAgentsStatus(
  itemId: string,
  roles: AgentRole[],
  targetStatus: AgentStatus
): Promise<void> {
  const promises = roles.map(role => waitForAgentStatus(itemId, role, targetStatus));
  await Promise.all(promises);
}

// Helper: Get running agent by role
async function getRunningAgentByRole(
  itemId: string,
  targetRole: 'front' | 'back'
): Promise<AgentInfo | null> {
  const agents = await getAgentsByItem(itemId);
  const role: AgentRole = targetRole;
  return agents.find(a => a.role === role && (a.status === 'running' || a.status === 'waiting_orchestrator')) || null;
}

// Helper: Send command to an agent
async function sendCommandToAgent(agentId: string, command: string): Promise<boolean> {
  return sendInput(agentId, command);
}

// Helper: Signal agent to exit
async function signalAgentToExit(agentId: string): Promise<boolean> {
  return sendInput(agentId, '/exit');
}

// Helper: Signal all agents to exit
async function signalAllAgentsToExit(itemId: string): Promise<void> {
  const agents = await getAgentsByItem(itemId);
  const rolesToWaitFor: AgentRole[] = [];

  for (const agent of agents) {
    if (agent.status === 'running' || agent.status === 'waiting_orchestrator') {
      await signalAgentToExit(agent.id);
      rolesToWaitFor.push(agent.role);
    }
  }

  // シグナルを送った全エージェントの完了を待機
  if (rolesToWaitFor.length > 0) {
    await waitForAgentsToComplete(itemId, rolesToWaitFor);
  }
}

// Helper: Extract review findings from workspace
async function extractReviewFindings(itemId: string): Promise<ReviewFindings | null> {
  const workspaceDir = getWorkspaceDir(itemId);
  const findingsPath = join(workspaceDir, 'review_findings.json');

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

// Start review agent (separate from dev agents)
async function startReviewAgent(itemId: string): Promise<AgentInfo | null> {
  const plan = await getPlan(itemId);
  if (!plan) return null;

  const itemConfig = await getItemConfig(itemId);
  const workspaceDir = resolve(getWorkspaceDir(itemId));

  // Create a minimal review task
  const reviewTask: PlanTask = {
    id: 'review-1',
    title: 'Code Review',
    description: 'Review code changes and provide feedback',
    agent: 'review',
  };

  const agentConfig = itemConfig?.agentConfigs?.find(a => a.role === 'review');
  const agentWorkdir = agentConfig?.workdir
    ? resolve(join(workspaceDir, agentConfig.workdir))
    : workspaceDir;

  return startWorkerAgentWithSnapshot(itemId, 'review', [reviewTask], plan, agentWorkdir, workspaceDir);
}

// Run iterative review loop
export async function runIterativeReview(itemId: string): Promise<void> {
  const maxIterations = 3;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    console.log(`Starting review iteration ${iteration + 1}/${maxIterations}`);

    // 1. Review Agent実行
    const reviewAgent = await startReviewAgent(itemId);
    if (!reviewAgent) {
      console.error('Failed to start review agent');
      break;
    }

    // 2. Review Agent が waiting_orchestrator になるまで待機
    await waitForAgentStatus(itemId, 'review', 'waiting_orchestrator');

    // 3. review_findings.json を解析
    const findings = await extractReviewFindings(itemId);
    if (!findings || findings.overallAssessment === 'pass') {
      console.log('Review passed');
      break;
    }

    console.log(`Review found ${findings.findings.length} issues`);

    // 4. 各Dev Agentにフィードバック送信
    const findingsByTarget = new Map<'front' | 'back', ReviewFinding[]>();
    for (const finding of findings.findings) {
      const target = finding.targetAgent;
      const existing = findingsByTarget.get(target) || [];
      existing.push(finding);
      findingsByTarget.set(target, existing);
    }

    for (const [targetRole, roleFindings] of findingsByTarget.entries()) {
      const agent = await getRunningAgentByRole(itemId, targetRole);
      if (agent) {
        const feedbackPrompt = buildFeedbackPrompt(roleFindings);
        await sendCommandToAgent(agent.id, feedbackPrompt);
      }
    }

    // 5. Dev Agent修正完了を待機
    const devRoles: AgentRole[] = ['front', 'back'];
    const activeDevRoles = devRoles.filter(role =>
      findingsByTarget.has(role as 'front' | 'back')
    );
    if (activeDevRoles.length > 0) {
      await waitForAllAgentsStatus(itemId, activeDevRoles, 'waiting_orchestrator');
    }

    // Review agent を終了
    if (reviewAgent) {
      await signalAgentToExit(reviewAgent.id);
      await waitForAgentsToComplete(itemId, ['review']);
    }
  }

  // 6. 全エージェント終了
  await signalAllAgentsToExit(itemId);

  // 7. Draft PR作成（失敗時はエラーを伝播）
  await createDraftPr(itemId);
}
