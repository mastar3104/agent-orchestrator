import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { readFile, mkdir, writeFile } from 'fs/promises';
import { finished } from 'stream/promises';
import { resolve, join } from 'path';
import type {
  Plan,
  PlanTask,
  AgentRole,
  ItemRepositoryConfig,
  StartWorkersMode,
  TaskExecutionStatus,
  TaskProgressPhase,
} from '@agent-orch/shared';

import { executeAgent, getAgentsByItem, stopAgent } from './agent-service';
import { getPlan } from './planner-service';
import { getItemConfig } from './item-service';
import {
  startGitSnapshot,
  stopAllGitSnapshots,
} from './git-snapshot-service';
import { createDraftPrsForAllRepos } from './git-pr-service';
import { getWorkspaceRoot, getRepoWorkspaceDir, getItemEventsPath, getItemPlanPath, getHookLogDir } from '../lib/paths';
import { eventBus } from './event-bus';
import { appendJsonl } from '../lib/jsonl';
import {
  createReviewFindingsExtractedEvent,
  createStatusChangedEvent,
  createHooksExecutedEvent,
  createErrorEvent,
  createTaskStateChangedEvent,
} from '../lib/events';
import type { HookResult } from '@agent-orch/shared';
import {
  type EngineerResponse,
  type ReviewerResponse,
  type ReviewComment,
} from '../lib/claude-schemas';
import { getRole, mergeAllowedTools } from '../lib/role-loader';
import {
  ensureTaskStatesForPlan,
  readRepoTaskState,
  writeRepoTaskState,
  type RepoTaskStateFile,
  type RepoTaskStateTask,
} from './task-state-service';
import { deriveRepoStatuses } from './state-service';
import { resolveHooksMaxAttempts } from '../lib/repository-config';

const MAX_FEEDBACK_ROUNDS = 3;
const MAX_DIFF_LINES = 20000;
const REVIEW_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const ENGINEER_TIMEOUT_MS = 50 * 60 * 1000; // 50 minutes
const AGENT_MAX_RETRIES = 2;
const HOOK_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes per command
const MAX_OUTPUT_LENGTH = 2000;

function getRoleDescription(role: string): string {
  const descriptions: Record<string, string> = {
    planner: 'Planning and architecture',
    review: 'Code review, testing, documentation, integration',
    'review-receiver': 'Receiving and processing PR review comments',
  };
  return descriptions[role] || `${role} development`;
}

// ─── Git helpers ───

