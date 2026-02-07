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
import { getItemEventsPath, getWorkspaceDir, getItemPlanPath } from '../lib/paths';
import { createReviewReceiveStartedEvent } from '../lib/events';
import { eventBus } from './event-bus';
import { watchForPlan } from './planner-service';

/**
 * Item単位のキュー化ロック
 *
 * 目的: 同一itemに対する startReviewReceive の並行呼び出しを完全に直列化し、
 * validateStatus → checkDuplicate → appendJsonl → startAgent の間の
 * レースコンディションを防止する。
 *
 * 実装: 各itemに対するPromiseチェーンを保持し、新しいリクエストは
 * 前のPromiseの完了後に実行される（FIFO順序を保証）。
 *
 * NOTE: ロックは startAgent 完了後に解放される。
 * Agent実行中の重複防止は checkDuplicateExecution で行う。
 */
const itemLockChains = new Map<string, Promise<void>>();

async function withItemLock<T>(itemId: string, fn: () => Promise<T>): Promise<T> {
  // 現在のチェーンの末尾を取得（なければ即座にresolve）
  const previousChain = itemLockChains.get(itemId) ?? Promise.resolve();

  // 新しい処理のPromiseを作成
  let resolve: () => void;
  const newChain = new Promise<void>((r) => {
    resolve = r;
  });

  // チェーンを更新（次のリクエストはこのPromiseを待つ）
  itemLockChains.set(itemId, newChain);

  try {
    // 前の処理の完了を待つ
    await previousChain;
    // 自分の処理を実行
    return await fn();
  } finally {
    // 自分の処理完了を通知（次のリクエストが実行可能に）
    resolve!();

    // チェーンが自分のものであり、かつ待機中のリクエストがなければクリーンアップ
    // （メモリリーク防止）
    if (itemLockChains.get(itemId) === newChain) {
      itemLockChains.delete(itemId);
    }
  }
}

/**
 * 指定されたItemのPR情報を取得する
 * 複数のPRがある場合は最新（events.jsonlへの保存順で最後）のPRを返す
 *
 * NOTE: events.jsonl は追記専用であり、イベントは発生順に保存される。
 * そのため配列の末尾が最新となる。タイムスタンプではなく配列順序で判定する。
 *
 * @returns PR情報、またはPRが存在しない場合はnull
 */
async function getPrInfo(
  itemId: string
): Promise<{ prNumber: number; prUrl: string } | null> {
  const events = await readJsonl<ItemEvent>(getItemEventsPath(itemId));

  // pr_created イベントを保存順（配列順）で取得し、最後のものを使用
  const prEvents = events.filter(
    (e): e is PrCreatedEvent => e.type === 'pr_created'
  );

  if (prEvents.length === 0) {
    return null;
  }

  // 配列の最後が最新のPR
  const latestPr = prEvents[prEvents.length - 1];
  return { prNumber: latestPr.prNumber, prUrl: latestPr.prUrl };
}

/**
 * 現在のplan.yamlをタイムスタンプ+ランダムサフィックス付きファイル名でアーカイブ
 * 形式: plan_{YYYYMMDD_HHmmss_SSS}_{random6}.yaml
 *
 * タイムスタンプ（ミリ秒）+ ランダム6文字で同一msでの衝突も回避
 *
 * NOTE: plan.yaml は2箇所に存在する可能性がある
 * - item dir: {DATA_DIR}/items/{itemId}/plan.yaml (getItemPlanPath)
 * - workspace: {DATA_DIR}/items/{itemId}/workspace/product/plan.yaml
 * watchForPlan が両方をチェックするため、両方をアーカイブする必要がある
 */
async function archiveCurrentPlan(itemId: string): Promise<string[]> {
  const archivedPaths: string[] = [];

  // タイムスタンプ形式のファイル名を生成（両方のファイルで同じタイムスタンプを使用）
  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '_')
    .replace(/\.\d{3}Z$/, `_${String(now.getMilliseconds()).padStart(3, '0')}`);

  // ランダム6文字を追加して衝突を完全に回避
  const randomSuffix = randomBytes(3).toString('hex'); // 6文字のhex
  const archiveFilename = `plan_${timestamp}_${randomSuffix}.yaml`;

  // 1. Item dir の plan.yaml をアーカイブ
  const itemPlanPath = getItemPlanPath(itemId);
  if (existsSync(itemPlanPath)) {
    const archivePath = join(dirname(itemPlanPath), archiveFilename);
    await rename(itemPlanPath, archivePath);
    archivedPaths.push(archivePath);
  }

  // 2. Workspace の plan.yaml をアーカイブ
  const workspaceDir = getWorkspaceDir(itemId);
  const workspacePlanPath = join(workspaceDir, 'plan.yaml');
  if (existsSync(workspacePlanPath)) {
    const archivePath = join(workspaceDir, archiveFilename);
    await rename(workspacePlanPath, archivePath);
    archivedPaths.push(archivePath);
  }

  return archivedPaths;
}

