import { nanoid } from 'nanoid';
import type {
  AgentStartedEvent,
  AgentExitedEvent,
  OutputEvent,
  StatusChangedEvent,
  PlanCreatedEvent,
  ApprovalRequestEvent,
  ApprovalDecisionEvent,
  ApprovalFlags,
  ApprovalTool,
  GitSnapshotEvent,
  GitSnapshotErrorEvent,
  TasksCompletedEvent,
  ItemCreatedEvent,
  CloneStartedEvent,
  CloneCompletedEvent,
  WorkspaceSetupStartedEvent,
  WorkspaceSetupCompletedEvent,
  ErrorEvent,
  PrCreatedEvent,
  AgentRole,
} from '@agent-orch/shared';

function createEventId(): string {
  return nanoid(12);
}

function timestamp(): string {
  return new Date().toISOString();
}

export function createItemCreatedEvent(itemId: string): ItemCreatedEvent {
  return {
    id: createEventId(),
    type: 'item_created',
    timestamp: timestamp(),
    itemId,
  };
}

export function createCloneStartedEvent(
  itemId: string,
  repositoryUrl: string
): CloneStartedEvent {
  return {
    id: createEventId(),
    type: 'clone_started',
    timestamp: timestamp(),
    itemId,
    repositoryUrl,
  };
}

export function createCloneCompletedEvent(
  itemId: string,
  success: boolean,
  error?: string
): CloneCompletedEvent {
  return {
    id: createEventId(),
    type: 'clone_completed',
    timestamp: timestamp(),
    itemId,
    success,
    error,
  };
}

export function createAgentStartedEvent(
  itemId: string,
  agentId: string,
  role: AgentRole,
  pid: number
): AgentStartedEvent {
  return {
    id: createEventId(),
    type: 'agent_started',
    timestamp: timestamp(),
    itemId,
    agentId,
    role,
    pid,
  };
}

export function createAgentExitedEvent(
  itemId: string,
  agentId: string,
  exitCode: number,
  signal?: string
): AgentExitedEvent {
  return {
    id: createEventId(),
    type: 'agent_exited',
    timestamp: timestamp(),
    itemId,
    agentId,
    exitCode,
    signal,
  };
}

export function createOutputEvent(
  itemId: string,
  agentId: string,
  type: 'stdout' | 'stderr',
  data: string
): OutputEvent {
  return {
    id: createEventId(),
    type,
    timestamp: timestamp(),
    itemId,
    agentId,
    data,
  };
}

export function createStatusChangedEvent(
  itemId: string,
  previousStatus: string,
  newStatus: string,
  agentId?: string
): StatusChangedEvent {
  return {
    id: createEventId(),
    type: 'status_changed',
    timestamp: timestamp(),
    itemId,
    agentId,
    previousStatus,
    newStatus,
  };
}

export function createPlanCreatedEvent(
  itemId: string,
  planPath: string
): PlanCreatedEvent {
  return {
    id: createEventId(),
    type: 'plan_created',
    timestamp: timestamp(),
    itemId,
    planPath,
  };
}

export function createApprovalRequestEvent(
  itemId: string,
  agentId: string,
  command: string,
  classification: 'blocklist' | 'approval_required' | 'auto_approvable',
  uiKind: 'menu' | 'yn' | 'unknown',
  context?: string,
  autoDecision?: 'approve' | 'deny',
  tool?: ApprovalTool,
  path?: string,
  flags?: ApprovalFlags
): ApprovalRequestEvent {
  return {
    id: createEventId(),
    type: 'approval_requested',
    timestamp: timestamp(),
    itemId,
    agentId,
    command,
    classification,
    uiKind,
    context,
    autoDecision,
    tool,
    path,
    flags,
  };
}

export function createApprovalDecisionEvent(
  itemId: string,
  agentId: string,
  requestEventId: string,
  decision: 'approve' | 'deny',
  decidedBy: 'user' | 'auto',
  reason?: string
): ApprovalDecisionEvent {
  return {
    id: createEventId(),
    type: 'approval_decision',
    timestamp: timestamp(),
    itemId,
    agentId,
    requestEventId,
    decision,
    decidedBy,
    reason,
  };
}

export function createGitSnapshotEvent(
  itemId: string,
  cwd: string,
  commitHash: string,
  dirty: boolean,
  changedFiles: string[],
  additions: number,
  deletions: number,
  diffStat: string,
  agentId?: string
): GitSnapshotEvent {
  return {
    id: createEventId(),
    type: 'git_snapshot',
    timestamp: timestamp(),
    itemId,
    agentId,
    cwd,
    commitHash,
    dirty,
    changedFiles,
    additions,
    deletions,
    diffStat,
  };
}

export function createGitSnapshotErrorEvent(
  itemId: string,
  cwd: string,
  error: string,
  agentId?: string
): GitSnapshotErrorEvent {
  return {
    id: createEventId(),
    type: 'git_snapshot_error',
    timestamp: timestamp(),
    itemId,
    agentId,
    cwd,
    error,
  };
}

export function createTasksCompletedEvent(
  itemId: string,
  agentId: string
): TasksCompletedEvent {
  return {
    id: createEventId(),
    type: 'tasks_completed',
    timestamp: timestamp(),
    itemId,
    agentId,
  };
}

export function createErrorEvent(
  itemId: string,
  message: string,
  stack?: string,
  agentId?: string
): ErrorEvent {
  return {
    id: createEventId(),
    type: 'error',
    timestamp: timestamp(),
    itemId,
    agentId,
    message,
    stack,
  };
}

export function createWorkspaceSetupStartedEvent(
  itemId: string,
  localPath: string,
  linkMode: 'symlink' | 'copy'
): WorkspaceSetupStartedEvent {
  return {
    id: createEventId(),
    type: 'workspace_setup_started',
    timestamp: timestamp(),
    itemId,
    localPath,
    linkMode,
  };
}

export function createWorkspaceSetupCompletedEvent(
  itemId: string,
  success: boolean,
  error?: string
): WorkspaceSetupCompletedEvent {
  return {
    id: createEventId(),
    type: 'workspace_setup_completed',
    timestamp: timestamp(),
    itemId,
    success,
    error,
  };
}

export function createPrCreatedEvent(
  itemId: string,
  prUrl: string,
  prNumber: number,
  branch: string,
  commitHash: string
): PrCreatedEvent {
  return {
    id: createEventId(),
    type: 'pr_created',
    timestamp: timestamp(),
    itemId,
    prUrl,
    prNumber,
    branch,
    commitHash,
  };
}
