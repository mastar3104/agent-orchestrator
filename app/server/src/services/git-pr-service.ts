import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import { join } from 'path';
import type { ItemConfig, ItemRepositoryConfig } from '@agent-orch/shared';
import { getItemConfig } from './item-service';
import { appendJsonl } from '../lib/jsonl';
import {
  getItemEventsPath,
  getRepoWorkspaceDir,
} from '../lib/paths';
import {
  createPrCreatedEvent,
  createRepoNoChangesEvent,
  createErrorEvent,
} from '../lib/events';
import { eventBus } from './event-bus';

// 禁止ブランチリスト（よく使われる保護ブランチ）
const PROTECTED_BRANCHES = ['main', 'master'];

// 一時ファイルリスト（ワークフロー終了時に削除）
const TEMP_FILES = ['review_findings.json'];

// ヘルパー: コマンド実行 (exported as execGitInRepo for use by other services)
export async function execGitInRepo(args: string[], cwd: string): Promise<string> {
  return execGit(args, cwd);
}

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

// ghユーザー名を取得
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
  message: string,
  repoName?: string
): Promise<void> {
  try {
    const errorEvent = createErrorEvent(itemId, truncateMessage(message), { repoName, phase: 'pr' });
    await appendJsonl(eventsPath, errorEvent);
    eventBus.emit('event', { itemId, event: errorEvent });
  } catch (logError) {
    console.error(`[${itemId}] Failed to log error event:`, logError);
  }
}

