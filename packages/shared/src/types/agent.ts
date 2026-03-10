export type AgentRole = string;

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
  sessionId?: string;
  exitCode: number;
  durationMs: number;
  timestamp: string;
}
