import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import type {
  CompletedReviewFinding,
  CompletedReviewState,
  CompletedReviewResult,
  CompletedReviewStatus,
  CompletedReviewFindingSeverity,
  ItemConfig,
  ItemEvent,
  ItemRepositoryConfig,
  Plan,
  TestPlan,
  AgentInfo,
} from '@agent-orch/shared';

import { appendJsonl, readJsonl } from '../lib/jsonl';
import {
  getHookLogDir,
  getItemEventsPath,
  getRepoWorkspaceDir,
  getWorkspaceRoot,
} from '../lib/paths';
import { stringifyYaml } from '../lib/yaml';
import { eventBus } from './event-bus';
import { getRole, mergeAllowedTools } from '../lib/role-loader';
import { composeRepositoryRolePrompt, composeWorkspaceRolePrompts } from '../lib/repository-role-prompts';
import {
  createCompletedReviewFindingsExtractedEvent,
  createCompletedReviewPassedEvent,
  createErrorEvent,
  createHooksExecutedEvent,
  createTasksCompletedEvent,
} from '../lib/events';
import {
  type CompletedReviewerResponse,
  type EngineerResponse,
} from '../lib/claude-schemas';
import { executeAgent, getAgentsByItem } from './agent-service';
import { getItemConfig } from './item-service';
import { getPlan } from './planner-service';
import { ensureApprovedTestPlan, getTestPlan } from './test-planner-service';
import { createDraftPrsForAllRepos, execGitInRepo } from './git-pr-service';
import { readRepoTaskState } from './task-state-service';
import { runShellCommands } from '../lib/command-runner';

const COMPLETED_REVIEW_MAX_ROUNDS = 3;
const COMPLETED_REVIEW_TIMEOUT_MS = 20 * 60 * 1000;
const COMPLETED_REVIEW_FIX_TIMEOUT_MS = 50 * 60 * 1000;
const MAX_DIFF_LINES = 8000;
const FIX_TASK_PREFIX = 'completed-review-fix';
const TASKS_COMPLETED_AGENT_ID = 'system-completed-review';

interface CompletedReviewLoopContext {
  itemConfig: ItemConfig;
  plan: Plan;
  testPlan: TestPlan;
}

interface CompletedReviewRunResult {
  agentId: string;
  reviewStatus: 'approve' | 'needs_fixes';
  summary: string;
  findings: CompletedReviewFinding[];
  round: number;
}

interface EngineerWorktreeState {
  commitHash: string;
  porcelain: string;
  dirty: boolean;
  summary: string;
}

interface CompletedReviewFixResult {
  hookSummary?: string;
}

function summarizePorcelain(porcelain: string): string {
  return porcelain
    .split('\n')
    .filter(Boolean)
    .slice(0, 5)
    .join(', ');
}

async function execGit(args: string[], cwd: string): Promise<string> {
  return execGitInRepo(args, cwd);
}

async function getGitHead(cwd: string): Promise<string> {
  return execGit(['rev-parse', 'HEAD'], cwd);
}

async function getGitStatusPorcelain(cwd: string): Promise<string> {
  return execGit(['status', '--porcelain'], cwd);
}

async function getEngineerWorktreeState(workingDir: string): Promise<EngineerWorktreeState> {
  const commitHash = await getGitHead(workingDir);
  const porcelain = await getGitStatusPorcelain(workingDir);
  return {
    commitHash,
    porcelain,
    dirty: porcelain.trim().length > 0,
    summary: summarizePorcelain(porcelain),
  };
}

async function resetRepoForAttempt(cwd: string, targetRef: string = 'HEAD'): Promise<void> {
  await execGit(['reset', '--hard', targetRef], cwd);
  await execGit(['clean', '-fd'], cwd);
}

