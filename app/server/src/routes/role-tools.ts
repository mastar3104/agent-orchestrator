import type { FastifyPluginAsync } from 'fastify';
import type {
  ApiResponse,
  GetRoleToolsResponse,
  UpdateRoleToolsRequest,
  UpdateRoleToolsResponse,
} from '@agent-orch/shared';
import {
  getRoleTools,
  updateRoleTools,
} from '../services/role-tools-service';
import { RoleToolOverridesFormatError } from '../lib/role-loader';

export const roleToolsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Reply: ApiResponse<GetRoleToolsResponse>;
  }>('/settings/role-tools', async (_request, reply) => {
    try {
      const roleTools = await getRoleTools();
      return reply.send({
        success: true,
        data: { roleTools },
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
    Body: UpdateRoleToolsRequest;
    Reply: ApiResponse<UpdateRoleToolsResponse>;
  }>('/settings/role-tools', async (request, reply) => {
    try {
      if (!request.body || typeof request.body !== 'object' || request.body.roleTools === undefined) {
        return reply.status(400).send({
          success: false,
          error: 'roleTools is required',
        });
      }

      const roleTools = await updateRoleTools(request.body.roleTools);
      return reply.send({
        success: true,
        data: { roleTools },
      });
    } catch (error) {
      if (error instanceof RoleToolOverridesFormatError) {
        return reply.status(400).send({
          success: false,
          error: error.message,
        });
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });
};
