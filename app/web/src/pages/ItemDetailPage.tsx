import { useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { ItemEvent, AgentInfo, ReviewFindingsExtractedEvent } from '@agent-orch/shared';
import { useItem } from '../hooks/useItems';
import { useWebSocket } from '../hooks/useWebSocket';
import { AgentCard } from '../components/AgentCard';
import { AgentTerminal } from '../components/AgentTerminal';
import { ApprovalQueue } from '../components/ApprovalQueue';
import * as api from '../api/client';

export function ItemDetailPage() {
  const { id } = useParams<{ id: string }>();
  const {
    item,
    loading,
    error,
    refresh,
    startPlanner,
    startWorkers,
    stopAgent,
    startReviewReceive,
    reviewReceiveError,
  } = useItem(id);
  const [selectedAgent, setSelectedAgent] = useState<AgentInfo | null>(null);
  const [recentEvents, setRecentEvents] = useState<ItemEvent[]>([]);
  const [planEditorOpen, setPlanEditorOpen] = useState(false);
  const [planContent, setPlanContent] = useState('');
  const [planOriginal, setPlanOriginal] = useState('');
  const [planLoaded, setPlanLoaded] = useState(false);
  const [planLoading, setPlanLoading] = useState(false);
  const [planSaving, setPlanSaving] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const handleEvent = useCallback((event: ItemEvent) => {
    setRecentEvents((prev) => [...prev.slice(-100), event]);
    // Refresh item state on significant events
    if (
      event.type === 'agent_started' ||
      event.type === 'agent_exited' ||
      event.type === 'status_changed' ||
      event.type === 'approval_requested' ||
      event.type === 'approval_decision' ||
      event.type === 'plan_created' ||
      event.type === 'review_findings_extracted'
    ) {
      refresh();
    }
  }, [refresh]);

  const { isConnected } = useWebSocket({
    itemId: id,
    onEvent: handleEvent,
  });

  const loadPlanContent = useCallback(async () => {
    if (!id) return;
    setPlanLoading(true);
    setPlanError(null);
    try {
      const result = await api.getPlanContent(id);
      const content = result.content ?? '';
      setPlanContent(content);
      setPlanOriginal(content);
      setPlanLoaded(true);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Failed to load plan');
    } finally {
      setPlanLoading(false);
    }
  }, [id]);

  const handleOpenPlanEditor = useCallback(async () => {
    setPlanEditorOpen(true);
    if (!planLoaded) {
      await loadPlanContent();
    }
  }, [loadPlanContent, planLoaded]);

  const handleSavePlan = useCallback(async () => {
    if (!id) return;
    setPlanSaving(true);
    setPlanError(null);
    try {
      const result = await api.updatePlan(id, { content: planContent });
      setPlanContent(result.content);
      setPlanOriginal(result.content);
      await refresh();
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Failed to save plan');
    } finally {
      setPlanSaving(false);
    }
  }, [id, planContent, refresh]);

  const planDirty = planContent !== planOriginal;

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

  // Review Receive can be started when completed or error
  // NOTE: UI側は status のみで表示制御、PRがない場合はサーバからエラーメッセージが返る
  const canStartReviewReceive =
    item.status === 'completed' || item.status === 'error';

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
                  : item.status === 'review_receiving'
                  ? 'bg-cyan-500'
                  : 'bg-gray-500'
              }`}
            >
              {item.status}
            </span>
            {item.prUrl && (
              <a
                href={item.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-2 py-0.5 text-xs rounded-full bg-purple-600 text-white hover:bg-purple-500"
              >
                PR #{item.prNumber}
              </a>
            )}
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
          {canStartReviewReceive && (
            <div className="flex flex-col gap-1">
              <button
                onClick={startReviewReceive}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-500"
              >
                Review Receive
              </button>
              {reviewReceiveError && (
                <span className="text-xs text-red-400">{reviewReceiveError}</span>
              )}
            </div>
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
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-medium text-gray-400 mb-2">Plan</h3>
              <p className="text-white mb-2">{item.plan.summary}</p>
              <p className="text-sm text-gray-400">
                {item.plan.tasks.length} tasks
              </p>
            </div>
            <button
              onClick={handleOpenPlanEditor}
              className="px-3 py-1.5 bg-gray-700 text-white rounded hover:bg-gray-600 text-sm"
            >
              Edit plan.yaml
            </button>
          </div>
          {planEditorOpen && (
            <div className="mt-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-gray-300">plan.yaml</h4>
                <div className="flex gap-2">
                  <button
                    onClick={loadPlanContent}
                    disabled={planLoading}
                    className="px-2.5 py-1 bg-gray-700 text-gray-200 rounded hover:bg-gray-600 text-xs disabled:opacity-50"
                  >
                    Reload
                  </button>
                  <button
                    onClick={() => {
                      setPlanContent(planOriginal);
                      setPlanError(null);
                    }}
                    disabled={!planDirty || planSaving}
                    className="px-2.5 py-1 bg-gray-700 text-gray-200 rounded hover:bg-gray-600 text-xs disabled:opacity-50"
                  >
                    Revert
                  </button>
                  <button
                    onClick={handleSavePlan}
                    disabled={!planDirty || planSaving}
                    className="px-2.5 py-1 bg-green-600 text-white rounded hover:bg-green-500 text-xs disabled:opacity-50"
                  >
                    {planSaving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
              {planLoading ? (
                <div className="text-xs text-gray-400">Loading plan...</div>
              ) : (
                <textarea
                  value={planContent}
                  onChange={(event) => setPlanContent(event.target.value)}
                  className="w-full min-h-[220px] bg-gray-900 text-gray-100 border border-gray-700 rounded p-3 font-mono text-xs"
                  spellCheck={false}
                />
              )}
              {planError && (
                <div className="text-xs text-red-400">{planError}</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Review Findings */}
      {recentEvents
        .filter((e): e is ReviewFindingsExtractedEvent =>
          e.type === 'review_findings_extracted'
        )
        .slice(-1)
        .map((reviewEvent) => (
          reviewEvent.findings.length > 0 && (
            <div
              key={reviewEvent.id}
              className="bg-gray-800 rounded-lg border border-yellow-500/50 p-4"
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-medium text-yellow-400">
                  Review Findings
                </h3>
                <div className="flex gap-3 text-sm">
                  {reviewEvent.criticalCount > 0 && (
                    <span className="text-red-400">
                      Critical: {reviewEvent.criticalCount}
                    </span>
                  )}
                  {reviewEvent.majorCount > 0 && (
                    <span className="text-orange-400">
                      Major: {reviewEvent.majorCount}
                    </span>
                  )}
                  {reviewEvent.minorCount > 0 && (
                    <span className="text-yellow-400">
                      Minor: {reviewEvent.minorCount}
                    </span>
                  )}
                </div>
              </div>

              <p className="text-gray-300 mb-3">{reviewEvent.summary}</p>

              <div className="space-y-2">
                {reviewEvent.findings
                  .filter(f => f.severity === 'critical' || f.severity === 'major')
                  .map((finding, idx) => (
                    <div
                      key={idx}
                      className="bg-gray-900 rounded p-3 border border-gray-700"
                    >
                      <div className="flex items-start justify-between mb-2">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded ${
                          finding.severity === 'critical'
                            ? 'bg-red-500/20 text-red-400'
                            : 'bg-orange-500/20 text-orange-400'
                        }`}>
                          {finding.severity.toUpperCase()}
                        </span>
                        <span className="text-xs text-gray-500">
                          {finding.targetAgent}
                        </span>
                      </div>
                      <p className="text-sm text-gray-400 mb-1">
                        {finding.file}:{finding.line}
                      </p>
                      <p className="text-sm text-white mb-2">
                        {finding.description}
                      </p>
                      <p className="text-xs text-gray-500">
                        Fix: {finding.suggestedFix}
                      </p>
                    </div>
                  ))}
              </div>
            </div>
          )
        ))
      }

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
