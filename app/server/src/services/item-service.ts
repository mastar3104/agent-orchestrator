import { mkdir, readdir, rm, symlink, cp, lstat } from 'fs/promises';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { nanoid } from 'nanoid';
import type {
  ItemConfig,
  ItemSummary,
  ItemDetail,
  CreateItemRequest,
  Plan,
  RepositoryConfig,
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
  getWorkspaceDir,
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

export async function createItem(request: CreateItemRequest): Promise<ItemConfig> {
  const id = `ITEM-${nanoid(8)}`;
  const now = new Date().toISOString();

  // Resolve repository configuration
  let repositoryConfig: RepositoryConfig;

  if (request.repositoryId) {
    // Use saved repository
    const savedRepo = await getRepository(request.repositoryId);
    if (!savedRepo) {
      throw new Error(`Repository not found: ${request.repositoryId}`);
    }
    repositoryConfig = {
      type: savedRepo.type,
      url: savedRepo.url,
      localPath: savedRepo.localPath,
      branch: savedRepo.branch,
      workBranch: request.workBranch,
      submodules: savedRepo.submodules,
      linkMode: savedRepo.linkMode,
    };
  } else if (request.repository) {
    // Use directly provided repository config
    repositoryConfig = request.repository;

    // Optionally save the repository for reuse
    if (request.saveRepository && request.repositoryName) {
      await createRepository({
        name: request.repositoryName,
        type: request.repository.type,
        url: request.repository.url,
        localPath: request.repository.localPath,
        branch: request.repository.branch,
        submodules: request.repository.submodules,
        linkMode: request.repository.linkMode,
      });
    }
  } else {
    throw new Error('Either repositoryId or repository must be provided');
  }

  const config: ItemConfig = {
    id,
    name: request.name,
    description: request.description,
    repository: repositoryConfig,
    designDoc: request.designDoc,
    createdAt: now,
    updatedAt: now,
  };

  // Create directory structure (workspace/product will be created by git clone)
  const itemDir = getItemDir(id);
  await mkdir(itemDir, { recursive: true });
  // Create workspace parent directory only, product will be created by clone
  await mkdir(join(getItemDir(id), 'workspace'), { recursive: true });

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

  const workspaceParent = join(getItemDir(itemId), 'workspace');
  const workspaceDir = getWorkspaceDir(itemId);
  const eventsPath = getItemEventsPath(itemId);

  // Remove existing workspace/product if it exists (for retry)
  if (existsSync(workspaceDir)) {
    // Check if it's a symlink first
    try {
      const stats = await lstat(workspaceDir);
      if (stats.isSymbolicLink()) {
        await rm(workspaceDir);
      } else {
        await rm(workspaceDir, { recursive: true, force: true });
      }
    } catch {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }

  if (config.repository.type === 'local') {
    await setupLocalWorkspace(itemId, config, workspaceDir, eventsPath);
  } else {
    await cloneRemoteRepo(itemId, config, workspaceParent, workspaceDir, eventsPath);
  }
}

async function setupLocalWorkspace(
  itemId: string,
  config: ItemConfig,
  workspaceDir: string,
  eventsPath: string
): Promise<void> {
  const localPath = config.repository.localPath;
  if (!localPath) {
    throw new Error('localPath is required for local repository');
  }

  if (!existsSync(localPath)) {
    throw new Error(`Local path does not exist: ${localPath}`);
  }

  const linkMode = config.repository.linkMode || 'symlink';

  // Log workspace setup started
  await appendJsonl(eventsPath, createWorkspaceSetupStartedEvent(itemId, localPath, linkMode));

  try {
    if (linkMode === 'symlink') {
      // Create symlink to the local repository
      await symlink(localPath, workspaceDir, 'dir');
    } else {
      // Copy the local repository
      await cp(localPath, workspaceDir, { recursive: true });
    }

    // Log workspace setup completed
    await appendJsonl(eventsPath, createWorkspaceSetupCompletedEvent(itemId, true));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await appendJsonl(eventsPath, createWorkspaceSetupCompletedEvent(itemId, false, message));
    throw error;
  }
}

async function cloneRemoteRepo(
  itemId: string,
  config: ItemConfig,
  workspaceParent: string,
  workspaceDir: string,
  eventsPath: string
): Promise<void> {
  const url = config.repository.url;
  if (!url) {
    throw new Error('url is required for remote repository');
  }

  // Log clone started
  await appendJsonl(eventsPath, createCloneStartedEvent(itemId, url));

  try {
    // Build git clone command - clone into 'product' subdirectory
    const args = ['clone'];
    if (config.repository.branch) {
      args.push('-b', config.repository.branch);
    }
    if (config.repository.submodules) {
      args.push('--recurse-submodules');
    }
    args.push(url, 'product');

    // Execute git clone
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('git', args, {
        cwd: workspaceParent,
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
    if (config.repository.workBranch) {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('git', ['checkout', '-b', config.repository.workBranch!], {
          cwd: workspaceDir,
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
    await appendJsonl(eventsPath, createCloneCompletedEvent(itemId, true));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await appendJsonl(eventsPath, createCloneCompletedEvent(itemId, false, message));
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
  return readYamlSafe<ItemConfig>(getItemConfigPath(itemId));
}

export async function getItemDetail(itemId: string): Promise<ItemDetail | null> {
  const config = await getItemConfig(itemId);
  if (!config) {
    return null;
  }

  const status = await deriveItemStatus(itemId);
  // Check both item dir and workspace for plan.yaml
  let plan = await readYamlSafe<Plan>(getItemPlanPath(itemId));
  if (!plan) {
    plan = await readYamlSafe<Plan>(join(getWorkspaceDir(itemId), 'plan.yaml'));
  }
  const agents = await getAgentsByItem(itemId);
  const pendingApprovals = await getPendingApprovals(itemId);

  return {
    ...config,
    status,
    plan: plan || undefined,
    agents,
    pendingApprovals,
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