async function emitCompletedReviewError(
  itemId: string,
  message: string,
  repoName?: string
): Promise<void> {
  const event = createErrorEvent(itemId, message, { repoName, phase: 'completed_review' });
  await appendJsonl(getItemEventsPath(itemId), event);
  eventBus.emit('event', { itemId, event });
}

function getCompletedReviewAddDirs(itemId: string, itemConfig: ItemConfig): string[] {
  const seen = new Set<string>();
  const addDirs: string[] = [];

  for (const repository of itemConfig.repositories) {
    const repoDir = getRepoWorkspaceDir(itemId, repository.name);
    if (!existsSync(repoDir) || seen.has(repoDir)) {
      continue;
    }
    seen.add(repoDir);
    addDirs.push(repoDir);
  }

  return addDirs;
}

async function getRepoReviewStateSummary(
  itemId: string,
  repository: ItemRepositoryConfig,
  hookWarningsByRepo: Map<string, string>
): Promise<string> {
  const repoDir = getRepoWorkspaceDir(itemId, repository.name);
  const baseBranch = repository.branch || 'main';

  const [branch, head, aheadCount, changedFiles, diffStat, status] = await Promise.all([
    execGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir).catch(() => '<unknown>'),
    execGit(['rev-parse', 'HEAD'], repoDir).catch(() => '<unknown>'),
    execGit(['rev-list', '--count', `origin/${baseBranch}..HEAD`], repoDir).catch(() => '<unknown>'),
    execGit(['diff', '--name-only', `origin/${baseBranch}...HEAD`], repoDir).catch(() => ''),
    execGit(['diff', '--stat', `origin/${baseBranch}...HEAD`], repoDir).catch(() => ''),
    execGit(['status', '--short'], repoDir).catch(() => ''),
  ]);

  const changedFilesBlock = changedFiles.trim()
    ? changedFiles.trim().split('\n').map((file) => `- ${file}`).join('\n')
    : '- <none>';
  const hookWarning = hookWarningsByRepo.get(repository.name);

  return `### ${repository.name}
Workspace: ${repoDir}
Current branch: ${branch}
HEAD: ${head}
Commits ahead of origin/${baseBranch}: ${aheadCount}
Changed files:
${changedFilesBlock}

Diff stat:
${diffStat || '<none>'}

Worktree status:
${status || '<clean>'}

Recent hook warning:
${hookWarning || '<none>'}`;
}

async function buildCompletedReviewContext(
  itemId: string,
  itemConfig: ItemConfig,
  plan: Plan,
  testPlan: TestPlan,
  hookWarningsByRepo: Map<string, string>
): Promise<string> {
  const repoList = itemConfig.repositories
    .map((repository) => `- **${repository.name}** (type: ${repository.type})`)
    .join('\n');
  const repoStates = await Promise.all(
    itemConfig.repositories.map((repository) => getRepoReviewStateSummary(itemId, repository, hookWarningsByRepo))
  );

  const basePrompt = `## Context

**Project Name:** ${itemConfig.name}
**Description:** ${itemConfig.description}
**Item ID:** ${itemConfig.id}

**Repositories:**
${repoList}

**Design Document:**
${itemConfig.designDoc || 'No design document provided.'}

## Current plan.yaml

\`\`\`yaml
${stringifyYaml(plan)}
\`\`\`

## Approved test-plan.yaml

\`\`\`yaml
${stringifyYaml(testPlan)}
\`\`\`

## Repository Implementation State

${repoStates.join('\n\n')}

## Review Rules

- Treat plan.yaml and test-plan.yaml as fixed.
- Extract only implementation gaps that still block acceptance.
- Do not ask for re-planning or test-plan changes.
- Every finding must map to a single targetRepository.`;

  return composeWorkspaceRolePrompts(basePrompt, itemConfig.repositories, 'completedReviewer');
}

function normalizeFindingSeverity(value: string): CompletedReviewFindingSeverity {
  if (value === 'critical' || value === 'major' || value === 'minor') {
    return value;
  }
  return 'major';
}

