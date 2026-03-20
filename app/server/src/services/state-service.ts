import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import type {
  ItemStatus,
  AgentStatus,
  ItemEvent,
  ApprovalRequestEvent,
  ReviewReceiveStartedEvent,
  ReviewReceiveCompletedEvent,
  CloneCompletedEvent,
  WorkspaceSetupCompletedEvent,
  RepoSetupCompletedEvent,
  AgentStartedEvent,
  AgentExitedEvent,
  ErrorEvent,
  PrCreatedEvent,
  RepoNoChangesEvent,
  HooksExecutedEvent,
  RepoStatus,
  RepoPhase,
} from '@agent-orch/shared';
import { readJsonl } from '../lib/jsonl';
import { getItemEventsPath, getAgentEventsPath, getItemPlanPath, getWorkspaceRoot } from '../lib/paths';
import { readYamlSafe } from '../lib/yaml';
import type { Plan } from '@agent-orch/shared';
import {
  AGENT_STOPPED_BEFORE_COMPLETION_ERROR,
  hasStaleExecutionStop,
  readRepoTaskState,
  reconcileStoppedRepoTaskState,
  type RepoTaskStateFile,
} from './task-state-service';
import { deriveTestPlanApproval } from './test-planner-service';

/**
 * Map old agent statuses to new ones for backward compat with persisted events.
 */
function mapAgentStatus(status: string): AgentStatus {
  if (status === 'waiting_approval') return 'running';
  if (status === 'waiting_orchestrator') return 'completed';
  return status as AgentStatus;
}

// ─── Repo-level derived state ───

export interface RepoDerivedState {
  status: RepoStatus;
  activePhase?: RepoPhase;
  inCurrentPlan: boolean;
  lastErrorMessage?: string;
}

/**
 * Derive per-repo statuses from the item event log.
 * This is the source of truth for repo-level state.
 */
