import type { TaskExecutionStatus, TaskProgressPhase } from './item';
import type { CompletedReviewFinding, VerificationPolicy } from './plan';

export type EventType =
  | 'agent_started'
  | 'agent_exited'
  | 'stdout'
  | 'stderr'
  | 'status_changed'
  | 'plan_created'
  | 'test_plan_created'
  | 'test_plan_approved'
  | 'completed_review_findings_extracted'
  | 'completed_review_passed'
  | 'completed_review_skipped'
  | 'approval_requested'
  | 'approval_decision'
  | 'git_snapshot'
  | 'git_snapshot_error'
  | 'tasks_completed'
  | 'claude_execution'
  | 'item_created'
  | 'clone_started'
  | 'clone_completed'
  | 'workspace_setup_started'
  | 'workspace_setup_completed'
  | 'repo_setup_started'
  | 'repo_setup_completed'
  | 'error'
  | 'test_plan_parse_warning'
  | 'pr_created'
  | 'repo_no_changes'
  | 'review_findings_extracted'
  | 'review_receive_started'
  | 'review_receive_completed'
  | 'hooks_executed'
  | 'task_state_changed';

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
  repoName?: string;  // planner のみ optional、それ以外は必須
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

export interface TestPlanCreatedEvent extends BaseEvent {
  type: 'test_plan_created';
  testPlanPath: string;
  planFingerprint: string;
  testPlanFingerprint: string;
}

export interface TestPlanApprovedEvent extends BaseEvent {
  type: 'test_plan_approved';
  planFingerprint: string;
  testPlanFingerprint: string;
  approvedBy: 'user' | 'auto';
}

export interface CompletedReviewFindingsExtractedEvent extends BaseEvent {
  type: 'completed_review_findings_extracted';
  agentId: string;
  findings: CompletedReviewFinding[];
  summary: string;
  round: number;
  criticalCount: number;
  majorCount: number;
  minorCount: number;
}

export interface CompletedReviewPassedEvent extends BaseEvent {
  type: 'completed_review_passed';
  agentId: string;
  summary: string;
  round: number;
}

export interface CompletedReviewSkippedEvent extends BaseEvent {
  type: 'completed_review_skipped';
  agentId: string;
  policy: VerificationPolicy;
  reason: string;
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
  repoName: string;
  repositoryUrl: string;
}

export interface CloneCompletedEvent extends BaseEvent {
  type: 'clone_completed';
  repoName: string;
  success: boolean;
  error?: string;
}

export interface WorkspaceSetupStartedEvent extends BaseEvent {
  type: 'workspace_setup_started';
  repoName: string;
  localPath: string;
  linkMode: 'symlink' | 'copy';
}

export interface WorkspaceSetupCompletedEvent extends BaseEvent {
  type: 'workspace_setup_completed';
  repoName: string;
  success: boolean;
  error?: string;
}

export interface RepoSetupStartedEvent extends BaseEvent {
  type: 'repo_setup_started';
  repoName: string;
  commands: string[];
}

export interface RepoSetupCompletedEvent extends BaseEvent {
  type: 'repo_setup_completed';
  repoName: string;
  results: HookResult[];
  allPassed: boolean;
}

export type ErrorPhase =
  | 'planner'
  | 'test_planner'
  | 'completed_review'
  | 'clone'
  | 'workspace_setup'
  | 'engineer'
  | 'hooks'
  | 'review'
  | 'pr'
  | 'review_receive';

export interface ErrorEvent extends BaseEvent {
  type: 'error';
  message: string;
  stack?: string;
  repoName?: string;
  phase?: ErrorPhase;
}

export interface TestPlanParseWarningEvent extends BaseEvent {
  type: 'test_plan_parse_warning';
  message: string;
  sourcePath: string;
  rawContentSavedTo: string;
  phase: 'test_planner';
}

export interface PrCreatedEvent extends BaseEvent {
  type: 'pr_created';
  repoName: string;
  prUrl: string;
  prNumber: number;
  branch: string;
  commitHash: string;
}

