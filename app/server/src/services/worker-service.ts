import { spawn } from 'child_process';
import { resolve } from 'path';
import type { Plan, PlanTask, AgentRole, ItemRepositoryConfig } from '@agent-orch/shared';
import { isDevRole } from '@agent-orch/shared';

import { executeAgent, getAgentsByItem, stopAgent } from './agent-service';
import { getPlan } from './planner-service';
import { getItemConfig } from './item-service';
import {
  startGitSnapshot,
  stopGitSnapshot,
  stopAllGitSnapshots,
} from './git-snapshot-service';
import { createDraftPrsForAllRepos } from './git-pr-service';
import { getWorkspaceRoot, getRepoWorkspaceDir, getItemEventsPath } from '../lib/paths';
import { eventBus } from './event-bus';
import { appendJsonl } from '../lib/jsonl';
import { createReviewFindingsExtractedEvent, createStatusChangedEvent } from '../lib/events';
import {
  type EngineerResponse,
  type ReviewerResponse,
  type ReviewComment,
} from '../lib/claude-schemas';
import { getRole, mergeAllowedTools } from '../lib/role-loader';

const MAX_REVIEW_ITERATIONS = 3;
const MAX_DIFF_LINES = 20000;
const REVIEW_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const ENGINEER_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const AGENT_MAX_RETRIES = 1;

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

// ─── Engineer Phase Result ───

interface EngineerPhaseResult {
  response: EngineerResponse;
  reviewBase: string;
  phaseBase: string;
  initialHead: string;
}

