// role を固定値ではなく string にし、将来の拡張 (docs, mobile 等) に対応
export type DevAgentRole = string;  // "front", "back", "docs", "mobile" など自由

export interface ItemRepositoryConfig {
  name: string;                    // ディレクトリ名 (例: "frontend")
  role: DevAgentRole;              // 担当する開発エージェント (自由文字列)
  type: 'remote' | 'local';
  url?: string;
  localPath?: string;
  branch?: string;
  workBranch?: string;
  submodules?: boolean;
  linkMode?: 'symlink' | 'copy';
}

export interface ItemConfig {
  id: string;
  name: string;
  description: string;
  repositories: ItemRepositoryConfig[];  // 変更: 配列
  designDoc?: string;
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

export interface RepoSummary {
  repoName: string;
  role: DevAgentRole;
  prUrl?: string;
  prNumber?: number;
  noChanges: boolean;  // repo_no_changes イベントから派生
}

export interface ItemDetail extends ItemConfig {
  status: ItemStatus;
  plan?: import('./plan').Plan;
  agents: import('./agent').AgentInfo[];
  pendingApprovals: import('./events').ApprovalRequestEvent[];
  repos: RepoSummary[];  // 変更: prUrl/prNumber を置換
}
