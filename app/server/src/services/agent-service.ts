import { mkdir } from 'fs/promises';
import { nanoid } from 'nanoid';
import type {
  AgentInfo,
  AgentRole,
  AgentStatus,
  AgentStartOptions,
  ItemEvent,
} from '@agent-orch/shared';
import { ptyManager } from '../lib/pty-manager';
import { appendJsonl, readJsonl } from '../lib/jsonl';
import {
  getAgentDir,
  getAgentEventsPath,
  getItemEventsPath,
  getWorkspaceDir,
} from '../lib/paths';
import {
  createAgentStartedEvent,
  createAgentExitedEvent,
  createOutputEvent,
  createStatusChangedEvent,
  createApprovalRequestEvent,
  createApprovalDecisionEvent,
  createTasksCompletedEvent,
  createErrorEvent,
} from '../lib/events';
import { eventBus } from './event-bus';

// In-memory state for running agents
const agentState = new Map<string, AgentInfo>();

export async function startAgent(options: AgentStartOptions): Promise<AgentInfo> {
  const agentId = `agent-${options.role}-${nanoid(6)}`;

  // Create agent directory
  await mkdir(getAgentDir(options.itemId, agentId), { recursive: true });

  const agent: AgentInfo = {
    id: agentId,
    itemId: options.itemId,
    role: options.role,
    status: 'starting',
    startedAt: new Date().toISOString(),
  };

  agentState.set(agentId, agent);

  try {
    // Spawn PTY
    const instance = await ptyManager.spawn({
      id: agentId,
      itemId: options.itemId,
      role: options.role,
      workingDir: options.workingDir || getWorkspaceDir(options.itemId),
      prompt: options.prompt,
      env: options.env,
    });

    agent.pid = instance.pid;
    agent.status = 'running';

    // Log agent started
    const startEvent = createAgentStartedEvent(
      options.itemId,
      agentId,
      options.role,
      instance.pid
    );
    await logEvent(options.itemId, agentId, startEvent);

    // Setup event handlers
    setupAgentEventHandlers(agentId, options.itemId);

    return agent;
  } catch (error) {
    agent.status = 'error';
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    const errorEvent = createErrorEvent(options.itemId, errorMessage, undefined, agentId);
    await logEvent(options.itemId, agentId, errorEvent);

    throw error;
  }
}