export async function deriveRepoStatuses(itemId: string): Promise<Map<string, RepoDerivedState>> {
  const events = await readJsonl<ItemEvent>(getItemEventsPath(itemId));

  // Build agent → repo mapping from agent_started events
  const agentRepoMap = new Map<string, string>();
  const agentRoleMap = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'agent_started') {
      const ev = e as AgentStartedEvent;
      if (ev.repoName) agentRepoMap.set(ev.agentId, ev.repoName);
      agentRoleMap.set(ev.agentId, ev.role);
    }
  }

  // Determine current plan repos
  const currentPlanRepos = await getCurrentPlanRepos(itemId);

  // Find the last plan_created index for cycle boundary
  let lastPlanCreatedIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'plan_created') {
      lastPlanCreatedIdx = i;
      break;
    }
  }

  // Build repo states
  const repoStates = new Map<string, RepoDerivedState>();

  // Collect all known repos from events
  const allRepoNames = new Set<string>();
  for (const e of events) {
    const repoName = extractRepoName(e, agentRepoMap);
    if (repoName) allRepoNames.add(repoName);
  }

  // Also add repos from current plan
  if (currentPlanRepos) {
    for (const repoName of currentPlanRepos) {
      allRepoNames.add(repoName);
    }
  }

  // Initialize all known repos
  for (const repoName of allRepoNames) {
    const inCurrentPlan = currentPlanRepos ? currentPlanRepos.has(repoName) : false;
    repoStates.set(repoName, {
      status: inCurrentPlan ? 'ready' : 'not_started',
      inCurrentPlan,
    });
  }

  // Track review_receive state for restore logic
  const reviewReceivePreStates = new Map<string, RepoDerivedState>();
  const reviewReceivingRepos = new Set<string>();
  const hasCompletedReviewPassInCurrentCycle = events.some(
    (event, index) => index > lastPlanCreatedIdx && event.type === 'completed_review_passed'
  );

  // Process events in order
  for (let i = 0; i < events.length; i++) {
    const e = events[i];

    switch (e.type) {
      case 'clone_started': {
        const ev = e as import('@agent-orch/shared').CloneStartedEvent;
        ensureRepo(repoStates, ev.repoName, currentPlanRepos);
        const state = repoStates.get(ev.repoName)!;
        state.status = 'running';
        state.activePhase = 'clone';
        break;
      }
      case 'clone_completed': {
        const ev = e as CloneCompletedEvent;
        const state = repoStates.get(ev.repoName);
        if (state) {
          if (!ev.success) {
            state.status = 'error';
            state.activePhase = 'clone';
            state.lastErrorMessage = ev.error;
          } else {
            state.status = 'running';
            if (state.activePhase === 'clone') {
              state.activePhase = undefined;
            }
            state.lastErrorMessage = undefined;
          }
        }
        break;
      }
      case 'workspace_setup_started': {
        const ev = e as import('@agent-orch/shared').WorkspaceSetupStartedEvent;
        ensureRepo(repoStates, ev.repoName, currentPlanRepos);
        const state = repoStates.get(ev.repoName)!;
        state.status = 'running';
        state.activePhase = 'workspace_setup';
        break;
      }
      case 'workspace_setup_completed': {
        const ev = e as WorkspaceSetupCompletedEvent;
        const state = repoStates.get(ev.repoName);
        if (state) {
          if (!ev.success) {
            state.status = 'error';
            state.activePhase = 'workspace_setup';
            state.lastErrorMessage = ev.error;
          } else {
            state.status = 'running';
            if (state.activePhase === 'workspace_setup') {
              state.activePhase = undefined;
            }
            state.lastErrorMessage = undefined;
          }
        }
        break;
      }
      case 'repo_setup_started': {
        const ev = e as import('@agent-orch/shared').RepoSetupStartedEvent;
        ensureRepo(repoStates, ev.repoName, currentPlanRepos);
        const state = repoStates.get(ev.repoName)!;
        state.status = 'running';
        state.activePhase = 'setup';
        break;
      }
      case 'repo_setup_completed': {
        const ev = e as RepoSetupCompletedEvent;
        const state = repoStates.get(ev.repoName);
        if (state) {
          state.status = 'running';
          if (state.activePhase === 'setup') {
            state.activePhase = undefined;
          }
          state.lastErrorMessage = undefined;
        }
        break;
      }
      case 'plan_created': {
        // Update inCurrentPlan based on new plan
        // But don't reset review_receiving repos
        if (currentPlanRepos) {
          for (const [repoName, state] of repoStates) {
            if (reviewReceivingRepos.has(repoName)) continue; // don't touch review_receiving repos
            state.inCurrentPlan = currentPlanRepos.has(repoName);
            // Reset in-scope repos to ready for the new cycle
            if (state.inCurrentPlan && i === lastPlanCreatedIdx) {
              state.status = 'ready';
              state.activePhase = undefined;
              state.lastErrorMessage = undefined;
            }
          }
        }
        break;
      }
      case 'agent_started': {
        const ev = e as AgentStartedEvent;
        if (!ev.repoName) break; // planner has no repoName
        const role = ev.role;
        const state = repoStates.get(ev.repoName);
        if (!state) break;
        if (role === 'engineer' || role === 'developer') {
          state.status = 'running';
          state.activePhase = 'engineer';
        } else if (role === 'review') {
          state.status = 'running';
          state.activePhase = 'review';
        }
        // review-receiver handled via review_receive_started
        break;
      }
      case 'agent_exited': {
        const ev = e as AgentExitedEvent;
        const repoName = agentRepoMap.get(ev.agentId);
        const role = agentRoleMap.get(ev.agentId);
        if (!repoName) break;
        const state = repoStates.get(repoName);
        if (!state) break;
        if (ev.exitCode !== 0 && role !== 'review-receiver') {
          state.status = 'error';
          // Keep activePhase
        }
        // exitCode=0: keep running (waiting for task-level review or PR)
        break;
      }
      case 'hooks_executed': {
        const ev = e as HooksExecutedEvent;
        const state = repoStates.get(ev.repoName);
        if (state) {
          state.activePhase = 'hooks';
          // allPassed: keep running, waiting for review/PR
          // !allPassed: don't change status (will be retried or error event follows)
        }
        break;
      }
      case 'review_findings_extracted': {
        const ev = e as import('@agent-orch/shared').ReviewFindingsExtractedEvent;
        const state = repoStates.get(ev.repoName);
        if (state) {
          state.status = 'running';
          state.activePhase = 'review';
        }
        break;
      }
      case 'error': {
        const ev = e as ErrorEvent;
        const repoName = resolveErrorRepoName(ev, agentRepoMap);
        if (repoName) {
          const state = repoStates.get(repoName);
          if (state) {
            state.status = 'error';
            if (ev.phase) state.activePhase = ev.phase as RepoPhase;
            state.lastErrorMessage = ev.message;
          }
        }
        // item-level errors (no repo attribution) are handled in deriveItemStatus
        break;
      }
      case 'pr_created': {
        const ev = e as PrCreatedEvent;
        const state = repoStates.get(ev.repoName);
        if (state) {
          state.status = 'completed';
          state.activePhase = 'pr';
        }
        break;
      }
      case 'repo_no_changes': {
        const ev = e as RepoNoChangesEvent;
        const state = repoStates.get(ev.repoName);
        if (state) {
          state.status = 'completed';
          state.activePhase = undefined;
        }
        break;
      }
      case 'review_receive_started': {
        const ev = e as ReviewReceiveStartedEvent;
        const state = repoStates.get(ev.repoName);
        if (state) {
          // Save pre-state for restore
          reviewReceivePreStates.set(ev.repoName, { ...state });
          reviewReceivingRepos.add(ev.repoName);
          state.status = 'review_receiving';
          state.activePhase = 'review_receive';
        }
        break;
      }
      case 'review_receive_completed': {
        const ev = e as ReviewReceiveCompletedEvent;
        const state = repoStates.get(ev.repoName);
        if (state) {
          reviewReceivingRepos.delete(ev.repoName);
          // Check if plan_created occurred between review_receive_started and this event
          const startIdx = findLastReviewReceiveStartIdx(events, ev.repoName, i);
          const planCreatedBetween = events.some(
            (pe, pi) => pe.type === 'plan_created' && pi > startIdx && pi < i
          );
          if (planCreatedBetween) {
            // New plan was created during review receive
            if (currentPlanRepos && currentPlanRepos.has(ev.repoName)) {
              state.status = 'ready';
              state.activePhase = undefined;
              state.lastErrorMessage = undefined;
              state.inCurrentPlan = true;
            } else {
              // Not in new plan — restore pre-state
              const pre = reviewReceivePreStates.get(ev.repoName);
              if (pre) {
                state.status = pre.status;
                state.activePhase = pre.activePhase;
                state.lastErrorMessage = pre.lastErrorMessage;
              }
              state.inCurrentPlan = currentPlanRepos ? currentPlanRepos.has(ev.repoName) : false;
            }
          } else {
            // No new plan — restore pre-state
            const pre = reviewReceivePreStates.get(ev.repoName);
            if (pre) {
              state.status = pre.status;
              state.activePhase = pre.activePhase;
              state.lastErrorMessage = pre.lastErrorMessage;
            }
          }
          reviewReceivePreStates.delete(ev.repoName);
        }
        break;
      }
      case 'status_changed': {
        const ev = e as import('@agent-orch/shared').StatusChangedEvent;
        // 条件: agent が running 中に stopped された場合のみ repo error に遷移
        if (ev.newStatus !== 'stopped' || ev.previousStatus !== 'running' || !ev.agentId) break;
        const repoName = agentRepoMap.get(ev.agentId);
        const role = agentRoleMap.get(ev.agentId);
        if (!repoName) break; // planner は repoName なし → スキップ
        const state = repoStates.get(repoName);
        if (!state) break;
        // repo が既に terminal 状態（completed/error）なら上書きしない
        if (state.status !== 'running' && state.status !== 'review_receiving') break;
        if (role === 'engineer' || role === 'developer' || role === 'review' || role === 'review-receiver') {
          state.status = 'error';
          state.lastErrorMessage = AGENT_STOPPED_BEFORE_COMPLETION_ERROR;
          // review_receiving 中に停止した場合もセットから除去して error にする
          reviewReceivingRepos.delete(repoName);
        }
        break;
      }
    }
  }

  await overlayExecutionStateFromTaskState(
    itemId,
    events,
    repoStates,
    currentPlanRepos,
    hasCompletedReviewPassInCurrentCycle
  );

  return repoStates;
}

