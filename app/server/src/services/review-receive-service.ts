import { existsSync } from 'fs';
import { rename } from 'fs/promises';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';
import type {
  ItemEvent,
  PrCreatedEvent,
  ItemStatus,
} from '@agent-orch/shared';
import { startAgent, getAgentsByItem, generateAgentId } from './agent-service';
import { getItemConfig } from './item-service';
import { deriveItemStatus } from './state-service';
import { readJsonl, appendJsonl } from '../lib/jsonl';
import { getItemEventsPath, getItemPlanPath, getWorkspaceRoot } from '../lib/paths';
import { createReviewReceiveStartedEvent } from '../lib/events';
import { eventBus } from './event-bus';
import { watchForPlan } from './planner-service';

/**
 * Item単位のキュー化ロック
 */
const itemLockChains = new Map<string, Promise<void>>();

async function withItemLock<T>(itemId: string, fn: () => Promise<T>): Promise<T> {
  const previousChain = itemLockChains.get(itemId) ?? Promise.resolve();

  let resolve: () => void;
  const newChain = new Promise<void>((r) => {
    resolve = r;
  });

  itemLockChains.set(itemId, newChain);

  try {
    await previousChain;
    return await fn();
  } finally {
    resolve!();

    if (itemLockChains.get(itemId) === newChain) {
      itemLockChains.delete(itemId);
    }
  }
}

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
 * 現在のplan.yamlをタイムスタンプ+ランダムサフィックス付きファイル名でアーカイブ
 * plan.yaml は workspace root にのみ存在
 */
async function archiveCurrentPlan(itemId: string): Promise<string[]> {
  const archivedPaths: string[] = [];

  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '_')
    .replace(/\.\d{3}Z$/, `_${String(now.getMilliseconds()).padStart(3, '0')}`);

  const randomSuffix = randomBytes(3).toString('hex');
  const archiveFilename = `plan_${timestamp}_${randomSuffix}.yaml`;

  // workspace root の plan.yaml をアーカイブ
  const planPath = getItemPlanPath(itemId);
  if (existsSync(planPath)) {
    const archivePath = join(dirname(planPath), archiveFilename);
    await rename(planPath, archivePath);
    archivedPaths.push(archivePath);
  }

  return archivedPaths;
}

/**
 * Review Receive 開始可能なステータスかを検証
 */