function setupAgentEventHandlers(agentId: string, itemId: string): void {
  // Define cleanup function to remove all listeners
  const cleanup = () => {
    ptyManager.off('output', handleOutput);
    ptyManager.off('exit', handleExit);
    ptyManager.off('approval_requested', handleApprovalRequest);
    ptyManager.off('approval_auto_denied', handleAutoDeny);
    ptyManager.off('tasks_completed', handleTasksCompleted);
  };

  const handleOutput = async (event: { instanceId: string; data: string; timestamp: string }) => {
    if (event.instanceId !== agentId) return;

    const outputEvent = createOutputEvent(itemId, agentId, 'stdout', event.data);
    await logEvent(itemId, agentId, outputEvent);
  };

  const handleExit = async (event: { instanceId: string; exitCode: number; signal?: number }) => {
    if (event.instanceId !== agentId) return;

    const agent = agentState.get(agentId);
    if (agent) {
      agent.status = event.exitCode === 0 ? 'completed' : 'error';
      agent.stoppedAt = new Date().toISOString();
      agent.exitCode = event.exitCode;
    }

    const exitEvent = createAgentExitedEvent(
      itemId,
      agentId,
      event.exitCode,
      event.signal?.toString()
    );
    await logEvent(itemId, agentId, exitEvent);

    // Cleanup all listeners
    cleanup();
  };

  const handleApprovalRequest = async (event: {
    instanceId: string;
    command: string;
    classification: 'blocklist' | 'approval_required';
    uiKind: 'menu' | 'yn' | 'unknown';
    context: string;
    timestamp: string;
  }) => {
    if (event.instanceId !== agentId) return;

    const agent = agentState.get(agentId);
    if (agent) {
      agent.status = 'waiting_approval';
    }

    const approvalEvent = createApprovalRequestEvent(
      itemId,
      agentId,
      event.command,
      event.classification,
      event.uiKind,
      event.context
    );
    await logEvent(itemId, agentId, approvalEvent);
  };

  const handleAutoDeny = async (event: { instanceId: string; command: string; reason: string }) => {
    if (event.instanceId !== agentId) return;

    // Log the auto-denial
    const requestEvent = createApprovalRequestEvent(
      itemId,
      agentId,
      event.command,
      'blocklist',
      'unknown',  // auto-denyの場合はuiKind不明でも問題ない
      undefined,
      'deny'
    );
    await logEvent(itemId, agentId, requestEvent);

    const decisionEvent = createApprovalDecisionEvent(
      itemId,
      agentId,
      requestEvent.id,
      'deny',
      'auto',
      event.reason
    );
    await logEvent(itemId, agentId, decisionEvent);
  };

  const handleTasksCompleted = async (event: { instanceId: string; timestamp: string }) => {
    if (event.instanceId !== agentId) return;

    const agent = agentState.get(agentId);
    if (agent) {
      const previousStatus = agent.status;
      agent.status = 'waiting_orchestrator';

      // Log status change
      const statusEvent = createStatusChangedEvent(
        itemId,
        previousStatus,
        'waiting_orchestrator',
        agentId
      );
      await logEvent(itemId, agentId, statusEvent);

      // Log tasks completed event
      const tasksCompletedEvent = createTasksCompletedEvent(itemId, agentId);
      await logEvent(itemId, agentId, tasksCompletedEvent);
    }
  };

  // Register all listeners
  ptyManager.on('output', handleOutput);
  ptyManager.on('exit', handleExit);
  ptyManager.on('approval_requested', handleApprovalRequest);
  ptyManager.on('approval_auto_denied', handleAutoDeny);
  ptyManager.on('tasks_completed', handleTasksCompleted);
}

async function logEvent(itemId: string, agentId: string, event: ItemEvent): Promise<void> {
  // Log to agent's events
  await appendJsonl(getAgentEventsPath(itemId, agentId), event);

  // Log to item's events
  await appendJsonl(getItemEventsPath(itemId), event);

  // Broadcast via event bus
  eventBus.emit('event', { itemId, event });
}

export async function sendInput(agentId: string, input: string): Promise<boolean> {
  return ptyManager.sendInput(agentId, input);
}

export async function processApproval(
  itemId: string,
  agentId: string,
  requestEventId: string,
  decision: 'approve' | 'deny',
  reason?: string,
  uiKind?: 'menu' | 'yn' | 'unknown'
): Promise<boolean> {
  const approved = decision === 'approve';
  const success = ptyManager.processApproval(agentId, approved, uiKind);

  if (success) {
    const agent = agentState.get(agentId);
    if (agent) {
      agent.status = 'running';
    }

    const decisionEvent = createApprovalDecisionEvent(
      itemId,
      agentId,
      requestEventId,
      decision,
      'user',
      reason
    );
    await logEvent(itemId, agentId, decisionEvent);
  }

  return success;
}

export async function stopAgent(agentId: string): Promise<boolean> {
  const agent = agentState.get(agentId);
  if (!agent) {
    return false;
  }

  const killed = ptyManager.kill(agentId);

  if (killed) {
    agent.status = 'stopped';
    agent.stoppedAt = new Date().toISOString();

    const statusEvent = createStatusChangedEvent(
      agent.itemId,
      'running',
      'stopped',
      agentId
    );
    await logEvent(agent.itemId, agentId, statusEvent);
  }

  return killed;
}

export function getAgent(agentId: string): AgentInfo | undefined {
  return agentState.get(agentId);
}

export async function getAgentsByItem(itemId: string): Promise<AgentInfo[]> {
  return Array.from(agentState.values()).filter((agent) => agent.itemId === itemId);
}