/**
 * Review Receive 開始可能なステータスかを検証
 * @throws Error 開始不可能な状態の場合
 */
async function validateStatusForReviewReceive(itemId: string): Promise<void> {
  const status = await deriveItemStatus(itemId);

  // 許可されるステータス
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
 * review-receiver agent が running の場合はエラー
 * @throws Error 重複起動の場合
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

// カスタムエラークラス（400と500の分類用）
export class ReviewReceiveValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewReceiveValidationError';
  }
}

const REVIEW_RECEIVER_PROMPT_TEMPLATE = `You are a review receiver agent. Your task is to fetch PR review comments and create a plan to address them.

## Context

**Project Name:** {{name}}
**PR Number:** {{prNumber}}
**PR URL:** {{prUrl}}

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
summary: "Address PR review comments from PR #{{prNumber}}"
tasks:
  - id: "review-fix-1"
    title: "Task title based on review comment"
    description: |
      What needs to be fixed based on review feedback.

      Original comment: "<paste the reviewer's comment here>"
      File: <file path if applicable>
    agent: "front|back|review"
    files: []
\`\`\`

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
 *
 * 前提条件:
 * - Item が completed または error 状態である
 * - PRが作成済みである（pr_created イベントが存在する）
 * - 別の review-receiver agent が running でない
 *
 * @throws ReviewReceiveValidationError バリデーションエラー（400相当）
 * @throws Error その他のエラー（500相当）
 */
export async function startReviewReceive(
  itemId: string
): Promise<{ started: boolean; prNumber: number }> {
  // Item単位のキュー化ロックで排他制御（完全な直列化）
  return withItemLock(itemId, async () => {
    // 1. Item設定を取得
    const config = await getItemConfig(itemId);
    if (!config) {
      throw new ReviewReceiveValidationError(`Item ${itemId} not found`);
    }

    // 2. ステータス検証（completed/error のみ許可）
    await validateStatusForReviewReceive(itemId);

    // 3. 重複起動チェック
    await checkDuplicateExecution(itemId);

    // 4. PR情報を取得（失敗時はエラー）
    const prInfo = await getPrInfo(itemId);
    if (!prInfo) {
      throw new ReviewReceiveValidationError(
        `No PR found for item ${itemId}. Please create a PR first.`
      );
    }

    const workspaceDir = getWorkspaceDir(itemId);
    const eventsPath = getItemEventsPath(itemId);

    // 5. AgentIDを事前生成（イベントとAgentの紐づけ用）
    const agentId = generateAgentId(itemId, 'review-receiver');

    // 6. review_receive_started イベントを作成・保存・発行
    const startEvent = createReviewReceiveStartedEvent(
      itemId,
      agentId,
      prInfo.prNumber,
      prInfo.prUrl
    );
    await appendJsonl(eventsPath, startEvent);
    eventBus.emit('event', { itemId, event: startEvent });

    // 7. 現在のplan.yamlをアーカイブ（存在する場合）
    // NOTE: item dir と workspace の両方をアーカイブする
    const archivedPaths = await archiveCurrentPlan(itemId);
    if (archivedPaths.length > 0) {
      console.log(`[${itemId}] Archived previous plans to: ${archivedPaths.join(', ')}`);
    }

    // 8. plan.yaml監視を開始（review-receiverがplanを作成するので、そのroleを指定）
    watchForPlan(itemId, 'review-receiver');

    // 9. プロンプトを構築
    const prompt = REVIEW_RECEIVER_PROMPT_TEMPLATE.replace(
      /\{\{name\}\}/g,
      config.name
    )
      .replace(/\{\{prNumber\}\}/g, String(prInfo.prNumber))
      .replace(/\{\{prUrl\}\}/g, prInfo.prUrl)
      .replace(/\{\{itemId\}\}/g, itemId);

    // 10. review-receiver Agent を起動（事前生成したagentIdを使用）
    await startAgent({
      itemId,
      role: 'review-receiver',
      prompt,
      workingDir: workspaceDir,
      agentId, // 事前生成したIDを渡す（必須）
    });

    return { started: true, prNumber: prInfo.prNumber };
  });
}
