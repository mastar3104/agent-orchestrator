import { exec } from 'child_process';
import { promisify } from 'util';
import { eventBus } from './event-bus';
import {
  createGitSnapshotEvent,
  createGitSnapshotErrorEvent,
} from '../lib/events';

const execAsync = promisify(exec);

const SNAPSHOT_INTERVAL = 20 * 1000; // 20秒

interface SnapshotTarget {
  itemId: string;
  cwd: string;
  agentId?: string;  // agent固有の場合
}

const snapshotTimers = new Map<string, NodeJS.Timeout>();

// keyにcwdも含めて衝突を避ける
function getTimerKey(itemId: string, cwd: string, agentId?: string): string {
  return `${itemId}:${agentId ?? 'root'}:${cwd}`;
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execAsync('git rev-parse --git-dir', { cwd });
    return true;
  } catch {
    return false;
  }
}

async function takeSnapshot(target: SnapshotTarget): Promise<void> {
  const { itemId, cwd, agentId } = target;

  // git repoでない場合は git_snapshot_error を発行してスキップ
  if (!(await isGitRepo(cwd))) {
    const errorEvent = createGitSnapshotErrorEvent(
      itemId,
      cwd,
      'Not a git repository',
      agentId
    );
    eventBus.emit('event', { itemId, event: errorEvent });
    return;
  }

  try {
    // 1. HEAD コミットハッシュ取得
    const { stdout: hash } = await execAsync('git rev-parse HEAD', { cwd });

    // 2. 未コミット変更の確認 (git status --porcelain)
    const { stdout: status } = await execAsync('git status --porcelain', { cwd });
    const dirty = status.trim().length > 0;

    // 3. 変更ファイル一覧を抽出 (best-effort: rename/submodule/binaryで不完全な場合あり)
    let changedFiles: string[] = [];
    try {
      changedFiles = status
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => line.slice(3)); // "M  file.ts" -> "file.ts"
    } catch {
      changedFiles = [];
    }

    // 4. 追加/削除行数 (best-effort: rename/submodule/binaryで不完全な場合あり)
    let additions = 0;
    let deletions = 0;
    try {
      const { stdout: numstat } = await execAsync('git diff --numstat', { cwd });
      for (const line of numstat.trim().split('\n').filter(Boolean)) {
        const [add, del] = line.split('\t');
        if (add !== '-') additions += parseInt(add, 10) || 0;
        if (del !== '-') deletions += parseInt(del, 10) || 0;
      }
    } catch {
      additions = 0;
      deletions = 0;
    }

    // 5. UI表示用 diff stat (best-effort)
    let diffStat = '';
    try {
      const { stdout } = await execAsync('git diff --stat', { cwd });
      diffStat = stdout.trim();
    } catch {
      diffStat = '';
    }

    // イベント発行
    const snapshotEvent = createGitSnapshotEvent(
      itemId,
      cwd,
      hash.trim(),
      dirty,
      changedFiles,
      additions,
      deletions,
      diffStat,
      agentId
    );
    eventBus.emit('event', { itemId, event: snapshotEvent });
  } catch (error) {
    console.error('Git snapshot failed:', error);
    const errorEvent = createGitSnapshotErrorEvent(
      itemId,
      cwd,
      error instanceof Error ? error.message : 'Unknown error',
      agentId
    );
    eventBus.emit('event', { itemId, event: errorEvent });
  }
}

// 複数のcwdを監視可能
export async function startGitSnapshot(
  itemId: string,
  cwd: string,
  agentId?: string
): Promise<void> {
  const key = getTimerKey(itemId, cwd, agentId);

  // 既存タイマーがあればスキップ
  if (snapshotTimers.has(key)) return;

  // 初回スナップショット
  await takeSnapshot({ itemId, cwd, agentId });

  const timer = setInterval(async () => {
    await takeSnapshot({ itemId, cwd, agentId });
  }, SNAPSHOT_INTERVAL);

  snapshotTimers.set(key, timer);
}

// 単一のsnapshotを停止
export function stopGitSnapshot(itemId: string, cwd: string, agentId?: string): void {
  const key = getTimerKey(itemId, cwd, agentId);
  const timer = snapshotTimers.get(key);
  if (timer) {
    clearInterval(timer);
    snapshotTimers.delete(key);
  }
}

// itemId配下のすべてのsnapshotを一括停止
export function stopAllGitSnapshots(itemId: string): void {
  const prefix = `${itemId}:`;
  for (const [key, timer] of snapshotTimers.entries()) {
    if (key.startsWith(prefix)) {
      clearInterval(timer);
      snapshotTimers.delete(key);
    }
  }
}

// テスト用: すべてのスナップショットを停止
export function stopAllSnapshots(): void {
  for (const timer of snapshotTimers.values()) {
    clearInterval(timer);
  }
  snapshotTimers.clear();
}