export function getOutputBuffer(agentId: string): string | null {
  return ptyManager.getOutputBuffer(agentId);
}

export function resizeTerminal(agentId: string, cols: number, rows: number): boolean {
  return ptyManager.resize(agentId, cols, rows);
}

// Wait for specific agents to complete (by role)
// Agents are considered complete when they:
// - Exit (exit event)
// - Output TASKS_COMPLETED (tasks_completed event, status becomes waiting_orchestrator)
// - Already in terminal state (waiting_orchestrator, completed, error, stopped)
export function waitForAgentsToComplete(
  itemId: string,
  roles: AgentRole[]
): Promise<void> {
  return new Promise((resolve) => {
    const targetAgentIds = new Set<string>();
    const completedAgentIds = new Set<string>();

    // Find current agents matching the roles
    for (const agent of agentState.values()) {
      if (agent.itemId === itemId && roles.includes(agent.role)) {
        targetAgentIds.add(agent.id);
        // If already in terminal state, mark as completed
        if (
          agent.status === 'waiting_orchestrator' ||
          agent.status === 'completed' ||
          agent.status === 'error' ||
          agent.status === 'stopped'
        ) {
          completedAgentIds.add(agent.id);
        }
      }
    }

    // If no agents or all already completed
    if (targetAgentIds.size === 0 || completedAgentIds.size === targetAgentIds.size) {
      resolve();
      return;
    }

    const checkCompletion = () => {
      if (completedAgentIds.size === targetAgentIds.size) {
        ptyManager.off('exit', handleExit);
        ptyManager.off('tasks_completed', handleTasksCompleted);
        resolve();
      }
    };

    const handleExit = (event: { instanceId: string; exitCode: number; signal?: number }) => {
      if (targetAgentIds.has(event.instanceId)) {
        completedAgentIds.add(event.instanceId);
        checkCompletion();
      }
    };

    const handleTasksCompleted = (event: { instanceId: string; timestamp: string }) => {
      if (targetAgentIds.has(event.instanceId)) {
        completedAgentIds.add(event.instanceId);
        checkCompletion();
      }
    };

    ptyManager.on('exit', handleExit);
    ptyManager.on('tasks_completed', handleTasksCompleted);
  });
}

// Reconstruct agent state from events on startup
export async function reconstructAgentState(itemId: string): Promise<void> {
  const events = await readJsonl<ItemEvent>(getItemEventsPath(itemId));

  const agents = new Map<string, AgentInfo>();

  for (const event of events) {
    if (event.type === 'agent_started' && event.agentId) {
      const e = event as import('@agent-orch/shared').AgentStartedEvent;
      agents.set(e.agentId, {
        id: e.agentId,
        itemId: e.itemId,
        role: e.role,
        status: 'running',
        pid: e.pid,
        startedAt: e.timestamp,
      });
    } else if (event.type === 'agent_exited' && event.agentId) {
      const e = event as import('@agent-orch/shared').AgentExitedEvent;
      const agent = agents.get(e.agentId);
      if (agent) {
        agent.status = e.exitCode === 0 ? 'completed' : 'error';
        agent.stoppedAt = e.timestamp;
        agent.exitCode = e.exitCode;
      }
    } else if (event.type === 'status_changed' && event.agentId) {
      const e = event as import('@agent-orch/shared').StatusChangedEvent;
      const agent = agents.get(event.agentId);
      if (agent) {
        agent.status = e.newStatus as AgentStatus;
      }
    }
  }

  // Only keep non-running agents in state (running ones would have PTYs)
  for (const [id, agent] of agents) {
    if (agent.status !== 'running') {
      agentState.set(id, agent);
    }
  }
}