// 現在のブランチを取得
async function getCurrentBranch(cwd: string): Promise<string> {
  return execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

// デフォルトブランチを取得（複数の方法を試行）
async function getDefaultBranch(cwd: string): Promise<string | null> {
  try {
    const result = await execGit(
      ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
      cwd
    );
    return result.replace('origin/', '');
  } catch {
    // origin/HEAD が未設定
  }

  try {
    const result = await execGh(
      ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'],
      cwd
    );
    if (result) return result;
  } catch {
    // gh コマンド失敗
  }

  return null;
}

/**
 * 単一リポジトリのDraft PRを作成する
 */
export async function createDraftPrForRepo(
  itemId: string,
  repo: ItemRepositoryConfig,
  itemName: string,
  description: string,
  designDoc?: string
): Promise<{ prUrl: string; prNumber: number } | null> {
  const repoDir = getRepoWorkspaceDir(itemId, repo.name);
  const eventsPath = getItemEventsPath(itemId);

  const currentBranch = await getCurrentBranch(repoDir);
  const defaultBranch = await getDefaultBranch(repoDir);

  // 安全チェック: 保護ブランチへのpushを禁止
  if (PROTECTED_BRANCHES.includes(currentBranch)) {
    const error = `Cannot push to protected branch: ${currentBranch} (repo: ${repo.name})`;
    await appendJsonl(eventsPath, createErrorEvent(itemId, error, { repoName: repo.name, phase: 'pr' }));
    throw new Error(error);
  }

  if (defaultBranch && currentBranch === defaultBranch) {
    const error = `Cannot push to default branch: ${currentBranch} (repo: ${repo.name})`;
    await appendJsonl(eventsPath, createErrorEvent(itemId, error, { repoName: repo.name, phase: 'pr' }));
    throw new Error(error);
  }

  // 一時ファイル削除
  for (const file of TEMP_FILES) {
    try {
      await unlink(join(repoDir, file));
    } catch {
      // ファイルが存在しない場合は無視
    }
  }

  // dirty check
  const status = await execGit(['status', '--porcelain'], repoDir);
  if (status) {
    console.warn(`[${itemId}/${repo.name}] Warning: Uncommitted changes detected`);
  }

  // 変更がないかチェック（コミット差分）
  try {
    const baseBranch = repo.branch || 'main';
    const ahead = await execGit(['rev-list', '--count', `origin/${baseBranch}..HEAD`], repoDir);
    if (parseInt(ahead, 10) === 0 && !status) {
      // 変更なし - repo_no_changes イベント発行
      const noChangesEvent = createRepoNoChangesEvent(itemId, repo.name);
      await appendJsonl(eventsPath, noChangesEvent);
      eventBus.emit('event', { itemId, event: noChangesEvent });
      console.log(`[${itemId}/${repo.name}] No changes detected, skipping PR creation`);
      return null;
    }
  } catch {
    // rev-list 失敗はスキップ（ブランチ比較不可の場合は続行）
  }

  // コミットハッシュ取得
  const commitHash = await execGit(['rev-parse', 'HEAD'], repoDir);

  // git push (with fallback to -fix branch if rejected)
  let pushBranch = currentBranch;
  try {
    await execGit(['push', '-u', 'origin', currentBranch], repoDir);
  } catch (pushError) {
    const pushErrMsg = getErrorMessage(pushError);
    console.warn(`[${itemId}/${repo.name}] Push to ${currentBranch} failed: ${pushErrMsg}, creating fix branch`);
    const fixBranch = `${currentBranch}-fix`;
    try {
      await execGit(['checkout', '-b', fixBranch], repoDir);
      await execGit(['push', '-u', 'origin', fixBranch], repoDir);
      pushBranch = fixBranch;
      console.log(`[${itemId}/${repo.name}] Pushed to fix branch: ${fixBranch}`);
    } catch (fixError) {
      await safeLogErrorEvent(eventsPath, itemId, `Git push failed for ${repo.name} (fix branch also failed): ${getErrorMessage(fixError)}`, repo.name);
      throw fixError;
    }
  }

  // ghユーザー名取得
  let ghUsername: string;
  try {
    ghUsername = await getGhUsername(repoDir);
  } catch (error) {
    await safeLogErrorEvent(eventsPath, itemId, `Failed to get GitHub username for ${repo.name}: ${getErrorMessage(error)}`, repo.name);
    throw error;
  }

  // Draft PR作成
  const prTitle = `${itemName}`;
  const designDocSection = designDoc
    ? `\n\n## Design Doc\n\n${designDoc}\n`
    : '';
  const prBody = `## Description\n\n${description}\n${designDocSection}\n---\n*This PR was automatically created by agent-orch*`;

  const baseBranch = repo.branch || 'main';
  let prInfo: { number: number; url: string };

  // Check if PR already exists (only when pushing to the original branch)
  if (pushBranch === currentBranch) {
    try {
      const existingPrJson = await execGh(
        ['pr', 'view', pushBranch, '--json', 'number,url'],
        repoDir
      );
      prInfo = JSON.parse(existingPrJson);
      console.log(`[${itemId}/${repo.name}] PR already exists: ${prInfo.url}`);
    } catch {
      // No existing PR → create new one
      try {
        await execGh(
          ['pr', 'create', '--draft', '--base', baseBranch, '--title', prTitle, '--body', prBody],
          repoDir
        );
        const prJsonOutput = await execGh(
          ['pr', 'view', '--json', 'number,url'],
          repoDir
        );
        prInfo = JSON.parse(prJsonOutput);
      } catch (error) {
        await safeLogErrorEvent(eventsPath, itemId, `PR creation failed for ${repo.name}: ${getErrorMessage(error)}`, repo.name);
        throw error;
      }
    }
  } else {
    // fix branch → always create new PR
    try {
      await execGh(
        ['pr', 'create', '--draft', '--base', baseBranch, '--head', pushBranch, '--title', prTitle, '--body', prBody],
        repoDir
      );
      const prJsonOutput = await execGh(
        ['pr', 'view', pushBranch, '--json', 'number,url'],
        repoDir
      );
      prInfo = JSON.parse(prJsonOutput);
    } catch (error) {
      await safeLogErrorEvent(eventsPath, itemId, `PR creation failed for ${repo.name} (fix branch): ${getErrorMessage(error)}`, repo.name);
      throw error;
    }
  }

  // イベント記録
  try {
    const event = createPrCreatedEvent(
      itemId,
      repo.name,
      prInfo.url,
      prInfo.number,
      pushBranch,
      commitHash
    );
    await appendJsonl(eventsPath, event);
    eventBus.emit('event', { itemId, event });
  } catch (logError) {
    console.error(`[${itemId}] Failed to log pr_created event for ${repo.name}:`, logError);
  }

  console.log(`[${itemId}/${repo.name}] Draft PR created: ${prInfo.url}`);

  return { prUrl: prInfo.url, prNumber: prInfo.number };
}

/**
 * Fetch PR comments (both review comments and issue comments)
 */
export async function fetchPrComments(
  repoDir: string,
  prNumber: number
): Promise<{ author: string; body: string; path?: string; line?: number; createdAt: string }[]> {
  const comments: { author: string; body: string; path?: string; line?: number; createdAt: string }[] = [];
  let reviewFetchSuccess = false;
  let issueFetchSuccess = false;

  // Fetch PR review comments (inline comments on diff)
  try {
    const reviewCommentsJson = await execGh(
      ['api', `repos/{owner}/{repo}/pulls/${prNumber}/comments`, '--jq', '.[] | {author: .user.login, body: .body, path: .path, line: .line, createdAt: .created_at}'],
      repoDir
    );
    if (reviewCommentsJson.trim()) {
      for (const line of reviewCommentsJson.trim().split('\n')) {
        try {
          comments.push(JSON.parse(line));
        } catch { /* skip malformed lines */ }
      }
    }
    reviewFetchSuccess = true;
  } catch (error) {
    console.warn(`Failed to fetch PR review comments: ${error instanceof Error ? error.message : error}`);
  }

  // Fetch PR issue comments (general comments)
  try {
    const issueCommentsJson = await execGh(
      ['api', `repos/{owner}/{repo}/issues/${prNumber}/comments`, '--jq', '.[] | {author: .user.login, body: .body, createdAt: .created_at}'],
      repoDir
    );
    if (issueCommentsJson.trim()) {
      for (const line of issueCommentsJson.trim().split('\n')) {
        try {
          comments.push(JSON.parse(line));
        } catch { /* skip malformed lines */ }
      }
    }
    issueFetchSuccess = true;
  } catch (error) {
    console.warn(`Failed to fetch PR issue comments: ${error instanceof Error ? error.message : error}`);
  }

  if (!reviewFetchSuccess || !issueFetchSuccess) {
    throw new Error(`Failed to fetch PR comments for PR #${prNumber}`);
  }

  // Sort by creation time
  comments.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  return comments;
}

/**
 * 全リポジトリのDraft PRを作成する
 */
export async function createDraftPrsForAllRepos(
  itemId: string,
  successfulRepos?: Set<string>
): Promise<{ results: Array<{ repoName: string; prUrl?: string; prNumber?: number; noChanges: boolean }> }> {
  const config = await getItemConfig(itemId);
  if (!config) {
    throw new Error(`Item ${itemId} not found`);
  }

  const results: Array<{ repoName: string; prUrl?: string; prNumber?: number; noChanges: boolean }> = [];

  for (const repo of config.repositories) {
    if (successfulRepos && !successfulRepos.has(repo.name)) {
      console.log(`[${itemId}/${repo.name}] Skipping PR creation (hooks failed or not in successful repos)`);
      continue;
    }
    try {
      const result = await createDraftPrForRepo(itemId, repo, config.name, config.description, config.designDoc);
      if (result) {
        results.push({ repoName: repo.name, prUrl: result.prUrl, prNumber: result.prNumber, noChanges: false });
      } else {
        results.push({ repoName: repo.name, noChanges: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[${itemId}] PR creation failed for ${repo.name}: ${message}`);
      results.push({ repoName: repo.name, noChanges: false });
    }
  }

  return { results };
}

