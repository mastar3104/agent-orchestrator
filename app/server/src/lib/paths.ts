import { join } from 'path';

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');

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
  return join(getItemDir(itemId), 'plan.yaml');
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

export function getAgentEventsPath(itemId: string, agentId: string): string {
  return join(getAgentDir(itemId, agentId), 'events.jsonl');
}

export function getWorkspaceDir(itemId: string): string {
  return join(getItemDir(itemId), 'workspace', 'product');
}

export function getRepositoriesPath(): string {
  return join(DATA_DIR, 'repositories.yaml');
}
