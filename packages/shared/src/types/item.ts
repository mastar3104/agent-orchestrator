export interface ItemRepositoryConfig {
  name: string;                    // ディレクトリ名 (例: "frontend")
  type: 'remote' | 'local';
  url?: string;
  localPath?: string;
  branch?: string;
  workBranch?: string;
  submodules?: boolean;
  linkMode?: 'symlink' | 'copy';
  /** エージェントに追加で許可するツール。危険なコマンドも設定可能な自己責任項目。 */
  allowedTools?: string[];
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
