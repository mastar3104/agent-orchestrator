import { spawn } from 'child_process';
import { resolve, join } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import type {
  Plan,
  PlanTask,
  AgentRole,
  ItemRepositoryConfig,
  ReviewFinding,
  ReviewPerspective,
  ReviewPerspectiveStatus,
  ReviewPerspectiveSummary,
  StartWorkersMode,
  TaskProgressPhase,
} from '@agent-orch/shared';

import { executeAgent, getAgentsByItem } from './agent-service';
import { getPlan } from './planner-service';
import { getItemConfig } from './item-service';
import {
  startGitSnapshot,
} from './git-snapshot-service';
import {
  getWorkspaceRoot,
  getRepoWorkspaceDir,
  getItemEventsPath,
  getHookLogDir,
  getTaskReviewArtifactsDir,
  getTaskReviewArtifactIndexPath,
  getReviewResultFilePath,
} from '../lib/paths';
import { stringifyYaml } from '../lib/yaml';
import { eventBus } from './event-bus';
import { appendJsonl } from '../lib/jsonl';
import {
  createReviewFindingsExtractedEvent,
  createHooksExecutedEvent,
  createErrorEvent,
  createTaskStateChangedEvent,
} from '../lib/events';
import type { HookResult } from '@agent-orch/shared';
import {
  isEngineerFailureOutput,
  isReviewerResponse,
  type ReviewerResponse,
} from '../lib/claude-schemas';
import { getRole, mergeAllowedTools } from '../lib/role-loader';
import { composeRepositoryRolePrompt } from '../lib/repository-role-prompts';
import { COMMAND_TIMEOUT_MS, runShellCommands } from '../lib/command-runner';
import {
  ensureTaskStatesForPlan,
  readRepoTaskState,
  reconcileStoppedRepoTaskState,
  reconcileStoppedRepoTaskStateForItem,
  writeRepoTaskState,
  type RepoTaskStateFile,
  type RepoTaskStateTask,
} from './task-state-service';
import { resolveHooksMaxAttempts } from '../lib/repository-config';
import { ensureApprovedTestPlan } from './test-planner-service';
import { maybeStartCompletedReviewAfterTasks } from './completed-review-service';

const MAX_FEEDBACK_ROUNDS = 3;
const MAX_DIFF_LINES = 20000;
const REVIEW_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const ENGINEER_TIMEOUT_MS = 50 * 60 * 1000; // 50 minutes
const AGENT_MAX_RETRIES = 2;
const HOOK_TIMEOUT_MS = COMMAND_TIMEOUT_MS;
const ENGINEER_SCHEMA_FALLBACK_MODE = 'result_or_empty' as const;
const MAX_REVIEW_ARTIFACT_DIFF_LINES = 5000;
const MAX_REVIEW_ARTIFACT_DIFF_CHARS = 200000;
const REVIEW_PERSPECTIVE_RUN_ORDER: ReviewPerspective[] = [
  'architecture',
  'security',
  'testing',
  'requirements',
];
const REVIEW_PERSPECTIVE_FEEDBACK_ORDER: ReviewPerspective[] = [
  'security',
  'requirements',
  'architecture',
  'testing',
];

type ReviewPerspectiveRoleKey =
  | 'reviewer'
  | 'architectureReviewer'
  | 'securityReviewer'
  | 'testingReviewer'
  | 'requirementsReviewer';

interface ReviewPerspectiveConfig {
  perspective: ReviewPerspective;
  roleName: ReviewPerspectiveRoleKey;
  promptKey: ReviewPerspectiveRoleKey;
  label: string;
}

interface ReviewPerspectiveExecutionResult {
  perspective: ReviewPerspective;
  status: ReviewPerspectiveStatus;
  findings: ReviewFinding[];
  summary: string;
  agentId: string;
  hasStructuredSignal: boolean;
  detail?: string;
  reviewResultFilePath?: string;
}

interface ReviewContextBuildResult {
  prompt: string;
  artifactDir?: string;
}

interface ReviewCycleResult {
  findings: ReviewFinding[];
  overallAssessment: 'pass' | 'needs_fixes';
  summary: string;
  perspectives?: ReviewPerspectiveSummary[];
  feedbackFiles: string[];
  reviewResultFilePaths: string[];
  hardFailureMessage?: string;
}

const REVIEW_PERSPECTIVE_CONFIGS: ReviewPerspectiveConfig[] = [
  {
    perspective: 'architecture',
    roleName: 'architectureReviewer',
    promptKey: 'architectureReviewer',
    label: 'Architecture',
  },
  {
    perspective: 'security',
    roleName: 'securityReviewer',
    promptKey: 'securityReviewer',
    label: 'Security',
  },
  {
    perspective: 'testing',
    roleName: 'testingReviewer',
    promptKey: 'testingReviewer',
    label: 'Testing',
  },
  {
    perspective: 'requirements',
    roleName: 'requirementsReviewer',
    promptKey: 'requirementsReviewer',
    label: 'Requirements',
  },
];

const REVIEW_PERSPECTIVE_LABELS: Record<ReviewPerspective, string> = Object.fromEntries(
  REVIEW_PERSPECTIVE_CONFIGS.map((config) => [config.perspective, config.label])
) as Record<ReviewPerspective, string>;

export class WorkerStartValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerStartValidationError';
  }
}

function getRoleDescription(role: string): string {
  const descriptions: Record<string, string> = {
    planner: 'Planning and architecture',
    review: 'Code review, testing, documentation, integration',
    'review-receiver': 'Receiving and processing PR review comments',
  };
  return descriptions[role] || `${role} development`;
}

function getReviewPerspectiveConfig(
  perspective: ReviewPerspective
): ReviewPerspectiveConfig {
  const config = REVIEW_PERSPECTIVE_CONFIGS.find(
    (candidate) => candidate.perspective === perspective
  );
  if (!config) {
    throw new Error(`Unknown review perspective: ${perspective}`);
  }
  return config;
}

function getSeverityRank(severity: ReviewFinding['severity']): number {
  switch (severity) {
    case 'critical':
      return 0;
    case 'major':
      return 1;
    case 'minor':
      return 2;
  }
}

export function sortReviewFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort((left, right) => {
    const severityDiff = getSeverityRank(left.severity) - getSeverityRank(right.severity);
    if (severityDiff !== 0) {
      return severityDiff;
    }

    const perspectiveLeft = left.perspective
      ? REVIEW_PERSPECTIVE_FEEDBACK_ORDER.indexOf(left.perspective)
      : Number.MAX_SAFE_INTEGER;
    const perspectiveRight = right.perspective
      ? REVIEW_PERSPECTIVE_FEEDBACK_ORDER.indexOf(right.perspective)
      : Number.MAX_SAFE_INTEGER;
    if (perspectiveLeft !== perspectiveRight) {
      return perspectiveLeft - perspectiveRight;
    }

    const fileDiff = left.file.localeCompare(right.file);
    if (fileDiff !== 0) {
      return fileDiff;
    }

    return (left.line || 0) - (right.line || 0);
  });
}

function countFindingsBySeverity(findings: ReviewFinding[]): {
  criticalCount: number;
  majorCount: number;
  minorCount: number;
} {
  return {
    criticalCount: findings.filter((finding) => finding.severity === 'critical').length,
    majorCount: findings.filter((finding) => finding.severity === 'major').length,
    minorCount: findings.filter((finding) => finding.severity === 'minor').length,
  };
}

