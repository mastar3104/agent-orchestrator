import { existsSync } from 'fs';
import type {
  ItemEvent,
  PrCreatedEvent,
  ReviewReceiveCompletedEvent,
} from '@agent-orch/shared';
import { executeAgent, getAgentsByItem, generateAgentId } from './agent-service';
import { getItemConfig } from './item-service';
import { deriveRepoStatuses } from './state-service';
import { readJsonl, appendJsonl } from '../lib/jsonl';
import { getItemEventsPath, getItemPlanPath, getWorkspaceRoot } from '../lib/paths';
import { createReviewReceiveStartedEvent, createReviewReceiveCompletedEvent, createErrorEvent } from '../lib/events';
import { eventBus } from './event-bus';
import { fetchPrComments, execGitInRepo } from './git-pr-service';
import { getRepoWorkspaceDir } from '../lib/paths';
import { type ReviewReceiverResponse } from '../lib/claude-schemas';
import { getRole } from '../lib/role-loader';
import { archiveCurrentExecutionArtifacts, finalizeGeneratedPlan } from './planner-service';

/**
 * 指定されたItemのPR情報を取得する（repoName でフィルタ可能）
 */
async function getPrInfo(
  itemId: string,
  repoName?: string
): Promise<{ prNumber: number; prUrl: string; repoName: string } | null> {
  const events = await readJsonl<ItemEvent>(getItemEventsPath(itemId));

  const prEvents = events.filter(
    (e): e is PrCreatedEvent => e.type === 'pr_created'
  );

  if (prEvents.length === 0) {
    return null;
  }

  if (repoName) {
    const filtered = prEvents.filter(e => e.repoName === repoName);
    if (filtered.length === 0) return null;
    const latest = filtered[filtered.length - 1];
    return { prNumber: latest.prNumber, prUrl: latest.prUrl, repoName: latest.repoName };
  }

  const latestPr = prEvents[prEvents.length - 1];
  return { prNumber: latestPr.prNumber, prUrl: latestPr.prUrl, repoName: latestPr.repoName };
}

/**
 * 対応済みコメントのカットオフ日時を取得
 * イベントログから該当repoの review_receive_completed イベントを逆順で探索し、
 * commentsCutoffAt フィールドを返す。初回（イベントなし）は null を返す。
 */
async function getCommentsCutoffAt(
  itemId: string,
  repoName: string
): Promise<string | null> {
  const events = await readJsonl<ItemEvent>(getItemEventsPath(itemId));

  // 逆順で探索し、該当repoの有効なカットオフを見つける
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (
      e.type === 'review_receive_completed' &&
      (e as ReviewReceiveCompletedEvent).repoName === repoName
    ) {
      const cutoff = (e as ReviewReceiveCompletedEvent).commentsCutoffAt;
      if (cutoff !== null) {
        return cutoff;
      }
      // commentsCutoffAt が null のイベントはスキップし、直前の有効なカットオフを探す
    }
  }

  return null;
}

type RepoResolution =
  | { kind: 'none' }
  | { kind: 'single'; repoName: string }
  | { kind: 'multiple'; repoNames: string[] };

async function resolveTargetRepo(itemId: string, repoName?: string): Promise<RepoResolution> {
  const events = await readJsonl<ItemEvent>(getItemEventsPath(itemId));
  const prEvents = events.filter((e): e is PrCreatedEvent => e.type === 'pr_created');

  if (repoName) {
    const hasPr = prEvents.some(e => e.repoName === repoName);
    return hasPr ? { kind: 'single', repoName } : { kind: 'none' };
  }

  const uniquePrRepos = [...new Set(prEvents.map(e => e.repoName))];
  if (uniquePrRepos.length === 0) return { kind: 'none' };
  if (uniquePrRepos.length === 1) return { kind: 'single', repoName: uniquePrRepos[0] };
  return { kind: 'multiple', repoNames: uniquePrRepos };
}

/**
 * Review Receive 開始可能なステータスかを検証 (常に repo-level)
 */
async function validateRepoStatusForReviewReceive(itemId: string, repoName: string): Promise<void> {
  const repoStatuses = await deriveRepoStatuses(itemId);
  const repoState = repoStatuses.get(repoName);
  if (!repoState) {
    throw new ReviewReceiveValidationError(`Repository '${repoName}' not found`);
  }
  const allowedStatuses: import('@agent-orch/shared').RepoStatus[] = ['completed', 'error'];
  if (!allowedStatuses.includes(repoState.status)) {
    throw new ReviewReceiveValidationError(
      `Cannot start Review Receive: repo '${repoName}' is in '${repoState.status}' status.`
    );
  }
}