function normalizeCompletedReviewFinding(finding: CompletedReviewFinding): CompletedReviewFinding {
  return {
    id: finding.id,
    scenarioId: finding.scenarioId,
    targetRepository: finding.targetRepository,
    relatedRepositories: Array.isArray(finding.relatedRepositories) ? [...finding.relatedRepositories] : [],
    severity: normalizeFindingSeverity(finding.severity),
    summary: finding.summary,
    details: finding.details,
    suggestedFix: finding.suggestedFix,
  };
}

function validateCompletedReviewResponse(
  response: CompletedReviewerResponse,
  itemConfig: ItemConfig,
  testPlan: TestPlan
): string[] {
  const errors: string[] = [];
  const validRepoNames = new Set(itemConfig.repositories.map((repository) => repository.name));
  const validScenarioIds = new Set(testPlan.scenarios.map((scenario) => scenario.id));
  const findingIds = new Set<string>();

  if (!response.summary.trim()) {
    errors.push('summary must not be empty');
  }
  if (response.review_status === 'approve' && response.findings.length > 0) {
    errors.push('approve response must not include findings');
  }
  if (response.review_status === 'needs_fixes' && response.findings.length === 0) {
    errors.push('needs_fixes response must include at least one finding');
  }

  for (const finding of response.findings) {
    if (!finding.id?.trim()) {
      errors.push('finding.id must not be empty');
    } else if (findingIds.has(finding.id)) {
      errors.push(`Duplicate finding id: ${finding.id}`);
    } else {
      findingIds.add(finding.id);
    }
    if (!finding.scenarioId?.trim()) {
      errors.push(`Finding ${finding.id || '<unknown>'} missing scenarioId`);
    } else if (!validScenarioIds.has(finding.scenarioId)) {
      errors.push(`Finding ${finding.id || '<unknown>'} references unknown scenarioId: ${finding.scenarioId}`);
    }
    if (!finding.targetRepository?.trim()) {
      errors.push(`Finding ${finding.id || '<unknown>'} missing targetRepository`);
    } else if (!validRepoNames.has(finding.targetRepository)) {
      errors.push(`Finding ${finding.id || '<unknown>'} references unknown targetRepository: ${finding.targetRepository}`);
    }
    if (!Array.isArray(finding.relatedRepositories)) {
      errors.push(`Finding ${finding.id || '<unknown>'} must include relatedRepositories array`);
    } else {
      for (const repository of finding.relatedRepositories) {
        if (!validRepoNames.has(repository)) {
          errors.push(`Finding ${finding.id || '<unknown>'} references unknown relatedRepository: ${repository}`);
        }
      }
    }
    if (!finding.summary?.trim()) {
      errors.push(`Finding ${finding.id || '<unknown>'} missing summary`);
    }
    if (!finding.details?.trim()) {
      errors.push(`Finding ${finding.id || '<unknown>'} missing details`);
    }
    if (!finding.suggestedFix?.trim()) {
      errors.push(`Finding ${finding.id || '<unknown>'} missing suggestedFix`);
    }
  }

  return errors;
}