async function overlayExecutionStateFromTaskState(
  itemId: string,
  events: ItemEvent[],
  repoStates: Map<string, RepoDerivedState>,
  currentPlanRepos: Set<string> | null,
  hasCompletedReviewPass: boolean
): Promise<void> {
  if (!currentPlanRepos || currentPlanRepos.size === 0) {
    return;
  }

  const taskStatesByRepo = new Map<string, RepoTaskStateFile>();
  for (const repoName of currentPlanRepos) {
    ensureRepo(repoStates, repoName, currentPlanRepos);
    const persistedState = await readRepoTaskState(itemId, repoName);
    if (persistedState) {
      taskStatesByRepo.set(
        repoName,
        hasStaleExecutionStop(events, repoName)
          ? reconcileStoppedRepoTaskState(persistedState).state
          : persistedState
      );
    }
  }

  const allExecutionCompleted = [...currentPlanRepos].every((repoName) => {
    const taskState = taskStatesByRepo.get(repoName);
    return Boolean(
      taskState &&
      taskState.tasks.length > 0 &&
      taskState.tasks.every((task) => task.status === 'completed')
    );
  });

  for (const repoName of currentPlanRepos) {
    const persistedState = taskStatesByRepo.get(repoName);
    const repoState = repoStates.get(repoName);
    if (!persistedState || !repoState) {
      continue;
    }
    applyExecutionStateFromTaskState(
      repoState,
      persistedState,
      hasStaleExecutionStop(events, repoName),
      hasCompletedReviewPass,
      allExecutionCompleted
    );
  }
}

