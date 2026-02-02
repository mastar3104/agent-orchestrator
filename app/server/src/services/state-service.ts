import type {
  ItemStatus,
  AgentStatus,
  ItemEvent,
  ApprovalRequestEvent,
  ApprovalDecisionEvent,
} from '@agent-orch/shared';
import { readJsonl } from '../lib/jsonl';
import { getItemEventsPath, getAgentEventsPath } from '../lib/paths';

export async function deriveItemStatus(itemId: string): Promise<ItemStatus> {
  const events = await readJsonl<ItemEvent>(getItemEventsPath(itemId));

  if (events.length === 0) {
    return 'created';
  }

  // Check for errors
  const hasError = events.some((e) => e.type === 'error');
  if (hasError) {
    // PR作成が完了していない状態でエラーがあれば error
    const hasPrCreated = events.some((e) => e.type === 'pr_created');
    if (!hasPrCreated) {
      return 'error';
    }
    // PR作成後のエラーは最後のイベントがerrorの場合のみ
    const lastEvent = events[events.length - 1];
    if (lastEvent.type === 'error') {
      return 'error';
    }
  }

  // Check for active clone operation (remote)
  const cloneStarted = events.some((e) => e.type === 'clone_started');
  const cloneCompleted = events.some(
    (e) => e.type === 'clone_completed' && (e as { success: boolean }).success
  );
  const cloneFailed = events.some(
    (e) => e.type === 'clone_completed' && !(e as { success: boolean }).success
  );

  if (cloneStarted && !cloneCompleted && !cloneFailed) {
    return 'cloning';
  }

  if (cloneFailed) {
    return 'error';
  }

  // Check for workspace setup operation (local)
  const setupStarted = events.some((e) => e.type === 'workspace_setup_started');
  const setupCompleted = events.some(
    (e) => e.type === 'workspace_setup_completed' && (e as { success: boolean }).success
  );
  const setupFailed = events.some(
    (e) => e.type === 'workspace_setup_completed' && !(e as { success: boolean }).success
  );

  if (setupStarted && !setupCompleted && !setupFailed) {
    return 'cloning'; // Use 'cloning' status for consistency (could be renamed to 'preparing' in future)
  }

  if (setupFailed) {
    return 'error';
  }

  // Check for plan
  const hasPlan = events.some((e) => e.type === 'plan_created');

  // Build agent role map from agent_started events
  const agentRoles = new Map<string, import('@agent-orch/shared').AgentRole>();
  for (const event of events) {
    if (event.type === 'agent_started') {
      const e = event as import('@agent-orch/shared').AgentStartedEvent;
      agentRoles.set(e.agentId, e.role);
    }
  }

  // Helper: check if agentId is planner (with fallback to string matching)
  const isPlannerAgent = (agentId: string): boolean => {
    const role = agentRoles.get(agentId);
    if (role !== undefined) {
      return role === 'planner';
    }
    // Fallback: string matching (for missing agent_started events)
    return agentId.includes('-planner-');
  };

  // Check for running agents
  const agentStates = new Map<string, AgentStatus>();

  for (const event of events) {
    if (event.agentId) {
      switch (event.type) {
        case 'agent_started':
          agentStates.set(event.agentId, 'running');
          break;
        case 'agent_exited': {
          const e = event as import('@agent-orch/shared').AgentExitedEvent;
          agentStates.set(event.agentId, e.exitCode === 0 ? 'completed' : 'error');
          break;
        }
        case 'approval_requested':
          agentStates.set(event.agentId, 'waiting_approval');
          break;
        case 'approval_decision':
          // Resume running after approval decision
          const currentStatus = agentStates.get(event.agentId);
          if (currentStatus === 'waiting_approval') {
            agentStates.set(event.agentId, 'running');
          }
          break;
        case 'status_changed': {
          const e = event as import('@agent-orch/shared').StatusChangedEvent;
          agentStates.set(event.agentId, e.newStatus as AgentStatus);
          break;
        }
      }
    }
  }

  const statuses = Array.from(agentStates.values());

  // Check for pending approvals first (for any agent including planner)
  if (statuses.includes('waiting_approval')) {
    return 'waiting_approval';
  }

  // Check if planner is running (using role map with fallback)
  const plannerAgentId = Array.from(agentStates.keys()).find(isPlannerAgent);
  if (plannerAgentId) {
    const plannerStatus = agentStates.get(plannerAgentId);
    if (plannerStatus === 'running') {
      return 'planning';
    }
  }

  // Check for running agents (workers, not planner)
  if (statuses.includes('running')) {
    return 'running';
  }

  // Check if any worker (non-planner) agents exist (using role map with fallback)
  const workerAgentIds = Array.from(agentStates.keys()).filter((id) => !isPlannerAgent(id));
  const hasWorkers = workerAgentIds.length > 0;

  // Check for completed state: all workers have tasks_completed and PR is created
  if (hasWorkers) {
    // Deduplicate tasks_completed by agentId
    const completedWorkerAgentIds = new Set(
      events
        .filter((e) => e.type === 'tasks_completed' && e.agentId)
        .map((e) => e.agentId!)
        .filter((id) => !isPlannerAgent(id))
    );
    const hasPrCreated = events.some((e) => e.type === 'pr_created');

    if (completedWorkerAgentIds.size >= workerAgentIds.length && hasPrCreated) {
      return 'completed';
    }
  }

  // Has plan but workers not finished or PR not created
  if (hasPlan) {
    return 'ready';
  }

  return 'created';
}