async function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => (stdout += d.toString()));
    proc.stderr?.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args[0]} failed: ${stderr}`));
    });
    proc.on('error', reject);
  });
}

async function getGitHead(cwd: string): Promise<string> {
  return execGit(['rev-parse', 'HEAD'], cwd);
}

async function getGitMergeBase(cwd: string, baseBranch: string): Promise<string> {
  return execGit(['merge-base', `origin/${baseBranch}`, 'HEAD'], cwd);
}

async function getGitDiff(cwd: string, base: string, head: string, files?: string[]): Promise<string> {
  const args = ['diff', base, head];
  if (files && files.length > 0) {
    args.push('--');
    args.push(...files);
  }
  const diff = await execGit(args, cwd);
  const lines = diff.split('\n');
  if (lines.length > MAX_DIFF_LINES) {
    return lines.slice(0, MAX_DIFF_LINES).join('\n') + `\n<diff truncated at ${MAX_DIFF_LINES} lines; total ${lines.length} lines>`;
  }
  return diff;
}

async function getGitDiffNameOnly(cwd: string, base: string, head: string): Promise<string[]> {
  const output = await execGit(['diff', '--name-only', base, head], cwd);
  if (!output.trim()) {
    return [];
  }
  return [...new Set(output.trim().split('\n').filter(Boolean))];
}

async function getGitStatusPorcelain(cwd: string): Promise<string> {
  return execGit(['status', '--porcelain'], cwd);
}

async function resetRepoForAttempt(cwd: string, targetRef: string = 'HEAD'): Promise<void> {
  await execGit(['reset', '--hard', targetRef], cwd);
  await execGit(['clean', '-fd'], cwd);
}

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

interface EngineerAttemptResult {
  commitHash: string;
  filesModified: string[];
}

interface RunEngineerAttemptOptions {
  itemId: string;
  repoName: string;
  currentTask: string;
  prompt: string;
  workingDir: string;
  allowedTools: string[];
  jsonSchema: object;
  timeoutMs: number;
}

async function runEngineerAttemptWithCleanup(
  options: RunEngineerAttemptOptions
): Promise<EngineerAttemptResult> {
  const preAttemptHead = await getGitHead(options.workingDir);
  try {
    const { result } = await executeAgent<EngineerResponse>({
      itemId: options.itemId,
      role: 'engineer',
      repoName: options.repoName,
      currentTask: options.currentTask,
      prompt: options.prompt,
      workingDir: options.workingDir,
      allowedTools: options.allowedTools,
      jsonSchema: options.jsonSchema,
      timeoutMs: options.timeoutMs,
    });

    if (result.output.status !== 'success') {
      throw new Error(`[${options.itemId}/${options.repoName}] Engineer reported failure`);
    }

    const commitHash = await getGitHead(options.workingDir);
    if (commitHash === preAttemptHead) {
      throw new Error(`[${options.itemId}/${options.repoName}] Engineer did not create a commit`);
    }

    const porcelain = await getGitStatusPorcelain(options.workingDir);
    if (porcelain.trim()) {
      const summary = porcelain
        .split('\n')
        .filter(Boolean)
        .slice(0, 5)
        .join(', ');
      throw new Error(`[${options.itemId}/${options.repoName}] Engineer left dirty worktree: ${summary}`);
    }

    const filesModified = await getGitDiffNameOnly(options.workingDir, preAttemptHead, commitHash);
    return { commitHash, filesModified };
  } catch (error) {
    try {
      await resetRepoForAttempt(options.workingDir, preAttemptHead);
    } catch (cleanupError) {
      const attemptMessage = error instanceof Error ? error.message : String(error);
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new Error(
        `[${options.itemId}/${options.repoName}] ${attemptMessage}; cleanup to ${preAttemptHead} failed: ${cleanupMessage}`
      );
    }
    throw error;
  }
}

function cloneRepoTaskState(state: RepoTaskStateFile): RepoTaskStateFile {
  return {
    ...state,
    tasks: state.tasks.map((task) => ({ ...task, dependencies: [...task.dependencies], filesModified: task.filesModified ? [...task.filesModified] : undefined })),
  };
}

function mergeFilesModified(...lists: Array<string[] | undefined>): string[] {
  const merged = new Set<string>();
  for (const list of lists) {
    for (const file of list || []) {
      merged.add(file);
    }
  }
  return [...merged];
}

function getRepoTaskEntry(state: RepoTaskStateFile, taskId: string): RepoTaskStateTask {
  const task = state.tasks.find((entry) => entry.id === taskId);
  if (!task) {
    throw new Error(`Task state not found for task ${taskId} in repo ${state.repository}`);
  }
  return task;
}

async function mutateRepoTaskState(
  itemId: string,
  repoName: string,
  mutate: (state: RepoTaskStateFile) => void
): Promise<RepoTaskStateFile> {
  const current = await readRepoTaskState(itemId, repoName);
  if (!current) {
    throw new Error(`Task state not found for repo ${repoName}`);
  }

  const next = cloneRepoTaskState(current);
  mutate(next);
  next.updatedAt = new Date().toISOString();
  await writeRepoTaskState(itemId, next);
  return next;
}

async function mutateVisibleTaskState(
  itemId: string,
  repoName: string,
  taskId: string,
  mutateTask: (task: RepoTaskStateTask) => void
): Promise<RepoTaskStateFile> {
  const current = await readRepoTaskState(itemId, repoName);
  if (!current) {
    throw new Error(`Task state not found for repo ${repoName}`);
  }

  const previousTask = getRepoTaskEntry(current, taskId);
  const next = cloneRepoTaskState(current);
  const task = getRepoTaskEntry(next, taskId);
  mutateTask(task);
  next.updatedAt = new Date().toISOString();
  await writeRepoTaskState(itemId, next);

  if (
    previousTask.status !== task.status ||
    previousTask.currentPhase !== task.currentPhase
  ) {
    eventBus.publish(
      itemId,
      createTaskStateChangedEvent(itemId, repoName, task.id, task.status, task.currentPhase)
    );
  }

  return next;
}

async function normalizeStaleInProgressTasks(itemId: string, repoName: string): Promise<RepoTaskStateFile> {
  return mutateRepoTaskState(itemId, repoName, (state) => {
    for (const task of state.tasks) {
      if (task.status === 'in_progress') {
        task.status = 'failed';
        task.currentPhase = task.currentPhase || 'engineer';
        task.lastError = task.lastError || 'Interrupted before completion';
      }
    }
  });
}

function areRepoTasksCompleted(state: RepoTaskStateFile): boolean {
  return state.tasks.every((task) => task.status === 'completed');
}

function buildTaskStateIndex(statesByRepo: Map<string, RepoTaskStateFile>): Map<string, RepoTaskStateTask> {
  const index = new Map<string, RepoTaskStateTask>();
  for (const state of statesByRepo.values()) {
    for (const task of state.tasks) {
      index.set(task.id, task);
    }
  }
  return index;
}

function buildPlanTaskIndex(plan: Plan): Map<string, PlanTask> {
  return new Map(plan.tasks.map((task) => [task.id, task]));
}

function isHooksFailedTask(taskState: RepoTaskStateTask | undefined): boolean {
  return taskState?.status === 'failed' && taskState.currentPhase === 'hooks';
}

function areDependenciesCompleted(
  task: PlanTask,
  taskStateIndex: Map<string, RepoTaskStateTask>
): boolean {
  const dependencies = task.dependencies || [];
  return dependencies.every((dependencyId) => taskStateIndex.get(dependencyId)?.status === 'completed');
}

function selectInReviewTask(
  plan: Plan,
  statesByRepo: Map<string, RepoTaskStateFile>,
  targetRepos?: string[]
): PlanTask | null {
  for (const task of plan.tasks) {
    if (targetRepos && !targetRepos.includes(task.repository)) {
      continue;
    }

    const repoState = statesByRepo.get(task.repository);
    if (!repoState) {
      continue;
    }

    const taskState = repoState.tasks.find((entry) => entry.id === task.id);
    if (taskState?.status === 'in_review') {
      return task;
    }
  }

  return null;
}

function selectNextRunnableTask(
  plan: Plan,
  statesByRepo: Map<string, RepoTaskStateFile>,
  targetRepos?: string[]
): PlanTask | null {
  const taskStateIndex = buildTaskStateIndex(statesByRepo);
  for (const task of plan.tasks) {
    if (targetRepos && !targetRepos.includes(task.repository)) {
      continue;
    }

    const repoState = statesByRepo.get(task.repository);
    if (!repoState) {
      continue;
    }

    const taskState = repoState.tasks.find((entry) => entry.id === task.id);
    if (!taskState) {
      continue;
    }

    if (
      taskState.status === 'completed' ||
      taskState.status === 'failed' ||
      taskState.status === 'in_progress' ||
      taskState.status === 'in_review'
    ) {
      continue;
    }

    if (!areDependenciesCompleted(task, taskStateIndex)) {
      continue;
    }

    return task;
  }

  return null;
}

function selectNextFailedTask(
  plan: Plan,
  statesByRepo: Map<string, RepoTaskStateFile>,
  targetRepos?: string[]
): PlanTask | null {
  const taskStateIndex = buildTaskStateIndex(statesByRepo);
  for (const task of plan.tasks) {
    if (targetRepos && !targetRepos.includes(task.repository)) {
      continue;
    }

    const repoState = statesByRepo.get(task.repository);
    if (!repoState) {
      continue;
    }

    const taskState = repoState.tasks.find((entry) => entry.id === task.id);
    if (taskState?.status !== 'failed') {
      continue;
    }

    if (!areDependenciesCompleted(task, taskStateIndex)) {
      continue;
    }

    return task;
  }

  return null;
}

function isPendingTaskBlockedByHookFailures(
  task: PlanTask,
  planTaskIndex: Map<string, PlanTask>,
  taskStateIndex: Map<string, RepoTaskStateTask>,
  visiting: Set<string> = new Set()
): boolean {
  const taskState = taskStateIndex.get(task.id);
  if (taskState?.status !== 'pending') {
    return false;
  }

  const dependencies = task.dependencies || [];
  if (dependencies.length === 0 || visiting.has(task.id)) {
    return false;
  }

  visiting.add(task.id);
  let hasBlockingDependency = false;

  for (const dependencyId of dependencies) {
    const dependencyState = taskStateIndex.get(dependencyId);
    if (!dependencyState) {
      visiting.delete(task.id);
      return false;
    }

    if (dependencyState.status === 'completed') {
      continue;
    }

    if (isHooksFailedTask(dependencyState)) {
      hasBlockingDependency = true;
      continue;
    }

    if (dependencyState.status === 'pending') {
      const dependencyTask = planTaskIndex.get(dependencyId);
      if (
        dependencyTask &&
        isPendingTaskBlockedByHookFailures(dependencyTask, planTaskIndex, taskStateIndex, visiting)
      ) {
        hasBlockingDependency = true;
        continue;
      }
    }

    visiting.delete(task.id);
    return false;
  }

  visiting.delete(task.id);
  return hasBlockingDependency;
}

function canIgnoreRemainingTasksAfterHookFailures(
  plan: Plan,
  statesByRepo: Map<string, RepoTaskStateFile>,
  remainingTasks: PlanTask[]
): boolean {
  const taskStateIndex = buildTaskStateIndex(statesByRepo);
  const planTaskIndex = buildPlanTaskIndex(plan);

  return remainingTasks.every((task) => {
    const taskState = taskStateIndex.get(task.id);
    return (
      isHooksFailedTask(taskState) ||
      isPendingTaskBlockedByHookFailures(task, planTaskIndex, taskStateIndex)
    );
  });
}

async function markTaskInProgress(
  itemId: string,
  repoName: string,
  taskId: string,
  phaseBase: string
): Promise<RepoTaskStateFile> {
  return mutateVisibleTaskState(itemId, repoName, taskId, (task) => {
    task.status = 'in_progress';
    task.currentPhase = 'engineer';
    task.attempts += 1;
    task.phaseBase = phaseBase;
    task.reviewRounds = 0;
    task.lastStartedAt = new Date().toISOString();
    task.completedAt = undefined;
    task.lastError = undefined;
    task.commitHash = undefined;
    task.filesModified = undefined;
  });
}

async function markTaskInReview(
  itemId: string,
  repoName: string,
  taskId: string,
  currentPhase: TaskProgressPhase,
  filesModified?: string[]
): Promise<RepoTaskStateFile> {
  return mutateVisibleTaskState(itemId, repoName, taskId, (task) => {
    task.status = 'in_review';
    task.currentPhase = currentPhase;
    task.lastError = undefined;
    task.filesModified = mergeFilesModified(task.filesModified, filesModified);
  });
}

async function markTaskCompleted(
  itemId: string,
  repoName: string,
  taskId: string,
  commitHash: string
): Promise<RepoTaskStateFile> {
  return mutateVisibleTaskState(itemId, repoName, taskId, (task) => {
    task.status = 'completed';
    task.currentPhase = undefined;
    task.completedAt = new Date().toISOString();
    task.lastError = undefined;
    task.commitHash = commitHash;
  });
}

async function mergeTaskFilesModified(
  itemId: string,
  repoName: string,
  taskId: string,
  filesModified: string[]
): Promise<RepoTaskStateFile> {
  return mutateRepoTaskState(itemId, repoName, (state) => {
    const task = getRepoTaskEntry(state, taskId);
    task.filesModified = mergeFilesModified(task.filesModified, filesModified);
  });
}

async function incrementTaskReviewRounds(
  itemId: string,
  repoName: string,
  taskId: string
): Promise<RepoTaskStateFile> {
  return mutateRepoTaskState(itemId, repoName, (state) => {
    const task = getRepoTaskEntry(state, taskId);
    task.reviewRounds = (task.reviewRounds || 0) + 1;
  });
}

async function markTaskFailed(
  itemId: string,
  repoName: string,
  taskId: string,
  errorMessage: string,
  currentPhase?: TaskProgressPhase
): Promise<RepoTaskStateFile> {
  return mutateVisibleTaskState(itemId, repoName, taskId, (task) => {
    task.status = 'failed';
    task.currentPhase = currentPhase ?? task.currentPhase;
    task.lastError = errorMessage;
  });
}

// ─── Hooks execution ───

function truncateOutput(output: string, maxLength: number = MAX_OUTPUT_LENGTH): string {
  if (output.length <= maxLength) return output;
  return output.slice(0, maxLength) + '...(truncated)';
}

async function runHooks(
  commands: string[],
  cwd: string,
  logDir: string,
  attempt: number,
  timeoutMs: number = HOOK_TIMEOUT_MS
): Promise<HookResult[]> {
  const attemptDir = join(logDir, `attempt-${attempt}`);
  await mkdir(attemptDir, { recursive: true });
  const results: HookResult[] = [];

  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    const stdoutPath = join(attemptDir, `hook-${i}.stdout.log`);
    const stderrPath = join(attemptDir, `hook-${i}.stderr.log`);
    const startTime = Date.now();

    try {
      const result = await new Promise<HookResult>((resolve) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const stdoutStream = createWriteStream(stdoutPath);
        const stderrStream = createWriteStream(stderrPath);

        let stdoutBuf = '';
        let stderrBuf = '';

        const proc = spawn('sh', ['-c', command], {
          cwd,
          stdio: 'pipe',
          signal: controller.signal,
        });

        proc.stdout?.on('data', (d: Buffer) => {
          const chunk = d.toString();
          if (stdoutBuf.length < MAX_OUTPUT_LENGTH) stdoutBuf += chunk;
        });
        proc.stderr?.on('data', (d: Buffer) => {
          const chunk = d.toString();
          if (stderrBuf.length < MAX_OUTPUT_LENGTH) stderrBuf += chunk;
        });

        proc.stdout?.pipe(stdoutStream);
        proc.stderr?.pipe(stderrStream);

        proc.on('close', async (code, signal) => {
          clearTimeout(timer);
          stdoutStream.end();
          stderrStream.end();
          try {
            await Promise.all([finished(stdoutStream), finished(stderrStream)]);
          } catch {
            // Log write failure is not fatal
          }
          resolve({
            command,
            exitCode: code,
            stdout: truncateOutput(stdoutBuf),
            stderr: truncateOutput(stderrBuf),
            stdoutLogPath: stdoutPath,
            stderrLogPath: stderrPath,
            durationMs: Date.now() - startTime,
            timedOut: false,
            signal: signal || undefined,
          });
        });

        proc.on('error', async (err) => {
          clearTimeout(timer);
          stdoutStream.end();
          stderrStream.end();
          try {
            await Promise.all([finished(stdoutStream), finished(stderrStream)]);
          } catch {
            // Log write failure is not fatal
          }
          const isAbort = err.name === 'AbortError' || (err as any).code === 'ABORT_ERR';
          if (isAbort) {
            await writeFile(stderrPath, `Timed out after ${timeoutMs}ms`).catch(() => {});
          }
          resolve({
            command,
            exitCode: null,
            stdout: truncateOutput(stdoutBuf),
            stderr: truncateOutput(isAbort ? `Timed out after ${timeoutMs}ms` : err.message),
            stdoutLogPath: stdoutPath,
            stderrLogPath: stderrPath,
            durationMs: Date.now() - startTime,
            timedOut: isAbort,
            signal: isAbort ? 'SIGTERM' : undefined,
          });
        });
      });

      results.push(result);
    } catch (err) {
      await writeFile(stderrPath, err instanceof Error ? err.message : String(err)).catch(() => {});
      results.push({
        command,
        exitCode: null,
        stdout: '',
        stderr: truncateOutput(err instanceof Error ? err.message : String(err)),
        stdoutLogPath: stdoutPath,
        stderrLogPath: stderrPath,
        durationMs: Date.now() - startTime,
        timedOut: false,
      });
    }
  }

  return results;
}

function buildHooksFixPrompt(hookResults: HookResult[]): string {
  const failedHooks = hookResults
    .map((r) => {
      if (r.exitCode === 0) return null;
      const parts = [`Command: ${r.command}`, `Exit code: ${r.exitCode}`];
      if (r.timedOut) parts.push('(TIMED OUT)');
      if (r.stderrLogPath) parts.push(`Stderr log: ${r.stderrLogPath}`);
      if (r.stdoutLogPath) parts.push(`Stdout log: ${r.stdoutLogPath}`);
      return parts.join('\n');
    })
    .filter(Boolean)
    .join('\n\n---\n\n');

  return `## Hook Validation Failures
