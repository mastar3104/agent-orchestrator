import type { FastifyPluginAsync } from 'fastify';
import type {
  ApiResponse,
  StartAgentRequest,
  StartAgentResponse,
  SendInputRequest,
  AgentInfo,
  AgentRole,
} from '@agent-orch/shared';
import { isSystemRole } from '@agent-orch/shared';
import {
  startAgent,
  stopAgent,
  sendInput,
  getAgent,
  getAgentsByItem,
  getOutputBuffer,
  resizeTerminal,
} from '../services/agent-service';
import { startPlanner, getPlan, getPlanContent, updatePlanContent } from '../services/planner-service';
import { startWorkers, startWorkerForRole, getWorkerStatus } from '../services/worker-service';
import { getWorkspaceRoot } from '../lib/paths';

export const agentRoutes: FastifyPluginAsync = async (fastify) => {
  // Start planner for an item
  fastify.post<{
    Params: { id: string };
    Reply: ApiResponse<{ started: boolean }>;
  }>('/items/:id/planner/start', async (request, reply) => {
    try {
      await startPlanner(request.params.id);
      return reply.send({
        success: true,
        data: { started: true },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
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

  // Start all workers
  fastify.post<{
    Params: { id: string };
    Reply: ApiResponse<{ started: boolean }>;
  }>('/items/:id/workers/start', async (request, reply) => {
    try {
      await startWorkers(request.params.id);
      return reply.send({
        success: true,
        data: { started: true },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
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
    Body: StartAgentRequest;
    Reply: ApiResponse<StartAgentResponse>;
  }>('/items/:id/agents/start', async (request, reply) => {
    try {
      const { role, prompt } = request.body;

      // If role is a dev role or review, start via worker service
      if (!isSystemRole(role) || role === 'review') {
        await startWorkerForRole(request.params.id, role as AgentRole);
        const agents = await getAgentsByItem(request.params.id);
        const agent = agents.find((a) => a.role === role);
        if (agent) {
          return reply.status(201).send({
            success: true,
            data: { agent },
          });
        }
      }

      // Otherwise start a generic agent
      const agent = await startAgent({
        itemId: request.params.id,
        role,
        prompt: prompt || 'Start working on the assigned tasks.',
        workingDir: getWorkspaceRoot(request.params.id),
      });

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

  // Send input to an agent
  fastify.post<{
    Params: { id: string; agentId: string };
    Body: SendInputRequest;
    Reply: ApiResponse<{ sent: boolean }>;
  }>('/items/:id/agents/:agentId/input', async (request, reply) => {
    try {
      const sent = await sendInput(request.params.agentId, request.body.input);
      if (!sent) {
        return reply.status(404).send({
          success: false,
          error: 'Agent not found or not running',
        });
      }
      return reply.send({
        success: true,
        data: { sent: true },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  // Get agent output buffer
  fastify.get<{
    Params: { id: string; agentId: string };
    Reply: ApiResponse<{ output: string }>;
  }>('/items/:id/agents/:agentId/output', async (request, reply) => {
    try {
      const output = getOutputBuffer(request.params.agentId);
      if (output === null) {
        return reply.status(404).send({
          success: false,
          error: 'Agent not found',
        });
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

  // Resize agent terminal
  fastify.post<{
    Params: { id: string; agentId: string };
    Body: { cols: number; rows: number };
    Reply: ApiResponse<{ resized: boolean }>;
  }>('/items/:id/agents/:agentId/resize', async (request, reply) => {
    try {
      const { cols, rows } = request.body;
      const resized = resizeTerminal(request.params.agentId, cols, rows);
      if (!resized) {
        return reply.status(404).send({
          success: false,
          error: 'Agent not found or not running',
        });
      }
      return reply.send({
        success: true,
        data: { resized: true },
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
