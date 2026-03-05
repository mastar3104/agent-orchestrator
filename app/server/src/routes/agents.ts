import { readFile } from 'fs/promises';
import type { FastifyPluginAsync } from 'fastify';
import type {
  ApiResponse,
  AgentInfo,
  AgentExecutionOutput,
  AgentRole,
} from '@agent-orch/shared';
import {
  stopAgent,
  getAgent,
  getAgentsByItem,
} from '../services/agent-service';
import { startPlanner, getPlan, getPlanContent, updatePlanContent } from '../services/planner-service';
import { startWorkers, startWorkerForRepo, getWorkerStatus } from '../services/worker-service';
import { getWorkspaceRoot, getAgentOutputPath } from '../lib/paths';
import { withItemLock, isItemLocked } from '../lib/locks';
import { createErrorEvent } from '../lib/events';
import { appendJsonl } from '../lib/jsonl';
import { getItemEventsPath } from '../lib/paths';
import { eventBus } from '../services/event-bus';
import { stopAllGitSnapshots } from '../services/git-snapshot-service';

const WORKERS_MAX_RETRIES = 1; // Total 2 attempts

export const agentRoutes: FastifyPluginAsync = async (fastify) => {
  // Start planner for an item (async — returns 202 immediately)
  fastify.post<{
    Params: { id: string };
    Reply: ApiResponse<{ started: boolean }>;
  }>('/items/:id/planner/start', async (request, reply) => {
    const itemId = request.params.id;

    if (isItemLocked(itemId)) {
      return reply.status(409).send({
        success: false,
        error: 'Operation already in progress for this item',
      });
    }

    // Fire-and-forget with item lock + error logging
    withItemLock(itemId, () => startPlanner(itemId)).catch(async (err) => {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[${itemId}] Planner failed:`, message);
      try {
        const errorEvent = createErrorEvent(itemId, message);
        await appendJsonl(getItemEventsPath(itemId), errorEvent);
        eventBus.emit('event', { itemId, event: errorEvent });
      } catch { /* best-effort */ }
    });

    return reply.status(202).send({
      success: true,
      data: { started: true },
    });
  });

  // Get plan for an item
  fastify.get<{
    Params: { id: string };
    Reply: ApiResponse<{ plan: import('@agent-orch/shared').Plan | null }>;
  }>('/items/:id/plan', async (request, reply) => {
    try {
      const plan = await getPlan(request.params.id);
      return reply.send({
        success: true,
        data: { plan },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  // Get plan content for an item
  fastify.get<{
    Params: { id: string };
    Reply: ApiResponse<{ content: string | null }>;
  }>('/items/:id/plan/content', async (request, reply) => {
    try {
      const content = await getPlanContent(request.params.id);
      return reply.send({
        success: true,
        data: { content },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  // Update plan for an item
  fastify.put<{
    Params: { id: string };
    Body: { content: string };
    Reply: ApiResponse<{ plan: import('@agent-orch/shared').Plan; content: string }>;
  }>('/items/:id/plan', async (request, reply) => {
    try {
      const { content } = request.body;
      const updated = await updatePlanContent(request.params.id, content);
      return reply.send({
        success: true,
        data: updated,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(400).send({
        success: false,
        error: message,
      });
    }
  });

  // Start all workers (async — returns 202 immediately)
  fastify.post<{
    Params: { id: string };
    Reply: ApiResponse<{ started: boolean }>;
  }>('/items/:id/workers/start', async (request, reply) => {
    const itemId = request.params.id;

    if (isItemLocked(itemId)) {
      return reply.status(409).send({
        success: false,
        error: 'Operation already in progress for this item',
      });
    }

    // Fire-and-forget with item lock + retry + error logging
    withItemLock(itemId, async () => {
      let lastError: Error | null = null;
      for (let attempt = 0; attempt <= WORKERS_MAX_RETRIES; attempt++) {
        try {
          await startWorkers(itemId);
          return;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt < WORKERS_MAX_RETRIES) {
            stopAllGitSnapshots(itemId);
            console.warn(`[${itemId}] Workers attempt ${attempt + 1} failed: ${lastError.message}, retrying...`);
            continue;
          }
        }
      }
      throw lastError!;
    }).catch(async (err) => {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[${itemId}] Workers failed:`, message);
      try {
        const errorEvent = createErrorEvent(itemId, message);
        await appendJsonl(getItemEventsPath(itemId), errorEvent);
        eventBus.emit('event', { itemId, event: errorEvent });
      } catch { /* best-effort */ }
    });

    return reply.status(202).send({
      success: true,
      data: { started: true },
    });
  });

  // Get worker status
  fastify.get<{
    Params: { id: string };
    Reply: ApiResponse<{ workers: Awaited<ReturnType<typeof getWorkerStatus>> }>;
  }>('/items/:id/workers/status', async (request, reply) => {
    try {
      const workers = await getWorkerStatus(request.params.id);
      return reply.send({
        success: true,
        data: { workers },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  // List agents for an item
  fastify.get<{
    Params: { id: string };
    Reply: ApiResponse<{ agents: AgentInfo[] }>;
  }>('/items/:id/agents', async (request, reply) => {
    try {
      const agents = await getAgentsByItem(request.params.id);
      return reply.send({
        success: true,
        data: { agents },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  // Start a specific agent
  fastify.post<{
    Params: { id: string };
    Body: { repoName: string; role?: string; prompt?: string };
    Reply: ApiResponse<{ agent: AgentInfo }>;
  }>('/items/:id/agents/start', async (request, reply) => {
    try {
      const { repoName, role } = request.body;
      const effectiveRole = (role || 'engineer') as AgentRole;

      if (!repoName) {
        return reply.status(400).send({
          success: false,
          error: 'repoName is required',
        });
      }

      // Reject system roles that have dedicated start flows
      if (effectiveRole === 'planner') {
        return reply.status(400).send({
          success: false,
          error: 'Use POST /items/:id/planner/start to start the planner',
        });
      }
      if (effectiveRole === 'review-receiver') {
        return reply.status(400).send({
          success: false,
          error: 'review-receiver requires PR context; use the review-receive endpoint',
        });
      }

      // Dev roles (and 'review') → delegate to startWorkerForRepo
      await startWorkerForRepo(request.params.id, repoName, effectiveRole);
      const agents = await getAgentsByItem(request.params.id);
      const agent = agents.find((a) => a.role === effectiveRole && a.repoName === repoName);
      if (!agent) {
        return reply.status(404).send({
          success: false,
          error: `Agent for role '${effectiveRole}' in repo '${repoName}' not found after start`,
        });
      }
      return reply.status(201).send({
        success: true,
        data: { agent },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  // Get agent info
  fastify.get<{
    Params: { id: string; agentId: string };
    Reply: ApiResponse<{ agent: AgentInfo }>;
  }>('/items/:id/agents/:agentId', async (request, reply) => {
    try {
      const agent = getAgent(request.params.agentId);
      if (!agent || agent.itemId !== request.params.id) {
        return reply.status(404).send({
          success: false,
          error: 'Agent not found',
        });
      }
      return reply.send({
        success: true,
        data: { agent },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  // Get agent output
  fastify.get<{
    Params: { id: string; agentId: string };
    Reply: ApiResponse<{ output: AgentExecutionOutput | null }>;
  }>('/items/:id/agents/:agentId/output', async (request, reply) => {
    try {
      const agent = getAgent(request.params.agentId);
      if (!agent || agent.itemId !== request.params.id) {
        return reply.status(404).send({
          success: false,
          error: 'Agent not found',
        });
      }

      const outputPath = getAgentOutputPath(request.params.id, request.params.agentId);
      let output: AgentExecutionOutput | null = null;
      try {
        const raw = await readFile(outputPath, 'utf-8');
        output = JSON.parse(raw) as AgentExecutionOutput;
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
          // File not found — agent hasn't completed yet
          output = null;
        } else {
          console.warn(`[${request.params.agentId}] Failed to read output.json: ${err instanceof Error ? err.message : err}`);
          output = null;
        }
      }

      return reply.send({
        success: true,
        data: { output },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  // Stop an agent
  fastify.post<{
    Params: { id: string; agentId: string };
    Reply: ApiResponse<{ stopped: boolean }>;
  }>('/items/:id/agents/:agentId/stop', async (request, reply) => {
    try {
      const stopped = await stopAgent(request.params.agentId);
      if (!stopped) {
        return reply.status(404).send({
          success: false,
          error: 'Agent not found or already stopped',
        });
      }
      return reply.send({
        success: true,
        data: { stopped: true },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });
};
