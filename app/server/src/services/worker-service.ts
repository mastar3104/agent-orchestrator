import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { readFile, mkdir, writeFile } from 'fs/promises';
import { finished } from 'stream/promises';
import { resolve, join } from 'path';
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
import { getWorkspaceRoot, getRepoWorkspaceDir, getItemEventsPath, getItemPlanPath, getHookLogDir } from '../lib/paths';
import { eventBus } from './event-bus';
import { appendJsonl } from '../lib/jsonl';
import { createReviewFindingsExtractedEvent, createStatusChangedEvent, createHooksExecutedEvent, createErrorEvent } from '../lib/events';
import type { HookResult } from '@agent-orch/shared';
import {
  type EngineerResponse,
  type ReviewerResponse,
  type ReviewComment,
} from '../lib/claude-schemas';
import { getRole, mergeAllowedTools } from '../lib/role-loader';

const MAX_FEEDBACK_ROUNDS = 2;
const MAX_DIFF_LINES = 20000;
const REVIEW_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const ENGINEER_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const AGENT_MAX_RETRIES = 1;
const MAX_HOOKS_RETRIES = 2;
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
3. Commit your changes:
   - NEVER use git add -A or git add .
   - Only commit files you actually modified
   - Run: git add <specific files>
   - Run: git commit -m "fix(<scope>): address hook validation failures"

