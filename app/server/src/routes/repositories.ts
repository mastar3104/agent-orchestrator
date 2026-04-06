import type { FastifyPluginAsync } from 'fastify';
import type {
  ApiResponse,
  CreateRepositoryRequest,
  UpdateRepositoryRequest,
  ListRepositoriesResponse,
  GetRepositoryResponse,
  CreateRepositoryResponse,
  UpdateRepositoryResponse,
  DeleteRepositoryResponse,
} from '@agent-orch/shared';
import {
  listRepositories,
  getRepository,
  createRepository,
  updateRepository,
  deleteRepository,
} from '../services/repository-service';
import { AllowedToolsFormatError, RolePromptsFormatError } from '../lib/role-loader';
import { normalizeCommandList } from '../lib/validation';

export const repositoryRoutes: FastifyPluginAsync = async (fastify) => {
  // List all repositories
  fastify.get<{
    Reply: ApiResponse<ListRepositoriesResponse>;
  }>('/repositories', async (_request, reply) => {
    try {
      const repositories = await listRepositories();
      return reply.send({
        success: true,
        data: { repositories },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  // Get repository by ID
  fastify.get<{
    Params: { id: string };
    Reply: ApiResponse<GetRepositoryResponse>;
  }>('/repositories/:id', async (request, reply) => {
    try {
      const repository = await getRepository(request.params.id);
      if (!repository) {
        return reply.status(404).send({
          success: false,
          error: 'Repository not found',
        });
      }
      return reply.send({
        success: true,
        data: { repository },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  // Create new repository
  fastify.post<{
    Body: CreateRepositoryRequest;
    Reply: ApiResponse<CreateRepositoryResponse>;
  }>('/repositories', async (request, reply) => {
    try {
      // Validate request
      if (!request.body.name) {
        return reply.status(400).send({
          success: false,
          error: 'name is required',
        });
      }
      if (!request.body.type) {
        return reply.status(400).send({
          success: false,
          error: 'type is required',
        });
      }
      if (request.body.type === 'remote' && !request.body.url) {
        return reply.status(400).send({
          success: false,
          error: 'url is required for remote repository',
        });
      }
      if (request.body.type === 'local' && !request.body.localPath) {
        return reply.status(400).send({
          success: false,
          error: 'localPath is required for local repository',
        });
      }

      const normalizedHooks = normalizeCommandList('hooks', request.body.hooks, 'hook');
      if (normalizedHooks.error) {
        return reply.status(400).send({ success: false, error: normalizedHooks.error });
      }

      if (request.body.type === 'local' && request.body.setup !== undefined) {
        return reply.status(400).send({ success: false, error: 'setup is only supported for remote repositories' });
      }
      const normalizedSetup = normalizeCommandList('setup', request.body.setup, 'setup command');
      if (normalizedSetup.error) {
        return reply.status(400).send({ success: false, error: normalizedSetup.error });
      }

      const repository = await createRepository({
        ...request.body,
        hooks: normalizedHooks.commands,
        setup: normalizedSetup.commands,
      });
      return reply.status(201).send({
        success: true,
        data: { repository },
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

  // Update repository
  fastify.patch<{
    Params: { id: string };
    Body: UpdateRepositoryRequest;
    Reply: ApiResponse<UpdateRepositoryResponse>;
  }>('/repositories/:id', async (request, reply) => {
    try {
      const normalizedHooks = normalizeCommandList('hooks', request.body.hooks, 'hook');
      if (normalizedHooks.error) {
        return reply.status(400).send({ success: false, error: normalizedHooks.error });
      }

      const existing = request.body.setup !== undefined ? await getRepository(request.params.id) : null;
      if (request.body.setup !== undefined && !existing) {
        return reply.status(404).send({
          success: false,
          error: 'Repository not found',
        });
      }
      if (existing?.type === 'local') {
        return reply.status(400).send({ success: false, error: 'setup is only supported for remote repositories' });
      }

      const normalizedSetup = normalizeCommandList('setup', request.body.setup, 'setup command');
      if (normalizedSetup.error) {
        return reply.status(400).send({ success: false, error: normalizedSetup.error });
      }

      const repository = await updateRepository(request.params.id, {
        ...request.body,
        hooks: normalizedHooks.commands,
        setup: normalizedSetup.commands,
      });
      if (!repository) {
        return reply.status(404).send({
          success: false,
          error: 'Repository not found',
        });
      }
      return reply.send({
        success: true,
        data: { repository },
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

  // Delete repository
  fastify.delete<{
    Params: { id: string };
    Reply: ApiResponse<DeleteRepositoryResponse>;
  }>('/repositories/:id', async (request, reply) => {
    try {
      const deleted = await deleteRepository(request.params.id);
      if (!deleted) {
        return reply.status(404).send({
          success: false,
          error: 'Repository not found',
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
};