// ─── Main orchestration ───

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

  // ─── Phase 1: Dev Workers (parallel per repo) ───
  const engineerResults = new Map<string, EngineerPhaseResult>();

  const savedPhaseBases = new Map<string, string>();
  const devPromises: Promise<void>[] = [];

  for (const repo of itemConfig.repositories) {
    const repoTasks = tasksByRepo.get(repo.name);
    const devTasks = repoTasks?.filter(t => isDevRole(t.agent)) || [];
    if (devTasks.length === 0) continue;

    const agentWorkdir = resolve(getRepoWorkspaceDir(itemId, repo.name));
    validateAgentWorkdir(agentWorkdir, workspaceRoot);

    const promise = (async () => {
      const baseBranch = repo.branch || 'main';
      const phaseBase = await getGitHead(agentWorkdir);
      savedPhaseBases.set(repo.name, phaseBase);

      // reviewBase: try merge-base first, fallback to phaseBase
      let reviewBase: string;
      try {
        reviewBase = await getGitMergeBase(agentWorkdir, baseBranch);
      } catch {
        reviewBase = phaseBase;
      }

      // Start git snapshot
      await startGitSnapshot(itemId, agentWorkdir);

      const engineerRole = getRole('engineer');
      const effectiveTools = mergeAllowedTools(engineerRole.allowedTools, repo.allowedTools);
      const context = buildWorkerContext('engineer', repo.name, devTasks, plan);
      const prompt = `${engineerRole.promptTemplate}\n\n${context}`;

      for (let attempt = 0; attempt <= AGENT_MAX_RETRIES; attempt++) {
        try {
          const { result } = await executeAgent<EngineerResponse>({
            itemId,
            role: 'engineer',
            repoName: repo.name,
            prompt,
            workingDir: agentWorkdir,
            allowedTools: effectiveTools,
            jsonSchema: engineerRole.jsonSchema,
            timeoutMs: ENGINEER_TIMEOUT_MS,
          });
          let initialHead = phaseBase;
          try {
            initialHead = await getGitHead(agentWorkdir);
          } catch {
            // Keep phaseBase as a safe fallback.
          }

          engineerResults.set(repo.name, {
            response: result.output,
            reviewBase,
            phaseBase,
            initialHead,
          });
          break;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (attempt < AGENT_MAX_RETRIES) {
            console.warn(`[${itemId}/${repo.name}] Engineer attempt ${attempt + 1} failed: ${msg}, retrying...`);
            continue;
          }
          console.error(`[${itemId}/${repo.name}] Engineer failed after ${attempt + 1} attempts: ${msg}, skipping repo`);
        }
      }
    })();

    devPromises.push(promise);
  }

  // Wait for all dev workers to complete (allSettled to tolerate individual failures)
  if (devPromises.length > 0) {
    await Promise.allSettled(devPromises);

    // Retry failed repos (repos that didn't produce results after initial attempts)
    const failedRepos = itemConfig.repositories.filter(
      repo => tasksByRepo.has(repo.name) &&
              (tasksByRepo.get(repo.name)?.some(t => isDevRole(t.agent)) ?? false) &&
              !engineerResults.has(repo.name)
    );

    for (const repo of failedRepos) {
      const agentWorkdir = resolve(getRepoWorkspaceDir(itemId, repo.name));
      // Cleanup stale state and restart snapshot
      stopGitSnapshot(itemId, agentWorkdir);
      await startGitSnapshot(itemId, agentWorkdir);

      const baseBranch = repo.branch || 'main';
      const phaseBase = savedPhaseBases.get(repo.name)!;
      let reviewBase: string;
      try { reviewBase = await getGitMergeBase(agentWorkdir, baseBranch); }
      catch { reviewBase = phaseBase; }

      const engineerRole = getRole('engineer');
      const effectiveTools = mergeAllowedTools(engineerRole.allowedTools, repo.allowedTools);
      const devTasks = tasksByRepo.get(repo.name)?.filter(t => isDevRole(t.agent)) || [];
      const context = buildWorkerContext('engineer', repo.name, devTasks, plan);
      const prompt = `${engineerRole.promptTemplate}\n\n${context}`;

      try {
        const { result } = await executeAgent<EngineerResponse>({
          itemId, role: 'engineer', repoName: repo.name, prompt,
          workingDir: agentWorkdir, allowedTools: effectiveTools,
          jsonSchema: engineerRole.jsonSchema, timeoutMs: ENGINEER_TIMEOUT_MS,
        });
        let initialHead = phaseBase;
        try {
          initialHead = await getGitHead(agentWorkdir);
        } catch {
          // Keep phaseBase as a safe fallback.
        }
        engineerResults.set(repo.name, { response: result.output, reviewBase, phaseBase, initialHead });
        console.log(`[${itemId}/${repo.name}] Engineer retry succeeded`);
      } catch (retryError) {
        const msg = retryError instanceof Error ? retryError.message : String(retryError);
        console.error(`[${itemId}/${repo.name}] Engineer retry also failed: ${msg}`);
      }
    }

    if (engineerResults.size === 0) {
      throw new Error(`All engineer agents failed for item ${itemId}`);
    }
  }

  // ─── Phase 2: Review Loop (per repo, max 3 cycles) ───
  for (const repo of itemConfig.repositories) {
    const engineerResult = engineerResults.get(repo.name);
    if (!engineerResult) continue;

    const agentWorkdir = resolve(getRepoWorkspaceDir(itemId, repo.name));

    const { reviewBase, phaseBase, initialHead } = engineerResult;

    for (let cycle = 0; cycle < MAX_REVIEW_ITERATIONS; cycle++) {
      console.log(`[${itemId}/${repo.name}] Starting review cycle ${cycle + 1}/${MAX_REVIEW_ITERATIONS}`);

      const currentHead = await getGitHead(agentWorkdir);

      // Build review diff (what the PR will show)
      let reviewDiff: string;
      try {
        reviewDiff = await getGitDiff(agentWorkdir, reviewBase, currentHead);
      } catch {
        reviewDiff = '<unable to generate diff>';
      }

      if (!reviewDiff || reviewDiff.trim() === '') {
        console.log(`[${itemId}/${repo.name}] No diff to review, skipping`);
        break;
      }

      // Run reviewer with retry + graceful skip
      const devTasks = tasksByRepo.get(repo.name)?.filter(t => isDevRole(t.agent)) || [];
      const reviewerRole = getRole('reviewer');
      let initialImplementationDiff = '<unable to generate initial implementation diff>';
      try {
        initialImplementationDiff = await getGitDiff(agentWorkdir, phaseBase, initialHead);
      } catch {
        // Keep placeholder string.
      }

      let followupDiff = '<no additional fixes after the initial implementation>';
      if (initialHead !== currentHead) {
        try {
          followupDiff = await getGitDiff(agentWorkdir, initialHead, currentHead);
        } catch {
          followupDiff = '<unable to generate post-initial fixes diff>';
        }
      }

      const includeCombinedFallback =
        initialImplementationDiff.startsWith('<unable') || followupDiff.startsWith('<unable');

      const reviewContext = buildReviewContext(
        repo.name,
        {
          initialImplementationDiff,
          followupDiff,
          combinedDiff: includeCombinedFallback ? reviewDiff : undefined,
        },
        devTasks
      );
      const reviewPrompt = `${reviewerRole.promptTemplate}\n\n${reviewContext}`;

      let reviewResponse: ReviewerResponse | null = null;
      for (let attempt = 0; attempt <= AGENT_MAX_RETRIES; attempt++) {
        try {
          const { result: reviewResult } = await executeAgent<ReviewerResponse>({
            itemId,
            role: 'review',
            repoName: repo.name,
            prompt: reviewPrompt,
            workingDir: agentWorkdir,
            allowedTools: reviewerRole.allowedTools,
            jsonSchema: reviewerRole.jsonSchema,
            timeoutMs: REVIEW_TIMEOUT_MS,
          });
          reviewResponse = reviewResult.output;
          break;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (attempt < AGENT_MAX_RETRIES) {
            console.warn(`[${itemId}/${repo.name}] Review attempt ${attempt + 1} failed: ${msg}, retrying...`);
            continue;
          }
          console.warn(`[${itemId}/${repo.name}] Review failed after ${attempt + 1} attempts: ${msg}, skipping review`);
        }
      }

      if (!reviewResponse) {
        console.log(`[${itemId}/${repo.name}] Skipping review due to failure, proceeding to PR`);
        break;
      }
      const comments = reviewResponse.comments ?? [];
      const findings = comments.map(c => ({
        severity: (c.severity || 'minor') as 'critical' | 'major' | 'minor',
        file: c.file,
        line: c.line,
        description: c.comment,
        suggestedFix: c.suggestedFix || '',
        targetAgent: repo.name,
      }));

      const findingsEvent = createReviewFindingsExtractedEvent(
        itemId,
        `review-${repo.name}-cycle${cycle + 1}`,
        repo.name,
        findings,
        reviewResponse.review_status === 'approve' ? 'pass' : 'needs_fixes',
        reviewResponse.review_status === 'approve'
          ? 'Code review passed'
          : `${comments.length} issues found`
      );
      await appendJsonl(getItemEventsPath(itemId), findingsEvent);
      eventBus.publish(itemId, findingsEvent);

      if (reviewResponse.review_status === 'approve') {
        console.log(`[${itemId}/${repo.name}] Review approved on cycle ${cycle + 1}`);
        break;
      }

      // Last cycle - don't send feedback
      if (cycle === MAX_REVIEW_ITERATIONS - 1) {
        console.warn(`[${itemId}/${repo.name}] Max review cycles reached`);
        break;
      }

      console.log(`[${itemId}/${repo.name}] Review found ${comments.length} issues`);

      // Get feedback diff (what engineer changed during this phase)
      let feedbackDiff: string;
      try {
        // Prefer targeted diff when reviewer comments specify files
        const commentFiles = comments
          .map(c => c.file)
          .filter(Boolean);
        feedbackDiff = await getGitDiff(
          agentWorkdir,
          phaseBase,
          currentHead,
          commentFiles.length > 0 ? commentFiles : undefined
        );
      } catch {
        feedbackDiff = '<unable to generate diff>';
      }

      // Build feedback prompt
      const feedbackRole = getRole('engineer');
      const feedbackEffectiveTools = mergeAllowedTools(feedbackRole.allowedTools, repo.allowedTools);
      const feedbackPrompt = buildFeedbackPrompt(
        plan,
        repo,
        comments,
        feedbackDiff,
        tasksByRepo.get(repo.name)?.filter(t => isDevRole(t.agent)) || []
      );

      // New engineer execution for fixes (with retry)
      let feedbackFailed = false;
      for (let feedbackAttempt = 0; feedbackAttempt <= AGENT_MAX_RETRIES; feedbackAttempt++) {
        try {
          await executeAgent<EngineerResponse>({
            itemId,
            role: 'engineer',
            repoName: repo.name,
            prompt: feedbackPrompt,
            workingDir: agentWorkdir,
            allowedTools: feedbackEffectiveTools,
            jsonSchema: feedbackRole.jsonSchema,
            timeoutMs: ENGINEER_TIMEOUT_MS,
          });
          break;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (feedbackAttempt < AGENT_MAX_RETRIES) {
            console.warn(`[${itemId}/${repo.name}] Feedback engineer attempt ${feedbackAttempt + 1} failed: ${msg}, retrying...`);
            continue;
          }
          console.error(`[${itemId}/${repo.name}] Feedback engineer failed after ${feedbackAttempt + 1} attempts: ${msg}`);
          feedbackFailed = true;
        }
      }
      if (feedbackFailed) {
        console.warn(`[${itemId}/${repo.name}] Skipping remaining review cycles due to feedback engineer failure`);
        break;
      }

      // phaseBase stays the same — next cycle's diff still covers everything
    }
  }

  // ─── Phase 3: Push & PR ───
  await createDraftPrsForAllRepos(itemId);
}

