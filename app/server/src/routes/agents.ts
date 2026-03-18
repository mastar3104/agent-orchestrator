import { readFile } from 'fs/promises';
import type { FastifyPluginAsync } from 'fastify';
import { existsSync } from 'fs';
import type {
  ApiResponse,
  AgentInfo,
  AgentExecutionOutput,
  Plan,
  PlanFeedbackItem,
  TestPlanFeedbackItem,
  StartWorkersRequest,
  GetPlanContentResponse,
  GetTestPlanResponse,
  GetTestPlanContentResponse,
  UpdatePlanRequest,
  UpdatePlanResponse,
  UpdateTestPlanRequest,
  UpdateTestPlanResponse,
  StartAsyncResponse,
  TestPlanApprovalResponse,
} from '@agent-orch/shared';
import {
  stopAgent,
  getAgent,
  getAgentsByItem,
} from '../services/agent-service';
import { startPlanner, getPlan, getPlanContent, updatePlanContent, planFeedback, validatePlanFeedback } from '../services/planner-service';
import { parseYaml } from '../lib/yaml';
import { startWorkers, getWorkerStatus } from '../services/worker-service';
import { getWorkspaceRoot, getAgentOutputPath, getItemPlanPath, getItemEventsPath } from '../lib/paths';
import { withItemLock, isItemLocked } from '../lib/locks';
import { createErrorEvent } from '../lib/events';
import { appendJsonl } from '../lib/jsonl';
import { eventBus } from '../services/event-bus';
import { stopAllGitSnapshots } from '../services/git-snapshot-service';
import {
  approveTestPlan,
  deriveTestPlanApproval,
  getTestPlan,
  getTestPlanContent,
  startTestPlanner,
  testPlanFeedback,
  updateTestPlanContent,
  validateTestPlanFeedback,
} from '../services/test-planner-service';

async function recordBackgroundError(
  itemId: string,
  message: string,
  phase?: import('@agent-orch/shared').ErrorPhase
): Promise<void> {
  try {
    const errorEvent = createErrorEvent(itemId, message, { phase });
    await appendJsonl(getItemEventsPath(itemId), errorEvent);
    eventBus.emit('event', { itemId, event: errorEvent });
  } catch {
    // best-effort
  }
}