export interface RepoNoChangesEvent extends BaseEvent {
  type: 'repo_no_changes';
  repoName: string;
}

export type ReviewPerspective =
  | 'architecture'
  | 'security'
  | 'testing'
  | 'requirements';

export type ReviewPerspectiveStatus =
  | 'approve'
  | 'request_changes'
  | 'error'
  | 'schema_fallback';

export interface ReviewPerspectiveSummary {
  perspective: ReviewPerspective;
  status: ReviewPerspectiveStatus;
  summary: string;
  agentId: string;
  criticalCount: number;
  majorCount: number;
  minorCount: number;
}

export interface ReviewFinding {
  severity: 'critical' | 'major' | 'minor';
  file: string;
  line?: number;
  description: string;
  suggestedFix: string;
  targetAgent: string;
  perspective?: ReviewPerspective;
}

export interface ReviewFindingsExtractedEvent extends BaseEvent {
  type: 'review_findings_extracted';
  agentId: string;
  repoName: string;
  findings: ReviewFinding[];
  perspectives?: ReviewPerspectiveSummary[];
  overallAssessment: 'pass' | 'needs_fixes';
  summary: string;
  criticalCount: number;
  majorCount: number;
  minorCount: number;
}

export interface ReviewReceiveStartedEvent extends BaseEvent {
  type: 'review_receive_started';
  agentId: string;  // 起動するagentのIDを含める（状態判定の紐づけ用）
  repoName: string;
  prNumber: number;
  prUrl: string;
}

export interface ReviewReceiveCompletedEvent extends BaseEvent {
  type: 'review_receive_completed';
  agentId: string;
  repoName: string;
  prNumber: number;
  commentsCutoffAt: string | null; // max(fetchedComments.createdAt)。コメント0件ならnull
  totalComments: number;           // GitHub取得コメント総数
  newComments: number;             // フィルタ通過コメント数
  filteredComments: number;        // 除外コメント数
}

export interface ClaudeExecutionEvent extends BaseEvent {
  type: 'claude_execution';
  agentId: string;
  role: import('./agent').AgentRole;
  exitCode: number;
  durationMs: number;
  attempt: number;
  success: boolean;
}

export interface HookResult {
  command: string;
  exitCode: number | null;
  stderr: string;
  stdout: string;
  stdoutLogPath?: string;
  stderrLogPath?: string;
  durationMs: number;
  timedOut: boolean;
  signal?: string;
}

export interface HooksExecutedEvent extends BaseEvent {
  type: 'hooks_executed';
  repoName: string;
  results: HookResult[];
  allPassed: boolean;
  attempt: number;
}

export interface TaskStateChangedEvent extends BaseEvent {
  type: 'task_state_changed';
  repoName: string;
  taskId: string;
  status: TaskExecutionStatus;
  currentPhase?: TaskProgressPhase;
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
  | ClaudeExecutionEvent
  | ErrorEvent;

export type ItemEvent =
  | ItemCreatedEvent
  | CloneStartedEvent
  | CloneCompletedEvent
  | WorkspaceSetupStartedEvent
  | WorkspaceSetupCompletedEvent
  | RepoSetupStartedEvent
  | RepoSetupCompletedEvent
  | PlanCreatedEvent
  | TestPlanCreatedEvent
  | TestPlanApprovedEvent
  | CompletedReviewFindingsExtractedEvent
  | CompletedReviewPassedEvent
  | CompletedReviewSkippedEvent
  | StatusChangedEvent
  | ErrorEvent
  | TestPlanParseWarningEvent
  | PrCreatedEvent
  | RepoNoChangesEvent
  | ReviewFindingsExtractedEvent
  | ReviewReceiveStartedEvent
  | ReviewReceiveCompletedEvent
  | ClaudeExecutionEvent
  | HooksExecutedEvent
  | TaskStateChangedEvent
  | AgentEvent;