// Clean up orphaned agents (running in events but no PTY exists)
// This should be called on server startup for each item
export async function cleanupOrphanedAgentsForItem(itemId: string): Promise<number> {
  const events = await readJsonl<ItemEvent>(getItemEventsPath(itemId));

  // Build agent states from events
  // Key design decisions:
  // 1. agent_started initializes the agent, but doesn't override existing status
  // 2. status_changed can create an agent entry even without agent_started (handles missing events)
  // 3. Events are processed in order, so later events always take precedence
  const agents = new Map<string, { status: AgentStatus; agentId: string; role?: AgentRole }>();

  for (const event of events) {
    if (event.type === 'agent_started' && event.agentId) {
      const e = event as import('@agent-orch/shared').AgentStartedEvent;
      // Only initialize if not exists (don't override later status_changed events)
      if (!agents.has(event.agentId)) {
        agents.set(event.agentId, {
          status: 'running',
          agentId: event.agentId,
          role: e.role,
        });
      } else {
        // Update role if we have it, but keep existing status
        const existing = agents.get(event.agentId)!;
        existing.role = e.role;
      }
    } else if (event.type === 'agent_exited' && event.agentId) {
      const e = event as import('@agent-orch/shared').AgentExitedEvent;
      const existing = agents.get(event.agentId);
      const newStatus = e.exitCode === 0 ? 'completed' : 'error';
      if (existing) {
        existing.status = newStatus;
      } else {
        // Create entry even without agent_started
        agents.set(event.agentId, {
          status: newStatus,
          agentId: event.agentId,
        });
      }
    } else if (event.type === 'status_changed' && event.agentId) {
      const e = event as import('@agent-orch/shared').StatusChangedEvent;
      const existing = agents.get(event.agentId);
      if (existing) {
        existing.status = e.newStatus as AgentStatus;
      } else {
        // Create entry even without agent_started (handles missing events)
        agents.set(event.agentId, {
          status: e.newStatus as AgentStatus,
          agentId: event.agentId,
        });
      }
    }
  }

  // Find agents that are in "active" status but have no PTY
  let cleanedCount = 0;
  for (const [agentId, agent] of agents) {
    const isActiveStatus = agent.status === 'running' ||
                           agent.status === 'waiting_approval' ||
                           agent.status === 'waiting_orchestrator';

    if (isActiveStatus) {
      // Check if PTY exists
      const ptyInstance = ptyManager.getInstance(agentId);
      if (!ptyInstance) {
        // No PTY exists - agent was orphaned by server restart

        // 1. Determine role FIRST (before any writes)
        const role = agent.role ?? tryExtractRoleFromAgentId(agentId);

        if (!role) {
          // Cannot determine role - skip entirely (no event write, no in-memory update)
          console.warn(`[${itemId}] Skipping orphaned agent cleanup: ${agentId} (unknown role, was ${agent.status})`);
          continue;
        }

        console.log(`[${itemId}] Cleaning up orphaned agent: ${agentId} (was ${agent.status})`);

        // 2. Write event first
        const statusEvent = createStatusChangedEvent(
          itemId,
          agent.status,
          'stopped',
          agentId
        );

        try {
          await logEvent(itemId, agentId, statusEvent);
        } catch (error) {
          // logEvent failed - do NOT update in-memory state to maintain consistency
          console.error(`[${itemId}] Failed to log status_changed for orphaned agent ${agentId}:`, error);
          continue;
        }

        // 3. Update in-memory state ONLY after successful event write
        agentState.set(agentId, {
          id: agentId,
          itemId,
          role,
          status: 'stopped',
          stoppedAt: new Date().toISOString(),
        });

        cleanedCount++;
      }
    }
  }

  return cleanedCount;
}

// Helper to extract role from agent ID (e.g., "agent-review-kYB7V2" -> "review")
// Returns null if pattern is unknown - caller must handle this case
function tryExtractRoleFromAgentId(agentId: string): AgentRole | null {
  if (agentId.includes('-planner-')) return 'planner';
  if (agentId.includes('-front-')) return 'front';
  if (agentId.includes('-back-')) return 'back';
  if (agentId.includes('-review-')) return 'review';

  // Unknown role pattern - return null to let caller decide
  return null;
}
