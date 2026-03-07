import { mkdir, writeFile } from 'fs/promises';
import { type ChildProcess } from 'child_process';
import { nanoid } from 'nanoid';
import type {
  AgentInfo,
  AgentRole,
  AgentStatus,
  AgentExecutionOutput,
  ItemEvent,
} from '@agent-orch/shared';

import {
  runClaude,
  ClaudeExecutionError,
  ClaudeSchemaValidationError,
  type ClaudeExecutionOptions,
  type ClaudeExecutionResult,
} from '../lib/claude-executor';
import { appendJsonl, readJsonl } from '../lib/jsonl';
import {
  getAgentDir,
  getAgentEventsPath,
  getAgentOutputPath,
  getItemEventsPath,
} from '../lib/paths';
import {
  createAgentStartedEvent,
  createAgentExitedEvent,
  createStatusChangedEvent,
  createClaudeExecutionEvent,
  createErrorEvent,
} from '../lib/events';
import { eventBus } from './event-bus';

// In-memory state for running agents
const agentState = new Map<string, AgentInfo>();

// Track running processes for stopAgent
const runningProcesses = new Map<string, { abort: AbortController }>();

/**
 * Generate a unique agent ID
 * Exported for pre-generating IDs before event recording
 */
export function generateAgentId(_itemId: string, role: AgentRole, repoName?: string): string {
  if (repoName) {
    return `agent-${role}--${repoName}--${nanoid(6)}`;
  }
  return `agent-${role}--${nanoid(6)}`;
}