function applyExecutionStateFromTaskState(
  repoState: RepoDerivedState,
  taskState: RepoTaskStateFile,
  interruptedExecutionStopped: boolean,
  hasCompletedReviewPass: boolean,
  allExecutionCompleted: boolean
): void {
  if (repoState.status === 'review_receiving' || repoState.activePhase === 'review_receive') {
    return;
  }
  if (repoState.status === 'completed') {
    return;
  }
  if (repoState.status === 'error' && repoState.activePhase === 'pr') {
    return;
  }

  const failedTask = taskState.tasks.find((task) => task.status === 'failed');
  if (failedTask) {
    repoState.status = 'error';
    repoState.activePhase = failedTask.currentPhase || 'engineer';
    repoState.lastErrorMessage = failedTask.lastError;
    return;
  }

  if (interruptedExecutionStopped) {
    const interruptedReviewTask = taskState.tasks.find((task) => task.status === 'in_review');
    if (interruptedReviewTask) {
      repoState.status = 'ready';
      repoState.activePhase = undefined;
      repoState.lastErrorMessage = undefined;
      return;
    }
  }

  const runningTask = taskState.tasks.find(
    (task) => task.status === 'in_progress' || task.status === 'in_review'
  );
  if (runningTask) {
    repoState.status = 'running';
    repoState.activePhase = runningTask.currentPhase || 'engineer';
    repoState.lastErrorMessage = undefined;
    return;
  }

  const hasUnfinishedTask = taskState.tasks.some((task) => task.status !== 'completed');
  if (hasUnfinishedTask) {
    const hasCompletedTask = taskState.tasks.some((task) => task.status === 'completed');
    if (repoState.status === 'error' && !hasCompletedTask) {
      return;
    }
    repoState.status = 'ready';
    repoState.activePhase = undefined;
    repoState.lastErrorMessage = undefined;
    return;
  }

  if (allExecutionCompleted) {
    repoState.status = 'running';
    repoState.activePhase = hasCompletedReviewPass ? 'pr' : 'completed_review';
  } else {
    repoState.status = 'completed';
    repoState.activePhase = undefined;
  }
  repoState.lastErrorMessage = undefined;
}

