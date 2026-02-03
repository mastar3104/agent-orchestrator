import { spawn } from 'child_process';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { getItemConfig } from './item-service';
import { getWorkspaceDir, getItemEventsPath } from '../lib/paths';
import { appendJsonl } from '../lib/jsonl';
import { createPrCreatedEvent, createErrorEvent } from '../lib/events';
import { eventBus } from './event-bus';

// 禁止ブランチリスト（よく使われる保護ブランチ）
const PROTECTED_BRANCHES = ['main', 'master'];

// 一時ファイルリスト（ワークフロー終了時に削除）
const TEMP_FILES = ['review_findings.json', 'plan.yaml'];

// ヘルパー: コマンド実行
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

async function execGh(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('gh', args, { cwd, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => (stdout += d.toString()));
    proc.stderr?.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`gh ${args.join(' ')} failed: ${stderr}`));
    });
    proc.on('error', reject);
  });
}

// ghユーザー名を取得（workspaceDirで実行して認証コンテキストを一致させる）
async function getGhUsername(cwd: string): Promise<string> {
  const result = await execGh(['api', 'user', '-q', '.login'], cwd);
  return result;
}

// エラーメッセージを truncate するヘルパー
function truncateMessage(message: string, maxLength = 500): string {
  if (!message) return 'Unknown error';
  if (message.length <= maxLength) return message;
  return message.slice(0, maxLength) + '...(truncated)';
}

// エラーメッセージを安全に取得
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || 'Error occurred (no message)';
  }
  return String(error) || 'Unknown error';
}

// イベント記録のラッパー（失敗時はログのみ）
async function safeLogErrorEvent(
  eventsPath: string,
  itemId: string,
  message: string
): Promise<void> {
  try {
    const errorEvent = createErrorEvent(itemId, truncateMessage(message));
    await appendJsonl(eventsPath, errorEvent);
    eventBus.emit('event', { itemId, event: errorEvent });
  } catch (logError) {
    console.error(`[${itemId}] Failed to log error event:`, logError);
    // イベント記録失敗は握り潰す
  }
}

// 現在のブランチを取得
async function getCurrentBranch(cwd: string): Promise<string> {
  return execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

// デフォルトブランチを取得（複数の方法を試行）
async function getDefaultBranch(cwd: string): Promise<string | null> {
  // 1. origin/HEAD から取得を試みる
  try {
    const result = await execGit(
      ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
      cwd
    );
    return result.replace('origin/', '');
  } catch {
    // origin/HEAD が未設定
  }

  // 2. gh api でリポジトリのデフォルトブランチを取得
  try {
    const result = await execGh(
      ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'],
      cwd
    );
    if (result) return result;
  } catch {
    // gh コマンド失敗
  }

  // 3. 取得できない場合はnullを返す（呼び出し側で判断）
  return null;
}

export async function createDraftPr(itemId: string): Promise<{ prUrl: string; prNumber: number }> {
  const config = await getItemConfig(itemId);
  if (!config) {
    throw new Error(`Item ${itemId} not found`);
  }

  const workspaceDir = getWorkspaceDir(itemId);
  const eventsPath = getItemEventsPath(itemId);

  const currentBranch = await getCurrentBranch(workspaceDir);
  const defaultBranch = await getDefaultBranch(workspaceDir);

  // 安全チェック: 保護ブランチへのpushを禁止
  if (PROTECTED_BRANCHES.includes(currentBranch)) {
    const error = `Cannot push to protected branch: ${currentBranch}`;
    await appendJsonl(eventsPath, createErrorEvent(itemId, error));
    throw new Error(error);
  }

  // デフォルトブランチが取得できた場合、それもチェック
  if (defaultBranch && currentBranch === defaultBranch) {
    const error = `Cannot push to default branch: ${currentBranch}`;
    await appendJsonl(eventsPath, createErrorEvent(itemId, error));
    throw new Error(error);
  }

  // 1. 一時ファイル削除
  for (const file of TEMP_FILES) {
    try {
      await unlink(join(workspaceDir, file));
    } catch {
      // ファイルが存在しない場合は無視
    }
  }

  // 2. dirty check（コミットはしないが、未コミット変更があれば警告ログ出力）
  //    NOTE: 警告のみで続行する設計。PRとローカルに差分が生じる可能性があるが、
  //    エージェントが適切にコミットしていれば問題ない。
  //    未コミット変更がある場合は、エージェントのコミット漏れか一時ファイルの削除漏れ。
  const status = await execGit(['status', '--porcelain'], workspaceDir);
  if (status) {
    console.warn('Warning: Uncommitted changes detected (will not be included in PR):');
    console.warn(status);
    // 警告のみ、処理は続行（PRには含まれない）
  }

  // 3. コミットハッシュ取得
  const commitHash = await execGit(['rev-parse', 'HEAD'], workspaceDir);

  // 4. git push - エラーハンドリング追加
  try {
    await execGit(['push', '-u', 'origin', currentBranch], workspaceDir);
  } catch (error) {
    await safeLogErrorEvent(eventsPath, itemId, `Git push failed: ${getErrorMessage(error)}`);
    throw error;
  }

  // 5. ghユーザー名取得 - エラーハンドリング追加
  let ghUsername: string;
  try {
    ghUsername = await getGhUsername(workspaceDir);
  } catch (error) {
    await safeLogErrorEvent(eventsPath, itemId, `Failed to get GitHub username: ${getErrorMessage(error)}`);
    throw error;
  }

  // 6. Draft PR作成 - エラーハンドリング追加
  const prTitle = `[Draft] ${config.name}`;
  const prBody = `## Summary

Automated implementation by agent-orch.

**Item:** ${itemId}
**Description:** ${config.description}

---

@${ghUsername} セルフレビューをお願いします。

---
*This PR was automatically created by agent-orch*`;

  let prInfo: { number: number; url: string };
  try {
    // PR作成
    const baseBranch = config.repository.branch || 'main';
    await execGh(
      ['pr', 'create', '--draft', '--base', baseBranch, '--title', prTitle, '--body', prBody],
      workspaceDir
    );

    // 作成したPRの情報を取得（gh pr view はカレントブランチのPR情報を取得）
    const prJsonOutput = await execGh(
      ['pr', 'view', '--json', 'number,url'],
      workspaceDir
    );
    prInfo = JSON.parse(prJsonOutput);
  } catch (error) {
    await safeLogErrorEvent(eventsPath, itemId, `PR creation failed: ${getErrorMessage(error)}`);
    throw error;
  }

  // 7. イベント記録（失敗してもログのみ）
  try {
    const event = createPrCreatedEvent(itemId, prInfo.url, prInfo.number, currentBranch, commitHash);
    await appendJsonl(eventsPath, event);
    eventBus.emit('event', { itemId, event });
  } catch (logError) {
    console.error(`[${itemId}] Failed to log pr_created event:`, logError);
  }

  console.log(`Draft PR created: ${prInfo.url}`);

  // 8. PR情報を返す（イベント記録の成功に依存しない）
  return { prUrl: prInfo.url, prNumber: prInfo.number };
}