The following validation commands failed after your implementation.
Read the log files to identify the root cause, then fix the issues.

${failedHooks}

## Instructions
1. Read the log files above to understand what failed
2. Fix all issues

Please fix all issues, commit your intentional changes, and return status.
Before returning, stage your intentional fixes with \`git add -A -- <paths>\`, create a commit with \`git commit -m "<message>"\`, and ensure \`git status --porcelain\` is empty.
Return {"status": "success"} when done.
If you encounter an error, return {"status": "failure"}.`;
}

async function finalizeCompletedRepo(itemId: string, repoName: string): Promise<void> {
  await createDraftPrsForAllRepos(itemId, new Set([repoName]));
}

async function failTaskWithError(
  itemId: string,
  repoName: string,
  taskId: string,
  phase: 'engineer' | 'hooks' | 'review',
  message: string
): Promise<{ state: RepoTaskStateFile; errorMessage: string }> {
  const failedState = await markTaskFailed(itemId, repoName, taskId, message, phase);
  const errorEvent = createErrorEvent(itemId, message, { repoName, phase });
  await appendJsonl(getItemEventsPath(itemId), errorEvent);
  eventBus.publish(itemId, errorEvent);
  return { state: failedState, errorMessage: errorEvent.message };
}

async function runTaskHooksPhase(
  itemId: string,
  repo: ItemRepositoryConfig,
  task: PlanTask,
  agentWorkdir: string,
  effectiveTools: string[],
  reviewRound: number
): Promise<RepoTaskStateFile> {
  const hooks = repo.hooks;
  if (!hooks || hooks.length === 0) {
    const currentState = await readRepoTaskState(itemId, repo.name);
    if (!currentState) {
      throw new Error(`Task state missing for repo ${repo.name}`);
    }
    return currentState;
  }

  const engineerRole = getRole('engineer');
  const hookLogDir = join(getHookLogDir(itemId, repo.name), task.id, `review-round-${reviewRound + 1}`);
  let latestState = await readRepoTaskState(itemId, repo.name);
  if (!latestState) {
    throw new Error(`Task state missing for repo ${repo.name}`);
  }

  const hooksMaxAttempts = resolveHooksMaxAttempts(repo.hooksMaxAttempts);

  for (let hookAttempt = 1; hookAttempt <= hooksMaxAttempts; hookAttempt++) {
    console.log(
      `[${itemId}/${repo.name}] Running hooks for ${task.id} (attempt ${hookAttempt}/${hooksMaxAttempts})`
    );
    const hookResults = await runHooks(hooks, agentWorkdir, hookLogDir, hookAttempt);
    const allPassed = hookResults.every((result) => result.exitCode === 0);

    const hooksEvent = createHooksExecutedEvent(itemId, repo.name, hookResults, allPassed, hookAttempt);
    await appendJsonl(getItemEventsPath(itemId), hooksEvent);
    eventBus.publish(itemId, hooksEvent);

    if (allPassed) {
      return latestState;
    }

    if (hookAttempt < hooksMaxAttempts) {
      const fixPrompt = buildHooksFixPrompt(hookResults);
      try {
        const committed = await runEngineerAttemptWithCleanup({
          itemId,
          repoName: repo.name,
          currentTask: `${task.id}: hooks-fix`,
          prompt: fixPrompt,
          workingDir: agentWorkdir,
          allowedTools: effectiveTools,
          jsonSchema: engineerRole.jsonSchema,
          timeoutMs: ENGINEER_TIMEOUT_MS,
        });
        latestState = await mergeTaskFilesModified(
          itemId,
          repo.name,
          task.id,
          committed.filesModified
        );
      } catch (fixError) {
        const fixMsg = fixError instanceof Error ? fixError.message : String(fixError);
        console.error(`[${itemId}/${repo.name}] Hooks fix engineer failed for ${task.id}: ${fixMsg}`);
      }
    }
  }

  throw new Error(
    `Hooks validation failed for ${repo.name} during task ${task.id} after ${hooksMaxAttempts} attempts`
  );
}