function ensureRepo(
  repoStates: Map<string, RepoDerivedState>,
  repoName: string,
  currentPlanRepos: Set<string> | null
): void {
  if (!repoStates.has(repoName)) {
    repoStates.set(repoName, {
      status: currentPlanRepos?.has(repoName) ? 'ready' : 'not_started',
      inCurrentPlan: currentPlanRepos ? currentPlanRepos.has(repoName) : false,
    });
  }
}

function extractRepoName(event: ItemEvent, agentRepoMap: Map<string, string>): string | null {
  // Direct repoName field
  if ('repoName' in event && typeof (event as { repoName?: string }).repoName === 'string') {
    return (event as { repoName: string }).repoName;
  }
  // Agent-based
  if (event.agentId) {
    return agentRepoMap.get(event.agentId) ?? null;
  }
  return null;
}

/**
 * Resolve error event to a repo name using multiple strategies:
 * 1. Direct repoName field (new format)
 * 2. agentId → agent_started repo mapping
 * 3. Legacy hooks failure message regex
 */
function resolveErrorRepoName(
  event: ErrorEvent,
  agentRepoMap: Map<string, string>
): string | null {
  if (event.repoName) return event.repoName;
  if (event.agentId) {
    const repo = agentRepoMap.get(event.agentId);
    if (repo) return repo;
  }
  // Legacy hooks failure regex
  const hooksMatch = event.message?.match(/Hooks validation failed for (\S+)/);
  if (hooksMatch) return hooksMatch[1];
  return null;
}

function findLastReviewReceiveStartIdx(events: ItemEvent[], repoName: string, beforeIdx: number): number {
  for (let i = beforeIdx - 1; i >= 0; i--) {
    if (events[i].type === 'review_receive_started' &&
        (events[i] as ReviewReceiveStartedEvent).repoName === repoName) {
      return i;
    }
  }
  return -1;
}

/**
 * Get the set of repo names in the current plan.
 * Falls back to archived plan if current plan doesn't exist.
 * Returns null if no plan has ever been created.
 */
async function getCurrentPlanRepos(itemId: string): Promise<Set<string> | null> {
  // Try current plan.yaml
  const planPath = getItemPlanPath(itemId);
  let plan = await readYamlSafe<Plan>(planPath);
  if (plan?.tasks) {
    const repos = new Set<string>();
    for (const t of plan.tasks) {
      if (t.repository) repos.add(t.repository);
    }
    return repos;
  }

  // Fallback: look for archived plans
  const workspaceRoot = getWorkspaceRoot(itemId);
  if (!existsSync(workspaceRoot)) return null;

  try {
    const files = await readdir(workspaceRoot);
    const planFiles = files
      .filter(f => f.startsWith('plan_') && f.endsWith('.yaml'))
      .sort()
      .reverse();

    for (const pf of planFiles) {
      const archivedPlan = await readYamlSafe<Plan>(`${workspaceRoot}/${pf}`);
      if (archivedPlan?.tasks) {
        const repos = new Set<string>();
        for (const t of archivedPlan.tasks) {
          if (t.repository) repos.add(t.repository);
        }
        return repos;
      }
    }
  } catch {
    // Directory listing failed
  }

  return null;
}

// ─── Item-level status derivation ───

