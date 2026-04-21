import { useState, useCallback, useRef, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import type {
  ItemEvent,
  ItemDetail,
  ReviewFinding,
  ItemWorkflowJob,
  ItemWorkflowSummary,
  ReviewFindingsExtractedEvent,
  ReviewPerspective,
  TaskProgressPhase,
  VerificationPolicy,
  WorkflowStageId,
  WorkflowStageStatus,
} from '@agent-orch/shared';
import { getVerificationPolicyRank } from '@agent-orch/shared';
import { useItem } from '../hooks/useItems';
import { useWebSocket } from '../hooks/useWebSocket';
import { AgentCard } from '../components/AgentCard';
import { AgentOutputPanel } from '../components/AgentOutputPanel';
import * as api from '../api/client';
import {
  getRepoSetupStatus,
  SETUP_STATUS_STYLES,
  SETUP_STATUS_LABELS,
  SETUP_STATUS_ICONS,
} from '../utils/setup-status';

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

const TEST_PLAN_APPROVAL_STYLES: Record<string, string> = {
  missing: 'bg-gray-700 text-gray-300',
  parse_error: 'bg-yellow-500/20 text-yellow-200',
  stale: 'bg-yellow-500/20 text-yellow-200',
  pending: 'bg-blue-500/20 text-blue-200',
  approved: 'bg-emerald-500/20 text-emerald-200',
};

const COMPLETED_REVIEW_STATUS_STYLES: Record<string, string> = {
  not_started: 'bg-gray-700 text-gray-300',
  running: 'bg-amber-500/20 text-amber-200',
  needs_fixes: 'bg-red-500/20 text-red-200',
  passed: 'bg-emerald-500/20 text-emerald-200',
  skipped: 'bg-sky-500/20 text-sky-200',
  error: 'bg-red-500/20 text-red-200',
};

const REVIEW_PERSPECTIVE_ORDER: ReviewPerspective[] = [
  'architecture',
  'security',
  'testing',
  'requirements',
];

const REVIEW_PERSPECTIVE_LABELS: Record<ReviewPerspective, string> = {
  architecture: 'Architecture',
  security: 'Security',
  testing: 'Testing',
  requirements: 'Requirements',
};

const REVIEW_PERSPECTIVE_STATUS_STYLES: Record<string, string> = {
  approve: 'bg-emerald-500/20 text-emerald-200',
  request_changes: 'bg-red-500/20 text-red-200',
  error: 'bg-red-500/20 text-red-200',
  schema_fallback: 'bg-yellow-500/20 text-yellow-200',
};

function formatVerificationPolicy(policy: VerificationPolicy): string {
  switch (policy) {
    case 'none':
      return 'None';
    case 'regression_only':
      return 'Regression Only';
    case 'bdd_required':
      return 'BDD Required';
  }
}

function resolveVerificationView(item: ItemDetail): {
  planPolicy: VerificationPolicy;
  resolvedPolicy: VerificationPolicy;
  planRationale: string;
  resolvedRationale: string;
  promotedByTestPlan: boolean;
  completedReviewRequired: boolean;
} | null {
  if (!item.plan) {
    return null;
  }

  const liveTestPlan = item.testPlan && item.testPlanApproval.status !== 'stale'
    ? item.testPlan
    : null;
  const resolvedPolicy = liveTestPlan?.verificationPolicy ?? item.plan.verificationPolicy;
  const resolvedRationale = liveTestPlan?.verificationRationale ?? item.plan.verificationRationale;

  return {
    planPolicy: item.plan.verificationPolicy,
    resolvedPolicy,
    planRationale: item.plan.verificationRationale,
    resolvedRationale,
    promotedByTestPlan:
      getVerificationPolicyRank(resolvedPolicy) >
      getVerificationPolicyRank(item.plan.verificationPolicy),
    completedReviewRequired: resolvedPolicy === 'bdd_required',
  };
}

function formatPhase(phase?: TaskProgressPhase): string {
  if (!phase) return '';
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

function getReviewFindingSeverityStyles(severity: ReviewFinding['severity']): string {
  switch (severity) {
    case 'critical':
      return 'bg-red-500/20 text-red-400';
    case 'major':
      return 'bg-orange-500/20 text-orange-300';
    case 'minor':
      return 'bg-yellow-500/20 text-yellow-200';
  }
}

function groupFindingsByPerspective(
  reviewEvent: ReviewFindingsExtractedEvent
): Map<ReviewPerspective, ReviewFinding[]> {
  const grouped = new Map<ReviewPerspective, ReviewFinding[]>();
  for (const perspective of REVIEW_PERSPECTIVE_ORDER) {
    grouped.set(perspective, []);
  }

  for (const finding of reviewEvent.findings) {
    if (!finding.perspective) {
      continue;
    }
    grouped.get(finding.perspective)?.push(finding);
  }

  return grouped;
}

function formatStageLabel(stage: WorkflowStageId): string {
  switch (stage) {
    case 'workspace':
      return 'Preparing workspace';
    case 'planning':
      return 'Planning';
    case 'test_planning':
      return 'Test Planning';
    case 'execution':
      return 'Executing tasks';
    case 'completed_review':
      return 'Completed Review';
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
  if (activity.stage === 'test_planning') {
    return 'Test planner is building the current test plan';
  }
  if (activity.stage === 'completed_review') {
    if (activity.repoName) {
      return `${activity.repoName}: ${activity.taskId || 'completed review fix'}${activity.phase ? ` (${formatPhase(activity.phase)})` : ''}`;
    }
    return 'Completed reviewer is validating the implementation against the approved test plan';
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
  if (job.activeStage === 'completed_review') {
    return job.currentTaskId
      ? `${job.currentTaskId}${job.currentPhase ? ` (${formatPhase(job.currentPhase)})` : ''}`
      : 'Awaiting final completed review';
  }
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
    startTestPlanner,
    startWorkers,
    startCompletedReview,
    stopAgent,
    startReviewReceive,
    reviewReceiveError,
    testPlannerError,
    completedReviewError,
    submitPlanFeedback,
    planFeedbackSubmitting,
    planFeedbackError,
    submitTestPlanFeedback,
    testPlanFeedbackSubmitting,
    testPlanFeedbackError,
    approveCurrentTestPlan,
    testPlanApproveSubmitting,
    testPlanApproveError,
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
  const [testPlanEditorOpen, setTestPlanEditorOpen] = useState(false);
  const [testPlanContent, setTestPlanContent] = useState('');
  const [testPlanOriginal, setTestPlanOriginal] = useState('');
  const [testPlanLoaded, setTestPlanLoaded] = useState(false);
  const [testPlanLoading, setTestPlanLoading] = useState(false);
  const [testPlanSaving, setTestPlanSaving] = useState(false);
  const [testPlanError, setTestPlanError] = useState<string | null>(null);
  const [testPlanFeedbackRows, setTestPlanFeedbackRows] = useState<{ scenarioId: string; feedback: string }[]>([
    { scenarioId: '', feedback: '' },
  ]);
  const [testPlanFeedbackLocalError, setTestPlanFeedbackLocalError] = useState<string | null>(null);
  const [testPlanUpdatedBanner, setTestPlanUpdatedBanner] = useState(false);
  const [setupEditingRepo, setSetupEditingRepo] = useState<string | null>(null);
  const [setupEditContent, setSetupEditContent] = useState('');
  const [setupSaving, setSetupSaving] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupResults, setSetupResults] = useState<Map<string, boolean>>(new Map());
  const [setupRunningRepo, setSetupRunningRepo] = useState<string | null>(null);

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
  const testPlanDirty = testPlanContent !== testPlanOriginal;

  // Use refs so handleEvent always sees current values without re-creating
  const planEditorOpenRef = useRef(planEditorOpen);
  const planDirtyRef = useRef(planDirty);
  const loadPlanContentRef = useRef(loadPlanContent);
  const testPlanEditorOpenRef = useRef(testPlanEditorOpen);
  const testPlanDirtyRef = useRef(testPlanDirty);
  useEffect(() => { planEditorOpenRef.current = planEditorOpen; }, [planEditorOpen]);
  useEffect(() => { planDirtyRef.current = planDirty; }, [planDirty]);
  useEffect(() => { loadPlanContentRef.current = loadPlanContent; }, [loadPlanContent]);
  useEffect(() => { testPlanEditorOpenRef.current = testPlanEditorOpen; }, [testPlanEditorOpen]);
  useEffect(() => { testPlanDirtyRef.current = testPlanDirty; }, [testPlanDirty]);

  const loadTestPlanContent = useCallback(async () => {
    if (!id) return;
    setTestPlanLoading(true);
    setTestPlanError(null);
    try {
      const result = await api.getTestPlanContent(id);
      const content = result.content ?? '';
      setTestPlanContent(content);
      setTestPlanOriginal(content);
      setTestPlanLoaded(true);
    } catch (err) {
      setTestPlanError(err instanceof Error ? err.message : 'Failed to load test plan');
    } finally {
      setTestPlanLoading(false);
    }
  }, [id]);

  const loadTestPlanContentRef = useRef(loadTestPlanContent);
  useEffect(() => { loadTestPlanContentRef.current = loadTestPlanContent; }, [loadTestPlanContent]);

  const handleEvent = useCallback((event: ItemEvent) => {
    setRecentEvents((prev) => [...prev.slice(-100), event]);
    // Refresh item state on significant events
    if (
      event.type === 'clone_started' ||
      event.type === 'clone_completed' ||
      event.type === 'workspace_setup_started' ||
      event.type === 'workspace_setup_completed' ||
      event.type === 'repo_setup_started' ||
      event.type === 'repo_setup_completed' ||
      event.type === 'agent_started' ||
      event.type === 'agent_exited' ||
      event.type === 'status_changed' ||
      event.type === 'approval_requested' ||
      event.type === 'approval_decision' ||
      event.type === 'plan_created' ||
      event.type === 'test_plan_created' ||
      event.type === 'test_plan_approved' ||
      event.type === 'completed_review_findings_extracted' ||
      event.type === 'completed_review_passed' ||
      event.type === 'completed_review_skipped' ||
      event.type === 'hooks_executed' ||
      event.type === 'review_receive_started' ||
      event.type === 'review_receive_completed' ||
      event.type === 'review_findings_extracted' ||
      event.type === 'pr_created' ||
      event.type === 'repo_no_changes' ||
      event.type === 'error' ||
      event.type === 'test_plan_parse_warning' ||
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
    if (event.type === 'test_plan_created' && testPlanEditorOpenRef.current) {
      if (!testPlanDirtyRef.current) {
        loadTestPlanContentRef.current();
      } else {
        setTestPlanUpdatedBanner(true);
      }
    }
    // Track setup command results
    if (event.type === 'repo_setup_started') {
      setSetupResults((prev) => {
        const next = new Map(prev);
        next.delete(event.repoName);
        return next;
      });
    }
    if (event.type === 'repo_setup_completed') {
      setSetupResults((prev) => {
        const next = new Map(prev);
        next.set(event.repoName, event.allPassed);
        return next;
      });
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

  const handleOpenTestPlanEditor = useCallback(async () => {
    setTestPlanEditorOpen(true);
    if (!testPlanLoaded) {
      await loadTestPlanContent();
    }
  }, [loadTestPlanContent, testPlanLoaded]);

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

  const handleSaveTestPlan = useCallback(async () => {
    if (!id) return;
    setTestPlanSaving(true);
    setTestPlanError(null);
    try {
      const result = await api.updateTestPlan(id, { content: testPlanContent });
      setTestPlanContent(result.content);
      setTestPlanOriginal(result.content);
      await refresh();
    } catch (err) {
      setTestPlanError(err instanceof Error ? err.message : 'Failed to save test plan');
    } finally {
      setTestPlanSaving(false);
    }
  }, [id, testPlanContent, refresh]);

  const handleSaveSetup = useCallback(async () => {
    if (!id || !setupEditingRepo) return;
    setSetupSaving(true);
    setSetupError(null);
    try {
      const commands = setupEditContent
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      await api.updateRepoSetup(id, setupEditingRepo, commands);
      setSetupEditingRepo(null);
      setSetupResults((prev) => {
        const next = new Map(prev);
        next.delete(setupEditingRepo!);
        return next;
      });
      await refresh();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : 'Failed to save setup commands');
    } finally {
      setSetupSaving(false);
    }
  }, [id, setupEditingRepo, setupEditContent, refresh]);

  const handleRunSetup = useCallback(async (repoName: string) => {
    if (!id) return;
    setSetupError(null);
    setSetupRunningRepo(repoName);
    try {
      await api.runRepoSetup(id, repoName);
      await refresh();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : 'Failed to run setup commands');
    } finally {
      setSetupRunningRepo(null);
    }
  }, [id, refresh]);

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
    item.testPlanApproval.status === 'approved' &&
    (item.status === 'ready' ||
      (item.status === 'error' && !!item.plan));
  const testPlanScenarios = item.testPlan?.scenarios ?? [];
  const verificationView = resolveVerificationView(item);

  // Error repos for partial re-run
  const failedRepos = item.repos?.filter(r => r.status === 'error').map(r => r.repoName) ?? [];

  // Review Receive: check repo-level status for PR repos
  const canStartReviewReceive = item.repos?.some(
    repo => repo.prUrl && (repo.status === 'completed' || repo.status === 'error')
  ) ?? false;
  const allWorkflowStepsCompleted =
    item.workflow.overall.totalSteps > 0 &&
    item.workflow.overall.completedSteps === item.workflow.overall.totalSteps;
  const canStartCompletedReview =
    verificationView?.completedReviewRequired === true &&
    allWorkflowStepsCompleted &&
    item.completedReview.status !== 'running' &&
    item.completedReview.status !== 'passed' &&
    item.completedReview.status !== 'skipped';

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
                  startWorkers({ mode: 'retry_failed' });
                } else {
                  startWorkers();
                }
              }}
              className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-500"
            >
              {item.status === 'error' && failedRepos.length > 0
                ? 'Retry Workflow'
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
                      const showReviewExhausted = step.status === 'completed' && step.reviewExhausted;
                      const showHooksExhausted = Boolean(step.hooksExhausted);
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
                                {showReviewExhausted ? (
                                  <span className="px-2 py-0.5 rounded-full text-[11px] bg-amber-500/20 text-amber-200">
                                    review exhausted
                                  </span>
                                ) : null}
                                {showHooksExhausted ? (
                                  <span className="px-2 py-0.5 rounded-full text-[11px] bg-orange-500/20 text-orange-200">
                                    hooks exhausted
                                  </span>
                                ) : null}
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

      {/* Setup Commands */}
      {item.repositories.some((r) => r.type === 'remote') && (
        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <h3 className="text-sm font-medium text-gray-400 mb-3">Setup Commands</h3>
          <div className="space-y-3">
            {item.repositories
              .filter((r) => r.type === 'remote')
              .map((repoConfig) => {
                const repoSummary = item.repos.find((r) => r.repoName === repoConfig.name);
                const setupStatus = getRepoSetupStatus(repoConfig, repoSummary, setupResults.get(repoConfig.name));
                const isEditing = setupEditingRepo === repoConfig.name;
                const icon = SETUP_STATUS_ICONS[setupStatus];

                return (
                  <div key={repoConfig.name} className="border border-gray-700 rounded p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white">{repoConfig.name}</span>
                        <span className={`px-2 py-0.5 rounded-full text-xs ${SETUP_STATUS_STYLES[setupStatus]}`}>
                          {icon ? <><span className={setupStatus === 'running' ? 'inline-block animate-spin' : ''}>{icon}</span>{' '}</> : ''}{SETUP_STATUS_LABELS[setupStatus]}
                        </span>
                      </div>
                      <div className="flex gap-2">
                        {(setupStatus === 'pending' || setupStatus === 'failed') && (
                          <button
                            onClick={() => handleRunSetup(repoConfig.name)}
                            disabled={setupRunningRepo === repoConfig.name}
                            className="px-2.5 py-1 bg-amber-600 text-white rounded text-xs hover:bg-amber-500 disabled:opacity-50"
                          >
                            {setupStatus === 'failed' ? 'Re-run Setup' : 'Run Setup'}
                          </button>
                        )}
                        <button
                          onClick={() => {
                            if (isEditing) {
                              setSetupEditingRepo(null);
                            } else {
                              setSetupEditingRepo(repoConfig.name);
                              setSetupEditContent((repoConfig.setup || []).join('\n'));
                              setSetupError(null);
                            }
                          }}
                          className="px-2.5 py-1 bg-gray-700 text-gray-200 rounded text-xs hover:bg-gray-600"
                        >
                          {isEditing ? 'Cancel' : 'Edit'}
                        </button>
                      </div>
                    </div>

                    {/* Show current commands */}
                    {!isEditing && repoConfig.setup && repoConfig.setup.length > 0 && (
                      <div className="bg-gray-900 rounded p-2 mt-2">
                        {repoConfig.setup.map((cmd, idx) => (
                          <div key={idx} className="text-xs text-gray-300 font-mono py-0.5">{cmd}</div>
                        ))}
                      </div>
                    )}

                    {/* Edit panel */}
                    {isEditing && (
                      <div className="mt-2 space-y-2">
                        <textarea
                          value={setupEditContent}
                          onChange={(e) => setSetupEditContent(e.target.value)}
                          placeholder="One command per line..."
                          className="w-full min-h-[80px] bg-gray-900 text-gray-100 border border-gray-700 rounded p-2 font-mono text-xs"
                          spellCheck={false}
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={handleSaveSetup}
                            disabled={setupSaving}
                            className="px-2.5 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-500 disabled:opacity-50"
                          >
                            {setupSaving ? 'Saving...' : 'Save'}
                          </button>
                          <button
                            onClick={() => setSetupEditingRepo(null)}
                            className="px-2.5 py-1 bg-gray-700 text-gray-200 rounded text-xs hover:bg-gray-600"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
          {setupError && <div className="text-xs text-red-400 mt-2">{setupError}</div>}
        </div>
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
              {verificationView && (
                <div className="mt-3 space-y-1">
                  <p className="text-xs text-gray-400">
                    Verification Policy: <span className="text-gray-200">{formatVerificationPolicy(verificationView.planPolicy)}</span>
                  </p>
                  <p className="text-xs text-gray-500">
                    {verificationView.planRationale}
                  </p>
                </div>
              )}
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

      {/* Test Plan Summary */}
      {item.plan && (
        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <h3 className="text-sm font-medium text-gray-400">Test Plan</h3>
                <span className={`px-2 py-0.5 rounded-full text-xs ${TEST_PLAN_APPROVAL_STYLES[item.testPlanApproval.status]}`}>
                  {item.testPlanApproval.status}
                </span>
              </div>
              <p className="text-white mb-2">
                {item.testPlan?.summary || 'No test plan generated yet.'}
              </p>
              <p className="text-sm text-gray-400">
                {item.testPlan?.scenarios.length ?? 0} scenarios
              </p>
              {verificationView && (
                <div className="mt-3 space-y-1">
                  <p className="text-xs text-gray-400">
                    Resolved Policy: <span className="text-gray-200">{formatVerificationPolicy(verificationView.resolvedPolicy)}</span>
                  </p>
                  <p className="text-xs text-gray-500">
                    {verificationView.resolvedRationale}
                  </p>
                </div>
              )}
              {verificationView?.promotedByTestPlan && item.testPlanApproval.status !== 'stale' && (
                <p className="text-xs text-amber-300 mt-2">
                  Test Planner promoted verification from {formatVerificationPolicy(verificationView.planPolicy)} to {formatVerificationPolicy(verificationView.resolvedPolicy)}.
                </p>
              )}
              {item.testPlanApproval.status === 'stale' && (
                <p className="text-xs text-yellow-300 mt-2">
                  This test plan is stale for the current live plan. Regenerate or edit it before approval.
                </p>
              )}
              {item.testPlanApproval.status === 'parse_error' && (
                <p className="text-xs text-yellow-300 mt-2">
                  Test planner finished but the generated YAML could not be parsed. You can approve as-is to start workers, or edit the YAML first.
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={startTestPlanner}
                className="px-3 py-1.5 bg-indigo-600 text-white rounded hover:bg-indigo-500 text-sm"
              >
                Run Test Planner
              </button>
              {(item.testPlanApproval.status === 'pending' || item.testPlanApproval.status === 'parse_error') && (
                <button
                  onClick={approveCurrentTestPlan}
                  disabled={testPlanApproveSubmitting}
                  className="px-3 py-1.5 bg-emerald-600 text-white rounded hover:bg-emerald-500 text-sm disabled:opacity-50"
                >
                  {testPlanApproveSubmitting ? 'Approving...' : 'Approve Test Plan'}
                </button>
              )}
              <button
                onClick={handleOpenTestPlanEditor}
                className="px-3 py-1.5 bg-gray-700 text-white rounded hover:bg-gray-600 text-sm"
              >
                Edit test-plan.yaml
              </button>
            </div>
          </div>
          {(testPlannerError || testPlanApproveError) && (
            <div className="text-xs text-red-400 mt-3">{testPlannerError || testPlanApproveError}</div>
          )}
          {testPlanEditorOpen && (
            <div className="mt-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-gray-300">test-plan.yaml</h4>
                <div className="flex gap-2">
                  <button
                    onClick={loadTestPlanContent}
                    disabled={testPlanLoading}
                    className="px-2.5 py-1 bg-gray-700 text-gray-200 rounded hover:bg-gray-600 text-xs disabled:opacity-50"
                  >
                    Reload
                  </button>
                  <button
                    onClick={() => {
                      setTestPlanContent(testPlanOriginal);
                      setTestPlanError(null);
                    }}
                    disabled={!testPlanDirty || testPlanSaving}
                    className="px-2.5 py-1 bg-gray-700 text-gray-200 rounded hover:bg-gray-600 text-xs disabled:opacity-50"
                  >
                    Revert
                  </button>
                  <button
                    onClick={handleSaveTestPlan}
                    disabled={!testPlanDirty || testPlanSaving}
                    className="px-2.5 py-1 bg-green-600 text-white rounded hover:bg-green-500 text-xs disabled:opacity-50"
                  >
                    {testPlanSaving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
              {testPlanLoading ? (
                <div className="text-xs text-gray-400">Loading test plan...</div>
              ) : (
                <textarea
                  value={testPlanContent}
                  onChange={(event) => setTestPlanContent(event.target.value)}
                  className="w-full min-h-[220px] bg-gray-900 text-gray-100 border border-gray-700 rounded p-3 font-mono text-xs"
                  spellCheck={false}
                />
              )}
              {testPlanError && (
                <div className="text-xs text-red-400">{testPlanError}</div>
              )}
              {testPlanUpdatedBanner && (
                <div className="flex items-center gap-3 bg-blue-900/50 border border-blue-500/50 rounded px-3 py-2 text-sm text-blue-300">
                  <span>Test plan has been updated. Reload?</span>
                  <button
                    onClick={() => {
                      loadTestPlanContent();
                      setTestPlanUpdatedBanner(false);
                    }}
                    className="px-2 py-0.5 bg-blue-600 text-white rounded text-xs hover:bg-blue-500"
                  >
                    Reload
                  </button>
                  <button
                    onClick={() => setTestPlanUpdatedBanner(false)}
                    className="px-2 py-0.5 bg-gray-700 text-gray-300 rounded text-xs hover:bg-gray-600"
                  >
                    Dismiss
                  </button>
                </div>
              )}
              {item.testPlan && item.testPlanApproval.status !== 'stale' && testPlanScenarios.length > 0 && (
                <div className="border border-gray-700 rounded p-3 space-y-2">
                  <h5 className="text-xs font-medium text-gray-400">Test Plan Feedback</h5>
                  {testPlanFeedbackRows.map((row, idx) => (
                    <div key={idx} className="flex gap-2 items-start">
                      <select
                        value={row.scenarioId}
                        onChange={(e) => {
                          const updated = [...testPlanFeedbackRows];
                          updated[idx] = { ...updated[idx], scenarioId: e.target.value };
                          setTestPlanFeedbackRows(updated);
                        }}
                        className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 min-w-[160px]"
                      >
                        <option value="">Select scenario...</option>
                        {testPlanScenarios.map((scenario) => (
                          <option key={scenario.id} value={scenario.id}>{scenario.id}</option>
                        ))}
                      </select>
                      <textarea
                        value={row.feedback}
                        onChange={(e) => {
                          const updated = [...testPlanFeedbackRows];
                          updated[idx] = { ...updated[idx], feedback: e.target.value };
                          setTestPlanFeedbackRows(updated);
                        }}
                        placeholder="Feedback..."
                        className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 min-h-[32px]"
                        rows={1}
                      />
                      <button
                        onClick={() => {
                          const updated = testPlanFeedbackRows.filter((_, i) => i !== idx);
                          setTestPlanFeedbackRows(
                            updated.length === 0 ? [{ scenarioId: '', feedback: '' }] : updated
                          );
                        }}
                        className="text-gray-500 hover:text-red-400 text-xs px-1"
                      >
                        x
                      </button>
                    </div>
                  ))}
                  <div className="flex gap-2 items-center">
                    <button
                      onClick={() =>
                        setTestPlanFeedbackRows([...testPlanFeedbackRows, { scenarioId: '', feedback: '' }])
                      }
                      className="px-2 py-0.5 bg-gray-700 text-gray-300 rounded text-xs hover:bg-gray-600"
                    >
                      + Add Row
                    </button>
                    <button
                      onClick={async () => {
                        setTestPlanFeedbackLocalError(null);
                        const valid = testPlanFeedbackRows.filter(
                          (row) => row.scenarioId && row.feedback.trim()
                        );
                        if (valid.length === 0) {
                          setTestPlanFeedbackLocalError('No valid feedback provided');
                          return;
                        }
                        const ok = await submitTestPlanFeedback(valid);
                        if (ok) {
                          setTestPlanFeedbackRows([{ scenarioId: '', feedback: '' }]);
                        }
                      }}
                      disabled={
                        testPlanFeedbackSubmitting ||
                        testPlanFeedbackRows.every((row) => !row.scenarioId || !row.feedback.trim())
                      }
                      className="px-2 py-0.5 bg-indigo-600 text-white rounded text-xs hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {testPlanFeedbackSubmitting ? 'Submitting...' : 'Submit Feedback'}
                    </button>
                  </div>
                  {(testPlanFeedbackLocalError || testPlanFeedbackError) && (
                    <div className="text-xs text-red-400">
                      {testPlanFeedbackLocalError || testPlanFeedbackError}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Completed Review Summary */}
      {item.plan && (
        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <h3 className="text-sm font-medium text-gray-400">Completed Review</h3>
                <span className={`px-2 py-0.5 rounded-full text-xs ${COMPLETED_REVIEW_STATUS_STYLES[item.completedReview.status]}`}>
                  {item.completedReview.status}
                </span>
              </div>
              <p className="text-white mb-2">
                {item.completedReview.summary || 'Final completed review has not run yet.'}
              </p>
              <p className="text-sm text-gray-400">
                Round {item.completedReview.round || 0} · {item.completedReview.findings.length} findings
              </p>
              {verificationView && (
                <p className="text-xs text-gray-500 mt-2">
                  {verificationView.completedReviewRequired
                    ? `Completed review is required for ${formatVerificationPolicy(verificationView.resolvedPolicy)}.`
                    : `Completed review is not required for ${formatVerificationPolicy(verificationView.resolvedPolicy)}.`}
                </p>
              )}
              {item.completedReview.errorMessage && (
                <p className="text-xs text-red-300 mt-2">{item.completedReview.errorMessage}</p>
              )}
            </div>
            {canStartCompletedReview && (
              <button
                onClick={startCompletedReview}
                className="px-3 py-1.5 bg-fuchsia-600 text-white rounded hover:bg-fuchsia-500 text-sm"
              >
                Run Completed Review
              </button>
            )}
          </div>
          {completedReviewError && (
            <div className="text-xs text-red-400 mt-3">{completedReviewError}</div>
          )}
          {item.completedReview.findings.length > 0 && (
            <div className="mt-4 space-y-2">
              {item.completedReview.findings.map((finding) => (
                <div
                  key={finding.id}
                  className="bg-gray-900 rounded p-3 border border-gray-700"
                >
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded ${
                        finding.severity === 'critical'
                          ? 'bg-red-500/20 text-red-400'
                          : finding.severity === 'major'
                          ? 'bg-orange-500/20 text-orange-300'
                          : 'bg-yellow-500/20 text-yellow-200'
                      }`}>
                        {finding.severity.toUpperCase()}
                      </span>
                      <span className="text-sm text-white">{finding.summary}</span>
                    </div>
                    <span className="text-xs text-gray-500">{finding.targetRepository}</span>
                  </div>
                  <p className="text-xs text-gray-400 mb-2">Scenario: {finding.scenarioId}</p>
                  <p className="text-sm text-gray-300 mb-2">{finding.details}</p>
                  <p className="text-xs text-gray-500">Fix: {finding.suggestedFix}</p>
                </div>
              ))}
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
          (reviewEvent.findings.length > 0 || (reviewEvent.perspectives?.length || 0) > 0) && (
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

              {reviewEvent.perspectives && reviewEvent.perspectives.length > 0 ? (
                <div className="space-y-4">
                  {(() => {
                    const groupedFindings = groupFindingsByPerspective(reviewEvent);
                    return REVIEW_PERSPECTIVE_ORDER.map((perspective) => {
                      const summary = reviewEvent.perspectives?.find(
                        (entry) => entry.perspective === perspective
                      );
                      if (!summary) {
                        return null;
                      }

                      const findings = groupedFindings.get(perspective) || [];

                      return (
                        <div
                          key={perspective}
                          className="bg-gray-900 rounded-lg border border-gray-700 p-4"
                        >
                          <div className="flex items-center justify-between gap-3 mb-3">
                            <div className="flex items-center gap-2">
                              <h4 className="text-sm font-semibold text-white">
                                {REVIEW_PERSPECTIVE_LABELS[perspective]}
                              </h4>
                              <span className={`text-xs font-medium px-2 py-0.5 rounded ${REVIEW_PERSPECTIVE_STATUS_STYLES[summary.status] || 'bg-gray-700 text-gray-300'}`}>
                                {summary.status.replace('_', ' ')}
                              </span>
                            </div>
                            <div className="flex gap-3 text-xs text-gray-400">
                              <span>Critical: {summary.criticalCount}</span>
                              <span>Major: {summary.majorCount}</span>
                              <span>Minor: {summary.minorCount}</span>
                            </div>
                          </div>

                          <p className="text-sm text-gray-300 mb-3">{summary.summary}</p>

                          {findings.length > 0 && (
                            <div className="space-y-2">
                              {findings.map((finding, idx) => (
                                <div
                                  key={`${perspective}-${idx}`}
                                  className="bg-gray-950 rounded p-3 border border-gray-800"
                                >
                                  <div className="flex items-start justify-between mb-2">
                                    <span className={`text-xs font-semibold px-2 py-0.5 rounded ${getReviewFindingSeverityStyles(finding.severity)}`}>
                                      {finding.severity.toUpperCase()}
                                    </span>
                                    <span className="text-xs text-gray-500">
                                      {finding.targetAgent}
                                    </span>
                                  </div>
                                  <p className="text-sm text-gray-400 mb-1">
                                    {finding.file}{finding.line ? `:${finding.line}` : ''}
                                  </p>
                                  <p className="text-sm text-white mb-2">
                                    {finding.description}
                                  </p>
                                  {finding.suggestedFix && (
                                    <p className="text-xs text-gray-500">
                                      Fix: {finding.suggestedFix}
                                    </p>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    });
                  })()}
                </div>
              ) : (
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
              )}
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