async function runCompletedReviewer(
  itemId: string,
  context: CompletedReviewLoopContext,
  round: number,
  hookWarningsByRepo: Map<string, string>
): Promise<CompletedReviewRunResult> {
  const role = getRole('completedReviewer');
  const prompt = await buildCompletedReviewContext(
    itemId,
    context.itemConfig,
    context.plan,
    context.testPlan,
    hookWarningsByRepo
  );
  const { agent, result } = await executeAgent<CompletedReviewerResponse>({
    itemId,
    role: 'completed-reviewer',
    prompt,
    appendSystemPrompt: role.systemPrompt,
    addDirs: getCompletedReviewAddDirs(itemId, context.itemConfig),
    workingDir: getWorkspaceRoot(itemId),
    allowedTools: role.allowedTools,
    jsonSchema: role.jsonSchema,
    timeoutMs: COMPLETED_REVIEW_TIMEOUT_MS,
  });

  const response = {
    ...result.output,
    findings: (result.output.findings || []).map((finding) => normalizeCompletedReviewFinding(finding)),
  };
  const errors = validateCompletedReviewResponse(response, context.itemConfig, context.testPlan);
  if (errors.length > 0) {
    throw new Error(`Completed review validation failed: ${errors.join('; ')}`);
  }

  if (response.review_status === 'approve') {
    const passEvent = createCompletedReviewPassedEvent(itemId, agent.id, response.summary, round);
    await appendJsonl(getItemEventsPath(itemId), passEvent);
    eventBus.emit('event', { itemId, event: passEvent });
  } else {
    const findingsEvent = createCompletedReviewFindingsExtractedEvent(
      itemId,
      agent.id,
      response.findings,
      response.summary,
      round
    );
    await appendJsonl(getItemEventsPath(itemId), findingsEvent);
    eventBus.emit('event', { itemId, event: findingsEvent });
  }

  return {
    agentId: agent.id,
    reviewStatus: response.review_status,
    summary: response.summary,
    findings: response.findings,
    round,
  };
}

function buildScenarioIndex(testPlan: TestPlan): Map<string, TestPlan['scenarios'][number]> {
  return new Map(testPlan.scenarios.map((scenario) => [scenario.id, scenario]));
}

async function getRepoDiffForCompletedReviewFix(
  repoDir: string,
  baseBranch: string
): Promise<string> {
  try {
    const diff = await execGit(['diff', `origin/${baseBranch}...HEAD`], repoDir);
    const lines = diff.split('\n');
    if (lines.length > MAX_DIFF_LINES) {
      return `${lines.slice(0, MAX_DIFF_LINES).join('\n')}\n<diff truncated at ${MAX_DIFF_LINES} lines>`;
    }
    return diff || '<no diff>';
  } catch {
    return '<unable to generate diff>';
  }
}

function buildCompletedReviewFixPrompt(
  repo: ItemRepositoryConfig,
  findings: CompletedReviewFinding[],
  testPlan: TestPlan,
  currentDiff: string,
  round: number,
  hookSummary?: string
): string {
  const scenarioIndex = buildScenarioIndex(testPlan);
  const findingBlocks = findings.map((finding) => {
    const scenario = scenarioIndex.get(finding.scenarioId);
    const scenarioBlock = scenario
      ? `Scenario: ${scenario.id} - ${scenario.title}
Given: ${scenario.given}
When: ${scenario.when}
Then: ${scenario.then}`
      : `Scenario: ${finding.scenarioId}`;

    const relatedRepositories = finding.relatedRepositories.length > 0
      ? finding.relatedRepositories.join(', ')
      : '<none>';

    return `### ${finding.id} [${finding.severity}]
${scenarioBlock}
Target repository: ${finding.targetRepository}
Related repositories: ${relatedRepositories}
Summary: ${finding.summary}
Details: ${finding.details}
Suggested fix: ${finding.suggestedFix}`;
  }).join('\n\n');

  return `## Completed Review Fix

You are addressing final acceptance gaps for repository "${repo.name}".
This is round ${round} of the completed review loop.

## Assigned Findings

${findingBlocks}

## Current Repository Diff

\`\`\`diff
${currentDiff}
\`\`\`

## Hook Status From Previous Round
${hookSummary || 'No hook warnings recorded.'}

## Instructions

- Fix only the remaining acceptance gaps assigned above.
- Do not edit plan.yaml or test-plan.yaml.
- Coordinate through code changes only.
- Commit your intentional changes before returning success.`;
}