export async function deriveItemStatus(itemId: string): Promise<ItemStatus> {
  const events = await readJsonl<ItemEvent>(getItemEventsPath(itemId));

  if (events.length === 0) {
    return 'created';
  }

  const repoStatuses = await deriveRepoStatuses(itemId);
  const inScopeRepos = [...repoStatuses.values()].filter(r => r.inCurrentPlan);
  const allRepos = [...repoStatuses.values()];

  // 1. Clone/workspace_setup failure
  for (const r of allRepos) {
    if (r.status === 'error' && (r.activePhase === 'clone' || r.activePhase === 'workspace_setup')) {
      return 'error';
    }
  }

  // 2. Clone/workspace_setup incomplete
  const hasWorkspaceStarted = events.some((e) =>
    e.type === 'clone_started' || e.type === 'workspace_setup_started' || e.type === 'repo_setup_started'
  );
  if (hasWorkspaceStarted) {
    const stillCloning = allRepos.some(r =>
      r.status === 'running' && (
        r.activePhase === 'clone' ||
        r.activePhase === 'workspace_setup' ||
        r.activePhase === 'setup'
      )
    );
    if (stillCloning) {
      return 'cloning';
    }
  }

  // 3. Planner / test planner state
  const currentPlan = await readYamlSafe<Plan>(getItemPlanPath(itemId));
  const hasCurrentPlan = Boolean(currentPlan);
  const testPlanApproval = await deriveTestPlanApproval(itemId, currentPlan);
  const agentRoles = new Map<string, string>();
  const agentStates = new Map<string, AgentStatus>();
  let latestPlannerStatus: AgentStatus | undefined;
  let latestTestPlannerStatus: AgentStatus | undefined;
  let hasPlannerSignal = false;
  let hasTestPlannerSignal = false;
  for (const event of events) {
    if (event.type === 'agent_started') {
      const e = event as AgentStartedEvent;
      agentRoles.set(e.agentId, e.role);
      agentStates.set(e.agentId, 'running');
      if (e.role === 'planner') {
        latestPlannerStatus = 'running';
        hasPlannerSignal = true;
      } else if (e.role === 'test-planner') {
        latestTestPlannerStatus = 'running';
        hasTestPlannerSignal = true;
      }
    } else if (event.type === 'agent_exited' && event.agentId) {
      const e = event as AgentExitedEvent;
      const current = agentStates.get(event.agentId);
      if (current !== 'stopped') {
        const nextStatus = e.exitCode === 0 ? 'completed' : 'error';
        agentStates.set(event.agentId, nextStatus);
        if (agentRoles.get(event.agentId) === 'planner') {
          latestPlannerStatus = nextStatus;
          hasPlannerSignal = true;
        } else if (agentRoles.get(event.agentId) === 'test-planner') {
          latestTestPlannerStatus = nextStatus;
          hasTestPlannerSignal = true;
        }
      }
    } else if (event.type === 'status_changed' && event.agentId) {
      const e = event as import('@agent-orch/shared').StatusChangedEvent;
      const current = agentStates.get(event.agentId);
      if (current !== 'stopped') {
        const nextStatus = mapAgentStatus(e.newStatus);
        agentStates.set(event.agentId, nextStatus);
        if (agentRoles.get(event.agentId) === 'planner') {
          latestPlannerStatus = nextStatus;
          hasPlannerSignal = true;
        } else if (agentRoles.get(event.agentId) === 'test-planner') {
          latestTestPlannerStatus = nextStatus;
          hasTestPlannerSignal = true;
        }
      }
    } else if (event.type === 'error') {
      const e = event as ErrorEvent;
      if (e.phase === 'planner') {
        latestPlannerStatus = 'error';
        hasPlannerSignal = true;
      } else if (e.phase === 'test_planner') {
        latestTestPlannerStatus = 'error';
        hasTestPlannerSignal = true;
      }
    }
  }

  if (latestPlannerStatus === 'running' || latestTestPlannerStatus === 'running') {
    return 'planning';
  }

  // 4. Planner failed & no current plan
  if (!hasCurrentPlan && latestPlannerStatus === 'error') {
    return 'error';
  }

  if (
    hasCurrentPlan &&
    latestTestPlannerStatus === 'error' &&
    testPlanApproval.status !== 'approved'
  ) {
    return 'error';
  }

  if (
    hasWorkspaceStarted &&
    !hasPlannerSignal &&
    !hasCurrentPlan &&
    allRepos.some((r) => r.status === 'running')
  ) {
    return 'cloning';
  }

  if (
    hasCurrentPlan &&
    (testPlanApproval.status === 'missing' ||
      testPlanApproval.status === 'stale' ||
      testPlanApproval.status === 'pending' ||
      (!hasTestPlannerSignal && hasPlannerSignal))
  ) {
    return 'planning';
  }

  // 5. Any repo review_receiving
  if (allRepos.some(r => r.status === 'review_receiving')) {
    return 'review_receiving';
  }

  // 6. In-scope repo running
  if (inScopeRepos.some(r => r.status === 'running')) {
    return 'running';
  }

  // 7. All in-scope repos completed
  if (inScopeRepos.length > 0 && inScopeRepos.every(r => r.status === 'completed')) {
    return 'completed';
  }

  // 8. No in-scope repos but some completed
  if (inScopeRepos.length === 0 && allRepos.some(r => r.status === 'completed')) {
    return 'completed';
  }

  // 9. In-scope repo error
  if (inScopeRepos.some(r => r.status === 'error')) {
    return 'error';
  }

  // 10. Item-level unattributed errors since last plan_created
  let lastPlanCreatedIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'plan_created') {
      lastPlanCreatedIdx = i;
      break;
    }
  }

  const agentRepoMap = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'agent_started') {
      const ev = e as AgentStartedEvent;
      if (ev.repoName) agentRepoMap.set(ev.agentId, ev.repoName);
    }
  }

  const hasUnattributedError = events.some((e, idx) => {
    if (e.type !== 'error' || idx <= lastPlanCreatedIdx) return false;
    const errEvent = e as ErrorEvent;
    return !resolveErrorRepoName(errEvent, agentRepoMap);
  });
  if (hasUnattributedError) {
    return 'error';
  }

  // 11. In-scope repos have ready
  if (inScopeRepos.some(r => r.status === 'ready')) {
    return 'ready';
  }

  // 12. Default
  if (hasCurrentPlan && testPlanApproval.status === 'approved') {
    return 'ready';
  }

  return 'created';
}