export async function startWorkerForRepo(
  itemId: string,
  repoName: string,
  role: AgentRole = 'engineer'
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

  const workerRole = getRole('engineer');

  const tasks = plan.tasks.filter(t => t.agent === role && t.repository === repoName);
  if (tasks.length === 0) {
    throw new Error(`No tasks found for agent ${role} in repository ${repoName}`);
  }

  const repoConfig = itemConfig.repositories.find(r => r.name === repoName);
  const effectiveTools = isDevRole(role)
    ? mergeAllowedTools(workerRole.allowedTools, repoConfig?.allowedTools)
    : workerRole.allowedTools;

  const agentWorkdir = resolve(getRepoWorkspaceDir(itemId, repoName));
  validateAgentWorkdir(agentWorkdir, workspaceRoot);

  const context = buildWorkerContext(role, repoName, tasks, plan);
  const prompt = `${workerRole.promptTemplate}\n\n${context}`;
  await executeAgent<EngineerResponse>({
    itemId,
    role,
    repoName,
    prompt,
    workingDir: agentWorkdir,
    allowedTools: effectiveTools,
    jsonSchema: workerRole.jsonSchema,
  });
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

function buildReviewContext(
  repoName: string,
  reviewDiffs: {
    initialImplementationDiff: string;
    followupDiff: string;
    combinedDiff?: string;
  },
  reviewTasks: PlanTask[]
): string {
  const taskDescriptions = reviewTasks
    .map((task) => `### Task: ${task.id} - ${task.title}\n${task.description}`)
    .join('\n\n');

  const combinedDiffSection = reviewDiffs.combinedDiff
    ? `
### Fallback Combined Diff
\`\`\`diff
${reviewDiffs.combinedDiff}
\`\`\`
`
    : '';

  return `## Repository: ${repoName}

## Changes to Review

The following diffs are organized by when they were created in this run:

### Initial Implementation Diff
\`\`\`diff
${reviewDiffs.initialImplementationDiff}
\`\`\`

### Post-Initial Fixes Diff (e.g. hooks/review follow-ups)
\`\`\`diff
${reviewDiffs.followupDiff}
\`\`\`

${combinedDiffSection}

## Implemented Tasks

${taskDescriptions}`;
}

function buildFeedbackPrompt(
  plan: Plan,
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
Please address all review comments and create a new commit.
Follow the same commit rules as before:
- NEVER use git add -A or git add .
- Only commit files you actually modified
- Run: git add <specific files>
- Run: git commit -m "fix(<scope>): address review feedback"

Return a JSON response with {"status": "success", "files_modified": ["path/to/file1"]} when done.
If you encounter an error, return {"status": "failure", "files_modified": []}.`;

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
      const devTaskCount = plan?.tasks.filter(t => t.repository === repo.name && isDevRole(t.agent)).length || 0;
      const devAgent = agents.find(a => a.repoName === repo.name && isDevRole(a.role));
      result.push({
        role: 'engineer',
        repoName: repo.name,
        taskCount: devTaskCount,
        status: devAgent?.status || 'not_started',
      });

      if (devTaskCount > 0) {
        const reviewAgent = agents.find(a => a.repoName === repo.name && a.role === 'review');
        result.push({
          role: 'review',
          repoName: repo.name,
          taskCount: devTaskCount,
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
