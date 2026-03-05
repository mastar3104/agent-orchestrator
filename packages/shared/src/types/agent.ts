export type AgentRole = string;

const SYSTEM_ROLES = new Set(['planner', 'review', 'review-receiver']);

export function isSystemRole(role: string): boolean {
  return SYSTEM_ROLES.has(role);
}

export function isDevRole(role: string): boolean {
  return role === 'engineer';
}

export type AgentStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'completed'
  | 'error';

export interface AgentInfo {
  id: string;
  itemId: string;
  role: AgentRole;
  repoName?: string;
  status: AgentStatus;
  pid?: number;
  startedAt?: string;
  stoppedAt?: string;
  exitCode?: number;
  currentTask?: string;
}

export interface AgentStartOptions {
  itemId: string;
  role: AgentRole;
  repoName?: string;
  prompt: string;
  workingDir: string;
  env?: Record<string, string>;
}

export interface AgentOutput {
  agentId: string;
  type: 'stdout' | 'stderr';
  data: string;
  timestamp: string;
}

export interface AgentExecutionOutput {
  prompt: string;
  stdout: string;
  stderr: string;
  parsedOutput: unknown;
  exitCode: number;
  durationMs: number;
  timestamp: string;
}
