import { useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { ItemEvent, AgentInfo } from '@agent-orch/shared';
import { useItem } from '../hooks/useItems';
import { useWebSocket } from '../hooks/useWebSocket';
import { AgentCard } from '../components/AgentCard';
import { AgentTerminal } from '../components/AgentTerminal';
import { ApprovalQueue } from '../components/ApprovalQueue';

export function ItemDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { item, loading, error, refresh, startPlanner, startWorkers, stopAgent } =
    useItem(id);
  const [selectedAgent, setSelectedAgent] = useState<AgentInfo | null>(null);
  const [recentEvents, setRecentEvents] = useState<ItemEvent[]>([]);

  const handleEvent = useCallback((event: ItemEvent) => {
    setRecentEvents((prev) => [...prev.slice(-100), event]);
    // Refresh item state on significant events
    if (
      event.type === 'agent_started' ||
      event.type === 'agent_exited' ||
      event.type === 'status_changed' ||
      event.type === 'approval_requested' ||
      event.type === 'approval_decision' ||
      event.type === 'plan_created'
    ) {
      refresh();
    }
  }, [refresh]);

  const { isConnected } = useWebSocket({
    itemId: id,
    onEvent: handleEvent,
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (error || !item) {
    return (
      <div className="bg-red-900/50 text-red-300 px-4 py-3 rounded">
        {error || 'Item not found'}
        <Link to="/" className="ml-4 underline hover:no-underline">
          Back to list
        </Link>
      </div>
    );
  }

  const canStartPlanner =
    item.status === 'created' ||
    (item.status === 'error' && !item.plan);

  // Workers can only be started when ready or when there was an error but plan exists
  const canStartWorkers =
    item.status === 'ready' ||
    (item.status === 'error' && !!item.plan);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Link to="/" className="text-gray-400 hover:text-white">
              &larr;
            </Link>
            <h1 className="text-2xl font-bold text-white">{item.name}</h1>
            <span
              className={`px-2 py-0.5 text-xs rounded-full text-white ${
                item.status === 'error'
                  ? 'bg-red-500'
                  : item.status === 'running'
                  ? 'bg-yellow-500'
                  : item.status === 'completed'
                  ? 'bg-green-600'
                  : 'bg-gray-500'
              }`}
            >
              {item.status}
            </span>
            {!isConnected && (
              <span className="text-xs text-red-400">Disconnected</span>
            )}
          </div>
          <p className="text-gray-400">{item.id}</p>
        </div>

        <div className="flex gap-3">
          {canStartPlanner && (
            <button
              onClick={startPlanner}
              className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-500"
            >
              Start Planner
            </button>
          )}
          {canStartWorkers && (
            <button
              onClick={startWorkers}
              className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-500"
            >
              Start Workers
            </button>
          )}
        </div>
      </div>

      {/* Description */}
      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <h3 className="text-sm font-medium text-gray-400 mb-2">Description</h3>
        <p className="text-white">{item.description}</p>
      </div>

      {/* Approval Queue */}
      {item.pendingApprovals.length > 0 && (
        <ApprovalQueue
          itemId={item.id}
          approvals={item.pendingApprovals}
          onProcessed={refresh}
        />
      )}

      {/* Plan Summary */}
      {item.plan && (
        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <h3 className="text-sm font-medium text-gray-400 mb-2">Plan</h3>
          <p className="text-white mb-2">{item.plan.summary}</p>
          <p className="text-sm text-gray-400">
            {item.plan.tasks.length} tasks
          </p>
        </div>
      )}

      {/* Agents Grid */}
      <div>
        <h3 className="text-lg font-medium text-white mb-3">Agents</h3>
        {item.agents.length === 0 ? (
          <div className="text-gray-400 text-center py-8 bg-gray-800 rounded-lg border border-gray-700">
            No agents running. Start the planner or workers to begin.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {item.agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                isSelected={selectedAgent?.id === agent.id}
                onSelect={() => setSelectedAgent(agent)}
                onStop={() => stopAgent(agent.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Terminal */}
      {selectedAgent && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-medium text-white">
              Terminal - {selectedAgent.role}
            </h3>
            <button
              onClick={() => setSelectedAgent(null)}
              className="text-gray-400 hover:text-white"
            >
              Close
            </button>
          </div>
          <div className="h-96">
            <AgentTerminal
              key={selectedAgent.id}
              itemId={item.id}
              agentId={selectedAgent.id}
              events={recentEvents}
            />
          </div>
        </div>
      )}

      {/* Design Doc */}
      {item.designDoc && (
        <details className="bg-gray-800 rounded-lg border border-gray-700">
          <summary className="p-4 cursor-pointer text-sm font-medium text-gray-400 hover:text-white">
            Design Document
          </summary>
          <pre className="p-4 pt-0 text-sm text-gray-300 whitespace-pre-wrap overflow-x-auto">
            {item.designDoc}
          </pre>
        </details>
      )}
    </div>
  );
}
