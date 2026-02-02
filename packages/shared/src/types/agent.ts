export type AgentRole = 'planner' | 'front' | 'back' | 'review';

export type AgentStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting_approval'
  | 'waiting_orchestrator'  // タスク完了後、オーケストレーターからの指示待ち
  | 'stopped'
  | 'completed'
  | 'error';

export interface AgentInfo {
  id: string;
  itemId: string;
  role: AgentRole;
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