/**
 * 重複起動チェック
 */
async function checkDuplicateExecution(itemId: string): Promise<void> {
  const agents = await getAgentsByItem(itemId);
  const runningReviewReceiver = agents.find(
    (a) =>
      a.role === 'review-receiver' &&
      a.status === 'running'
  );

  if (runningReviewReceiver) {
    throw new ReviewReceiveValidationError(
      'Review Receive is already in progress. Please wait for it to complete or stop it first.'
    );
  }
}

export class ReviewReceiveValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewReceiveValidationError';
  }
}

/**
 * Format PR comments for injection into prompt
 */
function formatPrComments(
  comments: { author: string; body: string; path?: string; line?: number; createdAt: string }[]
): string {
  if (comments.length === 0) {
    return 'No PR comments found.';
  }

  return comments
    .map((c, i) => {
      let header = `### Comment ${i + 1} by @${c.author} (${c.createdAt})`;
      if (c.path) {
        header += ` on \`${c.path}\``;
        if (c.line) {
          header += `:${c.line}`;
        }
      }
      return `${header}\n${c.body}`;
    })
    .join('\n\n');
}

function buildReviewReceiverContext(
  projectName: string,
  repoName: string,
  prNumber: number,
  prUrl: string,
  itemId: string,
  repositories: { name: string; type: string }[],
  formattedComments: string
): string {
  const repoList = repositories
    .map(r => `- **${r.name}** (type: ${r.type})`)
    .join('\n');

  return `## Context

**Project Name:** ${projectName}
**Target Repository:** ${repoName}
**PR Number:** ${prNumber}
**PR URL:** ${prUrl}
**Item ID:** ${itemId}

**All Repositories:**
${repoList}

## PR Review Comments

${formattedComments}`;
}

/**
 * Review Receive プロセスを開始する
 */
/**
 * バリデーションのみを実行（ルートハンドラーで事前チェック用）
 * fire-and-forget パターンで 202 返却前にバリデーションエラーを返すために使用
 */
export async function validateReviewReceivePreConditions(
  itemId: string,
  repoName?: string
): Promise<void> {
  const config = await getItemConfig(itemId);
  if (!config) {
    throw new ReviewReceiveValidationError(`Item ${itemId} not found`);
  }

  // 1. Repo resolution (before status validation)
  const resolution = await resolveTargetRepo(itemId, repoName);
  if (resolution.kind === 'none') {
    const repoMsg = repoName ? ` for repository '${repoName}'` : '';
    throw new ReviewReceiveValidationError(
      `No PR found${repoMsg} for item ${itemId}. Please create a PR first.`
    );
  }
  if (resolution.kind === 'multiple') {
    throw new ReviewReceiveValidationError(
      `Multiple repos have PRs (${resolution.repoNames.join(', ')}). Please specify a repo name.`
    );
  }

  // 2. Status validation (always repo-level)
  await validateRepoStatusForReviewReceive(itemId, resolution.repoName);

  // 3. Duplicate execution check
  await checkDuplicateExecution(itemId);
}

/**
 * Review Receive プロセスを開始する
 * NOTE: withItemLock はルートハンドラー側で適用するため、内部では使用しない
 */
