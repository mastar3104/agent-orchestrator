import type {
  ItemStatus,
  AgentStatus,
  ItemEvent,
  ApprovalRequestEvent,
  ApprovalDecisionEvent,
  ReviewReceiveStartedEvent,
  CloneCompletedEvent,
  WorkspaceSetupCompletedEvent,
} from '@agent-orch/shared';
import { isSystemRole } from '@agent-orch/shared';
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
    const hasPrCreated = events.some((e) => e.type === 'pr_created');
    const hasNoChanges = events.some((e) => e.type === 'repo_no_changes');
    if (!hasPrCreated && !hasNoChanges) {
      return 'error';
    }
    const lastEvent = events[events.length - 1];
    if (lastEvent.type === 'error') {
      return 'error';
    }
  }

  // Check for active clone operation (remote) - any repo
  const cloneStartedEvents = events.filter((e) => e.type === 'clone_started');
  const cloneCompletedEvents = events.filter((e) => e.type === 'clone_completed') as CloneCompletedEvent[];

  if (cloneStartedEvents.length > 0) {
    // Check if any clone is still in progress or failed
    const completedRepos = new Set(
      cloneCompletedEvents.filter(e => e.success).map(e => e.repoName)
    );
    const failedRepos = cloneCompletedEvents.filter(e => !e.success);

    if (failedRepos.length > 0) {
      return 'error';
    }

    const startedRepos = new Set(
      (events.filter(e => e.type === 'clone_started') as Array<{ repoName: string }>).map(e => e.repoName)
    );
    const allCloned = [...startedRepos].every(r => completedRepos.has(r));
    if (!allCloned) {
      return 'cloning';
    }
  }

  // Check for workspace setup operation (local) - any repo
  const setupStartedEvents = events.filter((e) => e.type === 'workspace_setup_started');
  const setupCompletedEvents = events.filter((e) => e.type === 'workspace_setup_completed') as WorkspaceSetupCompletedEvent[];

  if (setupStartedEvents.length > 0) {
    const completedRepos = new Set(
      setupCompletedEvents.filter(e => e.success).map(e => e.repoName)
    );
    const failedRepos = setupCompletedEvents.filter(e => !e.success);

    if (failedRepos.length > 0) {
      return 'error';
    }

    const startedRepos = new Set(
      (events.filter(e => e.type === 'workspace_setup_started') as Array<{ repoName: string }>).map(e => e.repoName)
    );
    const allSetup = [...startedRepos].every(r => completedRepos.has(r));
    if (!allSetup) {
      return 'cloning';
    }
  }

  // Check for plan
  const hasPlan = events.some((e) => e.type === 'plan_created');

  // Build agent role map from agent_started events
  const agentRoles = new Map<string, string>();
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
    return agentId.includes('-planner-');
  };

  // Helper: check if agentId is review-receiver (with fallback to string matching)
  const isReviewReceiverAgent = (agentId: string): boolean => {
    const role = agentRoles.get(agentId);
    if (role !== undefined) {
      return role === 'review-receiver';
    }
    return agentId.includes('-review-receiver-');
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
          const currentStatusExited = agentStates.get(event.agentId);
          if (currentStatusExited !== 'stopped') {
            agentStates.set(event.agentId, e.exitCode === 0 ? 'completed' : 'error');
          }
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
          const currentStatusChanged = agentStates.get(event.agentId);
          if (currentStatusChanged !== 'stopped') {
            agentStates.set(event.agentId, e.newStatus as AgentStatus);
          }
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

  // Check for review receive in progress
  const reviewReceiveStartedEvents = events.filter(
    (e): e is ReviewReceiveStartedEvent => e.type === 'review_receive_started'
  );

  if (reviewReceiveStartedEvents.length > 0) {
    const lastReviewReceiveEvent =
      reviewReceiveStartedEvents[reviewReceiveStartedEvents.length - 1];
    const lastReviewReceiveIdx = events.indexOf(lastReviewReceiveEvent);

    if (lastReviewReceiveEvent.agentId) {
      const targetAgentId = lastReviewReceiveEvent.agentId;

      const planCreatedAfterLastReviewReceive = events.some(
        (e, idx) => e.type === 'plan_created' && idx > lastReviewReceiveIdx
      );

      if (!planCreatedAfterLastReviewReceive) {
        const reviewReceiverStatus = agentStates.get(targetAgentId);

        // Still in progress: not started, running, or waiting for plan detection after TASKS_COMPLETED
        if (
          reviewReceiverStatus === undefined ||
          reviewReceiverStatus === 'running' ||
          reviewReceiverStatus === 'waiting_orchestrator'
        ) {
          return 'review_receiving';
        }

        // All other terminal states (completed, error, stopped) without plan = error
        return 'error';
      }
    }
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

  // Check if any worker (non-planner, non-review-receiver) agents exist
  const workerAgentIds = Array.from(agentStates.keys()).filter(
    (id) => !isPlannerAgent(id) && !isReviewReceiverAgent(id)
  );
  const hasWorkers = workerAgentIds.length > 0;

  // Check for completed state: all repos have pr_created OR repo_no_changes
  if (hasWorkers) {
    const completedWorkerAgentIds = new Set(
      events
        .filter((e) => e.type === 'tasks_completed' && e.agentId)
        .map((e) => e.agentId!)
        .filter((id) => !isPlannerAgent(id) && !isReviewReceiverAgent(id))
    );

    const hasPrCreated = events.some((e) => e.type === 'pr_created');
    const hasRepoNoChanges = events.some((e) => e.type === 'repo_no_changes');

    if (completedWorkerAgentIds.size >= workerAgentIds.length && (hasPrCreated || hasRepoNoChanges)) {
      const lastPrIdx = events.reduce(
        (maxIdx, e, idx) => (e.type === 'pr_created' || e.type === 'repo_no_changes' ? Math.max(maxIdx, idx) : maxIdx),
        -1
      );
      const hasPlanAfterLastPr = events.some(
        (e, idx) => e.type === 'plan_created' && idx > lastPrIdx
      );
      const hasReviewReceiveAfterLastPr = events.some(
        (e, idx) => e.type === 'review_receive_started' && idx > lastPrIdx
      );

      if (!hasPlanAfterLastPr && !hasReviewReceiveAfterLastPr) {
        return 'completed';
      }
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
        if (status !== 'stopped') {
          status = e.exitCode === 0 ? 'completed' : 'error';
        }
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
        if (status !== 'stopped') {
          status = e.newStatus as AgentStatus;
        }
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
