import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
const SERVER_ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..');

export function getDataDir(): string {
  return DATA_DIR;
}

export function getItemsDir(): string {
  return join(DATA_DIR, 'items');
}

export function getItemDir(itemId: string): string {
  return join(getItemsDir(), itemId);
}

export function getItemConfigPath(itemId: string): string {
  return join(getItemDir(itemId), 'item.yaml');
}

export function getItemPlanPath(itemId: string): string {
  return join(getWorkspaceRoot(itemId), 'plan.yaml');
}

export function getItemTestPlanPath(itemId: string): string {
  return join(getWorkspaceRoot(itemId), 'test-plan.yaml');
}

export function getItemEventsPath(itemId: string): string {
  return join(getItemDir(itemId), 'events.jsonl');
}

export function getAgentsDir(itemId: string): string {
  return join(getItemDir(itemId), 'agents');
}

export function getAgentDir(itemId: string, agentId: string): string {
  return join(getAgentsDir(itemId), agentId);
}

export function getAgentOutputPath(itemId: string, agentId: string): string {
  return join(getAgentDir(itemId, agentId), 'output.json');
}

export function getAgentEventsPath(itemId: string, agentId: string): string {
  return join(getAgentDir(itemId, agentId), 'events.jsonl');
}

// workspace ルート: {itemDir}/workspace/
export function getWorkspaceRoot(itemId: string): string {
  return join(getItemDir(itemId), 'workspace');
}

// 特定リポジトリ: {itemDir}/workspace/{repoName}/
export function getRepoWorkspaceDir(itemId: string, repoName: string): string {
  return join(getItemDir(itemId), 'workspace', repoName);
}

export function getHookLogDir(itemId: string, repoName: string): string {
  return join(getItemDir(itemId), 'hooks', repoName);
}

export function getRepoSetupLogDir(itemId: string, repoName: string): string {
  return join(getItemDir(itemId), 'setup', repoName);
}

export function getTaskStateDir(itemId: string): string {
  return join(getWorkspaceRoot(itemId), 'task-state');
}

export function getRepoTaskStatePath(itemId: string, repoName: string): string {
  return join(getTaskStateDir(itemId), `${repoName}.yaml`);
}

export function getTaskStateArchiveDir(itemId: string): string {
  return join(getTaskStateDir(itemId), 'archive');
}

export function getRepositoriesPath(): string {
  return join(DATA_DIR, 'repositories.yaml');
}

export function getRoleToolsLocalPath(): string {
  return join(SERVER_ROOT_DIR, 'config', 'role-tools.local.yaml');
}