export async function deriveAgentStatus(
  itemId: string,
  agentId: string
): Promise<AgentStatus> {
  const events = await readJsonl<ItemEvent>(getAgentEventsPath(itemId, agentId));

  if (events.length === 0) {
    return 'idle';
  }

  let status: AgentStatus = 'idle';

  for (const event of events) {
    switch (event.type) {
      case 'agent_started':
        status = 'running';
        break;
      case 'agent_exited': {
        const e = event as import('@agent-orch/shared').AgentExitedEvent;
        status = e.exitCode === 0 ? 'completed' : 'error';
        break;
      }
      case 'approval_requested':
        status = 'waiting_approval';
        break;
      case 'approval_decision':
        if (status === 'waiting_approval') {
          status = 'running';
        }
        break;
      case 'status_changed': {
        const e = event as import('@agent-orch/shared').StatusChangedEvent;
        status = e.newStatus as AgentStatus;
        break;
      }
    }
  }

  return status;
}

export async function getPendingApprovals(
  itemId: string
): Promise<ApprovalRequestEvent[]> {
  const events = await readJsonl<ItemEvent>(getItemEventsPath(itemId));

  // Get all approval requests
  const requests = events.filter(
    (e) => e.type === 'approval_requested'
  ) as ApprovalRequestEvent[];

  // Get all decisions
  const decisions = events.filter(
    (e) => e.type === 'approval_decision'
  ) as ApprovalDecisionEvent[];

  // Find requests without decisions
  const decidedRequestIds = new Set(decisions.map((d) => d.requestEventId));

  return requests.filter(
    (r) => !decidedRequestIds.has(r.id) && r.autoDecision !== 'deny'
  );
}

export async function getEventHistory(
  itemId: string,
  limit?: number,
  agentId?: string
): Promise<ItemEvent[]> {
  const path = agentId
    ? getAgentEventsPath(itemId, agentId)
    : getItemEventsPath(itemId);

  const events = await readJsonl<ItemEvent>(path);

  if (limit) {
    return events.slice(-limit);
  }

  return events;
}

export async function getAgentOutputHistory(
  itemId: string,
  agentId: string,
  limit?: number
): Promise<{ timestamp: string; data: string }[]> {
  const events = await readJsonl<ItemEvent>(getAgentEventsPath(itemId, agentId));

  const outputs = events
    .filter((e) => e.type === 'stdout' || e.type === 'stderr')
    .map((e) => {
      const o = e as import('@agent-orch/shared').OutputEvent;
      return {
        timestamp: o.timestamp,
        data: o.data,
      };
    });

  if (limit) {
    return outputs.slice(-limit);
  }

  return outputs;
}
