import { useState, useCallback, useRef, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import type {
  ItemEvent,
  ItemWorkflowJob,
  ItemWorkflowSummary,
  ReviewFindingsExtractedEvent,
  TaskProgressPhase,
  WorkflowStageId,
  WorkflowStageStatus,
} from '@agent-orch/shared';
import { useItem } from '../hooks/useItems';
import { useWebSocket } from '../hooks/useWebSocket';
import { AgentCard } from '../components/AgentCard';
import { AgentOutputPanel } from '../components/AgentOutputPanel';
import * as api from '../api/client';

const STAGE_STATUS_STYLES: Record<WorkflowStageStatus, string> = {
  pending: 'border-gray-700 bg-gray-800 text-gray-400',
  running: 'border-amber-500/50 bg-amber-500/10 text-amber-200',
  completed: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200',
  error: 'border-red-500/50 bg-red-500/10 text-red-200',
};

const JOB_STATUS_STYLES: Record<WorkflowStageStatus, string> = {
  pending: 'bg-gray-700 text-gray-300',
  running: 'bg-amber-500/20 text-amber-200',
  completed: 'bg-emerald-500/20 text-emerald-200',
  error: 'bg-red-500/20 text-red-200',
};

const STEP_STATUS_ICONS: Record<string, string> = {
  pending: '○',
  in_progress: '◐',
  in_review: '◐',
  completed: '●',
  failed: '✕',
};

function formatPhase(phase?: TaskProgressPhase): string {
  if (!phase) return '';
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

function formatStageLabel(stage: WorkflowStageId): string {
  switch (stage) {
    case 'workspace':
      return 'Preparing workspace';
    case 'planning':
      return 'Planning';
    case 'execution':
      return 'Executing tasks';
    case 'publish':
      return 'Creating PR';
    case 'review_receive':
      return 'Receiving review comments';
  }
  return 'Active';
}

function getCurrentActivityText(
  activity: ItemWorkflowSummary['currentActivity'],
  jobs: ItemWorkflowJob[]
): string {
  if (!activity) return 'No activity in progress';
  if (activity.stage === 'execution') {
    const job = jobs.find((candidate) => candidate.repoName === activity.repoName);
    const step = job?.steps.find((candidate) => candidate.taskId === activity.taskId);
    const detail = step ? `${step.taskId}: ${step.title}` : activity.taskId;
    return `${activity.repoName}: ${detail}${activity.phase ? ` (${formatPhase(activity.phase)})` : ''}`;
  }
  if (activity.stage === 'planning') {
    return 'Planner is building the current plan';
  }
  if (activity.stage === 'workspace') {
    return `${activity.repoName}: preparing workspace`;
  }
  if (activity.stage === 'publish') {
    return `${activity.repoName}: creating PR`;
  }
  return `${activity.repoName}: receiving review comments`;
}

function getJobSummary(job: ItemWorkflowJob): string {
  if (job.activeStage === 'publish') {
    return 'Creating PR';
  }
  if (job.activeStage === 'review_receive') {
    return 'Receiving review comments';
  }
  const step = job.steps.find((candidate) => candidate.taskId === job.currentTaskId);
  if (!step) {
    return job.status === 'completed' ? 'All planned steps completed' : 'Waiting to start';
  }
  return `${step.taskId}: ${step.title}${job.currentPhase ? ` (${formatPhase(job.currentPhase)})` : ''}`;
}

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
    submitPlanFeedback,
    planFeedbackSubmitting,
    planFeedbackError,
  } = useItem(id);
  const [recentEvents, setRecentEvents] = useState<ItemEvent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [planEditorOpen, setPlanEditorOpen] = useState(false);
  const [planContent, setPlanContent] = useState('');
  const [planOriginal, setPlanOriginal] = useState('');
  const [planLoaded, setPlanLoaded] = useState(false);
  const [planLoading, setPlanLoading] = useState(false);
  const [planSaving, setPlanSaving] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [feedbackRows, setFeedbackRows] = useState<{ taskId: string; feedback: string }[]>([{ taskId: '', feedback: '' }]);
  const [feedbackLocalError, setFeedbackLocalError] = useState<string | null>(null);
  const [planUpdatedBanner, setPlanUpdatedBanner] = useState(false);

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

  const planDirty = planContent !== planOriginal;

  // Use refs so handleEvent always sees current values without re-creating
  const planEditorOpenRef = useRef(planEditorOpen);
  const planDirtyRef = useRef(planDirty);
  const loadPlanContentRef = useRef(loadPlanContent);
  useEffect(() => { planEditorOpenRef.current = planEditorOpen; }, [planEditorOpen]);
  useEffect(() => { planDirtyRef.current = planDirty; }, [planDirty]);
  useEffect(() => { loadPlanContentRef.current = loadPlanContent; }, [loadPlanContent]);

  const handleEvent = useCallback((event: ItemEvent) => {
    setRecentEvents((prev) => [...prev.slice(-100), event]);
    // Refresh item state on significant events
    if (
      event.type === 'clone_started' ||
      event.type === 'clone_completed' ||
      event.type === 'workspace_setup_started' ||
      event.type === 'workspace_setup_completed' ||
      event.type === 'agent_started' ||
      event.type === 'agent_exited' ||
      event.type === 'status_changed' ||
      event.type === 'approval_requested' ||
      event.type === 'approval_decision' ||
      event.type === 'plan_created' ||
      event.type === 'hooks_executed' ||
      event.type === 'review_receive_started' ||
      event.type === 'review_receive_completed' ||
      event.type === 'review_findings_extracted' ||
      event.type === 'pr_created' ||
      event.type === 'repo_no_changes' ||
      event.type === 'error' ||
      event.type === 'task_state_changed'
    ) {
      refresh();
    }
    // Auto-reload plan editor on plan_created
    if (event.type === 'plan_created' && planEditorOpenRef.current) {
      if (!planDirtyRef.current) {
        loadPlanContentRef.current();
      } else {
        setPlanUpdatedBanner(true);
      }
    }
  }, [refresh]);

  const { isConnected } = useWebSocket({
    itemId: id,
    onEvent: handleEvent,
  });

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

  // Error repos for partial re-run
  const failedRepos = item.repos?.filter(r => r.status === 'error').map(r => r.repoName) ?? [];

  // Review Receive: check repo-level status for PR repos
  const canStartReviewReceive = item.repos?.some(
    repo => repo.prUrl && (repo.status === 'completed' || repo.status === 'error')
  ) ?? false;

  // "Review Receive (All)" only shown for single-PR items
  const prRepos = item.repos?.filter(r => r.prUrl) ?? [];
  const showReviewReceiveAll = canStartReviewReceive && prRepos.length === 1;
  const repoMetaByName = new Map(item.repos.map((repo) => [repo.repoName, repo]));
  const overallProgress = item.workflow.overall.totalSteps > 0
    ? Math.round((item.workflow.overall.completedSteps / item.workflow.overall.totalSteps) * 100)
    : 0;
  const activityText = getCurrentActivityText(item.workflow.currentActivity, item.workflow.jobs);

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
            {item.repos?.map((repo) => {
              const statusColor = repo.status === 'error' ? 'bg-red-500'
                : repo.status === 'running' ? 'bg-yellow-500'
                : repo.status === 'completed' ? 'bg-green-600'
                : repo.status === 'review_receiving' ? 'bg-cyan-500'
                : repo.status === 'ready' ? 'bg-blue-500'
                : 'bg-gray-600';
              const label = `${repo.repoName}${repo.prUrl ? ` PR #${repo.prNumber}` : repo.noChanges ? ': no changes' : ''}${repo.activePhase && repo.status === 'running' ? ` (${repo.activePhase})` : ''}`;
              const tooltip = repo.lastErrorMessage || (repo.activePhase ? `Phase: ${repo.activePhase}` : undefined);

              return repo.prUrl ? (
                <a
                  key={repo.repoName}
                  href={repo.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`px-2 py-0.5 text-xs rounded-full text-white hover:brightness-110 ${statusColor}`}
                  title={tooltip}
                >
                  {label}
                </a>
              ) : (
                <span
                  key={repo.repoName}
                  className={`px-2 py-0.5 text-xs rounded-full text-white ${statusColor}`}
                  title={tooltip}
                >
                  {label}
                </span>
              );
            })}
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
              onClick={() => {
                if (item.status === 'error' && failedRepos.length > 0) {
                  startWorkers({ repos: failedRepos, mode: 'retry_failed' });
                } else {
                  startWorkers();
                }
              }}
              className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-500"
            >
              {item.status === 'error' && failedRepos.length > 0
                ? `Retry Failed (${failedRepos.join(', ')})`
                : 'Start Workers'}
            </button>
          )}
          {canStartReviewReceive && (
            <div className="flex flex-col gap-1">
              <div className="flex gap-2">
                {showReviewReceiveAll && (
                  <button
                    onClick={() => startReviewReceive()}
                    className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-500"
                  >
                    Review Receive (All)
                  </button>
                )}
                {item.repos?.map((repo) =>
                  repo.prUrl && (repo.status === 'completed' || repo.status === 'error') ? (
                    <button
                      key={repo.repoName}
                      onClick={() => startReviewReceive(repo.repoName)}
                      className="px-3 py-2 bg-blue-700 text-white rounded hover:bg-blue-600 text-sm"
                    >
                      {repo.repoName}
                    </button>
                  ) : null
                )}
              </div>
              {reviewReceiveError && (
                <span className="text-xs text-red-400">{reviewReceiveError}</span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Workflow Strip */}
      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div>
            <h3 className="text-sm font-medium text-gray-400 mb-1">Workflow</h3>
            <p className="text-white">
              {item.workflow.overall.completedSteps} / {item.workflow.overall.totalSteps} steps completed
            </p>
          </div>
          {item.workflow.overall.totalSteps > 0 && (
            <div className="min-w-[180px] w-full max-w-xs">
              <div className="h-2 rounded-full bg-gray-900 overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all"
                  style={{ width: `${overallProgress}%` }}
                />
              </div>
              <p className="text-xs text-gray-500 mt-1 text-right">{overallProgress}%</p>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {item.workflow.stages.map((stage, index) => (
            <div key={stage.id} className="flex items-center gap-2 min-w-fit">
              <div className={`rounded-lg border px-3 py-2 min-w-[150px] ${STAGE_STATUS_STYLES[stage.status]}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{stage.label}</span>
                  {stage.optional && (
                    <span className="text-[10px] uppercase tracking-wide text-gray-400">Optional</span>
                  )}
                </div>
                <p className="text-xs mt-1 opacity-80">{stage.status}</p>
              </div>
              {index < item.workflow.stages.length - 1 && (
                <div className="w-8 h-px bg-gray-700" />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Current Activity */}
      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-gray-400 mb-2">Current Activity</h3>
            <p className="text-white">{activityText}</p>
            {item.workflow.currentActivity?.moreRunningCount ? (
              <p className="text-xs text-gray-500 mt-1">
                + {item.workflow.currentActivity.moreRunningCount} more running
              </p>
            ) : (
              <p className="text-xs text-gray-500 mt-1">
                {formatStageLabel(item.workflow.currentActivity?.stage || 'execution')}
              </p>
            )}
          </div>
          <span className="px-2 py-0.5 rounded-full text-xs bg-gray-900 text-gray-300">
            {item.workflow.overall.failedSteps} failed
          </span>
        </div>
      </div>

      {/* Jobs */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-medium text-white">Jobs</h3>
          {item.workflow.jobs.length > 0 && (
            <span className="text-sm text-gray-400">{item.workflow.jobs.length} repos in current plan</span>
          )}
        </div>
        {item.workflow.jobs.length === 0 ? (
          <div className="bg-gray-800 rounded-lg p-4 border border-gray-700 text-gray-400">
            No execution jobs yet. Create or load a plan to see task-level progress.
          </div>
        ) : (
          <div className="space-y-4">
            {item.workflow.jobs.map((job) => {
              const repoMeta = repoMetaByName.get(job.repoName);
              return (
                <div
                  key={job.repoName}
                  className="bg-gray-800 rounded-lg border border-gray-700 p-4"
                >
                  <div className="flex items-start justify-between gap-4 mb-3">
                    <div>
                      <div className="flex items-center gap-3">
                        <h4 className="text-base font-medium text-white">{job.repoName}</h4>
                        <span className={`px-2 py-0.5 rounded-full text-xs ${JOB_STATUS_STYLES[job.status]}`}>
                          {job.status}
                        </span>
                        <span className="text-xs text-gray-500">
                          {job.completedSteps} / {job.totalSteps} steps
                        </span>
                      </div>
                      <p className="text-sm text-gray-400 mt-1">{getJobSummary(job)}</p>
                    </div>
                    {repoMeta?.prUrl ? (
                      <a
                        href={repoMeta.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-cyan-300 hover:text-cyan-200"
                      >
                        PR #{repoMeta.prNumber}
                      </a>
                    ) : null}
                  </div>

                  <div className="space-y-2">
                    {job.steps.map((step) => {
                      const isRunning = step.status === 'in_progress' || step.status === 'in_review';
                      return (
                        <div
                          key={step.taskId}
                          className={`rounded-lg border px-3 py-2 ${
                            step.status === 'failed'
                              ? 'border-red-500/40 bg-red-500/5'
                              : isRunning
                              ? 'border-amber-500/40 bg-amber-500/5'
                              : step.status === 'completed'
                              ? 'border-emerald-500/30 bg-emerald-500/5'
                              : 'border-gray-700 bg-gray-900/60'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`text-sm ${
                                    step.status === 'failed'
                                      ? 'text-red-300'
                                      : isRunning
                                      ? 'text-amber-200'
                                      : step.status === 'completed'
                                      ? 'text-emerald-300'
                                      : 'text-gray-500'
                                  }`}
                                >
                                  {STEP_STATUS_ICONS[step.status]}
                                </span>
                                <span className="text-sm font-medium text-white">{step.taskId}</span>
                                <span className="text-sm text-gray-300 truncate">{step.title}</span>
                              </div>
                              {step.lastError && (
                                <p className="text-xs text-red-300 mt-2">{step.lastError}</p>
                              )}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {isRunning && step.currentPhase && (
                                <span className="px-2 py-0.5 rounded-full text-[11px] bg-amber-500/20 text-amber-200">
                                  {formatPhase(step.currentPhase)}
                                </span>
                              )}
                              <span className="text-xs text-gray-500">
                                attempts {step.attempts}
                              </span>
                              {step.reviewRounds ? (
                                <span className="text-xs text-gray-500">
                                  feedback {step.reviewRounds}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Description */}
      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <h3 className="text-sm font-medium text-gray-400 mb-2">Description</h3>
        <p className="text-white">{item.description}</p>
      </div>

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
              {planUpdatedBanner && (
                <div className="flex items-center gap-3 bg-blue-900/50 border border-blue-500/50 rounded px-3 py-2 text-sm text-blue-300">
                  <span>Plan has been updated. Reload?</span>
                  <button
                    onClick={() => {
                      loadPlanContent();
                      setPlanUpdatedBanner(false);
                    }}
                    className="px-2 py-0.5 bg-blue-600 text-white rounded text-xs hover:bg-blue-500"
                  >
                    Reload
                  </button>
                  <button
                    onClick={() => setPlanUpdatedBanner(false)}
                    className="px-2 py-0.5 bg-gray-700 text-gray-300 rounded text-xs hover:bg-gray-600"
                  >
                    Dismiss
                  </button>
                </div>
              )}
              {/* Plan Feedback Form */}
              {item.plan && item.plan.tasks.length > 0 && (
                <div className="border border-gray-700 rounded p-3 space-y-2">
                  <h5 className="text-xs font-medium text-gray-400">Plan Feedback</h5>
                  {feedbackRows.map((row, idx) => (
                    <div key={idx} className="flex gap-2 items-start">
                      <select
                        value={row.taskId}
                        onChange={(e) => {
                          const updated = [...feedbackRows];
                          updated[idx] = { ...updated[idx], taskId: e.target.value };
                          setFeedbackRows(updated);
                        }}
                        className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 min-w-[140px]"
                      >
                        <option value="">Select task...</option>
                        {item.plan!.tasks.map(t => (
                          <option key={t.id} value={t.id}>{t.id}</option>
                        ))}
                      </select>
                      <textarea
                        value={row.feedback}
                        onChange={(e) => {
                          const updated = [...feedbackRows];
                          updated[idx] = { ...updated[idx], feedback: e.target.value };
                          setFeedbackRows(updated);
                        }}
                        placeholder="Feedback..."
                        className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 min-h-[32px]"
                        rows={1}
                      />
                      <button
                        onClick={() => {
                          const updated = feedbackRows.filter((_, i) => i !== idx);
                          setFeedbackRows(updated.length === 0 ? [{ taskId: '', feedback: '' }] : updated);
                        }}
                        className="text-gray-500 hover:text-red-400 text-xs px-1"
                      >
                        x
                      </button>
                    </div>
                  ))}
                  <div className="flex gap-2 items-center">
                    <button
                      onClick={() => setFeedbackRows([...feedbackRows, { taskId: '', feedback: '' }])}
                      className="px-2 py-0.5 bg-gray-700 text-gray-300 rounded text-xs hover:bg-gray-600"
                    >
                      + Add Row
                    </button>
                    <button
                      onClick={async () => {
                        setFeedbackLocalError(null);
                        const valid = feedbackRows.filter(r => r.taskId && r.feedback.trim());
                        if (valid.length === 0) {
                          setFeedbackLocalError('No valid feedback provided');
                          return;
                        }
                        const ok = await submitPlanFeedback(valid);
                        if (ok) setFeedbackRows([{ taskId: '', feedback: '' }]);
                      }}
                      disabled={planFeedbackSubmitting || feedbackRows.every(r => !r.taskId || !r.feedback.trim())}
                      className="px-2 py-0.5 bg-purple-600 text-white rounded text-xs hover:bg-purple-500 disabled:opacity-50"
                    >
                      {planFeedbackSubmitting ? 'Submitting...' : 'Submit Feedback'}
                    </button>
                  </div>
                  {(feedbackLocalError || planFeedbackError) && (
                    <div className="text-xs text-red-400">{feedbackLocalError || planFeedbackError}</div>
                  )}
                </div>
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
                  {reviewEvent.repoName && (
                    <span className="ml-2 text-sm text-yellow-500">
                      ({reviewEvent.repoName})
                    </span>
                  )}
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
                onStop={() => stopAgent(agent.id)}
                onClick={() =>
                  setSelectedAgentId((prev) =>
                    prev === agent.id ? null : agent.id
                  )
                }
                isSelected={selectedAgentId === agent.id}
              />
            ))}
          </div>
        )}
        {selectedAgentId && id && (
          <AgentOutputPanel
            key={selectedAgentId}
            itemId={id}
            agentId={selectedAgentId}
            onClose={() => setSelectedAgentId(null)}
          />
        )}
      </div>

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
