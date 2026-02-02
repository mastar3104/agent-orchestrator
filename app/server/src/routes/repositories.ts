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

      const repository = await createRepository(request.body);
      return reply.status(201).send({
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

  // Update repository
  fastify.patch<{
    Params: { id: string };
    Body: UpdateRepositoryRequest;
    Reply: ApiResponse<UpdateRepositoryResponse>;
  }>('/repositories/:id', async (request, reply) => {
    try {
      const repository = await updateRepository(request.params.id, request.body);
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