Return a JSON response with {"status": "success", "files_modified": ["path/to/file1"]} when done.
If you encounter an error, return {"status": "failure", "files_modified": []}.`;
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
  const hooksFailedRepos = new Set<string>();

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

          // ─── Hooks execution ───
          const hooks = repo.hooks;
          if (hooks && hooks.length > 0) {
            const hookLogDir = getHookLogDir(itemId, repo.name);
            let hooksPassed = false;
            for (let hookAttempt = 1; hookAttempt <= MAX_HOOKS_RETRIES; hookAttempt++) {
              console.log(`[${itemId}/${repo.name}] Running hooks (attempt ${hookAttempt}/${MAX_HOOKS_RETRIES})`);
              const hookResults = await runHooks(hooks, agentWorkdir, hookLogDir, hookAttempt);
              const allPassed = hookResults.every(r => r.exitCode === 0);

              const hooksEvent = createHooksExecutedEvent(itemId, repo.name, hookResults, allPassed, hookAttempt);
              await appendJsonl(getItemEventsPath(itemId), hooksEvent);
              eventBus.publish(itemId, hooksEvent);

              if (allPassed) {
                console.log(`[${itemId}/${repo.name}] All hooks passed on attempt ${hookAttempt}`);
                hooksPassed = true;
                break;
              }

              console.warn(`[${itemId}/${repo.name}] Hooks failed on attempt ${hookAttempt}/${MAX_HOOKS_RETRIES}`);

              if (hookAttempt < MAX_HOOKS_RETRIES) {
                // Re-run engineer with fix prompt
                const fixPrompt = buildHooksFixPrompt(hookResults);
                try {
                  await executeAgent<EngineerResponse>({
                    itemId,
                    role: 'engineer',
                    repoName: repo.name,
                    prompt: fixPrompt,
                    workingDir: agentWorkdir,
                    allowedTools: effectiveTools,
                    jsonSchema: engineerRole.jsonSchema,
                    timeoutMs: ENGINEER_TIMEOUT_MS,
                  });
                } catch (fixError) {
                  const fixMsg = fixError instanceof Error ? fixError.message : String(fixError);
                  console.error(`[${itemId}/${repo.name}] Hooks fix engineer failed: ${fixMsg}`);
                }
              }
            }

            if (!hooksPassed) {
              console.error(`[${itemId}/${repo.name}] Hooks failed after ${MAX_HOOKS_RETRIES} attempts, skipping repo`);
              hooksFailedRepos.add(repo.name);
              const errorEvent = createErrorEvent(
                itemId,
                `Hooks validation failed for ${repo.name} after ${MAX_HOOKS_RETRIES} attempts`
              );
              await appendJsonl(getItemEventsPath(itemId), errorEvent);
              eventBus.publish(itemId, errorEvent);
              break; // Don't set engineerResults → skip review/PR
            }

            // Update initialHead after hooks fixes
            try {
              initialHead = await getGitHead(agentWorkdir);
            } catch {
              // Keep previous value
            }
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

    // Retry failed repos (repos where engineer itself failed, NOT hooks-exhausted repos)
    const failedRepos = itemConfig.repositories.filter(
      repo => tasksByRepo.has(repo.name) &&
              (tasksByRepo.get(repo.name)?.some(t => isDevRole(t.agent)) ?? false) &&
              !engineerResults.has(repo.name) &&
              !hooksFailedRepos.has(repo.name)
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
        // Run hooks if configured (this repo only enters retry because engineer itself failed,
        // not because hooks were exhausted — hooksFailedRepos are excluded above)
        const hooks = repo.hooks;
        if (hooks && hooks.length > 0) {
          const hookLogDir = getHookLogDir(itemId, repo.name);
          let hooksPassed = false;
          for (let hookAttempt = 1; hookAttempt <= MAX_HOOKS_RETRIES; hookAttempt++) {
            console.log(`[${itemId}/${repo.name}] Running hooks after engineer retry (attempt ${hookAttempt}/${MAX_HOOKS_RETRIES})`);
            const hookResults = await runHooks(hooks, agentWorkdir, hookLogDir, hookAttempt);
            const allPassed = hookResults.every(r => r.exitCode === 0);

            const hooksEvent = createHooksExecutedEvent(itemId, repo.name, hookResults, allPassed, hookAttempt);
            await appendJsonl(getItemEventsPath(itemId), hooksEvent);
            eventBus.publish(itemId, hooksEvent);

            if (allPassed) {
              hooksPassed = true;
              break;
            }

            if (hookAttempt < MAX_HOOKS_RETRIES) {
              const fixPrompt = buildHooksFixPrompt(hookResults);
              try {
                await executeAgent<EngineerResponse>({
                  itemId, role: 'engineer', repoName: repo.name, prompt: fixPrompt,
                  workingDir: agentWorkdir, allowedTools: effectiveTools,
                  jsonSchema: engineerRole.jsonSchema, timeoutMs: ENGINEER_TIMEOUT_MS,
                });
              } catch (fixError) {
                const fixMsg = fixError instanceof Error ? fixError.message : String(fixError);
                console.error(`[${itemId}/${repo.name}] Hooks fix engineer failed: ${fixMsg}`);
              }
            }
          }

          if (!hooksPassed) {
            console.error(`[${itemId}/${repo.name}] Hooks failed after engineer retry, skipping repo`);
            hooksFailedRepos.add(repo.name);
            const errorEvent = createErrorEvent(
              itemId,
              `Hooks validation failed for ${repo.name} after ${MAX_HOOKS_RETRIES} attempts`
            );
            await appendJsonl(getItemEventsPath(itemId), errorEvent);
            eventBus.publish(itemId, errorEvent);
            continue; // Skip this repo
          }

          try {
            initialHead = await getGitHead(agentWorkdir);
          } catch {
            // Keep previous value
          }
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

  // ─── Phase 2: Review Loop (per repo, max 2 feedback rounds) ───
  for (const repo of itemConfig.repositories) {
    const engineerResult = engineerResults.get(repo.name);
    if (!engineerResult) continue;

    const agentWorkdir = resolve(getRepoWorkspaceDir(itemId, repo.name));

    const { reviewBase, phaseBase, initialHead } = engineerResult;

    for (let cycle = 0; cycle < MAX_FEEDBACK_ROUNDS; cycle++) {
      console.log(`[${itemId}/${repo.name}] Starting review cycle ${cycle + 1}/${MAX_FEEDBACK_ROUNDS}`);

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

      const reviewContext = await buildReviewContext(
        itemId,
        repo.name,
        agentWorkdir,
        reviewBase,
        currentHead,
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
        console.warn(`[${itemId}/${repo.name}] Skipping remaining feedback rounds due to feedback engineer failure`);
        break;
      }

      // phaseBase stays the same — next cycle's diff still covers everything
    }
  }

  // ─── Phase 3: Push & PR ───
  await createDraftPrsForAllRepos(itemId, new Set(engineerResults.keys()));
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
  reviewBase: string,
  currentHead: string,
  reviewTasks: PlanTask[]
): Promise<string> {
  const taskDescriptions = reviewTasks
    .map((task) => `### Task: ${task.id} - ${task.title}\n${task.description}`)
    .join('\n\n');

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
    changedFiles = await getChangedFiles(agentWorkdir, reviewBase, currentHead);
    binaryFiles = await getBinaryFiles(agentWorkdir, reviewBase, currentHead);
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