export async function startReviewReceive(
  itemId: string,
  repoName?: string
): Promise<{ started: boolean; prNumber: number; repoName: string }> {
  const config = await getItemConfig(itemId);
  if (!config) {
    throw new ReviewReceiveValidationError(`Item ${itemId} not found`);
  }

  // Repo resolution → status validation → duplicate check
  const resolution = await resolveTargetRepo(itemId, repoName);
  if (resolution.kind === 'none') {
    const repoMsg = repoName ? ` for repository '${repoName}'` : '';
    throw new ReviewReceiveValidationError(
      `No PR found${repoMsg} for item ${itemId}. Please create a PR first.`
    );
  }
  if (resolution.kind === 'multiple') {
    throw new ReviewReceiveValidationError(
      `Multiple repos have PRs (${resolution.repoNames.join(', ')}). Please specify a repo name.`
    );
  }

  await validateRepoStatusForReviewReceive(itemId, resolution.repoName);
  await checkDuplicateExecution(itemId);

  const prInfo = await getPrInfo(itemId, resolution.repoName);
  if (!prInfo) {
    throw new ReviewReceiveValidationError(
      `No PR found for repository '${resolution.repoName}' in item ${itemId}.`
    );
  }

  const targetRepoName = prInfo.repoName;
  const workspaceRoot = getWorkspaceRoot(itemId);
  const eventsPath = getItemEventsPath(itemId);

  // Pre-generate agent ID
  const agentId = generateAgentId(itemId, 'review-receiver', targetRepoName);

  // Record review_receive_started event
  const startEvent = createReviewReceiveStartedEvent(
    itemId,
    agentId,
    targetRepoName,
    prInfo.prNumber,
    prInfo.prUrl
  );
  await appendJsonl(eventsPath, startEvent);
  eventBus.emit('event', { itemId, event: startEvent });

  // Get cutoff for filtering already-handled comments
  const cutoffAt = await getCommentsCutoffAt(itemId, targetRepoName);

  // Sync workspace with remote before starting review receive
  const repoDir = getRepoWorkspaceDir(itemId, targetRepoName);
  try {
    const currentBranch = await execGitInRepo(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir);
    await execGitInRepo(['pull', '--rebase', 'origin', currentBranch], repoDir);
    console.log(`[${itemId}/${targetRepoName}] Git pull --rebase succeeded`);
  } catch (error) {
    console.warn(`[${itemId}/${targetRepoName}] Git pull --rebase failed: ${error}, continuing anyway`);
  }

  // Fetch PR comments via orchestrator (NOT via Claude)
  let allPrComments;
  try {
    allPrComments = await fetchPrComments(repoDir, prInfo.prNumber);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorEvent = createErrorEvent(itemId, message.slice(0, 500), { repoName: targetRepoName, phase: 'review_receive' });
    await appendJsonl(eventsPath, errorEvent);
    eventBus.emit('event', { itemId, event: errorEvent });
    throw error;
  }

  // Filter by cutoff (strict >; comments at cutoff time are already handled)
  const newPrComments = cutoffAt
    ? allPrComments.filter(c => new Date(c.createdAt).getTime() > new Date(cutoffAt).getTime())
    : allPrComments;

  // Compute commentsCutoffAt: max(allFetchedComments.createdAt) — sort済みなので末尾が最新
  const commentsCutoffAt = allPrComments.length > 0
    ? allPrComments[allPrComments.length - 1].createdAt
    : null;

  // Early return if no new comments
  if (newPrComments.length === 0) {
    console.log(`[${itemId}/${targetRepoName}] No new PR comments since ${cutoffAt ?? 'initial'}. Skipping agent execution.`);
    const completedEvent = createReviewReceiveCompletedEvent(
      itemId, agentId, targetRepoName, prInfo.prNumber,
      commentsCutoffAt, allPrComments.length, 0, allPrComments.length
    );
    await appendJsonl(eventsPath, completedEvent);
    eventBus.emit('event', { itemId, event: completedEvent });
    return { started: true, prNumber: prInfo.prNumber, repoName: targetRepoName };
  }

  // Archive current plan (only when we have new comments to process)
  const archived = await archiveCurrentExecutionArtifacts(itemId);
  if (archived.archivedPlanPaths.length > 0 || archived.archivedTaskStatePaths.length > 0) {
    console.log(
      `[${itemId}] Archived previous execution artifacts: ${[
        ...archived.archivedPlanPaths,
        ...archived.archivedTaskStatePaths,
      ].join(', ')}`
    );
  }

  const formattedComments = formatPrComments(newPrComments);

  // Build prompt with pre-fetched comments
  const role = getRole('reviewReceiver');
  const context = buildReviewReceiverContext(
    config.name,
    targetRepoName,
    prInfo.prNumber,
    prInfo.prUrl,
    itemId,
    config.repositories,
    formattedComments
  );
  const prompt = `${role.promptTemplate}\n\n${context}`;

  // Execute review-receiver agent (NO Bash access)
  await executeAgent<ReviewReceiverResponse>({
    itemId,
    role: 'review-receiver',
    repoName: targetRepoName,
    prompt,
    workingDir: workspaceRoot,
    agentId,
    allowedTools: role.allowedTools,
    jsonSchema: role.jsonSchema,
  });

  if (existsSync(getItemPlanPath(itemId))) {
    await finalizeGeneratedPlan(itemId, config, { allowEmptyTasks: true });
  }

  // Record review_receive_completed after successful agent execution
  const completedEvent = createReviewReceiveCompletedEvent(
    itemId, agentId, targetRepoName, prInfo.prNumber,
    commentsCutoffAt, allPrComments.length, newPrComments.length, allPrComments.length - newPrComments.length
  );
  await appendJsonl(eventsPath, completedEvent);
  eventBus.emit('event', { itemId, event: completedEvent });

  return { started: true, prNumber: prInfo.prNumber, repoName: targetRepoName };
}
