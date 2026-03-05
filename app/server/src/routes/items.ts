import type { FastifyPluginAsync } from 'fastify';
import type {
  CreateItemRequest,
  ApiResponse,
  CreateItemResponse,
  ListItemsResponse,
  GetItemResponse,
} from '@agent-orch/shared';
import {
  createItem,
  setupWorkspace,
  listItems,
  getItemDetail,
  updateItem,
  deleteItem,
} from '../services/item-service';
import { createDraftPrsForAllRepos } from '../services/git-pr-service';
import {
  startReviewReceive,
  validateReviewReceivePreConditions,
  ReviewReceiveValidationError,
} from '../services/review-receive-service';
import { withItemLock, isItemLocked } from '../lib/locks';
import { AllowedToolsFormatError } from '../lib/role-loader';

export const itemRoutes: FastifyPluginAsync = async (fastify) => {
  // Create a new item
  fastify.post<{
    Body: CreateItemRequest;
    Reply: ApiResponse<CreateItemResponse>;
  }>('/items', async (request, reply) => {
    try {
      const item = await createItem(request.body);

      // Start workspace setup in background (clone or link)
      setupWorkspace(item.id).catch((error) => {
        fastify.log.error({ itemId: item.id, error }, 'Workspace setup failed');
      });

      return reply.status(201).send({
        success: true,
        data: { item },
      });
    } catch (error) {
      if (error instanceof AllowedToolsFormatError) {
        return reply.status(400).send({ success: false, error: error.message });
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  // List all items
  fastify.get<{
    Reply: ApiResponse<ListItemsResponse>;
  }>('/items', async (_request, reply) => {
    try {
      const items = await listItems();
      return reply.send({
        success: true,
        data: { items },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  // Get item detail
  fastify.get<{
    Params: { id: string };
    Reply: ApiResponse<GetItemResponse>;
  }>('/items/:id', async (request, reply) => {
    try {
      const item = await getItemDetail(request.params.id);
      if (!item) {
        return reply.status(404).send({
          success: false,
          error: 'Item not found',
        });
      }
      return reply.send({
        success: true,
        data: { item },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      // Legacy item detection → 400
      if (message.includes('Legacy item.yaml detected') || message.includes("missing 'repositories' field")) {
        return reply.status(400).send({
          success: false,
          error: message,
        });
      }
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  // Update item
  fastify.patch<{
    Params: { id: string };
    Body: { name?: string; description?: string; designDoc?: string };
    Reply: ApiResponse<{ item: import('@agent-orch/shared').ItemConfig }>;
  }>('/items/:id', async (request, reply) => {
    try {
      const item = await updateItem(request.params.id, request.body);
      if (!item) {
        return reply.status(404).send({
          success: false,
          error: 'Item not found',
        });
      }
      return reply.send({
        success: true,
        data: { item },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  // Delete item
  fastify.delete<{
    Params: { id: string };
    Reply: ApiResponse<{ deleted: boolean }>;
  }>('/items/:id', async (request, reply) => {
    try {
      const deleted = await deleteItem(request.params.id);
      if (!deleted) {
        return reply.status(404).send({
          success: false,
          error: 'Item not found',
        });
      }
      return reply.send({
        success: true,
        data: { deleted: true },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  // Retry clone / workspace setup
  fastify.post<{
    Params: { id: string };
    Reply: ApiResponse<{ started: boolean }>;
  }>('/items/:id/clone', async (request, reply) => {
    try {
      setupWorkspace(request.params.id).catch((error) => {
        fastify.log.error({ itemId: request.params.id, error }, 'Workspace setup failed');
      });

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

  // Create Draft PRs for all repos
  fastify.post<{
    Params: { id: string };
    Reply: ApiResponse<{ results: Array<{ repoName: string; prUrl?: string; prNumber?: number; noChanges: boolean }> }>;
  }>('/items/:id/create-pr', async (request, reply) => {
    try {
      const result = await createDraftPrsForAllRepos(request.params.id);

      return reply.send({
        success: true,
        data: result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      fastify.log.error({ itemId: request.params.id, error }, 'PR creation failed');
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  // Review Receive - fetch PR comments and create plan (async — returns 202 immediately)
  fastify.post<{
    Params: { id: string };
    Body: { repoName?: string };
    Reply: ApiResponse<{ started: boolean }>;
  }>('/items/:id/review-receive/start', async (request, reply) => {
    const itemId = request.params.id;

    if (isItemLocked(itemId)) {
      return reply.status(409).send({
        success: false,
        error: 'Operation already in progress for this item',
      });
    }

    // Validation (synchronous, fast)
    try {
      await validateReviewReceivePreConditions(itemId, request.body?.repoName);
    } catch (error) {
      if (error instanceof ReviewReceiveValidationError) {
        return reply.status(400).send({ success: false, error: error.message });
      }
      throw error;
    }

    // Fire-and-forget with item lock
    // Error events are recorded internally by review-receive-service (fetchPrComments)
    // and agent-service (executeAgent), so we only log to console here.
    withItemLock(itemId, () =>
      startReviewReceive(itemId, request.body?.repoName)
    ).catch((err) => {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[${itemId}] Review receive failed:`, message);
    });

    return reply.status(202).send({
      success: true,
      data: { started: true },
    });
  });
};