async function executeCompletedReviewFixEngineer(
  itemId: string,
  repo: ItemRepositoryConfig,
  prompt: string
): Promise<void> {
  const engineerRole = getRole('engineer');
  const workingDir = getRepoWorkspaceDir(itemId, repo.name);
  const effectiveTools = mergeAllowedTools(engineerRole.allowedTools, repo.allowedTools);
  const preAttemptHead = await getGitHead(workingDir);

  try {
    const composedPrompt = composeRepositoryRolePrompt(prompt, repo.rolePrompts, 'engineer');
    const { result } = await executeAgent<EngineerResponse>({
      itemId,
      role: 'engineer',
      repoName: repo.name,
      currentTask: `${FIX_TASK_PREFIX}: round-${Date.now()}`,
      prompt: composedPrompt,
      appendSystemPrompt: engineerRole.systemPrompt,
      workingDir,
      allowedTools: effectiveTools,
      jsonSchema: engineerRole.jsonSchema,
      timeoutMs: COMPLETED_REVIEW_FIX_TIMEOUT_MS,
    });

    if (result.output.status !== 'success') {
      throw new Error(`Completed review fix engineer reported failure for ${repo.name}`);
    }

    const state = await getEngineerWorktreeState(workingDir);
    if (state.commitHash === preAttemptHead && state.dirty) {
      throw new Error(`Completed review fix engineer left dirty worktree for ${repo.name}: ${state.summary}`);
    }
    if (state.commitHash !== preAttemptHead && state.dirty) {
      throw new Error(`Completed review fix engineer left dirty worktree after commit for ${repo.name}: ${state.summary}`);
    }
  } catch (error) {
    await resetRepoForAttempt(workingDir, preAttemptHead);
    throw error;
  }
}

async function summarizeHooks(
  itemId: string,
  repo: ItemRepositoryConfig,
  round: number
): Promise<string | undefined> {
  if (!repo.hooks || repo.hooks.length === 0) {
    return undefined;
  }

  const repoDir = getRepoWorkspaceDir(itemId, repo.name);
  const logDir = join(getHookLogDir(itemId, repo.name), '__completed_review__');
  const results = await runShellCommands(repo.hooks, repoDir, {
    logDir,
    attempt: round,
  });
  const allPassed = results.every((result) => result.exitCode === 0);
  const event = createHooksExecutedEvent(itemId, repo.name, results, allPassed, round);
  await appendJsonl(getItemEventsPath(itemId), event);
  eventBus.emit('event', { itemId, event });

  if (allPassed) {
    return undefined;
  }

  return results
    .filter((result) => result.exitCode !== 0)
    .map((result) => {
      const stderrPath = result.stderrLogPath ? ` stderr=${result.stderrLogPath}` : '';
      const stdoutPath = result.stdoutLogPath ? ` stdout=${result.stdoutLogPath}` : '';
      return `- ${result.command} | exit=${result.exitCode ?? 'error'}${stderrPath}${stdoutPath}`;
    })
    .join('\n');
}

async function runCompletedReviewFixForRepoInternal(
  itemId: string,
  context: CompletedReviewLoopContext,
  repoName: string,
  findings: CompletedReviewFinding[],
  round: number,
  previousHookSummary?: string
): Promise<CompletedReviewFixResult> {
  const repo = context.itemConfig.repositories.find((candidate) => candidate.name === repoName);
  if (!repo) {
    throw new Error(`Repository not found for completed review fix: ${repoName}`);
  }

  const repoDir = getRepoWorkspaceDir(itemId, repo.name);
  const currentDiff = await getRepoDiffForCompletedReviewFix(repoDir, repo.branch || 'main');
  const prompt = buildCompletedReviewFixPrompt(
    repo,
    findings,
    context.testPlan,
    currentDiff,
    round,
    previousHookSummary
  );

  await executeCompletedReviewFixEngineer(itemId, repo, prompt);
  const hookSummary = await summarizeHooks(itemId, repo, round);
  return { hookSummary };
}

