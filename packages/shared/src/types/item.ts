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
  hooks?: string[];
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

export type TaskExecutionStatus =
  | 'pending'
  | 'in_progress'
  | 'in_review'
  | 'completed'
  | 'failed';

export type TaskProgressPhase = 'engineer' | 'hooks' | 'review';

export type WorkflowStageId =
  | 'workspace'
  | 'planning'
  | 'execution'
  | 'publish'
  | 'review_receive';

export type WorkflowJobStage = 'execution' | 'publish' | 'review_receive';

export type WorkflowStageStatus = 'pending' | 'running' | 'completed' | 'error';

export type RepoStatus =
  | 'not_started'
  | 'ready'
  | 'running'
  | 'review_receiving'
  | 'completed'
  | 'error';

export type RepoPhase = 'clone' | 'workspace_setup' | 'engineer' | 'hooks' | 'review' | 'pr' | 'review_receive';

export interface RepoSummary {
  repoName: string;
  prUrl?: string;
  prNumber?: number;
  noChanges: boolean;  // repo_no_changes イベントから派生
  status: RepoStatus;
  activePhase?: RepoPhase;
  inCurrentPlan: boolean;
  lastErrorMessage?: string;
}

export interface ItemWorkflowStage {
  id: WorkflowStageId;
  label: string;
  status: WorkflowStageStatus;
  optional?: boolean;
}

export interface ItemWorkflowStep {
  taskId: string;
  title: string;
  status: TaskExecutionStatus;
  currentPhase?: TaskProgressPhase;
  attempts: number;
  reviewRounds?: number;
  lastError?: string;
}

export interface ItemWorkflowJob {
  repoName: string;
  status: WorkflowStageStatus;
  activeStage?: WorkflowJobStage;
  currentTaskId?: string;
  currentPhase?: TaskProgressPhase;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  steps: ItemWorkflowStep[];
}

export interface ItemWorkflowSummary {
  stages: ItemWorkflowStage[];
  jobs: ItemWorkflowJob[];
  overall: {
    totalSteps: number;
    completedSteps: number;
    failedSteps: number;
    runningStepId?: string;
  };
  currentActivity?: {
    repoName?: string;
    stage: WorkflowStageId;
    taskId?: string;
    phase?: TaskProgressPhase;
    moreRunningCount?: number;
  };
}

export interface ItemDetail extends ItemConfig {
  status: ItemStatus;
  plan?: import('./plan').Plan;
  agents: import('./agent').AgentInfo[];
  pendingApprovals: import('./events').ApprovalRequestEvent[];
  repos: RepoSummary[];  // 変更: prUrl/prNumber を置換
  workflow: ItemWorkflowSummary;
}