export async function deriveAgentStatus(
  itemId: string,
  agentId: string
): Promise<AgentStatus> {
  const events = await readJsonl<ItemEvent>(getAgentEventsPath(itemId, agentId));

  if (events.length === 0) {
    return 'idle';
  }

  let status: AgentStatus = 'idle';

  for (const event of events) {
    switch (event.type) {
      case 'agent_started':
        status = 'running';
        break;
      case 'agent_exited': {
        const e = event as import('@agent-orch/shared').AgentExitedEvent;
        if (status !== 'stopped') {
          status = e.exitCode === 0 ? 'completed' : 'error';
        }
        break;
      }
      case 'approval_requested':
        // Backward compat: map to running
        status = 'running';
        break;
      case 'approval_decision':
        // No-op for backward compat
        break;
      case 'status_changed': {
        const e = event as import('@agent-orch/shared').StatusChangedEvent;
        if (status !== 'stopped') {
          status = mapAgentStatus(e.newStatus);
        }
        break;
      }
    }
  }

  return status;
}

/**
 * @deprecated Approvals no longer exist. Always returns empty array.
 */
export async function getPendingApprovals(
  itemId: string
): Promise<ApprovalRequestEvent[]> {
  return [];
}

export async function getEventHistory(
  itemId: string,
  limit?: number,
  agentId?: string
): Promise<ItemEvent[]> {
  const path = agentId
    ? getAgentEventsPath(itemId, agentId)
    : getItemEventsPath(itemId);

  const events = await readJsonl<ItemEvent>(path);

  if (limit) {
    return events.slice(-limit);
  }

  return events;
}

export async function getAgentOutputHistory(
  itemId: string,
  agentId: string,
  limit?: number
): Promise<{ timestamp: string; data: string }[]> {
  const events = await readJsonl<ItemEvent>(getAgentEventsPath(itemId, agentId));

  const outputs = events
    .filter((e) => e.type === 'stdout' || e.type === 'stderr')
    .map((e) => {
      const o = e as import('@agent-orch/shared').OutputEvent;
      return {
        timestamp: o.timestamp,
        data: o.data,
      };
    });

  if (limit) {
    return outputs.slice(-limit);
  }

  return outputs;
}