async function saveAgentOutput(itemId: string, agentId: string, data: AgentExecutionOutput): Promise<void> {
  try {
    await writeFile(getAgentOutputPath(itemId, agentId), JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.warn(`[${agentId}] Failed to save output.json: ${e instanceof Error ? e.message : e}`);
  }
}

async function logEvent(itemId: string, agentId: string, event: ItemEvent): Promise<void> {
  await appendJsonl(getAgentEventsPath(itemId, agentId), event);
  await appendJsonl(getItemEventsPath(itemId), event);
  eventBus.emit('event', { itemId, event });
}

/**
 * Execute an agent using `claude -p` with JSON response.
 * Replaces the old PTY-based startAgent + waitForAgentsByIds flow.
 */
export async function executeAgent<T>(options: {
  itemId: string;
  role: AgentRole;
  repoName?: string;
  currentTask?: string;
  prompt: string;
  workingDir: string;
  allowedTools: string[];
  jsonSchema: object;
  agentId?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<{ agent: AgentInfo; result: ClaudeExecutionResult<T> }> {
  // planner 以外は repoName 必須チェック
  if (options.role !== 'planner' && !options.repoName) {
    throw new Error(`repoName is required for role '${options.role}'`);
  }

  const agentId = options.agentId ?? generateAgentId(options.itemId, options.role, options.repoName);

  // Create agent directory
  await mkdir(getAgentDir(options.itemId, agentId), { recursive: true });

  const agent: AgentInfo = {
    id: agentId,
    itemId: options.itemId,
    role: options.role,
    repoName: options.repoName,
    currentTask: options.currentTask,
    status: 'starting',
    startedAt: new Date().toISOString(),
  };

  agentState.set(agentId, agent);

  // Log agent started (pid 0 since we don't track PIDs for -p mode)
  const startEvent = createAgentStartedEvent(
    options.itemId,
    agentId,
    options.role,
    0,
    options.repoName
  );
  await logEvent(options.itemId, agentId, startEvent);

  agent.status = 'running';

  // Create abort controller for this agent
  const abortController = new AbortController();
  runningProcesses.set(agentId, { abort: abortController });

  try {
    const result = await runClaude<T>({
      prompt: options.prompt,
      allowedTools: options.allowedTools,
      jsonSchema: options.jsonSchema,
      cwd: options.workingDir,
      env: options.env,
      timeoutMs: options.timeoutMs,
      signal: abortController.signal,
    });

    // Save output.json (best-effort)
    await saveAgentOutput(options.itemId, agentId, {
      prompt: options.prompt,
      stdout: result.rawStdout,
      stderr: result.stderr,
      parsedOutput: result.output,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timestamp: new Date().toISOString(),
    });

    // Log claude_execution event
    const executionEvent = createClaudeExecutionEvent(
      options.itemId,
      agentId,
      options.role,
      result.exitCode,
      result.durationMs,
      1,
      true
    );
    await logEvent(options.itemId, agentId, executionEvent);

    // Log agent exited
    const exitEvent = createAgentExitedEvent(options.itemId, agentId, 0);
    await logEvent(options.itemId, agentId, exitEvent);

    agent.status = 'completed';
    agent.stoppedAt = new Date().toISOString();
    agent.exitCode = 0;

    return { agent, result };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Log error event
    const phase = options.role === 'review-receiver' ? 'review_receive' as const
      : (['engineer', 'review', 'planner'] as const).find(r => r === options.role);
    const errorEvent = createErrorEvent(options.itemId, errorMessage, {
      agentId,
      repoName: options.repoName,
      phase,
    });
    await logEvent(options.itemId, agentId, errorEvent);

    // Log agent exited with error
    const exitEvent = createAgentExitedEvent(options.itemId, agentId, 1);
    await logEvent(options.itemId, agentId, exitEvent);

    // Save output.json (best-effort)
    if (error instanceof ClaudeExecutionError) {
      await saveAgentOutput(options.itemId, agentId, {
        prompt: options.prompt,
        stdout: error.stdout,
        stderr: error.stderr,
        parsedOutput: null,
        exitCode: error.exitCode,
        durationMs: error.durationMs,
        timestamp: new Date().toISOString(),
      });
    } else if (error instanceof ClaudeSchemaValidationError) {
      await saveAgentOutput(options.itemId, agentId, {
        prompt: options.prompt,
        stdout: error.rawOutput,
        stderr: error.stderr,
        parsedOutput: null,
        exitCode: error.exitCode,
        durationMs: error.durationMs,
        timestamp: new Date().toISOString(),
      });
    }

    agent.status = 'error';
    agent.stoppedAt = new Date().toISOString();
    agent.exitCode = 1;

    throw error;
  } finally {
    runningProcesses.delete(agentId);
  }
}

export async function stopAgent(agentId: string): Promise<boolean> {
  const agent = agentState.get(agentId);
  if (!agent) {
    return false;
  }

  // Check if process is still running
  const running = runningProcesses.get(agentId);
  if (running) {
    running.abort.abort();
    runningProcesses.delete(agentId);
  }

  const previousStatus = agent.status;
  agent.status = 'stopped';
  agent.stoppedAt = new Date().toISOString();

  const statusEvent = createStatusChangedEvent(
    agent.itemId,
    previousStatus,
    'stopped',
    agentId
  );
  await logEvent(agent.itemId, agentId, statusEvent);

  return true;
}

export function getAgent(agentId: string): AgentInfo | undefined {
  return agentState.get(agentId);
}

export async function getAgentsByItem(itemId: string): Promise<AgentInfo[]> {
  return Array.from(agentState.values()).filter((agent) => agent.itemId === itemId);
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
        repoName: e.repoName,
        status: 'running',
        pid: e.pid,
        startedAt: e.timestamp,
      });
    } else if (event.type === 'agent_exited' && event.agentId) {
      const e = event as import('@agent-orch/shared').AgentExitedEvent;
      const agent = agents.get(e.agentId);
      if (agent) {
        if (agent.status !== 'stopped') {
          agent.status = e.exitCode === 0 ? 'completed' : 'error';
        }
        agent.stoppedAt = e.timestamp;
        agent.exitCode = e.exitCode;
      }
    } else if (event.type === 'status_changed' && event.agentId) {
      const e = event as import('@agent-orch/shared').StatusChangedEvent;
      const agent = agents.get(event.agentId);
      if (agent) {
        if (agent.status !== 'stopped') {
          // Backward compat: map old statuses to new ones
          let newStatus = e.newStatus as AgentStatus;
          if (newStatus === ('waiting_approval' as AgentStatus)) {
            newStatus = 'running';
          } else if (newStatus === ('waiting_orchestrator' as AgentStatus)) {
            newStatus = 'completed';
          }
          agent.status = newStatus;
        }
      }
    }
  }

  // Only keep non-running agents in state (running ones would have processes)
  for (const [id, agent] of agents) {
    if (agent.status !== 'running') {
      agentState.set(id, agent);
    }
  }
}