function createSyntheticReviewFinding(
  perspective: ReviewPerspective,
  description: string,
  suggestedFix: string
): ReviewFinding {
  return {
    perspective,
    severity: 'major',
    file: '<reviewer-output>',
    description,
    suggestedFix,
    targetAgent: perspective,
  };
}

function mapReviewCommentsToFindings(
  repoName: string,
  perspective: ReviewPerspective,
  comments: ReviewerResponse['comments']
): ReviewFinding[] {
  return comments.map((comment) => ({
    perspective,
    severity: (comment.severity || 'minor') as ReviewFinding['severity'],
    file: comment.file,
    line: comment.line,
    description: comment.comment,
    suggestedFix: comment.suggestedFix || '',
    targetAgent: repoName,
  }));
}

function buildPerspectiveSummary(
  perspective: ReviewPerspective,
  status: ReviewPerspectiveStatus,
  findings: ReviewFinding[],
  detail?: string
): string {
  const label = REVIEW_PERSPECTIVE_LABELS[perspective];
  switch (status) {
    case 'approve':
      return `${label} review approved.`;
    case 'request_changes':
      return findings.length > 0
        ? `${label} review found ${findings.length} issue${findings.length === 1 ? '' : 's'}.`
        : `${label} review requested changes.`;
    case 'schema_fallback':
      return `${label} review returned invalid structured output.${detail ? ` ${detail}` : ''}`;
    case 'error':
      return `${label} review failed after retries.${detail ? ` ${detail}` : ''}`;
  }
}

function buildReviewPerspectiveSummary(
  result: ReviewPerspectiveExecutionResult
): ReviewPerspectiveSummary {
  return {
    perspective: result.perspective,
    status: result.status,
    summary: result.summary,
    agentId: result.agentId,
    ...countFindingsBySeverity(result.findings),
  };
}

function resolveReviewPerspectiveRole(
  roleName: ReviewPerspectiveRoleKey
): ReturnType<typeof getRole> {
  const reviewerRole = getRole('reviewer');
  if (roleName === 'reviewer') {
    return reviewerRole;
  }

  try {
    const perspectiveRole = getRole(roleName);
    return {
      systemPrompt: perspectiveRole.systemPrompt,
      allowedTools: mergeAllowedTools(
        reviewerRole.allowedTools,
        perspectiveRole.allowedTools
      ),
      jsonSchema: perspectiveRole.jsonSchema,
    };
  } catch {
    return reviewerRole;
  }
}

export function resolveReviewerSystemPrompt(
  systemPrompt: string,
  itemId: string,
  repoName: string,
  taskId: string,
  reviewRound: number,
  perspective?: ReviewPerspective
): string {
  const filePath = getReviewResultFilePath(itemId, repoName, taskId, reviewRound, perspective);
  const result = systemPrompt.replace('{{reviewResultFilePath}}', filePath);
  if (result === systemPrompt) {
    console.warn(
      `[resolveReviewerSystemPrompt] placeholder {{reviewResultFilePath}} not found in system prompt`
    );
  }
  return result;
}

// Best-effort guard only: this avoids obviously write-capable reviewer roles,
// but it is not a security boundary because tool patterns may still permit writes.
// Note: Write is allowed for reviewers (review result file output), but Edit is
// still blocked because it would allow direct code modification.
export function isCompatibleReviewerRole(role: ReturnType<typeof getRole>): boolean {
  return !role.allowedTools.includes('Edit');
}

function supportsMultiPerspectiveReviews(): boolean {
  try {
    return REVIEW_PERSPECTIVE_CONFIGS.every((config) => {
      const role = getRole(config.roleName);
      return isCompatibleReviewerRole(role);
    });
  } catch {
    return false;
  }
}

async function runReviewPerspective(
  itemId: string,
  repo: ItemRepositoryConfig,
  task: PlanTask,
  agentWorkdir: string,
  reviewContext: ReviewContextBuildResult,
  reviewCycle: number,
  perspective: ReviewPerspective
): Promise<ReviewPerspectiveExecutionResult> {
  const config = getReviewPerspectiveConfig(perspective);
  const role = resolveReviewPerspectiveRole(config.roleName);
  const resolvedSystemPrompt = resolveReviewerSystemPrompt(
    role.systemPrompt,
    itemId,
    repo.name,
    task.id,
    reviewCycle,
    perspective
  );
  const prompt = composeRepositoryRolePrompt(
    reviewContext.prompt,
    repo.rolePrompts,
    config.promptKey,
    'reviewer'
  );

  const reviewResultFilePath = getReviewResultFilePath(itemId, repo.name, task.id, reviewCycle, perspective);
  let reviewError = 'Reviewer failed';
  let lastAgentId = '';
  let agentSucceeded = false;

  for (let attempt = 0; attempt <= AGENT_MAX_RETRIES; attempt++) {
    lastAgentId = buildSyntheticReviewAgentId(
      repo.name,
      task.id,
      reviewCycle,
      perspective,
      attempt + 1
    );
    try {
      const { agent } = await executeAgent<unknown>({
        itemId,
        agentId: lastAgentId,
        role: 'review',
        repoName: repo.name,
        currentTask: `${task.id}: review:${perspective}`,
        prompt,
        appendSystemPrompt: resolvedSystemPrompt,
        addDirs: reviewContext.artifactDir ? [reviewContext.artifactDir] : undefined,
        workingDir: agentWorkdir,
        allowedTools: role.allowedTools,
        emitErrorEvent: false,
        timeoutMs: REVIEW_TIMEOUT_MS,
      });
      lastAgentId = agent.id;
      agentSucceeded = true;
      break;
    } catch (error) {
      reviewError = error instanceof Error ? error.message : String(error);
      if (attempt < AGENT_MAX_RETRIES) {
        console.warn(
          `[${itemId}/${repo.name}] ${perspective} review attempt ${attempt + 1} failed for ${task.id}: ${reviewError}, retrying...`
        );
        continue;
      }
    }
  }

  if (!agentSucceeded) {
    const findings = [
      createSyntheticReviewFinding(
        perspective,
        `The ${config.label.toLowerCase()} reviewer failed to complete, so manual confirmation is required before considering this review complete.`,
        `Re-run the ${config.label.toLowerCase()} review and verify the code manually. Last error: ${reviewError}`
      ),
    ];
    return {
      perspective,
      status: 'error',
      findings,
      summary: buildPerspectiveSummary(perspective, 'error', findings, reviewError),
      agentId: lastAgentId,
      hasStructuredSignal: false,
      detail: reviewError,
    };
  }

  // File-based review result detection
  let fileContent: string | null = null;
  try {
    fileContent = await readFile(reviewResultFilePath, 'utf-8');
  } catch {
    // File doesn't exist → approve
  }

  if (!fileContent) {
    return {
      perspective,
      status: 'approve',
      findings: [],
      summary: buildPerspectiveSummary(perspective, 'approve', []),
      agentId: lastAgentId,
      hasStructuredSignal: true,
    };
  }

  // File exists → request_changes
  let parsedResponse: ReviewerResponse | null = null;
  try {
    const parsed = JSON.parse(fileContent);
    if (isReviewerResponse(parsed)) {
      parsedResponse = parsed;
    }
  } catch {
    // JSON parse failed — still request_changes with synthetic finding
  }

  if (parsedResponse) {
    const findings = mapReviewCommentsToFindings(
      repo.name,
      perspective,
      parsedResponse.comments ?? []
    );
    if (findings.length === 0) {
      findings.push(
        createSyntheticReviewFinding(
          perspective,
          `The ${config.label.toLowerCase()} reviewer requested changes but did not provide structured findings. Manual confirmation is required.`,
          `Re-run the ${config.label.toLowerCase()} review or manually inspect the implementation for ${config.label.toLowerCase()} concerns.`
        )
      );
    }

    return {
      perspective,
      status: 'request_changes',
      findings,
      summary: buildPerspectiveSummary(perspective, 'request_changes', findings),
      agentId: lastAgentId,
      hasStructuredSignal: true,
      reviewResultFilePath,
    };
  }

  // File exists but not parseable as ReviewerResponse
  const findings = [
    createSyntheticReviewFinding(
      perspective,
      `The ${config.label.toLowerCase()} reviewer wrote a result file but it could not be parsed as structured output. Manual confirmation is required.`,
      `Re-run the ${config.label.toLowerCase()} review or manually inspect the review result file at: ${reviewResultFilePath}`
    ),
  ];
  return {
    perspective,
    status: 'request_changes',
    findings,
    summary: buildPerspectiveSummary(perspective, 'request_changes', findings),
    agentId: lastAgentId,
    hasStructuredSignal: true,
    reviewResultFilePath,
  };
}

