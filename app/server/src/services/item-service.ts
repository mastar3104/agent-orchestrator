import { mkdir, readdir, rm, symlink, cp, lstat } from 'fs/promises';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { nanoid } from 'nanoid';
import type {
  ItemConfig,
  ItemRepositoryConfig,
  ItemSummary,
  ItemDetail,
  RepoSummary,
  CreateItemRequest,
  Plan,
  RepositoryConfig,
  PrCreatedEvent,
  RepoNoChangesEvent,
} from '@agent-orch/shared';
import { getRepository, createRepository } from './repository-service';
import { readYaml, writeYaml, readYamlSafe } from '../lib/yaml';
import { appendJsonl, readJsonl } from '../lib/jsonl';
import {
  getItemsDir,
  getItemDir,
  getItemConfigPath,
  getItemPlanPath,
  getItemEventsPath,
  getWorkspaceRoot,
  getRepoWorkspaceDir,
} from '../lib/paths';
import {
  createItemCreatedEvent,
  createCloneStartedEvent,
  createCloneCompletedEvent,
  createWorkspaceSetupStartedEvent,
  createWorkspaceSetupCompletedEvent,
  createErrorEvent,
} from '../lib/events';
import { deriveItemStatus, getPendingApprovals } from './state-service';
import { getAgentsByItem, stopAgent } from './agent-service';
import { stopAllGitSnapshots } from './git-snapshot-service';
import { startPlanner } from './planner-service';

export async function createItem(request: CreateItemRequest): Promise<ItemConfig> {
  const id = `ITEM-${nanoid(8)}`;
  const now = new Date().toISOString();

  if (!request.repositories || request.repositories.length === 0) {
    throw new Error('At least one repository must be provided');
  }

  // Resolve repository configurations
  const repositories: ItemRepositoryConfig[] = [];

  for (const repoInput of request.repositories) {
    let repoConfig: ItemRepositoryConfig;

    if (repoInput.repositoryId) {
      // Use saved repository
      const savedRepo = await getRepository(repoInput.repositoryId);
      if (!savedRepo) {
        throw new Error(`Repository not found: ${repoInput.repositoryId}`);
      }
      repoConfig = {
        name: repoInput.name,
        role: repoInput.role,
        type: savedRepo.type,
        url: savedRepo.url,
        localPath: savedRepo.localPath,
        branch: repoInput.branch || savedRepo.branch,
        workBranch: repoInput.workBranch || `work/${id}/${repoInput.name}`,
        submodules: savedRepo.submodules,
        linkMode: savedRepo.linkMode,
      };
    } else if (repoInput.repository) {
      // Use directly provided repository config
      repoConfig = {
        name: repoInput.name,
        role: repoInput.role,
        type: repoInput.repository.type,
        url: repoInput.repository.url,
        localPath: repoInput.repository.localPath,
        branch: repoInput.repository.branch,
        workBranch: repoInput.repository.workBranch || `work/${id}/${repoInput.name}`,
        submodules: repoInput.repository.submodules,
        linkMode: repoInput.repository.linkMode,
      };

      // Optionally save the repository for reuse
      if (repoInput.saveRepository && repoInput.repositoryName) {
        await createRepository({
          name: repoInput.repositoryName,
          type: repoInput.repository.type,
          url: repoInput.repository.url,
          localPath: repoInput.repository.localPath,
          branch: repoInput.repository.branch,
          submodules: repoInput.repository.submodules,
          linkMode: repoInput.repository.linkMode,
          directoryName: repoInput.name,
          role: repoInput.role,
        });
      }
    } else {
      throw new Error(`Repository input for "${repoInput.name}" must have either repositoryId or repository`);
    }

    repositories.push(repoConfig);
  }

  const config: ItemConfig = {
    id,
    name: request.name,
    description: request.description,
    repositories,
    designDoc: request.designDoc,
    createdAt: now,
    updatedAt: now,
  };

  // Create directory structure
  const itemDir = getItemDir(id);
  await mkdir(itemDir, { recursive: true });
  await mkdir(getWorkspaceRoot(id), { recursive: true });

  // Write item config
  await writeYaml(getItemConfigPath(id), config);

  // Log item created event
  const event = createItemCreatedEvent(id);
  await appendJsonl(getItemEventsPath(id), event);

  return config;
}

