import { useState } from 'react';
import type { ApprovalRequestEvent } from '@agent-orch/shared';
import * as api from '../api/client';

interface ApprovalQueueProps {
  itemId: string;
  approvals: ApprovalRequestEvent[];
  onProcessed?: () => void;
}

export function ApprovalQueue({ itemId, approvals, onProcessed }: ApprovalQueueProps) {
  const [processing, setProcessing] = useState<string | null>(null);

  const handleDecision = async (
    eventId: string,
    decision: 'approve' | 'deny'
  ) => {
    setProcessing(eventId);
    try {
      await api.processApproval(itemId, eventId, { decision });
      onProcessed?.();
    } catch (error) {
      console.error('Failed to process approval:', error);
    } finally {
      setProcessing(null);
    }
  };

  const handleBatchDecision = async (decision: 'approve' | 'deny') => {
    setProcessing('batch');
    try {
      await api.batchProcessApprovals(itemId, decision);
      onProcessed?.();
    } catch (error) {
      console.error('Failed to batch process approvals:', error);
    } finally {
      setProcessing(null);
    }
  };

  if (approvals.length === 0) {
    return null;
  }

  return (
    <div className="bg-gray-800 rounded-lg border border-orange-500/50 p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-medium text-orange-400">
          Pending Approvals ({approvals.length})
        </h3>
        {approvals.length > 1 && (
          <div className="flex gap-2">
            <button
              onClick={() => handleBatchDecision('approve')}
              disabled={processing === 'batch'}
              className="px-3 py-1 text-sm bg-green-600 text-white rounded hover:bg-green-500 disabled:opacity-50"
            >
              Approve All
            </button>
            <button
              onClick={() => handleBatchDecision('deny')}
              disabled={processing === 'batch'}
              className="px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-500 disabled:opacity-50"
            >
              Deny All
            </button>
          </div>
        )}
      </div>

      <div className="space-y-3">
        {approvals.map((approval) => (
          <div
            key={approval.id}
            className="bg-gray-900 rounded p-3 border border-gray-700"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-400 mb-1">
                  Agent: {approval.agentId}
                </p>
                <pre className="text-sm text-white bg-gray-800 rounded p-2 overflow-x-auto">
                  {approval.command}
                </pre>
                {approval.context && (
                  <p className="text-xs text-gray-500 mt-2 truncate">
                    {approval.context}
                  </p>
                )}
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => handleDecision(approval.id, 'approve')}
                  disabled={processing === approval.id}
                  className="px-3 py-1 text-sm bg-green-600 text-white rounded hover:bg-green-500 disabled:opacity-50"
                >
                  {processing === approval.id ? '...' : 'Approve'}
                </button>
                <button
                  onClick={() => handleDecision(approval.id, 'deny')}
                  disabled={processing === approval.id}
                  className="px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-500 disabled:opacity-50"
                >
                  {processing === approval.id ? '...' : 'Deny'}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
