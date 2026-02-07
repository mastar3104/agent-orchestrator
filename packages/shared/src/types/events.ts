export type EventType =
  | 'agent_started'
  | 'agent_exited'
  | 'stdout'
  | 'stderr'
  | 'status_changed'
  | 'plan_created'
  | 'approval_requested'
  | 'approval_decision'
  | 'git_snapshot'
  | 'git_snapshot_error'
  | 'tasks_completed'
  | 'item_created'
  | 'clone_started'
  | 'clone_completed'
  | 'workspace_setup_started'
  | 'workspace_setup_completed'
  | 'error'
  | 'pr_created'
  | 'review_findings_extracted'
  | 'review_receive_started';

export interface BaseEvent {
  id: string;
  type: EventType;
  timestamp: string;
  itemId: string;
  agentId?: string;
}

export interface AgentStartedEvent extends BaseEvent {
  type: 'agent_started';
  agentId: string;
  role: import('./agent').AgentRole;
  pid: number;
}

export interface AgentExitedEvent extends BaseEvent {
  type: 'agent_exited';
  agentId: string;
  exitCode: number;
  signal?: string;
}

export interface OutputEvent extends BaseEvent {
  type: 'stdout' | 'stderr';
  agentId: string;
  data: string;
}

export interface StatusChangedEvent extends BaseEvent {
  type: 'status_changed';
  agentId?: string;
  previousStatus: string;
  newStatus: string;
}

export interface PlanCreatedEvent extends BaseEvent {
  type: 'plan_created';
  planPath: string;
}

export type ApprovalTool = 'bash' | 'read' | 'write' | 'edit' | 'unknown';

export interface ApprovalFlags {
  isOutsideWorkspace: boolean;
  isDestructive: boolean;
  involvesSecrets: boolean;
  involvesNetwork: boolean;
}

export interface ApprovalRequestEvent extends BaseEvent {
  type: 'approval_requested';
  agentId: string;
  // Original fields
  command: string;
  classification: 'blocklist' | 'approval_required' | 'auto_approvable';
  uiKind: 'menu' | 'yn' | 'unknown';
  context?: string;
  autoDecision?: 'approve' | 'deny';
  // Extended fields for orchestrator control
  tool?: ApprovalTool;
  path?: string;
  flags?: ApprovalFlags;
}

export interface ApprovalDecisionEvent extends BaseEvent {
  type: 'approval_decision';
  agentId: string;
  requestEventId: string;
  decision: 'approve' | 'deny';
  decidedBy: 'user' | 'auto';
  reason?: string;
}

export interface GitSnapshotEvent extends BaseEvent {
  type: 'git_snapshot';
  agentId?: string;
  cwd: string;               // 対象ディレクトリ
  commitHash: string;        // HEAD のコミットハッシュ
  dirty: boolean;            // 未コミット変更があるか
  changedFiles: string[];    // 変更されたファイル一覧
  additions: number;         // 追加行数合計
  deletions: number;         // 削除行数合計
  diffStat: string;          // UI表示用 (git diff --stat の出力)
}

export interface GitSnapshotErrorEvent extends BaseEvent {
  type: 'git_snapshot_error';
  agentId?: string;
  cwd: string;
  error: string;
}

export interface TasksCompletedEvent extends BaseEvent {
  type: 'tasks_completed';
  agentId: string;
}

export interface ItemCreatedEvent extends BaseEvent {
  type: 'item_created';
}

export interface CloneStartedEvent extends BaseEvent {
  type: 'clone_started';
  repositoryUrl: string;
}

export interface CloneCompletedEvent extends BaseEvent {
  type: 'clone_completed';
  success: boolean;
  error?: string;
}

export interface WorkspaceSetupStartedEvent extends BaseEvent {
  type: 'workspace_setup_started';
  localPath: string;
  linkMode: 'symlink' | 'copy';
}

export interface WorkspaceSetupCompletedEvent extends BaseEvent {
  type: 'workspace_setup_completed';
  success: boolean;
  error?: string;
}

export interface ErrorEvent extends BaseEvent {
  type: 'error';
  message: string;
  stack?: string;
}

export interface PrCreatedEvent extends BaseEvent {
  type: 'pr_created';
  prUrl: string;
  prNumber: number;
  branch: string;
  commitHash: string;
}

export interface ReviewFinding {
  severity: 'critical' | 'major' | 'minor';
  file: string;
  line?: number;
  description: string;
  suggestedFix: string;
  targetAgent: 'front' | 'back';
}

export interface ReviewFindingsExtractedEvent extends BaseEvent {
  type: 'review_findings_extracted';
  agentId: string;
  findings: ReviewFinding[];
  overallAssessment: 'pass' | 'needs_fixes';
  summary: string;
  criticalCount: number;
  majorCount: number;
  minorCount: number;
}

export interface ReviewReceiveStartedEvent extends BaseEvent {
  type: 'review_receive_started';
  agentId: string;  // 起動するagentのIDを含める（状態判定の紐づけ用）
  prNumber: number;
  prUrl: string;
}

export type AgentEvent =
  | AgentStartedEvent
  | AgentExitedEvent
  | OutputEvent
  | StatusChangedEvent
  | ApprovalRequestEvent
  | ApprovalDecisionEvent
  | GitSnapshotEvent
  | GitSnapshotErrorEvent
  | TasksCompletedEvent
  | ErrorEvent;

export type ItemEvent =
  | ItemCreatedEvent
  | CloneStartedEvent
  | CloneCompletedEvent
  | WorkspaceSetupStartedEvent
  | WorkspaceSetupCompletedEvent
  | PlanCreatedEvent
  | StatusChangedEvent
  | ErrorEvent
  | PrCreatedEvent
  | ReviewFindingsExtractedEvent
  | ReviewReceiveStartedEvent
  | AgentEvent;