async function runLegacyReviewCycle(
  itemId: string,
  repo: ItemRepositoryConfig,
  task: PlanTask,
  agentWorkdir: string,
  reviewContext: ReviewContextBuildResult,
  reviewCycle: number
): Promise<ReviewCycleResult> {
  const reviewerRole = getRole('reviewer');
  const resolvedSystemPrompt = resolveReviewerSystemPrompt(
    reviewerRole.systemPrompt,
    itemId,
    repo.name,
    task.id,
    reviewCycle
  );
  const reviewerPrompt = composeRepositoryRolePrompt(
    reviewContext.prompt,
    repo.rolePrompts,
    'reviewer'
  );

  const reviewResultFilePath = getReviewResultFilePath(itemId, repo.name, task.id, reviewCycle);
  let reviewError = 'Reviewer failed';
  let agentSucceeded = false;

  for (let attempt = 0; attempt <= AGENT_MAX_RETRIES; attempt++) {
    try {
      await executeAgent<unknown>({
        itemId,
        role: 'review',
        repoName: repo.name,
        currentTask: `${task.id}: review`,
        prompt: reviewerPrompt,
        appendSystemPrompt: resolvedSystemPrompt,
        addDirs: reviewContext.artifactDir ? [reviewContext.artifactDir] : undefined,
        workingDir: agentWorkdir,
        allowedTools: reviewerRole.allowedTools,
        timeoutMs: REVIEW_TIMEOUT_MS,
      });
      agentSucceeded = true;
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

  if (!agentSucceeded) {
    return {
      findings: [],
      overallAssessment: 'needs_fixes',
      summary: '',
      feedbackFiles: [],
      reviewResultFilePaths: [],
      hardFailureMessage: `Review failed for ${repo.name} during task ${task.id}: ${reviewError}`,
    };
  }

  // File-based review result detection
  let fileContent: string | null = null;
  try {
    fileContent = await readFile(reviewResultFilePath, 'utf-8');
  } catch {
    // File doesn't exist → approve
  }

  if (!fileContent) {
    return {
      findings: [],
      overallAssessment: 'pass',
      summary: `Code review passed for ${task.id}`,
      feedbackFiles: [],
      reviewResultFilePaths: [],
    };
  }

  // File exists → request_changes
  let parsedResponse: ReviewerResponse | null = null;
  try {
    const parsed = JSON.parse(fileContent);
    if (isReviewerResponse(parsed)) {
      parsedResponse = parsed;
    }
  } catch {
    // JSON parse failed
  }

  if (parsedResponse) {
    const findings = parsedResponse.comments.map((comment) => ({
      severity: (comment.severity || 'minor') as ReviewFinding['severity'],
      file: comment.file,
      line: comment.line,
      description: comment.comment,
      suggestedFix: comment.suggestedFix || '',
      targetAgent: repo.name,
    }));

    return {
      findings,
      overallAssessment: 'needs_fixes',
      summary: `${parsedResponse.comments.length} issues found for ${task.id}`,
      feedbackFiles: parsedResponse.comments.map((comment) => comment.file).filter(Boolean),
      reviewResultFilePaths: [reviewResultFilePath],
    };
  }

  // File exists but not parseable
  return {
    findings: [],
    overallAssessment: 'needs_fixes',
    summary: `Review result file exists but could not be parsed for ${task.id}`,
    feedbackFiles: [],
    reviewResultFilePaths: [reviewResultFilePath],
  };
}

function shouldIncludeFindingFileInDiff(file: string): boolean {
  return file.trim().length > 0 && !file.startsWith('<');
}

function summarizeAggregatedReviewResults(
  task: PlanTask,
  results: ReviewPerspectiveExecutionResult[],
  findings: ReviewFinding[]
): string {
  const blocking = results.filter((result) => result.status !== 'approve');
  if (blocking.length === 0) {
    return `All review perspectives approved ${task.id}.`;
  }

  const blockingLabels = blocking
    .map((result) => REVIEW_PERSPECTIVE_LABELS[result.perspective])
    .join(', ');

  return `${findings.length} review issue${findings.length === 1 ? '' : 's'} found across ${blocking.length} perspective${blocking.length === 1 ? '' : 's'} (${blockingLabels}) for ${task.id}.`;
}

function buildSyntheticReviewAgentId(
  repoName: string,
  taskId: string,
  reviewCycle: number,
  perspective: ReviewPerspective,
  attempt: number
): string {
  return `review-${repoName}-${taskId}-cycle${reviewCycle}-${perspective}-attempt${attempt}`;
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

type EngineerAttemptResult =
  | { outcome: 'committed'; commitHash: string; filesModified: string[] }
  | { outcome: 'noop' };

interface EngineerWorktreeState {
  commitHash: string;
  porcelain: string;
  dirty: boolean;
  summary: string;
}

interface RunEngineerAttemptOptions {
  itemId: string;
  repoName: string;
  currentTask: string;
  prompt: string;
  appendSystemPrompt: string;
  workingDir: string;
  rolePrompts?: ItemRepositoryConfig['rolePrompts'];
  allowedTools: string[];
  jsonSchema: object;
  timeoutMs: number;
}

function summarizePorcelain(porcelain: string): string {
  return porcelain
    .split('\n')
    .filter(Boolean)
    .slice(0, 5)
    .join(', ');
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

async function executeSuccessfulEngineerAttempt(
  options: RunEngineerAttemptOptions,
  prompt: string,
  resumeSessionId?: string,
  emitErrorEvent: boolean = true
): Promise<{ sessionId?: string }> {
  const composedPrompt = composeRepositoryRolePrompt(
    prompt,
    options.rolePrompts,
    'engineer'
  );

  const { result } = await executeAgent<unknown>({
    itemId: options.itemId,
    role: 'engineer',
    repoName: options.repoName,
    currentTask: options.currentTask,
    prompt: composedPrompt,
    appendSystemPrompt: options.appendSystemPrompt,
    workingDir: options.workingDir,
    allowedTools: options.allowedTools,
    jsonSchema: options.jsonSchema,
    schemaFallbackMode: ENGINEER_SCHEMA_FALLBACK_MODE,
    resumeSessionId,
    emitErrorEvent,
    timeoutMs: options.timeoutMs,
  });

  if (result.usedSchemaFallback) {
    console.warn(
      `[${options.itemId}/${options.repoName}] Engineer output failed schema validation; continuing with fallback result.`
    );
  }

  if (isEngineerFailureOutput(result.output)) {
    throw new Error(`[${options.itemId}/${options.repoName}] Engineer reported failure`);
  }

  return { sessionId: result.sessionId };
}

async function buildCommittedEngineerAttemptResult(
  workingDir: string,
  preAttemptHead: string,
  commitHash: string
): Promise<EngineerAttemptResult> {
  const filesModified = await getGitDiffNameOnly(workingDir, preAttemptHead, commitHash);
  return {
    outcome: 'committed',
    commitHash,
    filesModified,
  };
}

function buildNoCommitFollowUpPrompt(currentTask: string, porcelainSummary: string): string {
  return `## Commit Verification
Your previous response for "${currentTask}" reported success, but Git HEAD did not change and the worktree is still dirty.

Current git status summary:
${porcelainSummary || '<unable to summarize git status>'}

## Required action
Decide which of these is correct, then finish the repository in one of these terminal states:
1. The uncommitted changes are intentional: stage and commit them now.
2. The uncommitted changes are not needed: discard or revert them until \`git status --porcelain\` is empty.

Do not leave the worktree dirty.
Return {"status": "success"} only after either a new commit exists or the worktree is completely clean with no commit required.
Return {"status": "failure"} only if you cannot resolve this yourself.`;
}

async function finalizeNoCommitFollowUpResult(
  options: RunEngineerAttemptOptions,
  preAttemptHead: string
): Promise<EngineerAttemptResult> {
  const state = await getEngineerWorktreeState(options.workingDir);

  if (state.commitHash !== preAttemptHead) {
    if (state.dirty) {
      console.warn(
        `[${options.itemId}/${options.repoName}] Engineer follow-up created commit ${state.commitHash} but left dirty worktree: ${state.summary || '(dirty worktree)'}. Resetting to the new commit and proceeding.`
      );
      await resetRepoForAttempt(options.workingDir, state.commitHash);
    }

    return buildCommittedEngineerAttemptResult(
      options.workingDir,
      preAttemptHead,
      state.commitHash
    );
  }

  if (!state.dirty) {
    console.log(
      `[${options.itemId}/${options.repoName}] Engineer follow-up cleaned the worktree with no new commit. Treating as no-op success.`
    );
    return { outcome: 'noop' };
  }

  console.warn(
    `[${options.itemId}/${options.repoName}] Engineer follow-up still left dirty worktree with no commit: ${state.summary || '(dirty worktree)'}. Resetting to ${preAttemptHead} and proceeding as no-op.`
  );
  await resetRepoForAttempt(options.workingDir, preAttemptHead);
  return { outcome: 'noop' };
}

async function resolveNoCommitEngineerAttempt(
  options: RunEngineerAttemptOptions,
  preAttemptHead: string,
  sessionId?: string
): Promise<EngineerAttemptResult> {
  const initialState = await getEngineerWorktreeState(options.workingDir);
  if (!initialState.dirty) {
    console.log(
      `[${options.itemId}/${options.repoName}] Engineer succeeded with no commit and clean worktree. Treating as no-op success.`
    );
    return { outcome: 'noop' };
  }

  const followUpPrompt = buildNoCommitFollowUpPrompt(options.currentTask, initialState.summary);

  if (sessionId) {
    try {
      await executeSuccessfulEngineerAttempt(options, followUpPrompt, sessionId, false);
      return finalizeNoCommitFollowUpResult(options, preAttemptHead);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[${options.itemId}/${options.repoName}] Same-session engineer follow-up failed for ${options.currentTask}: ${message}. Retrying once in a fresh session.`
      );
    }
  } else {
    console.warn(
      `[${options.itemId}/${options.repoName}] Engineer session id unavailable for ${options.currentTask}. Retrying commit verification in a fresh session.`
    );
  }

  try {
    await executeSuccessfulEngineerAttempt(options, followUpPrompt, undefined, false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[${options.itemId}/${options.repoName}] Fresh-session engineer follow-up failed for ${options.currentTask}: ${message}. Inspecting repo state before proceeding.`
    );
  }

  return finalizeNoCommitFollowUpResult(options, preAttemptHead);
}

async function runEngineerAttemptWithCleanup(
  options: RunEngineerAttemptOptions
): Promise<EngineerAttemptResult> {
  const preAttemptHead = await getGitHead(options.workingDir);
  try {
    const { sessionId } = await executeSuccessfulEngineerAttempt(options, options.prompt);

    const state = await getEngineerWorktreeState(options.workingDir);
    if (state.commitHash === preAttemptHead) {
      return resolveNoCommitEngineerAttempt(options, preAttemptHead, sessionId);
    }

    if (state.dirty) {
      throw new Error(
        `[${options.itemId}/${options.repoName}] Engineer left dirty worktree: ${state.summary}`
      );
    }

    return buildCommittedEngineerAttemptResult(
      options.workingDir,
      preAttemptHead,
      state.commitHash
    );
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

function buildTargetRepoSet(plan: Plan, targetRepos?: string[]): Set<string> {
  return new Set(targetRepos || plan.tasks.map((task) => task.repository));
}

function findTaskStateEntry(
  statesByRepo: Map<string, RepoTaskStateFile>,
  task: PlanTask
): RepoTaskStateTask | undefined {
  return statesByRepo.get(task.repository)?.tasks.find((entry) => entry.id === task.id);
}

function areDependenciesCompleted(
  task: PlanTask,
  taskStateIndex: Map<string, RepoTaskStateTask>,
  planTaskIndex: Map<string, PlanTask>,
  targetRepoSet: Set<string>
): boolean {
  const dependencies = task.dependencies || [];
  return dependencies.every((dependencyId) => {
    const dependencyState = taskStateIndex.get(dependencyId);
    if (dependencyState) {
      return dependencyState.status === 'completed';
    }

    const dependencyTask = planTaskIndex.get(dependencyId);
    if (!dependencyTask) {
      return false;
    }

    return !targetRepoSet.has(dependencyTask.repository);
  });
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

    const taskState = findTaskStateEntry(statesByRepo, task);
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
  const planTaskIndex = buildPlanTaskIndex(plan);
  const targetRepoSet = buildTargetRepoSet(plan, targetRepos);
  for (const task of plan.tasks) {
    if (targetRepos && !targetRepos.includes(task.repository)) {
      continue;
    }

    const taskState = findTaskStateEntry(statesByRepo, task);
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

    if (!areDependenciesCompleted(task, taskStateIndex, planTaskIndex, targetRepoSet)) {
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
  const planTaskIndex = buildPlanTaskIndex(plan);
  const targetRepoSet = buildTargetRepoSet(plan, targetRepos);
  for (const task of plan.tasks) {
    if (targetRepos && !targetRepos.includes(task.repository)) {
      continue;
    }

    const taskState = findTaskStateEntry(statesByRepo, task);
    if (taskState?.status !== 'failed') {
      continue;
    }

    if (!areDependenciesCompleted(task, taskStateIndex, planTaskIndex, targetRepoSet)) {
      continue;
    }

    return task;
  }

  return null;
}

interface SelectedTask {
  task: PlanTask;
  kind: 'review' | 'execute';
}

function selectNormalActionableTask(
  plan: Plan,
  statesByRepo: Map<string, RepoTaskStateFile>,
  targetRepos?: string[]
): SelectedTask | null {
  const reviewTask = selectInReviewTask(plan, statesByRepo, targetRepos);
  if (reviewTask) {
    return { task: reviewTask, kind: 'review' };
  }

  const runnableTask = selectNextRunnableTask(plan, statesByRepo, targetRepos);
  return runnableTask ? { task: runnableTask, kind: 'execute' } : null;
}

function selectActionableTask(
  plan: Plan,
  statesByRepo: Map<string, RepoTaskStateFile>,
  mode: StartWorkersMode,
  targetRepos?: string[]
): SelectedTask | null {
  if (mode === 'all') {
    return selectNormalActionableTask(plan, statesByRepo, targetRepos);
  }

  const failedTask = selectNextFailedTask(plan, statesByRepo, targetRepos);
  if (failedTask) {
    return { task: failedTask, kind: 'execute' };
  }

  return selectNormalActionableTask(plan, statesByRepo, targetRepos);
}

function buildNoActionableWorkersMessage(
  itemId: string,
  plan: Plan,
  statesByRepo: Map<string, RepoTaskStateFile>,
  mode: StartWorkersMode,
  targetRepos?: string[]
): string {
  if (mode === 'retry_failed') {
    const remainingFailedTasks = plan.tasks.filter((task) => {
      if (targetRepos && !targetRepos.includes(task.repository)) {
        return false;
      }
      return findTaskStateEntry(statesByRepo, task)?.status === 'failed';
    });

    if (remainingFailedTasks.length > 0) {
      return `No retryable failed tasks remain for item ${itemId}: ${remainingFailedTasks.map((task) => task.id).join(', ')}`;
    }

    return `No retryable failed tasks remain for item ${itemId}`;
  }

  const remainingTasks = plan.tasks.filter((task) => {
    if (targetRepos && !targetRepos.includes(task.repository)) {
      return false;
    }

    const taskState = findTaskStateEntry(statesByRepo, task);
    return taskState ? taskState.status !== 'completed' : true;
  });

  if (remainingTasks.length > 0) {
    return `No runnable tasks remain for item ${itemId}: ${remainingTasks.map((task) => task.id).join(', ')}`;
  }

  return `No runnable tasks remain for item ${itemId}`;
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
    task.reviewExhausted = undefined;
    task.hooksExhausted = undefined;
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
  commitHash: string,
  options: { reviewExhausted?: boolean; hooksExhausted?: boolean } = {}
): Promise<RepoTaskStateFile> {
  return mutateVisibleTaskState(itemId, repoName, taskId, (task) => {
    task.status = 'completed';
    task.currentPhase = undefined;
    task.completedAt = new Date().toISOString();
    task.lastError = undefined;
    task.commitHash = commitHash;
    if (options.reviewExhausted !== undefined) {
      task.reviewExhausted = options.reviewExhausted ? true : undefined;
    }
    if (options.hooksExhausted !== undefined) {
      task.hooksExhausted = options.hooksExhausted ? true : undefined;
    }
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

async function setTaskHooksExhausted(
  itemId: string,
  repoName: string,
  taskId: string,
  hooksExhausted: boolean
): Promise<RepoTaskStateFile> {
  return mutateRepoTaskState(itemId, repoName, (state) => {
    const task = getRepoTaskEntry(state, taskId);
    task.hooksExhausted = hooksExhausted ? true : undefined;
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

async function runHooks(
  commands: string[],
  cwd: string,
  logDir: string,
  attempt: number,
  timeoutMs: number = HOOK_TIMEOUT_MS
): Promise<HookResult[]> {
  return runShellCommands(commands, cwd, {
    logDir,
    attempt,
    timeoutMs,
  });
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

interface HooksPhaseResult {
  state: RepoTaskStateFile;
  exhausted: boolean;
  hookResults: HookResult[];
}

function summarizeHookFailures(hookResults: HookResult[]): string {
  const failedHooks = hookResults.filter((result) => result.exitCode !== 0);
  if (failedHooks.length === 0) {
    return 'All hooks passed.';
  }

  return failedHooks.map((result) => {
    const parts = [`- ${result.command}`];
    if (result.exitCode !== null) {
      parts.push(`exit=${result.exitCode}`);
    } else if (result.timedOut) {
      parts.push('timed out');
    } else {
      parts.push('execution error');
    }
    if (result.stderrLogPath) {
      parts.push(`stderr=${result.stderrLogPath}`);
    }
    return parts.join(' | ');
  }).join('\n');
}

async function runTaskHooksPhase(
  itemId: string,
  repo: ItemRepositoryConfig,
  task: PlanTask,
  agentWorkdir: string,
  effectiveTools: string[],
  reviewRound: number
): Promise<HooksPhaseResult> {
  const hooks = repo.hooks;
  if (!hooks || hooks.length === 0) {
    const currentState = await readRepoTaskState(itemId, repo.name);
    if (!currentState) {
      throw new Error(`Task state missing for repo ${repo.name}`);
    }
    return { state: currentState, exhausted: false, hookResults: [] };
  }

  const engineerRole = getRole('engineer');
  const hookLogDir = join(getHookLogDir(itemId, repo.name), task.id, `review-round-${reviewRound + 1}`);
  let latestState = await readRepoTaskState(itemId, repo.name);
  if (!latestState) {
    throw new Error(`Task state missing for repo ${repo.name}`);
  }

  const hooksMaxAttempts = resolveHooksMaxAttempts(repo.hooksMaxAttempts);
  let lastHookResults: HookResult[] = [];

  for (let hookAttempt = 1; hookAttempt <= hooksMaxAttempts; hookAttempt++) {
    console.log(
      `[${itemId}/${repo.name}] Running hooks for ${task.id} (attempt ${hookAttempt}/${hooksMaxAttempts})`
    );
    const hookResults = await runHooks(hooks, agentWorkdir, hookLogDir, hookAttempt);
    lastHookResults = hookResults;
    const allPassed = hookResults.every((result) => result.exitCode === 0);

    const hooksEvent = createHooksExecutedEvent(itemId, repo.name, hookResults, allPassed, hookAttempt);
    await appendJsonl(getItemEventsPath(itemId), hooksEvent);
    eventBus.publish(itemId, hooksEvent);

    if (allPassed) {
      latestState = await setTaskHooksExhausted(itemId, repo.name, task.id, false);
      return { state: latestState, exhausted: false, hookResults };
    }

    if (hookAttempt < hooksMaxAttempts) {
      const fixPrompt = buildHooksFixPrompt(hookResults);
      try {
        const committed = await runEngineerAttemptWithCleanup({
          itemId,
          repoName: repo.name,
          currentTask: `${task.id}: hooks-fix`,
          prompt: fixPrompt,
          appendSystemPrompt: engineerRole.systemPrompt,
          workingDir: agentWorkdir,
          rolePrompts: repo.rolePrompts,
          allowedTools: effectiveTools,
          jsonSchema: engineerRole.jsonSchema,
          timeoutMs: ENGINEER_TIMEOUT_MS,
        });
        if (committed.outcome === 'committed') {
          latestState = await mergeTaskFilesModified(
            itemId,
            repo.name,
            task.id,
            committed.filesModified
          );
        }
      } catch (fixError) {
        const fixMsg = fixError instanceof Error ? fixError.message : String(fixError);
        console.error(`[${itemId}/${repo.name}] Hooks fix engineer failed for ${task.id}: ${fixMsg}`);
      }
    }
  }

  latestState = await setTaskHooksExhausted(itemId, repo.name, task.id, true);
  return { state: latestState, exhausted: true, hookResults: lastHookResults };
}

async function runFinalNonFatalHooksPass(
  itemId: string,
  repo: ItemRepositoryConfig,
  task: PlanTask,
  agentWorkdir: string,
  reviewRound: number
): Promise<HooksPhaseResult> {
  const hooks = repo.hooks;
  if (!hooks || hooks.length === 0) {
    const currentState = await setTaskHooksExhausted(itemId, repo.name, task.id, false);
    return { state: currentState, exhausted: false, hookResults: [] };
  }

  const hookLogDir = join(getHookLogDir(itemId, repo.name), task.id, `review-round-${reviewRound + 1}`);
  const hookResults = await runHooks(hooks, agentWorkdir, hookLogDir, 1);
  const allPassed = hookResults.every((result) => result.exitCode === 0);

  const hooksEvent = createHooksExecutedEvent(itemId, repo.name, hookResults, allPassed, 1);
  await appendJsonl(getItemEventsPath(itemId), hooksEvent);
  eventBus.publish(itemId, hooksEvent);

  const currentState = await setTaskHooksExhausted(itemId, repo.name, task.id, !allPassed);
  return { state: currentState, exhausted: !allPassed, hookResults };
}

async function completeTaskAfterReviewExhaustion(
  itemId: string,
  repo: ItemRepositoryConfig,
  task: PlanTask,
  agentWorkdir: string,
  reviewRound: number
): Promise<{ state: RepoTaskStateFile; errorMessage?: string; shouldAbortRun?: boolean }> {
  let finalHooks: HooksPhaseResult;
  try {
    finalHooks = await runFinalNonFatalHooksPass(
      itemId,
      repo,
      task,
      agentWorkdir,
      reviewRound
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = await failTaskWithError(itemId, repo.name, task.id, 'hooks', message);
    return { state: failure.state, errorMessage: failure.errorMessage, shouldAbortRun: false };
  }

  const finalHead = await getGitHead(agentWorkdir);
  const state = await markTaskCompleted(itemId, repo.name, task.id, finalHead, {
    reviewExhausted: true,
    hooksExhausted: finalHooks.exhausted,
  });
  return { state };
}

async function runTaskReviewPhase(
  itemId: string,
  plan: Plan,
  repo: ItemRepositoryConfig,
  task: PlanTask,
  agentWorkdir: string
): Promise<{ state: RepoTaskStateFile; errorMessage?: string; shouldAbortRun?: boolean }> {
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

    let hookPhase: HooksPhaseResult;
    try {
      hookPhase = await runTaskHooksPhase(
        itemId,
        repo,
        task,
        agentWorkdir,
        effectiveTools,
        currentTaskState.reviewRounds || 0
      );
      currentState = hookPhase.state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = await failTaskWithError(itemId, repo.name, task.id, 'hooks', message);
      return { state: failure.state, errorMessage: failure.errorMessage, shouldAbortRun: false };
    }

    currentState = await markTaskInReview(itemId, repo.name, task.id, 'review');

    const taskStateAfterHooks = getRepoTaskEntry(currentState, task.id);
    const reviewCycle = (taskStateAfterHooks.reviewRounds || 0) + 1;
    const phaseBase = taskStateAfterHooks.phaseBase!;
    const currentHead = await getGitHead(agentWorkdir);

    const reviewContext = await buildReviewContext(
      itemId,
      repo.name,
      agentWorkdir,
      phaseBase,
      currentHead,
      task,
      plan,
      reviewCycle,
      hookPhase.exhausted ? summarizeHookFailures(hookPhase.hookResults) : undefined
    );
    const reviewCycleResult: ReviewCycleResult = supportsMultiPerspectiveReviews()
      ? await (async () => {
          const reviewResults = await Promise.all(
            REVIEW_PERSPECTIVE_RUN_ORDER.map((perspective) =>
              runReviewPerspective(
                itemId,
                repo,
                task,
                agentWorkdir,
                reviewContext,
                reviewCycle,
                perspective
              )
            )
          );
          const hasStructuredSignal = reviewResults.some((result) => result.hasStructuredSignal);
          if (!hasStructuredSignal) {
            const detail = reviewResults
              .map((result) => `${REVIEW_PERSPECTIVE_LABELS[result.perspective]}: ${result.detail || result.summary}`)
              .join(' | ');
            return {
              findings: [],
              overallAssessment: 'needs_fixes',
              summary: '',
              feedbackFiles: [],
              reviewResultFilePaths: [],
              hardFailureMessage: `All review perspectives failed for ${repo.name} during task ${task.id}: ${detail}`,
            };
          }

          const findings = sortReviewFindings(
            reviewResults.flatMap((result) => result.findings)
          );
          const reviewResultFilePaths = reviewResults
            .map((result) => result.reviewResultFilePath)
            .filter((filePath): filePath is string => filePath !== undefined);
          return {
            findings,
            overallAssessment: reviewResults.every((result) => result.status === 'approve')
              ? 'pass'
              : 'needs_fixes',
            summary: summarizeAggregatedReviewResults(task, reviewResults, findings),
            perspectives: reviewResults.map(buildReviewPerspectiveSummary),
            feedbackFiles: findings
              .map((finding) => finding.file)
              .filter(shouldIncludeFindingFileInDiff),
            reviewResultFilePaths,
          };
        })()
      : await runLegacyReviewCycle(itemId, repo, task, agentWorkdir, reviewContext, reviewCycle);

    if (reviewCycleResult.hardFailureMessage) {
      const failure = await failTaskWithError(
        itemId,
        repo.name,
        task.id,
        'review',
        reviewCycleResult.hardFailureMessage
      );
      return { state: failure.state, errorMessage: failure.errorMessage, shouldAbortRun: true };
    }

    const findings = reviewCycleResult.findings;
    const findingsEvent = createReviewFindingsExtractedEvent(
      itemId,
      `review-${repo.name}-${task.id}-cycle${reviewCycle}`,
      repo.name,
      findings,
      reviewCycleResult.overallAssessment,
      reviewCycleResult.summary,
      reviewCycleResult.perspectives
    );
    await appendJsonl(getItemEventsPath(itemId), findingsEvent);
    eventBus.publish(itemId, findingsEvent);

    if (reviewCycleResult.overallAssessment === 'pass') {
      currentState = await markTaskCompleted(itemId, repo.name, task.id, currentHead, {
        hooksExhausted: taskStateAfterHooks.hooksExhausted,
      });
      return { state: currentState };
    }

    const completedFeedbackRounds = taskStateAfterHooks.reviewRounds || 0;
    const isFinalFeedbackRound = completedFeedbackRounds + 1 >= MAX_FEEDBACK_ROUNDS;

    // Safety: reset worktree to discard any changes reviewers may have made via Write tool.
    // Review result files are stored outside the git repository ({itemDir}/reviews/) and
    // are not affected by this reset.
    await resetRepoForAttempt(agentWorkdir);
    const currentHeadAfterReset = await getGitHead(agentWorkdir);

    let feedbackDiff: string;
    try {
      const commentFiles = [...new Set(reviewCycleResult.feedbackFiles)];
      feedbackDiff = await getGitDiff(
        agentWorkdir,
        phaseBase,
        currentHeadAfterReset,
        commentFiles.length > 0 ? commentFiles : undefined
      );
    } catch {
      feedbackDiff = '<unable to generate diff>';
    }

    const feedbackPrompt = buildFeedbackPrompt(plan, repo, reviewCycleResult.reviewResultFilePaths, feedbackDiff, [task]);

    let feedbackError = 'Feedback engineer failed';
    let feedbackSucceeded = false;
    for (let feedbackAttempt = 0; feedbackAttempt <= AGENT_MAX_RETRIES; feedbackAttempt++) {
      try {
        const committed = await runEngineerAttemptWithCleanup({
          itemId,
          repoName: repo.name,
          currentTask: `${task.id}: review-fix`,
          prompt: feedbackPrompt,
          appendSystemPrompt: engineerRole.systemPrompt,
          workingDir: agentWorkdir,
          rolePrompts: repo.rolePrompts,
          allowedTools: effectiveTools,
          jsonSchema: engineerRole.jsonSchema,
          timeoutMs: ENGINEER_TIMEOUT_MS,
        });
        if (committed.outcome === 'committed') {
          currentState = await mergeTaskFilesModified(
            itemId,
            repo.name,
            task.id,
            committed.filesModified
          );
        }
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

    if (isFinalFeedbackRound) {
      const finalTaskState = getRepoTaskEntry(currentState, task.id);
      return completeTaskAfterReviewExhaustion(
        itemId,
        repo,
        task,
        agentWorkdir,
        finalTaskState.reviewRounds || 0
      );
    }
  }
}

// ─── Main orchestration ───

interface StartWorkersOptions {
  targetRepos?: string[];
  mode?: StartWorkersMode;
}

export async function validateWorkerStartPreconditions(
  itemId: string,
  options: StartWorkersOptions = {}
): Promise<void> {
  const plan = await getPlan(itemId);
  if (!plan) {
    throw new WorkerStartValidationError(`No plan found for item ${itemId}`);
  }

  const itemConfig = await getItemConfig(itemId);
  if (!itemConfig) {
    throw new WorkerStartValidationError(`Item config not found for ${itemId}`);
  }

  const targetRepos = options.targetRepos;
  const mode = options.mode || 'all';
  const configuredRepos = new Set(itemConfig.repositories.map((repo) => repo.name));
  const unknownRepos = (targetRepos || []).filter((repoName) => !configuredRepos.has(repoName));
  if (unknownRepos.length > 0) {
    throw new WorkerStartValidationError(
      `Repository config not found for ${unknownRepos.join(', ')}`
    );
  }

  await ensureTaskStatesForPlan(itemId, plan);

  const tasksByRepo = new Set(plan.tasks.map((task) => task.repository));
  const statesByRepo = new Map<string, RepoTaskStateFile>();
  for (const repo of itemConfig.repositories) {
    if (targetRepos && !targetRepos.includes(repo.name)) {
      continue;
    }
    if (!tasksByRepo.has(repo.name)) {
      continue;
    }

    const state = await readRepoTaskState(itemId, repo.name);
    if (!state) {
      continue;
    }
    statesByRepo.set(repo.name, reconcileStoppedRepoTaskState(state).state);
  }

  const initialActionableTask = mode === 'retry_failed'
    ? selectNextFailedTask(plan, statesByRepo, targetRepos)
    : selectActionableTask(plan, statesByRepo, mode, targetRepos);

  if (!initialActionableTask) {
    throw new WorkerStartValidationError(
      buildNoActionableWorkersMessage(itemId, plan, statesByRepo, mode, targetRepos)
    );
  }
}

export async function startWorkers(itemId: string, options: StartWorkersOptions = {}): Promise<void> {
  const plan = await getPlan(itemId);
  if (!plan) {
    throw new Error(`No plan found for item ${itemId}`);
  }

  await ensureApprovedTestPlan(itemId);

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
    const reconciledState = await reconcileStoppedRepoTaskStateForItem(itemId, repo.name);
    if (!reconciledState) {
      continue;
    }
    statesByRepo.set(repo.name, reconciledState.state);
  }

  let failedTaskMessage: string | null = null;
  while (true) {
    const selectedTask = selectActionableTask(plan, statesByRepo, mode, targetRepos);
    if (!selectedTask) {
      break;
    }
    const nextTask = selectedTask.task;
    const isReviewTask = selectedTask.kind === 'review';

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
    let skipReview = false;
    if (!isReviewTask) {
      console.log(
        `[${itemId}/${repo.name}] Starting task ${taskIndex + 1}/${repoTasks.length}: ${nextTask.id} - ${nextTask.title}`
      );
      await resetRepoForAttempt(agentWorkdir);
      const phaseBase = await getGitHead(agentWorkdir);
      const inProgressState = await markTaskInProgress(itemId, repo.name, nextTask.id, phaseBase);
      statesByRepo.set(repo.name, inProgressState);

      const prompt = buildWorkerContext('engineer', repo.name, [nextTask]);

      let taskSucceeded = false;
      let lastError = 'Engineer failed';
      for (let attempt = 0; attempt <= AGENT_MAX_RETRIES; attempt++) {
        try {
          const committed = await runEngineerAttemptWithCleanup({
            itemId,
            repoName: repo.name,
            currentTask: `${nextTask.id}: ${nextTask.title}`,
            prompt,
            appendSystemPrompt: engineerRole.systemPrompt,
            workingDir: agentWorkdir,
            rolePrompts: repo.rolePrompts,
            allowedTools: effectiveTools,
            jsonSchema: engineerRole.jsonSchema,
            timeoutMs: ENGINEER_TIMEOUT_MS,
          });

          if (committed.outcome === 'noop') {
            const completedState = await markTaskCompleted(
              itemId,
              repo.name,
              nextTask.id,
              await getGitHead(agentWorkdir)
            );
            statesByRepo.set(repo.name, completedState);
            taskSucceeded = true;
            skipReview = true;
            break;
          }

          if (committed.outcome === 'committed') {
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
          }
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

    if (!skipReview) {
      const reviewResult = await runTaskReviewPhase(itemId, plan, repo, nextTask, agentWorkdir);
      statesByRepo.set(repo.name, reviewResult.state);
      if (reviewResult.errorMessage) {
        if (reviewResult.shouldAbortRun === false) {
          continue;
        }
        failedTaskMessage = reviewResult.errorMessage;
        break;
      }
    }

  }

  if (failedTaskMessage) {
    throw new Error(failedTaskMessage);
  }

  if (mode === 'retry_failed') {
    const remainingFailedTasks = plan.tasks.filter((task) => {
      if (targetRepos && !targetRepos.includes(task.repository)) {
        return false;
      }
      return findTaskStateEntry(statesByRepo, task)?.status === 'failed';
    });

    if (remainingFailedTasks.length > 0) {
      throw new Error(
        `No retryable failed tasks remain for item ${itemId}: ${remainingFailedTasks.map((task) => task.id).join(', ')}`
      );
    }
  }

  const remainingTasks = plan.tasks.filter((task) => {
    if (targetRepos && !targetRepos.includes(task.repository)) {
      return false;
    }
    const taskState = findTaskStateEntry(statesByRepo, task);
    return taskState ? taskState.status !== 'completed' : true;
  });

  if (remainingTasks.length > 0) {
    throw new Error(
      `No runnable tasks remain for item ${itemId}: ${remainingTasks.map((task) => task.id).join(', ')}`
    );
  }

  await maybeStartCompletedReviewAfterTasks(itemId);
}

function buildWorkerContext(
  role: AgentRole,
  repoName: string,
  tasks: PlanTask[]
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

function sanitizeReviewArtifactName(filePath: string): string {
  return filePath
    .replace(/[\\/]/g, '__')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
}

function truncateReviewArtifactDiff(diff: string): { content: string; truncated: boolean; note?: string } {
  const lines = diff.split('\n');
  let content = diff;
  const notes: string[] = [];

  if (lines.length > MAX_REVIEW_ARTIFACT_DIFF_LINES) {
    content = lines.slice(0, MAX_REVIEW_ARTIFACT_DIFF_LINES).join('\n');
    notes.push(`truncated at ${MAX_REVIEW_ARTIFACT_DIFF_LINES} lines (total ${lines.length})`);
  }

  if (content.length > MAX_REVIEW_ARTIFACT_DIFF_CHARS) {
    content = content.slice(0, MAX_REVIEW_ARTIFACT_DIFF_CHARS);
    notes.push(`truncated at ${MAX_REVIEW_ARTIFACT_DIFF_CHARS} chars`);
  }

  if (notes.length === 0) {
    return { content, truncated: false };
  }

  return {
    content: `${content}\n\n<artifact ${notes.join(', ')}>\n`,
    truncated: true,
    note: notes.join(', '),
  };
}

function describeChangedFile(file: ChangedFileInfo): string {
  switch (file.status) {
    case 'A':
      return `[ADDED] ${file.path}`;
    case 'D':
      return `[DELETED] ${file.path}`;
    case 'R':
      return `[RENAMED] ${file.oldPath} -> ${file.path}`;
    case 'C':
      return `[COPIED] ${file.oldPath} -> ${file.path}`;
    case 'M':
      return `[MODIFIED] ${file.path}`;
    default:
      return `[${file.status}] ${file.path}`;
  }
}

interface ReviewArtifactEntry {
  file: ChangedFileInfo;
  relativePath: string;
  absolutePath: string;
  truncated: boolean;
  note?: string;
}

export async function generateTaskReviewArtifacts(
  itemId: string,
  repoName: string,
  agentWorkdir: string,
  phaseBase: string,
  currentHead: string,
  reviewTask: PlanTask,
  plan: Plan,
  reviewRound: number,
  hookWarningSummary?: string
): Promise<{
  artifactDir: string;
  indexPath: string;
  changedFiles: ChangedFileInfo[];
  entries: ReviewArtifactEntry[];
}> {
  const artifactDir = getTaskReviewArtifactsDir(itemId, repoName, reviewTask.id, reviewRound);
  const indexPath = getTaskReviewArtifactIndexPath(itemId, repoName, reviewTask.id, reviewRound);
  await mkdir(artifactDir, { recursive: true });

  const changedFiles = await getChangedFiles(agentWorkdir, phaseBase, currentHead);
  const entries: ReviewArtifactEntry[] = [];

  for (const [index, file] of changedFiles.entries()) {
    const relativePath = `${String(index + 1).padStart(3, '0')}-${sanitizeReviewArtifactName(file.path)}.diff`;
    const absolutePath = join(artifactDir, relativePath);
    let diffContent: string;
    try {
      diffContent = await getGitDiff(agentWorkdir, phaseBase, currentHead, [file.path]);
    } catch {
      diffContent = '<unable to generate diff>';
    }

    const { content, truncated, note } = truncateReviewArtifactDiff(diffContent);
    await writeFile(absolutePath, content, 'utf-8');
    entries.push({
      file,
      relativePath,
      absolutePath,
      truncated,
      note,
    });
  }

  const relevantPlan = {
    summary: plan.summary,
    tasks: plan.tasks.filter((task) => task.id === reviewTask.id),
  };
  const planContent = stringifyYaml(relevantPlan);
  const changedFileLines = changedFiles.length === 0
    ? ['- No file changes detected between phase base and current HEAD.']
    : entries.map((entry) => {
        const suffix = entry.note ? ` (${entry.note})` : '';
        return `- ${describeChangedFile(entry.file)} -> \`${entry.relativePath}\`${suffix}`;
      });

  const indexContent = [
    `# Review Artifacts for ${repoName}/${reviewTask.id}`,
    '',
    `- Repository: ${repoName}`,
    `- Task: ${reviewTask.id} - ${reviewTask.title}`,
    `- Review Round: ${reviewRound}`,
    `- Phase Base: ${phaseBase}`,
    `- Current HEAD: ${currentHead}`,
    '',
    hookWarningSummary
      ? `## Hook Status Warning\n${hookWarningSummary}\n`
      : null,
    '## Plan',
    '```yaml',
    planContent,
    '```',
    '',
    '## Implemented Task',
    reviewTask.description,
    '',
    '## Changed Files',
    ...changedFileLines,
    '',
    'Read the diff files above for the exact task-scoped patch content.',
    '',
  ].filter((line): line is string => line !== null);

  await writeFile(indexPath, indexContent.join('\n'), 'utf-8');

  return {
    artifactDir,
    indexPath,
    changedFiles,
    entries,
  };
}

async function buildReviewContext(
  itemId: string,
  repoName: string,
  agentWorkdir: string,
  phaseBase: string,
  currentHead: string,
  reviewTask: PlanTask,
  plan: Plan,
  reviewRound: number,
  hookWarningSummary?: string
): Promise<ReviewContextBuildResult> {
  const taskDescriptions = `### Task: ${reviewTask.id} - ${reviewTask.title}
${reviewTask.description}`;

  // Build plan excerpt for the current review task only
  const relevantPlan = {
    summary: plan.summary,
    tasks: plan.tasks.filter(t => t.id === reviewTask.id),
  };
  const planContent = stringifyYaml(relevantPlan);

  try {
    const artifacts = await generateTaskReviewArtifacts(
      itemId,
      repoName,
      agentWorkdir,
      phaseBase,
      currentHead,
      reviewTask,
      plan,
      reviewRound,
      hookWarningSummary
    );
    const changedFilesSection = artifacts.changedFiles.length === 0
      ? 'No file changes detected between phase start and current HEAD.'
      : [
          'Read the review artifact index first, then open only the diff files you need.',
          `Artifact index: ${artifacts.indexPath}`,
          ...artifacts.entries.map((entry) => `- ${describeChangedFile(entry.file)} (${entry.relativePath})`),
        ].join('\n');

    return {
      prompt: `## Repository: ${repoName}

${hookWarningSummary ? `## Hook Status Warning
Hooks exhausted their allowed attempts before this review. Review the current code with that context.

${hookWarningSummary}

` : ''}## Plan
\`\`\`yaml
${planContent}
\`\`\`

## Changed Files
${changedFilesSection}

## Implemented Tasks

${taskDescriptions}`,
      artifactDir: artifacts.artifactDir,
    };
  } catch {
    return {
      prompt: `## Repository: ${repoName}

${hookWarningSummary ? `## Hook Status Warning
Hooks exhausted their allowed attempts before this review. Review the current code with that context.

${hookWarningSummary}

` : ''}## Plan
\`\`\`yaml
${planContent}
\`\`\`

## Changed Files
<unable to determine changed files>

If review artifacts become available, read the artifact index first and then inspect only the necessary diff files.

## Implemented Tasks

${taskDescriptions}`,
    };
  }
}

export function buildFeedbackPrompt(
  _plan: Plan,
  repo: ItemRepositoryConfig,
  reviewResultFilePaths: string[],
  diff: string,
  originalTasks: PlanTask[]
): string {
  const taskList = originalTasks
    .map(t => `- ${t.id}: ${t.title}`)
    .join('\n');

  const reviewFilesSection = reviewResultFilePaths.length > 0
    ? reviewResultFilePaths.map(p => `- ${p}`).join('\n')
    : '- No review result files available';

  const context = `## Working on: ${repo.name}

## Original Tasks
${taskList}

## Review Feedback
The previous implementation was reviewed and changes were requested.

Review result files (read each file to understand the issues):
${reviewFilesSection}

## Current Changes (git diff from phase start)
\`\`\`diff
${diff}
\`\`\`

## Instructions
Read the review result files above, then address all review findings.
Please fix all issues, commit your intentional changes, and return status.
Before returning, stage your intentional fixes with \`git add -A -- <paths>\`, create a commit with \`git commit -m "<message>"\`, and ensure \`git status --porcelain\` is empty.
Return {"status": "success"} when done.
If you encounter an error, return {"status": "failure"}.`;

  return context;
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
