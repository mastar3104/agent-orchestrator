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
  ReviewReceiveValidationError,
} from '../services/review-receive-service';

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

  // Review Receive - fetch PR comments and create plan
  fastify.post<{
    Params: { id: string };
    Body: { repoName?: string };
    Reply: ApiResponse<{ started: boolean; prNumber: number; repoName: string }>;
  }>('/items/:id/review-receive/start', async (request, reply) => {
    try {
      const result = await startReviewReceive(request.params.id, request.body?.repoName);
      return reply.send({
        success: true,
        data: result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';

      if (error instanceof ReviewReceiveValidationError) {
        return reply.status(400).send({
          success: false,
          error: message,
        });
      }

      fastify.log.error(
        { itemId: request.params.id, error },
        'Review receive failed'
      );
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });
};
