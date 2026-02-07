export type AgentConfigRole = 'front' | 'back' | 'review';

export interface AgentConfig {
  role: AgentConfigRole;
  workdir: string;  // workspace root からの相対パス (例: "frontend", "backend")
}

export interface ItemConfig {
  id: string;
  name: string;
  description: string;
  repository: {
    type: 'remote' | 'local';
    url?: string;              // remoteの場合
    localPath?: string;        // localの場合
    branch?: string;           // clone元ブランチ（デフォルト: main）
    workBranch?: string;       // 作業用ブランチ名（指定時は自動作成）
    submodules?: boolean;
    linkMode?: 'symlink' | 'copy';  // localの場合のモード
  };
  designDoc?: string;
  agentConfigs?: AgentConfig[];  // エージェント固有の設定（workdir等）
  createdAt: string;
  updatedAt: string;
}

export type ItemStatus =
  | 'created'
  | 'cloning'
  | 'planning'
  | 'ready'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'review_receiving'
  | 'error';

export interface ItemSummary {
  id: string;
  name: string;
  status: ItemStatus;
  agentCount: number;
  pendingApprovals: number;
  updatedAt: string;
}

export interface ItemDetail extends ItemConfig {
  status: ItemStatus;
  plan?: import('./plan').Plan;
  agents: import('./agent').AgentInfo[];
  pendingApprovals: import('./events').ApprovalRequestEvent[];
  prUrl?: string;
  prNumber?: number;
}