async function validateStatusForReviewReceive(itemId: string): Promise<void> {
  const status = await deriveItemStatus(itemId);

  const allowedStatuses: ItemStatus[] = ['completed', 'error'];
  if (!allowedStatuses.includes(status)) {
    throw new ReviewReceiveValidationError(
      `Cannot start Review Receive: item is in '${status}' status. ` +
        `Allowed statuses: ${allowedStatuses.join(', ')}`
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
      (a.status === 'running' || a.status === 'waiting_approval')
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

const REVIEW_RECEIVER_PROMPT_TEMPLATE = `You are a review receiver agent. Your task is to fetch PR review comments and create a plan to address them.

## Context

**Project Name:** {{name}}
**Target Repository:** {{repoName}}
**PR Number:** {{prNumber}}
**PR URL:** {{prUrl}}

**All Repositories:**
{{repositories}}

**Repository-Role Mapping:**
{{repoRoleMapping}}

## Instructions

1. Execute the /pr-comments skill to fetch PR review comments:
   /pr-comments {{prNumber}}

2. Analyze each comment to determine if it requires code changes:
   - Address: Requests for changes, bug reports, improvements, architectural feedback
   - Skip: Questions already answered, approvals, minor style preferences without substance

3. For comments requiring action, create tasks in plan.yaml

4. Before creating plan.yaml:
   - Check if plan.yaml already exists
   - If it exists, it has already been archived by the orchestrator - just create the new one

## Output

Create a file named \`plan.yaml\` with the following structure:

\`\`\`yaml
version: "1.0"
itemId: "{{itemId}}"
summary: "Address PR review comments from PR #{{prNumber}} for {{repoName}}"
tasks:
  - id: "review-fix-1"
    title: "Task title based on review comment"
    description: |
      What needs to be fixed based on review feedback.

      Original comment: "<paste the reviewer's comment here>"
      File: <file path if applicable>
    agent: "<role>"
    repository: "<repoName>"
    files: []
\`\`\`

IMPORTANT: Every task MUST have a \`repository\` field matching one of the repository names.

If there are no actionable comments, create a plan with an empty tasks array and summary explaining that all feedback has been addressed or requires no code changes.

After creating plan.yaml, output "TASKS_COMPLETED" on its own line and STOP.

## CRITICAL CONSTRAINTS

You are a PLANNER, NOT a developer. You MUST NOT:
- Write or modify any code files (only plan.yaml is allowed)
- Implement any features, fixes, or code changes
- Continue working after plan.yaml is created

Your ONLY job is to:
1. Execute /pr-comments to fetch review comments
2. Analyze the comments
3. Create plan.yaml with tasks to address actionable feedback
4. Output "TASKS_COMPLETED" on its own line
5. STOP immediately`;

/**
 * Review Receive プロセスを開始する
 */
export async function startReviewReceive(
  itemId: string,
  repoName?: string
): Promise<{ started: boolean; prNumber: number; repoName: string }> {
  return withItemLock(itemId, async () => {
    const config = await getItemConfig(itemId);
    if (!config) {
      throw new ReviewReceiveValidationError(`Item ${itemId} not found`);
    }

    await validateStatusForReviewReceive(itemId);
    await checkDuplicateExecution(itemId);

    const prInfo = await getPrInfo(itemId, repoName);
    if (!prInfo) {
      const repoMsg = repoName ? ` for repository '${repoName}'` : '';
      throw new ReviewReceiveValidationError(
        `No PR found${repoMsg} for item ${itemId}. Please create a PR first.`
      );
    }

    const targetRepoName = prInfo.repoName;
    const workspaceRoot = getWorkspaceRoot(itemId);
    const eventsPath = getItemEventsPath(itemId);

    // AgentIDを事前生成
    const agentId = generateAgentId(itemId, 'review-receiver', targetRepoName);

    // review_receive_started イベントを記録
    const startEvent = createReviewReceiveStartedEvent(
      itemId,
      agentId,
      targetRepoName,
      prInfo.prNumber,
      prInfo.prUrl
    );
    await appendJsonl(eventsPath, startEvent);
    eventBus.emit('event', { itemId, event: startEvent });

    // plan.yamlをアーカイブ
    const archivedPaths = await archiveCurrentPlan(itemId);
    if (archivedPaths.length > 0) {
      console.log(`[${itemId}] Archived previous plans to: ${archivedPaths.join(', ')}`);
    }

    // plan.yaml監視を開始
    watchForPlan(itemId, 'review-receiver', agentId);

    // プロンプト構築
    const repoList = config.repositories
      .map(r => `- **${r.name}** (role: ${r.role}, type: ${r.type})`)
      .join('\n');
    const repoRoleMapping = config.repositories
      .map(r => `- Repository: \`${r.name}\` → Agent role: \`${r.role}\``)
      .join('\n');

    const prompt = REVIEW_RECEIVER_PROMPT_TEMPLATE
      .replace(/\{\{name\}\}/g, config.name)
      .replace(/\{\{repoName\}\}/g, targetRepoName)
      .replace(/\{\{prNumber\}\}/g, String(prInfo.prNumber))
      .replace(/\{\{prUrl\}\}/g, prInfo.prUrl)
      .replace(/\{\{itemId\}\}/g, itemId)
      .replace(/\{\{repositories\}\}/g, repoList)
      .replace(/\{\{repoRoleMapping\}\}/g, repoRoleMapping);

    // review-receiver Agent を起動
    await startAgent({
      itemId,
      role: 'review-receiver',
      repoName: targetRepoName,
      prompt,
      workingDir: workspaceRoot,
      agentId,
    });

    return { started: true, prNumber: prInfo.prNumber, repoName: targetRepoName };
  });
}