export const agentRoutes: FastifyPluginAsync = async (fastify) => {
  // Start planner for an item (async — returns 202 immediately)
  fastify.post<{
    Params: { id: string };
    Reply: ApiResponse<StartAsyncResponse>;
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
      await recordBackgroundError(itemId, message, 'planner');
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
    Reply: ApiResponse<GetPlanContentResponse>;
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
    Body: UpdatePlanRequest;
    Reply: ApiResponse<UpdatePlanResponse>;
  }>('/items/:id/plan', async (request, reply) => {
    try {
      const itemId = request.params.id;
      if (isItemLocked(itemId)) {
        return reply.status(409).send({
          success: false,
          error: 'Operation already in progress for this item',
        });
      }

      const { content } = request.body;
      const updated = await withItemLock(itemId, () =>
        updatePlanContent(itemId, content)
      );

      queueMicrotask(() => {
        withItemLock(itemId, () => startTestPlanner(itemId)).catch(async (err) => {
          const message = err instanceof Error ? err.message : 'Unknown error';
          console.error(`[${itemId}] Test planner failed after manual plan update:`, message);
          await recordBackgroundError(itemId, message, 'test_planner');
        });
      });

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

  // Submit plan feedback (async — returns 202 immediately)
  fastify.post<{
    Params: { id: string };
    Body: { feedbacks: PlanFeedbackItem[] };
    Reply: ApiResponse<StartAsyncResponse>;
  }>('/items/:id/plan/feedback', async (request, reply) => {
    const itemId = request.params.id;
    const { feedbacks } = request.body || {};

    if (isItemLocked(itemId)) {
      return reply.status(409).send({
        success: false,
        error: 'Operation already in progress for this item',
      });
    }

    // Validate feedbacks structure
    if (!Array.isArray(feedbacks)) {
      return reply.status(400).send({
        success: false,
        error: 'feedbacks must be an array',
      });
    }

    if (feedbacks.length === 0) {
      return reply.status(400).send({
        success: false,
        error: 'feedbacks must not be empty',
      });
    }

    for (const fb of feedbacks) {
      if (!fb || typeof fb !== 'object' || typeof fb.taskId !== 'string' || typeof fb.feedback !== 'string') {
        return reply.status(400).send({
          success: false,
          error: 'Each feedback must have string taskId and feedback',
        });
      }
      if (!fb.taskId.trim()) {
        return reply.status(400).send({
          success: false,
          error: 'taskId must not be empty',
        });
      }
      if (!fb.feedback.trim()) {
        return reply.status(400).send({
          success: false,
          error: 'feedback must not be empty',
        });
      }
    }

    // Check duplicate taskIds
    const taskIds = feedbacks.map(fb => fb.taskId.trim());
    const uniqueTaskIds = new Set(taskIds);
    if (uniqueTaskIds.size !== taskIds.length) {
      return reply.status(400).send({
        success: false,
        error: 'Duplicate taskId in feedbacks',
      });
    }

    // Check plan exists
    const planPath = getItemPlanPath(itemId);
    if (!existsSync(planPath)) {
      return reply.status(400).send({
        success: false,
        error: 'No plan exists yet',
      });
    }

    // Validate taskIds against plan
    try {
      const planContent = await readFile(planPath, 'utf-8');
      const plan = parseYaml<Plan>(planContent);
      const validationErrors = validatePlanFeedback(feedbacks, plan);
      if (validationErrors.length > 0) {
        return reply.status(400).send({
          success: false,
          error: validationErrors.join('; '),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read plan';
      return reply.status(400).send({
        success: false,
        error: message,
      });
    }

    // Fire-and-forget with item lock + error logging
    withItemLock(itemId, () => planFeedback(itemId, feedbacks)).catch(async (err) => {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[${itemId}] Plan feedback failed:`, message);
      await recordBackgroundError(itemId, message, 'planner');
    });

    return reply.status(202).send({
      success: true,
      data: { started: true },
    });
  });

  fastify.post<{
    Params: { id: string };
    Reply: ApiResponse<StartAsyncResponse>;
  }>('/items/:id/test-planner/start', async (request, reply) => {
    const itemId = request.params.id;

    if (isItemLocked(itemId)) {
      return reply.status(409).send({
        success: false,
        error: 'Operation already in progress for this item',
      });
    }

    withItemLock(itemId, () => startTestPlanner(itemId)).catch(async (err) => {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[${itemId}] Test planner failed:`, message);
      await recordBackgroundError(itemId, message, 'test_planner');
    });

    return reply.status(202).send({
      success: true,
      data: { started: true },
    });
  });

  fastify.get<{
    Params: { id: string };
    Reply: ApiResponse<GetTestPlanResponse>;
  }>('/items/:id/test-plan', async (request, reply) => {
    try {
      const testPlan = await getTestPlan(request.params.id);
      return reply.send({
        success: true,
        data: { testPlan },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  fastify.get<{
    Params: { id: string };
    Reply: ApiResponse<GetTestPlanContentResponse>;
  }>('/items/:id/test-plan/content', async (request, reply) => {
    try {
      const content = await getTestPlanContent(request.params.id);
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

  fastify.put<{
    Params: { id: string };
    Body: UpdateTestPlanRequest;
    Reply: ApiResponse<UpdateTestPlanResponse>;
  }>('/items/:id/test-plan', async (request, reply) => {
    try {
      const itemId = request.params.id;
      if (isItemLocked(itemId)) {
        return reply.status(409).send({
          success: false,
          error: 'Operation already in progress for this item',
        });
      }

      const updated = await withItemLock(itemId, () =>
        updateTestPlanContent(itemId, request.body.content)
      );
      return reply.send({
        success: true,
        data: {
          testPlan: updated.testPlan,
          content: updated.content,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(400).send({
        success: false,
        error: message,
      });
    }
  });

  fastify.post<{
    Params: { id: string };
    Body: { feedbacks: TestPlanFeedbackItem[] };
    Reply: ApiResponse<StartAsyncResponse>;
  }>('/items/:id/test-plan/feedback', async (request, reply) => {
    const itemId = request.params.id;
    const { feedbacks } = request.body || {};

    if (isItemLocked(itemId)) {
      return reply.status(409).send({
        success: false,
        error: 'Operation already in progress for this item',
      });
    }

    if (!Array.isArray(feedbacks) || feedbacks.length === 0) {
      return reply.status(400).send({
        success: false,
        error: 'feedbacks must not be empty',
      });
    }

    for (const feedback of feedbacks) {
      if (
        !feedback ||
        typeof feedback !== 'object' ||
        typeof feedback.scenarioId !== 'string' ||
        typeof feedback.feedback !== 'string'
      ) {
        return reply.status(400).send({
          success: false,
          error: 'Each feedback must have string scenarioId and feedback',
        });
      }
      if (!feedback.scenarioId.trim()) {
        return reply.status(400).send({
          success: false,
          error: 'scenarioId must not be empty',
        });
      }
      if (!feedback.feedback.trim()) {
        return reply.status(400).send({
          success: false,
          error: 'feedback must not be empty',
        });
      }
    }

    const scenarioIds = feedbacks.map((feedback) => feedback.scenarioId.trim());
    if (new Set(scenarioIds).size !== scenarioIds.length) {
      return reply.status(400).send({
        success: false,
        error: 'Duplicate scenarioId in feedbacks',
      });
    }

    try {
      const currentTestPlan = await getTestPlan(itemId);
      if (!currentTestPlan) {
        return reply.status(400).send({
          success: false,
          error: 'No test plan exists yet',
        });
      }
      const validationErrors = validateTestPlanFeedback(feedbacks, currentTestPlan);
      if (validationErrors.length > 0) {
        return reply.status(400).send({
          success: false,
          error: validationErrors.join('; '),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read test plan';
      return reply.status(400).send({
        success: false,
        error: message,
      });
    }

    withItemLock(itemId, () => testPlanFeedback(itemId, feedbacks)).catch(async (err) => {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[${itemId}] Test plan feedback failed:`, message);
      await recordBackgroundError(itemId, message, 'test_planner');
    });

    return reply.status(202).send({
      success: true,
      data: { started: true },
    });
  });

  fastify.post<{
    Params: { id: string };
    Reply: ApiResponse<TestPlanApprovalResponse>;
  }>('/items/:id/test-plan/approve', async (request, reply) => {
    try {
      const itemId = request.params.id;
      if (isItemLocked(itemId)) {
        return reply.status(409).send({
          success: false,
          error: 'Operation already in progress for this item',
        });
      }
      const approval = await withItemLock(itemId, () => approveTestPlan(itemId));
      return reply.send({
        success: true,
        data: { approval },
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
    Body: StartWorkersRequest;
    Reply: ApiResponse<StartAsyncResponse>;
  }>('/items/:id/workers/start', async (request, reply) => {
    const itemId = request.params.id;
    const startWorkersRequest = request.body || {};
    const targetRepos = startWorkersRequest.repos;
    const mode = startWorkersRequest.mode;

    if (isItemLocked(itemId)) {
      return reply.status(409).send({
        success: false,
        error: 'Operation already in progress for this item',
      });
    }

    const approval = await deriveTestPlanApproval(itemId);
    if (approval.status !== 'approved') {
      return reply.status(400).send({
        success: false,
        error: `Test plan approval is required before starting workers (current status: ${approval.status})`,
      });
    }

    // Fire-and-forget with item lock + error logging
    withItemLock(itemId, async () => {
      await startWorkers(itemId, { targetRepos, mode });
    }).catch(async (err) => {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[${itemId}] Workers failed:`, message);
      await recordBackgroundError(itemId, message);
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
