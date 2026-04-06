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
  getItemConfig,
  updateItem,
  updateRepoSetup,
  rerunRepoSetup,
  repoWorkspaceExists,
  deleteItem,
  RepoNotFoundError,
  UnsupportedRepoTypeError,
} from '../services/item-service';
import { createDraftPrsForAllRepos } from '../services/git-pr-service';
import { ensureCompletedReviewPassed } from '../services/completed-review-service';
import {
  startReviewReceive,
  validateReviewReceivePreConditions,
  ReviewReceiveValidationError,
} from '../services/review-receive-service';
import { withItemLock, isItemLocked } from '../lib/locks';
import { AllowedToolsFormatError, RolePromptsFormatError } from '../lib/role-loader';
import { normalizeCommandList } from '../lib/validation';

export const itemRoutes: FastifyPluginAsync = async (fastify) => {
  // Create a new item
  fastify.post<{
    Body: CreateItemRequest;
    Reply: ApiResponse<CreateItemResponse>;
  }>('/items', async (request, reply) => {
    try {
      // Validate and normalize setup commands, building a clean copy of repositories
      const normalizedRepositories = [];
      for (const repoInput of request.body.repositories || []) {
        if (repoInput.repository?.setup !== undefined) {
          if (repoInput.repository.type === 'local') {
            return reply.status(400).send({
              success: false,
              error: 'setup is only supported for remote repositories',
            });
          }
          const normalizedSetup = normalizeCommandList('setup', repoInput.repository.setup, 'setup command');
          if (normalizedSetup.error) {
            return reply.status(400).send({ success: false, error: normalizedSetup.error });
          }
          normalizedRepositories.push({
            ...repoInput,
            repository: { ...repoInput.repository, setup: normalizedSetup.commands },
          });
        } else {
          normalizedRepositories.push(repoInput);
        }
      }

      const item = await createItem({ ...request.body, repositories: normalizedRepositories });

      // Start workspace setup in background (clone or link)
      setupWorkspace(item.id).catch((error) => {
        fastify.log.error({ itemId: item.id, error }, 'Workspace setup failed');
      });

      return reply.status(201).send({
        success: true,
        data: { item },
      });
    } catch (error) {
      if (error instanceof AllowedToolsFormatError || error instanceof RolePromptsFormatError) {
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

  // Update setup commands for a repository
  fastify.patch<{
    Params: { id: string; repoName: string };
    Body: { setup: unknown };
    Reply: ApiResponse<{ item: import('@agent-orch/shared').ItemConfig }>;
  }>('/items/:id/repositories/:repoName/setup', async (request, reply) => {
    try {
      const normalizedSetup = normalizeCommandList('setup', request.body.setup, 'setup command');
      if (normalizedSetup.error) {
        return reply.status(400).send({ success: false, error: normalizedSetup.error });
      }
      if (!normalizedSetup.commands) {
        return reply.status(400).send({ success: false, error: 'setup is required' });
      }

      const item = await updateRepoSetup(
        request.params.id,
        request.params.repoName,
        normalizedSetup.commands
      );
      if (!item) {
        return reply.status(404).send({ success: false, error: 'Item not found' });
      }

      return reply.send({ success: true, data: { item } });
    } catch (error) {
      if (error instanceof RepoNotFoundError) {
        return reply.status(404).send({ success: false, error: error.message });
      }
      if (error instanceof UnsupportedRepoTypeError) {
        return reply.status(400).send({ success: false, error: error.message });
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({ success: false, error: message });
    }
  });

  // Re-run setup commands for a repository
  fastify.post<{
    Params: { id: string; repoName: string };
    Reply: ApiResponse<{ started: boolean }>;
  }>('/items/:id/repositories/:repoName/setup/run', async (request, reply) => {
    try {
      const config = await getItemConfig(request.params.id);
      if (!config) {
        return reply.status(404).send({ success: false, error: 'Item not found' });
      }

      const repo = config.repositories.find(r => r.name === request.params.repoName);
      if (!repo) {
        return reply.status(404).send({
          success: false,
          error: `Repository "${request.params.repoName}" not found`,
        });
      }

      if (repo.type !== 'remote') {
        return reply.status(400).send({
          success: false,
          error: 'setup is only supported for remote repositories',
        });
      }

      if (!repoWorkspaceExists(request.params.id, request.params.repoName)) {
        return reply.status(400).send({
          success: false,
          error: `Workspace directory does not exist for repository "${request.params.repoName}"`,
        });
      }

      // Fire-and-forget with item lock to prevent concurrent runs
      withItemLock(request.params.id, () =>
        rerunRepoSetup(request.params.id, request.params.repoName)
      ).catch((error) => {
        fastify.log.error(
          { itemId: request.params.id, repoName: request.params.repoName, error },
          'Setup command re-run failed'
        );
      });

      return reply.status(202).send({
        success: true,
        data: { started: true },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({ success: false, error: message });
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
      await ensureCompletedReviewPassed(request.params.id);
      const result = await createDraftPrsForAllRepos(request.params.id);

      return reply.send({
        success: true,
        data: result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message.includes('Completed review must be satisfied before publish')) {
        return reply.status(400).send({
          success: false,
          error: message,
        });
      }
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