async function runTaskReviewPhase(
  itemId: string,
  plan: Plan,
  repo: ItemRepositoryConfig,
  task: PlanTask,
  agentWorkdir: string
): Promise<{ state: RepoTaskStateFile; errorMessage?: string; shouldAbortRun?: boolean }> {
  const reviewerRole = getRole('reviewer');
  const engineerRole = getRole('engineer');
  const effectiveTools = mergeAllowedTools(engineerRole.allowedTools, repo.allowedTools);

  let currentState = await readRepoTaskState(itemId, repo.name);
  if (!currentState) {
    throw new Error(`Task state missing for repo ${repo.name}`);
  }

  while (true) {
    const currentTaskState = getRepoTaskEntry(currentState, task.id);
    if (!currentTaskState.phaseBase) {
      return failTaskWithError(
        itemId,
        repo.name,
        task.id,
        'review',
        `Task ${task.id} is missing phaseBase for review resume in ${repo.name}`
      );
    }

    try {
      currentState = await runTaskHooksPhase(
        itemId,
        repo,
        task,
        agentWorkdir,
        effectiveTools,
        currentTaskState.reviewRounds || 0
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = await failTaskWithError(itemId, repo.name, task.id, 'hooks', message);
      return { state: failure.state, errorMessage: failure.errorMessage, shouldAbortRun: false };
    }

    currentState = await markTaskInReview(itemId, repo.name, task.id, 'review');

    const taskStateAfterHooks = getRepoTaskEntry(currentState, task.id);
    const phaseBase = taskStateAfterHooks.phaseBase!;
    const currentHead = await getGitHead(agentWorkdir);

    const reviewContext = await buildReviewContext(
      itemId,
      repo.name,
      agentWorkdir,
      phaseBase,
      currentHead,
      task
    );
    const reviewPrompt = `${reviewerRole.promptTemplate}\n\n${reviewContext}`;

    let reviewResponse: ReviewerResponse | null = null;
    let reviewError = 'Reviewer failed';
    for (let attempt = 0; attempt <= AGENT_MAX_RETRIES; attempt++) {
      try {
        const { result: reviewResult } = await executeAgent<ReviewerResponse>({
          itemId,
          role: 'review',
          repoName: repo.name,
          currentTask: `${task.id}: review`,
          prompt: reviewPrompt,
          workingDir: agentWorkdir,
          allowedTools: reviewerRole.allowedTools,
          jsonSchema: reviewerRole.jsonSchema,
          timeoutMs: REVIEW_TIMEOUT_MS,
        });
        reviewResponse = reviewResult.output;
        break;
      } catch (error) {
        reviewError = error instanceof Error ? error.message : String(error);
        if (attempt < AGENT_MAX_RETRIES) {
          console.warn(
            `[${itemId}/${repo.name}] Review attempt ${attempt + 1} failed for ${task.id}: ${reviewError}, retrying...`
          );
          continue;
        }
      }
    }

    if (!reviewResponse) {
      const failure = await failTaskWithError(
        itemId,
        repo.name,
        task.id,
        'review',
        `Review failed for ${repo.name} during task ${task.id}: ${reviewError}`
      );
      return { state: failure.state, errorMessage: failure.errorMessage, shouldAbortRun: true };
    }

    const comments = reviewResponse.comments ?? [];
    const findings = comments.map((comment) => ({
      severity: (comment.severity || 'minor') as 'critical' | 'major' | 'minor',
      file: comment.file,
      line: comment.line,
      description: comment.comment,
      suggestedFix: comment.suggestedFix || '',
      targetAgent: repo.name,
    }));

    const findingsEvent = createReviewFindingsExtractedEvent(
      itemId,
      `review-${repo.name}-${task.id}-cycle${(taskStateAfterHooks.reviewRounds || 0) + 1}`,
      repo.name,
      findings,
      reviewResponse.review_status === 'approve' ? 'pass' : 'needs_fixes',
      reviewResponse.review_status === 'approve'
        ? `Code review passed for ${task.id}`
        : `${comments.length} issues found for ${task.id}`
    );
    await appendJsonl(getItemEventsPath(itemId), findingsEvent);
    eventBus.publish(itemId, findingsEvent);

    if (reviewResponse.review_status === 'approve') {
      currentState = await markTaskCompleted(itemId, repo.name, task.id, currentHead);
      return { state: currentState };
    }

    const completedFeedbackRounds = taskStateAfterHooks.reviewRounds || 0;
    if (completedFeedbackRounds >= MAX_FEEDBACK_ROUNDS) {
      const failure = await failTaskWithError(
        itemId,
        repo.name,
        task.id,
        'review',
        `Review feedback rounds exhausted for ${repo.name} during task ${task.id} after ${MAX_FEEDBACK_ROUNDS} rounds`
      );
      return { state: failure.state, errorMessage: failure.errorMessage, shouldAbortRun: true };
    }

    let feedbackDiff: string;
    try {
      const commentFiles = comments.map((comment) => comment.file).filter(Boolean);
      feedbackDiff = await getGitDiff(
        agentWorkdir,
        phaseBase,
        currentHead,
        commentFiles.length > 0 ? commentFiles : undefined
      );
    } catch {
      feedbackDiff = '<unable to generate diff>';
    }

    const feedbackPrompt = buildFeedbackPrompt(plan, repo, comments, feedbackDiff, [task]);

    let feedbackError = 'Feedback engineer failed';
    let feedbackSucceeded = false;
    for (let feedbackAttempt = 0; feedbackAttempt <= AGENT_MAX_RETRIES; feedbackAttempt++) {
      try {
        const committed = await runEngineerAttemptWithCleanup({
          itemId,
          repoName: repo.name,
          currentTask: `${task.id}: review-fix`,
          prompt: feedbackPrompt,
          workingDir: agentWorkdir,
          allowedTools: effectiveTools,
          jsonSchema: engineerRole.jsonSchema,
          timeoutMs: ENGINEER_TIMEOUT_MS,
        });
        currentState = await mergeTaskFilesModified(
          itemId,
          repo.name,
          task.id,
          committed.filesModified
        );
        currentState = await incrementTaskReviewRounds(itemId, repo.name, task.id);
        feedbackSucceeded = true;
        break;
      } catch (error) {
        feedbackError = error instanceof Error ? error.message : String(error);
        if (feedbackAttempt < AGENT_MAX_RETRIES) {
          console.warn(
            `[${itemId}/${repo.name}] Review-fix attempt ${feedbackAttempt + 1} failed for ${task.id}: ${feedbackError}, retrying...`
          );
          continue;
        }
      }
    }

    if (!feedbackSucceeded) {
      const failure = await failTaskWithError(
        itemId,
        repo.name,
        task.id,
        'review',
        `Review feedback handling failed for ${repo.name} during task ${task.id}: ${feedbackError}`
      );
      return { state: failure.state, errorMessage: failure.errorMessage, shouldAbortRun: true };
    }
  }
}

// ─── Main orchestration ───

interface StartWorkersOptions {
  targetRepos?: string[];
  mode?: StartWorkersMode;
}

export async function startWorkers(itemId: string, options: StartWorkersOptions = {}): Promise<void> {
  const plan = await getPlan(itemId);
  if (!plan) {
    throw new Error(`No plan found for item ${itemId}`);
  }

  const itemConfig = await getItemConfig(itemId);
  if (!itemConfig) {
    throw new Error(`Item config not found for ${itemId}`);
  }

  const targetRepos = options.targetRepos;
  const mode = options.mode || 'all';

  const workspaceRoot = resolve(getWorkspaceRoot(itemId));

  await startGitSnapshot(itemId, workspaceRoot);
  const tasksByRepo = new Map<string, PlanTask[]>();
  for (const task of plan.tasks) {
    const tasks = tasksByRepo.get(task.repository) || [];
    tasks.push(task);
    tasksByRepo.set(task.repository, tasks);
  }

  await ensureTaskStatesForPlan(itemId, plan);

  const statesByRepo = new Map<string, RepoTaskStateFile>();
  for (const repo of itemConfig.repositories) {
    if (targetRepos && !targetRepos.includes(repo.name)) {
      continue;
    }
    if (!tasksByRepo.has(repo.name)) {
      continue;
    }
    const normalizedState = await normalizeStaleInProgressTasks(itemId, repo.name);
    statesByRepo.set(repo.name, normalizedState);
  }

  const repoStatuses = await deriveRepoStatuses(itemId);
  const finalizedRepos = new Set(
    [...repoStatuses.entries()]
      .filter(([, state]) => state.inCurrentPlan && state.status === 'completed')
      .map(([repoName]) => repoName)
  );

  const tryFinalizeCompletedRepos = async (): Promise<void> => {
    for (const repo of itemConfig.repositories) {
      if (targetRepos && !targetRepos.includes(repo.name)) {
        continue;
      }
      if (finalizedRepos.has(repo.name)) {
        continue;
      }
      const repoTasks = tasksByRepo.get(repo.name);
      const repoState = statesByRepo.get(repo.name);
      if (!repoTasks || !repoState || !areRepoTasksCompleted(repoState)) {
        continue;
      }
      await finalizeCompletedRepo(itemId, repo.name);
      finalizedRepos.add(repo.name);
    }
  };

  await tryFinalizeCompletedRepos();

  let failedTaskMessage: string | null = null;
  while (true) {
    const reviewTask = mode === 'all' ? selectInReviewTask(plan, statesByRepo, targetRepos) : null;
    const nextTask = reviewTask || (
      mode === 'retry_failed'
        ? selectNextFailedTask(plan, statesByRepo, targetRepos)
        : selectNextRunnableTask(plan, statesByRepo, targetRepos)
    );
    if (!nextTask) {
      break;
    }

    const repo = itemConfig.repositories.find((candidate) => candidate.name === nextTask.repository);
    if (!repo) {
      throw new Error(`Repository config not found for ${nextTask.repository}`);
    }

    const repoTasks = tasksByRepo.get(repo.name) || [];
    const taskIndex = repoTasks.findIndex((task) => task.id === nextTask.id);
    const agentWorkdir = resolve(getRepoWorkspaceDir(itemId, repo.name));
    validateAgentWorkdir(agentWorkdir, workspaceRoot);
    await startGitSnapshot(itemId, agentWorkdir);

    const engineerRole = getRole('engineer');
    const effectiveTools = mergeAllowedTools(engineerRole.allowedTools, repo.allowedTools);
    if (!reviewTask) {
      console.log(
        `[${itemId}/${repo.name}] Starting task ${taskIndex + 1}/${repoTasks.length}: ${nextTask.id} - ${nextTask.title}`
      );
      await resetRepoForAttempt(agentWorkdir);
      const phaseBase = await getGitHead(agentWorkdir);
      const inProgressState = await markTaskInProgress(itemId, repo.name, nextTask.id, phaseBase);
      statesByRepo.set(repo.name, inProgressState);

      const prompt = `${engineerRole.promptTemplate}\n\n${buildWorkerContext('engineer', repo.name, [nextTask], plan)}`;

      let taskSucceeded = false;
      let lastError = 'Engineer failed';
      for (let attempt = 0; attempt <= AGENT_MAX_RETRIES; attempt++) {
        try {
          const committed = await runEngineerAttemptWithCleanup({
            itemId,
            repoName: repo.name,
            currentTask: `${nextTask.id}: ${nextTask.title}`,
            prompt,
            workingDir: agentWorkdir,
            allowedTools: effectiveTools,
            jsonSchema: engineerRole.jsonSchema,
            timeoutMs: ENGINEER_TIMEOUT_MS,
          });

          const inReviewState = await markTaskInReview(
            itemId,
            repo.name,
            nextTask.id,
            'hooks',
            committed.filesModified
          );
          statesByRepo.set(repo.name, inReviewState);
          taskSucceeded = true;
          break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          if (attempt < AGENT_MAX_RETRIES) {
            console.warn(
              `[${itemId}/${repo.name}] Task ${nextTask.id} attempt ${attempt + 1} failed: ${lastError}, retrying...`
            );
            continue;
          }
        }
      }

      if (!taskSucceeded) {
        const failure = await failTaskWithError(
          itemId,
          repo.name,
          nextTask.id,
          'engineer',
          `Task ${nextTask.id} failed for ${repo.name}: ${lastError}`
        );
        statesByRepo.set(repo.name, failure.state);
        failedTaskMessage = failure.errorMessage;
        break;
      }
    } else {
      console.log(
        `[${itemId}/${repo.name}] Resuming review for task ${nextTask.id} (${taskIndex + 1}/${repoTasks.length})`
      );
    }

    const reviewResult = await runTaskReviewPhase(itemId, plan, repo, nextTask, agentWorkdir);
    statesByRepo.set(repo.name, reviewResult.state);
    if (reviewResult.errorMessage) {
      if (reviewResult.shouldAbortRun === false) {
        continue;
      }
      failedTaskMessage = reviewResult.errorMessage;
      break;
    }

    const repoState = statesByRepo.get(repo.name);
    if (repoState && areRepoTasksCompleted(repoState) && !finalizedRepos.has(repo.name)) {
      await finalizeCompletedRepo(itemId, repo.name);
      finalizedRepos.add(repo.name);
    }
  }

  if (failedTaskMessage) {
    throw new Error(failedTaskMessage);
  }

  await tryFinalizeCompletedRepos();

  if (mode === 'retry_failed') {
    const remainingFailedTasks = plan.tasks.filter((task) => {
      if (targetRepos && !targetRepos.includes(task.repository)) {
        return false;
      }
      const repoState = statesByRepo.get(task.repository);
      return repoState ? getRepoTaskEntry(repoState, task.id).status === 'failed' : false;
    });

    if (remainingFailedTasks.length > 0) {
      throw new Error(
        `No retryable failed tasks remain for item ${itemId}: ${remainingFailedTasks.map((task) => task.id).join(', ')}`
      );
    }

    return;
  }

  const remainingTasks = plan.tasks.filter((task) => {
    if (targetRepos && !targetRepos.includes(task.repository)) {
      return false;
    }
    const repoState = statesByRepo.get(task.repository);
    return repoState ? getRepoTaskEntry(repoState, task.id).status !== 'completed' : false;
  });

  if (remainingTasks.length > 0) {
    if (canIgnoreRemainingTasksAfterHookFailures(plan, statesByRepo, remainingTasks)) {
      return;
    }
    throw new Error(
      `No runnable tasks remain for item ${itemId}: ${remainingTasks.map((task) => task.id).join(', ')}`
    );
  }
}

function buildWorkerContext(
  role: AgentRole,
  repoName: string,
  tasks: PlanTask[],
  plan: Plan
): string {
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

  return `## Your Role: ${getRoleDescription(role)}

## Project Context

**Repository:** ${repoName}
**Task ID:** ${tasks.map((t) => t.id).join(', ')}
**Task Title:** ${tasks.map((t) => t.title).join('; ')}

**Task Description:**
${taskList}

**Files to work on:**
${filesStr}

**Dependencies:**
${depsStr}`;
}

const MAX_FILE_LINES = 500;
const MAX_FILE_CHARS = 50000;
const MAX_TOTAL_LINES = 20000;
const MAX_TOTAL_CHARS = 500000;

interface ChangedFileInfo {
  status: string; // A, M, D, R, C, T, etc.
  path: string;
  oldPath?: string; // for renames
}

async function getChangedFiles(cwd: string, base: string, head: string): Promise<ChangedFileInfo[]> {
  const output = await execGit(['diff', '--name-status', base, head], cwd);
  if (!output.trim()) return [];

  return output.trim().split('\n').map(line => {
    const parts = line.split('\t');
    const statusCode = parts[0][0]; // First char (R100 -> R)
    if (statusCode === 'R' || statusCode === 'C') {
      return { status: statusCode, oldPath: parts[1], path: parts[2] };
    }
    return { status: statusCode, path: parts[1] };
  });
}

async function getBinaryFiles(cwd: string, base: string, head: string): Promise<Set<string>> {
  const output = await execGit(['diff', '--numstat', base, head], cwd);
  const binaries = new Set<string>();
  if (!output.trim()) return binaries;

  for (const line of output.trim().split('\n')) {
    if (line.startsWith('-\t-\t')) {
      const filePath = line.split('\t')[2];
      if (filePath) binaries.add(filePath);
    }
  }
  return binaries;
}

async function readFileAtCommit(
  cwd: string, commitHash: string, filePath: string
): Promise<{ content: string; lines: number; truncated: boolean }> {
  try {
    const raw = await execGit(['show', `${commitHash}:${filePath}`], cwd);
    const lines = raw.split('\n');
    let content = raw;
    let truncated = false;

    if (lines.length > MAX_FILE_LINES) {
      content = lines.slice(0, MAX_FILE_LINES).join('\n');
      truncated = true;
    }
    if (content.length > MAX_FILE_CHARS) {
      content = content.slice(0, MAX_FILE_CHARS);
      truncated = true;
    }

    return { content, lines: Math.min(lines.length, MAX_FILE_LINES), truncated };
  } catch {
    return { content: '<unable to read file>', lines: 1, truncated: false };
  }
}

async function getFileSizeAtCommit(cwd: string, commitHash: string, filePath: string): Promise<number> {
  try {
    const output = await execGit(['cat-file', '-s', `${commitHash}:${filePath}`], cwd);
    return parseInt(output, 10) || 0;
  } catch {
    return 0;
  }
}

async function buildReviewContext(
  itemId: string,
  repoName: string,
  agentWorkdir: string,
  phaseBase: string,
  currentHead: string,
  reviewTask: PlanTask
): Promise<string> {
  const taskDescriptions = `### Task: ${reviewTask.id} - ${reviewTask.title}
${reviewTask.description}`;

  // Read plan.yaml
  let planContent = '';
  try {
    planContent = await readFile(getItemPlanPath(itemId), 'utf-8');
  } catch {
    planContent = '<unable to read plan>';
  }

  // Get changed files info
  let changedFiles: ChangedFileInfo[] = [];
  let binaryFiles = new Set<string>();
  try {
    changedFiles = await getChangedFiles(agentWorkdir, phaseBase, currentHead);
    binaryFiles = await getBinaryFiles(agentWorkdir, phaseBase, currentHead);
  } catch {
    // Fallback: return minimal context
    return `## Repository: ${repoName}

## Plan
\`\`\`yaml
${planContent}
\`\`\`

## Changed Files
<unable to determine changed files>

## Implemented Tasks

${taskDescriptions}`;
  }

  // Build file contents section
  const fileSections: string[] = [];
  let totalLines = 0;
  let totalChars = 0;
  const skippedFiles: string[] = [];

  for (const file of changedFiles) {
    if (totalLines >= MAX_TOTAL_LINES || totalChars >= MAX_TOTAL_CHARS) {
      skippedFiles.push(file.path);
      continue;
    }

    const isBinary = binaryFiles.has(file.path);

    if (file.status === 'D') {
      fileSections.push(`### [DELETED] ${file.path}`);
      totalLines += 1;
      continue;
    }

    if (isBinary) {
      const size = await getFileSizeAtCommit(agentWorkdir, currentHead, file.path);
      const sizeStr = size > 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`;
      fileSections.push(`### [BINARY] ${file.path} (${sizeStr})`);
      totalLines += 1;
      continue;
    }

    // A, M, R, C, T and other statuses: read the file content from the commit
    const statusLabel = file.status === 'A' ? 'ADDED' : file.status === 'M' ? 'MODIFIED' : file.status === 'R' ? `RENAMED from ${file.oldPath}` : 'CHANGED';
    const { content, lines, truncated } = await readFileAtCommit(agentWorkdir, currentHead, file.path);

    if (totalLines + lines > MAX_TOTAL_LINES || totalChars + content.length > MAX_TOTAL_CHARS) {
      skippedFiles.push(file.path);
      continue;
    }

    const truncNote = truncated ? ' (truncated)' : '';
    fileSections.push(`### [${statusLabel}] ${file.path}${truncNote}
\`\`\`
${content}
\`\`\``);
    totalLines += lines;
    totalChars += content.length;
  }

  const skippedSection = skippedFiles.length > 0
    ? `\n### Remaining files (content omitted due to size limits)\n${skippedFiles.map(f => `- ${f}`).join('\n')}`
    : '';

  return `## Repository: ${repoName}

## Plan
\`\`\`yaml
${planContent}
\`\`\`

## Changed Files

${fileSections.join('\n\n')}
${skippedSection}

## Implemented Tasks

${taskDescriptions}`;
}

function buildFeedbackPrompt(
  _plan: Plan,
  repo: ItemRepositoryConfig,
  comments: ReviewComment[],
  diff: string,
  originalTasks: PlanTask[]
): string {
  const role = getRole('engineer');

  const taskList = originalTasks
    .map(t => `- ${t.id}: ${t.title}`)
    .join('\n');

  const commentList = comments
    .map((c, i) => `- [${(c.severity || 'minor').toUpperCase()}] ${c.file}${c.line ? `:${c.line}` : ''}: ${c.comment}${c.suggestedFix ? ` (Fix: ${c.suggestedFix})` : ''}`)
    .join('\n');

  const context = `## Working on: ${repo.name}

## Original Tasks
${taskList}

## Review Feedback
The previous implementation was reviewed and rejected.

Review comments:
${commentList}

## Current Changes (git diff from phase start)
\`\`\`diff
${diff}
\`\`\`

## Instructions
Please address all review comments, commit your intentional changes, and return status.
Before returning, stage your intentional fixes with \`git add -A -- <paths>\`, create a commit with \`git commit -m "<message>"\`, and ensure \`git status --porcelain\` is empty.
Return {"status": "success"} when done.
If you encounter an error, return {"status": "failure"}.`;

  return `${role.promptTemplate}\n\n${context}`;
}

export async function getWorkerStatus(
  itemId: string
): Promise<{ role: AgentRole; repoName?: string; taskCount: number; status: string }[]> {
  const plan = await getPlan(itemId);
  const agents = await getAgentsByItem(itemId);
  const itemConfig = await getItemConfig(itemId);

  const result: { role: AgentRole; repoName?: string; taskCount: number; status: string }[] = [];

  if (itemConfig) {
    for (const repo of itemConfig.repositories) {
      const repoTaskCount = plan?.tasks.filter(t => t.repository === repo.name).length || 0;
      const devAgent = agents.find(a => a.repoName === repo.name && a.role === 'engineer');
      result.push({
        role: 'engineer',
        repoName: repo.name,
        taskCount: repoTaskCount,
        status: devAgent?.status || 'not_started',
      });

      if (repoTaskCount > 0) {
        const reviewAgent = agents.find(a => a.repoName === repo.name && a.role === 'review');
        result.push({
          role: 'review',
          repoName: repo.name,
          taskCount: repoTaskCount,
          status: reviewAgent?.status || 'not_started',
        });
      }
    }
  }

  return result;
}

export async function stopWorkers(itemId: string): Promise<void> {
  stopAllGitSnapshots(itemId);
}
