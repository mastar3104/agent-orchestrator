import type { FastifyPluginAsync } from 'fastify';
import type { ApiResponse, ApprovalDecisionRequest, ApprovalRequestEvent } from '@agent-orch/shared';
import { processApproval } from '../services/agent-service';
import { getPendingApprovals } from '../services/state-service';

export const approvalRoutes: FastifyPluginAsync = async (fastify) => {
  // Get pending approvals for an item
  fastify.get<{
    Params: { id: string };
    Reply: ApiResponse<{ approvals: ApprovalRequestEvent[] }>;
  }>('/items/:id/approvals', async (request, reply) => {
    try {
      const approvals = await getPendingApprovals(request.params.id);
      return reply.send({
        success: true,
        data: { approvals },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  // Process an approval decision
  fastify.post<{
    Params: { id: string; eventId: string };
    Body: ApprovalDecisionRequest;
    Reply: ApiResponse<{ processed: boolean }>;
  }>('/items/:id/approval/:eventId', async (request, reply) => {
    try {
      const { decision, reason } = request.body;

      // Find the approval request to get the agentId
      const approvals = await getPendingApprovals(request.params.id);
      const approval = approvals.find((a) => a.id === request.params.eventId);

      if (!approval) {
        return reply.status(404).send({
          success: false,
          error: 'Approval request not found or already processed',
        });
      }

      const processed = await processApproval(
        request.params.id,
        approval.agentId,
        request.params.eventId,
        decision,
        reason,
        approval.uiKind
      );

      if (!processed) {
        return reply.status(500).send({
          success: false,
          error: 'Failed to process approval',
        });
      }

      return reply.send({
        success: true,
        data: { processed: true },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  // Batch approve/deny all pending approvals
  fastify.post<{
    Params: { id: string };
    Body: { decision: 'approve' | 'deny'; reason?: string };
    Reply: ApiResponse<{ processed: number }>;
  }>('/items/:id/approvals/batch', async (request, reply) => {
    try {
      const { decision, reason } = request.body;
      const approvals = await getPendingApprovals(request.params.id);

      let processed = 0;
      for (const approval of approvals) {
        const success = await processApproval(
          request.params.id,
          approval.agentId,
          approval.id,
          decision,
          reason,
          approval.uiKind
        );
        if (success) {
          processed++;
        }
      }

      return reply.send({
        success: true,
        data: { processed },
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