export async function runCompletedReviewFixForRepo(
  itemId: string,
  repoName: string,
  findings: CompletedReviewFinding[]
): Promise<void> {
  const context = await loadCompletedReviewContext(itemId);
  await runCompletedReviewFixForRepoInternal(itemId, context, repoName, findings, 1);
}

function groupFindingsByRepository(findings: CompletedReviewFinding[]): Map<string, CompletedReviewFinding[]> {
  const grouped = new Map<string, CompletedReviewFinding[]>();
  for (const finding of findings) {
    const existing = grouped.get(finding.targetRepository) || [];
    existing.push(finding);
    grouped.set(finding.targetRepository, existing);
  }
  return grouped;
}

function isCompletedReviewFixAgent(agent: AgentInfo): boolean {
  return agent.role === 'engineer' && agent.currentTask?.startsWith(FIX_TASK_PREFIX) === true;
}

async function loadCompletedReviewContext(itemId: string): Promise<CompletedReviewLoopContext> {
  const itemConfig = await getItemConfig(itemId);
  if (!itemConfig) {
    throw new Error(`Item ${itemId} not found`);
  }
  const plan = await getPlan(itemId);
  if (!plan) {
    throw new Error(`No plan found for item ${itemId}`);
  }
  const testPlan = await getTestPlan(itemId);
  if (!testPlan) {
    throw new Error(`No test plan found for item ${itemId}`);
  }
  await ensureApprovedTestPlan(itemId);

  return { itemConfig, plan, testPlan };
}

async function ensureAllTasksCompleted(itemId: string, plan: Plan): Promise<void> {
  for (const repository of new Set(plan.tasks.map((task) => task.repository))) {
    const repoState = await readRepoTaskState(itemId, repository);
    if (!repoState || repoState.tasks.some((task) => task.status !== 'completed')) {
      throw new Error(`All tasks must be completed before starting completed review (${repository})`);
    }
  }
}

async function publishTasksCompleted(itemId: string): Promise<void> {
  const event = createTasksCompletedEvent(itemId, TASKS_COMPLETED_AGENT_ID);
  await appendJsonl(getItemEventsPath(itemId), event);
  eventBus.emit('event', { itemId, event });
}