// Clean up orphaned agents (running in events but no process exists)
export async function cleanupOrphanedAgentsForItem(itemId: string): Promise<number> {
  const events = await readJsonl<ItemEvent>(getItemEventsPath(itemId));

  const agents = new Map<string, { status: AgentStatus; agentId: string; role?: AgentRole }>();

  for (const event of events) {
    if (event.type === 'agent_started' && event.agentId) {
      const e = event as import('@agent-orch/shared').AgentStartedEvent;
      if (!agents.has(event.agentId)) {
        agents.set(event.agentId, {
          status: 'running',
          agentId: event.agentId,
          role: e.role,
        });
      } else {
        const existing = agents.get(event.agentId)!;
        existing.role = e.role;
      }
    } else if (event.type === 'agent_exited' && event.agentId) {
      const e = event as import('@agent-orch/shared').AgentExitedEvent;
      const existing = agents.get(event.agentId);
      const newStatus = e.exitCode === 0 ? 'completed' : 'error';
      if (existing) {
        if (existing.status !== 'stopped') {
          existing.status = newStatus;
        }
      } else {
        agents.set(event.agentId, {
          status: newStatus,
          agentId: event.agentId,
        });
      }
    } else if (event.type === 'status_changed' && event.agentId) {
      const e = event as import('@agent-orch/shared').StatusChangedEvent;
      const existing = agents.get(event.agentId);
      // Backward compat mapping
      let newStatus = e.newStatus as AgentStatus;
      if (newStatus === ('waiting_approval' as AgentStatus)) {
        newStatus = 'running';
      } else if (newStatus === ('waiting_orchestrator' as AgentStatus)) {
        newStatus = 'completed';
      }
      if (existing) {
        if (existing.status !== 'stopped') {
          existing.status = newStatus;
        }
      } else {
        agents.set(event.agentId, {
          status: newStatus,
          agentId: event.agentId,
        });
      }
    }
  }

  // Find agents that are in "active" status but have no running process
  let cleanedCount = 0;
  for (const [agentId, agent] of agents) {
    const isActiveStatus = agent.status === 'running';

    if (isActiveStatus) {
      // Check if process exists
      const hasProcess = runningProcesses.has(agentId);
      if (!hasProcess) {
        const role = agent.role ?? tryExtractRoleFromAgentId(agentId);

        if (!role) {
          console.warn(`[${itemId}] Skipping orphaned agent cleanup: ${agentId} (unknown role, was ${agent.status})`);
          continue;
        }

        console.log(`[${itemId}] Cleaning up orphaned agent: ${agentId} (was ${agent.status})`);

        const statusEvent = createStatusChangedEvent(
          itemId,
          agent.status,
          'stopped',
          agentId
        );

        try {
          await logEvent(itemId, agentId, statusEvent);
        } catch (error) {
          console.error(`[${itemId}] Failed to log status_changed for orphaned agent ${agentId}:`, error);
          continue;
        }

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

  // Detect repos stuck in review_receiving (review_receive_started with no agent_started, completion, OR error)
  // Note: fetchPrComments failure writes an error event before throwing — that case is NOT a stuck repo
  const rrStates = new Map<string, { startIdx: number; completed: boolean; agentStarted: boolean; hadError: boolean }>();
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === 'review_receive_started') {
      const e = ev as import('@agent-orch/shared').ReviewReceiveStartedEvent;
      rrStates.set(e.repoName, { startIdx: i, completed: false, agentStarted: false, hadError: false });
    } else if (ev.type === 'review_receive_completed') {
      const e = ev as import('@agent-orch/shared').ReviewReceiveCompletedEvent;
      const s = rrStates.get(e.repoName);
      if (s) s.completed = true;
    } else if (ev.type === 'agent_started' && ev.agentId) {
      const e = ev as import('@agent-orch/shared').AgentStartedEvent;
      if (e.role === 'review-receiver' && e.repoName) {
        const s = rrStates.get(e.repoName);
        if (s && i > s.startIdx) s.agentStarted = true;
      }
    } else if (ev.type === 'error') {
      const e = ev as import('@agent-orch/shared').ErrorEvent;
      if (e.repoName) {
        const s = rrStates.get(e.repoName);
        if (s) s.hadError = true;
      }
    }
  }
  for (const [repoName, s] of rrStates) {
    if (!s.completed && !s.agentStarted && !s.hadError) {
      console.log(`[${itemId}] Cleaning up stuck review_receiving repo: ${repoName}`);
      const errorEvent = createErrorEvent(itemId, 'Server restarted before review receive agent started', {
        repoName,
        phase: 'review_receive',
      });
      try {
        await appendJsonl(getItemEventsPath(itemId), errorEvent);
        eventBus.emit('event', { itemId, event: errorEvent });
        cleanedCount++;
      } catch (err) {
        console.error(`[${itemId}] Failed to log error for stuck review_receiving repo ${repoName}:`, err);
      }
    }
  }

  return cleanedCount;
}

// Helper to extract role from agent ID
function tryExtractRoleFromAgentId(agentId: string): AgentRole | null {
  const parts = agentId.split('--');
  if (parts.length >= 2 && parts[0].startsWith('agent-')) {
    return parts[0].slice('agent-'.length) as AgentRole;
  }

  if (agentId.includes('-planner-')) return 'planner';
  if (agentId.includes('-review-receiver-')) return 'review-receiver';
  if (agentId.includes('-review-')) return 'review';

  const match = agentId.match(/^agent-([^-]+)-/);
  if (match) return match[1];

  return null;
}
