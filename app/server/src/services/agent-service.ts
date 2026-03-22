import { mkdir, writeFile } from 'fs/promises';
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
  type ClaudeSchemaFallbackMode,
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
import { reconcileStoppedRepoTaskStateForItem } from './task-state-service';

// In-memory state for running agents
const agentState = new Map<string, AgentInfo>();

// Track running processes for stopAgent
const runningProcesses = new Map<string, { abort: AbortController }>();
const TASK_STATE_TRACKED_STOP_ROLES = new Set(['engineer', 'developer', 'review']);

async function reconcileStoppedTaskStateForAgent(agent: {
  itemId: string;
  role: AgentRole;
  repoName?: string;
  id?: string;
}): Promise<void> {
  if (!agent.repoName || !TASK_STATE_TRACKED_STOP_ROLES.has(agent.role)) {
    return;
  }

  try {
    await reconcileStoppedRepoTaskStateForItem(agent.itemId, agent.repoName);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      `[${agent.itemId}] Failed to reconcile task state after stopping agent ${agent.id || '<unknown>'}: ${detail}`
    );
  }
}

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
  appendSystemPrompt?: string;
  addDirs?: string[];
  workingDir: string;
  allowedTools: string[];
  jsonSchema: object;
  schemaFallbackMode?: ClaudeSchemaFallbackMode;
  agentId?: string;
  resumeSessionId?: string;
  emitErrorEvent?: boolean;
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<{ agent: AgentInfo; result: ClaudeExecutionResult<T> }> {
  const workspaceScopedRoles = new Set(['planner', 'test-planner', 'completed-reviewer']);
  if (!workspaceScopedRoles.has(options.role) && !options.repoName) {
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
      appendSystemPrompt: options.appendSystemPrompt,
      addDirs: options.addDirs,
      allowedTools: options.allowedTools,
      jsonSchema: options.jsonSchema,
      schemaFallbackMode: options.schemaFallbackMode,
      cwd: options.workingDir,
      resumeSessionId: options.resumeSessionId,
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
      usedSchemaFallback: result.usedSchemaFallback,
      schemaValidationErrors: result.schemaValidationErrors,
      sessionId: result.sessionId,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timestamp: new Date().toISOString(),
    });

    if (result.usedSchemaFallback) {
      console.warn(
        `[${agentId}] Claude output failed schema validation; continuing with fallback output: ${(result.schemaValidationErrors || []).join('; ')}`
      );
    }

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

    if (options.emitErrorEvent !== false) {
      const phase = options.role === 'review-receiver' ? 'review_receive' as const
        : options.role === 'test-planner' ? 'test_planner' as const
        : options.role === 'completed-reviewer' ? 'completed_review' as const
        : (['engineer', 'review', 'planner'] as const).find(r => r === options.role);
      const errorEvent = createErrorEvent(options.itemId, errorMessage, {
        agentId,
        repoName: options.repoName,
        phase,
      });
      await logEvent(options.itemId, agentId, errorEvent);
    }

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
        schemaValidationErrors: error.validationErrors,
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
  await reconcileStoppedTaskStateForAgent(agent);

  return true;
}

export function getAgent(agentId: string): AgentInfo | undefined {
  return agentState.get(agentId);
}

export async function getAgentsByItem(itemId: string): Promise<AgentInfo[]> {
  return Array.from(agentState.values()).filter((agent) => agent.itemId === itemId);
}

// Clean up orphaned agents (running in events but no process exists)
export async function cleanupOrphanedAgentsForItem(itemId: string): Promise<number> {
  const events = await readJsonl<ItemEvent>(getItemEventsPath(itemId));

  const agents = new Map<string, { status: AgentStatus; agentId: string; role?: AgentRole; repoName?: string }>();

  for (const event of events) {
    if (event.type === 'agent_started' && event.agentId) {
      const e = event as import('@agent-orch/shared').AgentStartedEvent;
      if (!agents.has(event.agentId)) {
        agents.set(event.agentId, {
          status: 'running',
          agentId: event.agentId,
          role: e.role,
          repoName: e.repoName,
        });
      } else {
        const existing = agents.get(event.agentId)!;
        existing.role = e.role;
        existing.repoName = e.repoName;
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
          repoName: undefined,
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

        await reconcileStoppedTaskStateForAgent({
          id: agentId,
          itemId,
          role,
          repoName: agent.repoName,
        });

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
  if (agentId.includes('-completed-reviewer-')) return 'completed-reviewer';
  if (agentId.includes('-review-')) return 'review';

  const match = agentId.match(/^agent-([^-]+)-/);
  if (match) return match[1];

  return null;
}