export async function runCompletedReviewFixLoop(itemId: string): Promise<void> {
  const context = await loadCompletedReviewContext(itemId);
  await ensureAllTasksCompleted(itemId, context.plan);

  const hookWarningsByRepo = new Map<string, string>();

  for (let round = 1; round <= COMPLETED_REVIEW_MAX_ROUNDS; round++) {
    const reviewResult = await runCompletedReviewer(itemId, context, round, hookWarningsByRepo);
    if (reviewResult.reviewStatus === 'approve') {
      const targetRepos = new Set(context.plan.tasks.map((task) => task.repository));
      await createDraftPrsForAllRepos(itemId, targetRepos);
      return;
    }

    if (round >= COMPLETED_REVIEW_MAX_ROUNDS) {
      const message = `Completed review did not pass after ${COMPLETED_REVIEW_MAX_ROUNDS} rounds`;
      await emitCompletedReviewError(itemId, message);
      throw new Error(message);
    }

    const findingsByRepo = groupFindingsByRepository(reviewResult.findings);
    for (const repository of context.itemConfig.repositories) {
      const repoFindings = findingsByRepo.get(repository.name);
      if (!repoFindings || repoFindings.length === 0) {
        continue;
      }

      try {
        const result = await runCompletedReviewFixForRepoInternal(
          itemId,
          context,
          repository.name,
          repoFindings,
          round,
          hookWarningsByRepo.get(repository.name)
        );
        if (result.hookSummary) {
          hookWarningsByRepo.set(repository.name, result.hookSummary);
        } else {
          hookWarningsByRepo.delete(repository.name);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await emitCompletedReviewError(itemId, message, repository.name);
        throw error;
      }
    }
  }
}

export async function startCompletedReview(itemId: string): Promise<void> {
  await runCompletedReviewFixLoop(itemId);
}

export async function getLatestCompletedReview(itemId: string): Promise<CompletedReviewState> {
  const events = await readJsonl<ItemEvent>(getItemEventsPath(itemId));
  const agents = await getAgentsByItem(itemId);
  let lastPlanCreatedIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === 'plan_created') {
      lastPlanCreatedIndex = index;
      break;
    }
  }
  const currentCycleEvents = lastPlanCreatedIndex >= 0 ? events.slice(lastPlanCreatedIndex + 1) : events;

  const latestFindings = [...currentCycleEvents].reverse().find(
    (event): event is Extract<ItemEvent, { type: 'completed_review_findings_extracted' }> =>
      event.type === 'completed_review_findings_extracted'
  );
  const latestPass = [...currentCycleEvents].reverse().find(
    (event): event is Extract<ItemEvent, { type: 'completed_review_passed' }> =>
      event.type === 'completed_review_passed'
  );
  const latestError = [...currentCycleEvents].reverse().find(
    (event): event is Extract<ItemEvent, { type: 'error' }> =>
      event.type === 'error' && event.phase === 'completed_review'
  );

  const baseStateFromEvent = (status: CompletedReviewStatus, result?: CompletedReviewResult): CompletedReviewState => ({
    status,
    summary: result?.summary,
    findings: result?.findings || [],
    round: result?.round,
    updatedAt: result?.reviewedAt,
  });

  let latestResult: CompletedReviewResult | undefined;
  if (latestPass && (!latestFindings || latestPass.timestamp >= latestFindings.timestamp)) {
    latestResult = {
      status: 'passed',
      summary: latestPass.summary,
      findings: [],
      round: latestPass.round,
      reviewedAt: latestPass.timestamp,
    };
  } else if (latestFindings) {
    latestResult = {
      status: 'needs_fixes',
      summary: latestFindings.summary,
      findings: latestFindings.findings,
      round: latestFindings.round,
      reviewedAt: latestFindings.timestamp,
    };
  }

  const runningReviewer = agents.some(
    (agent) => agent.role === 'completed-reviewer' && (agent.status === 'starting' || agent.status === 'running')
  );
  const runningFixer = agents.some(
    (agent) => isCompletedReviewFixAgent(agent) && (agent.status === 'starting' || agent.status === 'running')
  );

  if ((runningReviewer || runningFixer) && latestResult) {
    return {
      ...baseStateFromEvent('running', latestResult),
    };
  }
  if (runningReviewer || runningFixer) {
    return { status: 'running', findings: [] };
  }
  if (latestError && (!latestResult || latestError.timestamp >= latestResult.reviewedAt)) {
    return {
      ...baseStateFromEvent('error', latestResult),
      errorMessage: latestError.message,
      updatedAt: latestError.timestamp,
    };
  }
  if (latestResult?.status === 'passed') {
    return baseStateFromEvent('passed', latestResult);
  }
  if (latestResult?.status === 'needs_fixes') {
    return baseStateFromEvent('needs_fixes', latestResult);
  }

  return { status: 'not_started', findings: [] };
}

export async function ensureCompletedReviewPassed(itemId: string): Promise<CompletedReviewState> {
  const state = await getLatestCompletedReview(itemId);
  if (state.status !== 'passed') {
    throw new Error(`Completed review must pass before publish (current status: ${state.status})`);
  }
  return state;
}

export async function maybeStartCompletedReviewAfterTasks(itemId: string): Promise<void> {
  const context = await loadCompletedReviewContext(itemId);
  await ensureAllTasksCompleted(itemId, context.plan);

  const completedReview = await getLatestCompletedReview(itemId);
  if (completedReview.status === 'passed') {
    return;
  }

  await publishTasksCompleted(itemId);
  await runCompletedReviewFixLoop(itemId);
}