export async function setupWorkspace(itemId: string): Promise<void> {
  const config = await getItemConfig(itemId);
  if (!config) {
    throw new Error(`Item ${itemId} not found`);
  }

  const eventsPath = getItemEventsPath(itemId);

  // Setup all repositories in parallel
  await Promise.all(
    config.repositories.map(repo => setupSingleRepo(itemId, repo, eventsPath))
  );

  // Auto-start planner after all repos are set up
  try {
    await startPlanner(itemId);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[${itemId}] Failed to auto-start planner: ${message}`);
    await appendJsonl(eventsPath, createErrorEvent(itemId, 'planner_autostart_failed', message));
  }
}

async function setupSingleRepo(
  itemId: string,
  repo: ItemRepositoryConfig,
  eventsPath: string
): Promise<void> {
  const repoDir = getRepoWorkspaceDir(itemId, repo.name);

  // Remove existing repo dir if it exists (for retry)
  if (existsSync(repoDir)) {
    try {
      const stats = await lstat(repoDir);
      if (stats.isSymbolicLink()) {
        await rm(repoDir);
      } else {
        await rm(repoDir, { recursive: true, force: true });
      }
    } catch {
      await rm(repoDir, { recursive: true, force: true });
    }
  }

  if (repo.type === 'local') {
    await setupLocalRepo(itemId, repo, repoDir, eventsPath);
  } else {
    await cloneRemoteRepo(itemId, repo, repoDir, eventsPath);
  }
}

async function setupLocalRepo(
  itemId: string,
  repo: ItemRepositoryConfig,
  repoDir: string,
  eventsPath: string
): Promise<void> {
  const localPath = repo.localPath;
  if (!localPath) {
    throw new Error(`localPath is required for local repository "${repo.name}"`);
  }

  if (!existsSync(localPath)) {
    throw new Error(`Local path does not exist: ${localPath}`);
  }

  const linkMode = repo.linkMode || 'symlink';

  // Log workspace setup started
  await appendJsonl(eventsPath, createWorkspaceSetupStartedEvent(itemId, repo.name, localPath, linkMode));

  try {
    if (linkMode === 'symlink') {
      await symlink(localPath, repoDir, 'dir');
    } else {
      await cp(localPath, repoDir, { recursive: true });
    }

    // Log workspace setup completed
    await appendJsonl(eventsPath, createWorkspaceSetupCompletedEvent(itemId, repo.name, true));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await appendJsonl(eventsPath, createWorkspaceSetupCompletedEvent(itemId, repo.name, false, message));
    throw error;
  }
}

async function cloneRemoteRepo(
  itemId: string,
  repo: ItemRepositoryConfig,
  repoDir: string,
  eventsPath: string
): Promise<void> {
  const url = repo.url;
  if (!url) {
    throw new Error(`url is required for remote repository "${repo.name}"`);
  }

  const workspaceRoot = getWorkspaceRoot(itemId);

  // Log clone started
  await appendJsonl(eventsPath, createCloneStartedEvent(itemId, repo.name, url));

  try {
    // Build git clone command - clone into repo.name subdirectory
    const args = ['clone'];
    if (repo.branch) {
      args.push('-b', repo.branch);
    }
    if (repo.submodules) {
      args.push('--recurse-submodules');
    }
    args.push(url, repo.name);

    // Execute git clone
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('git', args, {
        cwd: workspaceRoot,
        stdio: 'pipe',
      });

      let stderr = '';
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Git clone failed: ${stderr}`));
        }
      });

      proc.on('error', reject);
    });

    // Create work branch if specified
    if (repo.workBranch) {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('git', ['checkout', '-b', repo.workBranch!], {
          cwd: repoDir,
          stdio: 'pipe',
        });

        let stderr = '';
        proc.stderr?.on('data', (data) => {
          stderr += data.toString();
        });

        proc.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Failed to create work branch: ${stderr}`));
          }
        });

        proc.on('error', reject);
      });
    }

    // Log clone completed
    await appendJsonl(eventsPath, createCloneCompletedEvent(itemId, repo.name, true));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await appendJsonl(eventsPath, createCloneCompletedEvent(itemId, repo.name, false, message));
    throw error;
  }
}

/** @deprecated Use setupWorkspace instead */
export const cloneRepo = setupWorkspace;

export async function listItems(): Promise<ItemSummary[]> {
  const itemsDir = getItemsDir();

  if (!existsSync(itemsDir)) {
    return [];
  }

  const entries = await readdir(itemsDir, { withFileTypes: true });
  const items: ItemSummary[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('ITEM-')) {
      const config = await getItemConfig(entry.name);
      if (config) {
        const status = await deriveItemStatus(entry.name);
        const agents = await getAgentsByItem(entry.name);
        const pendingApprovals = await getPendingApprovals(entry.name);

        items.push({
          id: config.id,
          name: config.name,
          status,
          agentCount: agents.length,
          pendingApprovals: pendingApprovals.length,
          updatedAt: config.updatedAt,
        });
      }
    }
  }

  // Sort by most recently updated
  items.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return items;
}

export async function getItemConfig(itemId: string): Promise<ItemConfig | null> {
  const config = await readYamlSafe<ItemConfig>(getItemConfigPath(itemId));
  if (config && !config.repositories) {
    throw new Error(`Legacy item.yaml detected for ${itemId}: missing 'repositories' field. Please recreate this item.`);
  }
  return config;
}

export async function getItemDetail(itemId: string): Promise<ItemDetail | null> {
  const config = await getItemConfig(itemId);
  if (!config) {
    return null;
  }

  const status = await deriveItemStatus(itemId);
  const plan = await readYamlSafe<Plan>(getItemPlanPath(itemId));
  const agents = await getAgentsByItem(itemId);
  const pendingApprovals = await getPendingApprovals(itemId);

  // Build RepoSummary[] from events
  const events = await readJsonl<import('@agent-orch/shared').ItemEvent>(getItemEventsPath(itemId));
  const prEvents = events.filter((e): e is PrCreatedEvent => e.type === 'pr_created');
  const noChangesEvents = events.filter((e): e is RepoNoChangesEvent => e.type === 'repo_no_changes');

  const repos: RepoSummary[] = config.repositories.map(repo => {
    const prEvent = prEvents.filter(e => e.repoName === repo.name).pop();
    const hasNoChanges = noChangesEvents.some(e => e.repoName === repo.name);
    return {
      repoName: repo.name,
      role: repo.role,
      prUrl: prEvent?.prUrl,
      prNumber: prEvent?.prNumber,
      noChanges: hasNoChanges,
    };
  });

  return {
    ...config,
    status,
    plan: plan || undefined,
    agents,
    pendingApprovals,
    repos,
  };
}

export async function updateItem(
  itemId: string,
  updates: Partial<Pick<ItemConfig, 'name' | 'description' | 'designDoc'>>
): Promise<ItemConfig | null> {
  const config = await getItemConfig(itemId);
  if (!config) {
    return null;
  }

  const updated: ItemConfig = {
    ...config,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await writeYaml(getItemConfigPath(itemId), updated);
  return updated;
}

export async function deleteItem(itemId: string): Promise<boolean> {
  const itemDir = getItemDir(itemId);
  if (!existsSync(itemDir)) {
    return false;
  }

  // Stop all git snapshots for this item
  stopAllGitSnapshots(itemId);

  // Stop all agents for this item
  const agents = await getAgentsByItem(itemId);
  for (const agent of agents) {
    await stopAgent(agent.id);
  }

  await rm(itemDir, { recursive: true, force: true });
  return true;
}
