import { describe, expect, it } from 'vitest';
import type {
  AgentInfo,
  ItemConfig,
  ItemEvent,
  TestPlan,
  TestPlanApprovalState,
  Plan,
  PrCreatedEvent,
  RepoNoChangesEvent,
} from '@agent-orch/shared';
import { buildWorkflowSummary } from '../item-service';
import type { RepoDerivedState } from '../state-service';
import type { RepoTaskStateFile } from '../task-state-service';

function makeConfig(repos: Array<{ name: string; type?: 'remote' | 'local' }> = [{ name: 'repo-a' }]): ItemConfig {
  return {
    id: 'ITEM-1',
    name: 'Item',
    description: 'desc',
    repositories: repos.map((repo) => ({
      name: repo.name,
      type: repo.type || 'remote',
      url: `https://example.com/${repo.name}.git`,
    })),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function makePlan(
  tasks: Array<{ id: string; repository: string; title?: string }>,
  verificationPolicy: Plan['verificationPolicy'] = 'bdd_required',
  verificationRationale = 'Cross-repository behavior needs BDD coverage.'
): Plan {
  return {
    version: '1',
    itemId: 'ITEM-1',
    summary: 'summary',
    verificationPolicy,
    verificationRationale,
    createdAt: '2026-01-01T00:00:00Z',
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title || task.id,
      description: `${task.id} description`,
      repository: task.repository,
      dependencies: [],
      files: [],
    })),
  };
}

function makeTestPlan(
  verificationPolicy: TestPlan['verificationPolicy'],
  verificationRationale: string
): TestPlan {
  return {
    version: '1.0',
    itemId: 'ITEM-1',
    planFingerprint: 'fingerprint',
    summary: 'test plan',
    verificationPolicy,
    verificationRationale,
    createdAt: '2026-01-01T00:00:00Z',
    scenarios: verificationPolicy === 'bdd_required'
      ? [
          {
            id: 'S1',
            kind: 'bdd',
            title: 'BDD scenario',
            repositories: ['repo-a'],
            given: 'given',
            when: 'when',
            then: 'then',
          },
        ]
      : [
          {
            id: 'S1',
            kind: 'regression',
            title: 'Regression scenario',
            repositories: ['repo-a'],
            given: 'given',
            when: 'when',
            then: 'then',
          },
        ],
  };
}

function makeRepoState(
  overrides: Partial<RepoDerivedState> = {}
): RepoDerivedState {
  return {
    status: 'ready',
    inCurrentPlan: false,
    ...overrides,
  };
}

function makeTaskState(
  repoName: string,
  tasks: Array<Partial<RepoTaskStateFile['tasks'][number]> & { id: string; title: string }>
): RepoTaskStateFile {
  return {
    version: '1',
    itemId: 'ITEM-1',
    repository: repoName,
    planFingerprint: 'fingerprint',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      dependencies: [],
      status: task.status || 'pending',
      currentPhase: task.currentPhase,
      attempts: task.attempts || 0,
      reviewRounds: task.reviewRounds,
      reviewExhausted: task.reviewExhausted,
      hooksExhausted: task.hooksExhausted,
      lastError: task.lastError,
    })),
  };
}

function buildSummary(params: {
  itemStatus?: import('@agent-orch/shared').ItemStatus;
  plan?: Plan | null;
  events?: ItemEvent[];
  agents?: AgentInfo[];
  repoStatuses?: Map<string, RepoDerivedState>;
  prEvents?: PrCreatedEvent[];
  noChangesEvents?: RepoNoChangesEvent[];
  taskStates?: Map<string, RepoTaskStateFile>;
  config?: ItemConfig;
  testPlan?: TestPlan | null;
  testPlanApproval?: TestPlanApprovalState;
}) {
  return buildWorkflowSummary({
    config: params.config || makeConfig(),
    itemStatus: params.itemStatus || 'created',
    plan: params.plan ?? null,
    testPlan: params.testPlan ?? null,
    testPlanApproval: params.testPlanApproval || { status: 'missing' },
    events: params.events || [],
    agents: params.agents || [],
    repoStatuses: params.repoStatuses || new Map(),
    prEvents: params.prEvents || [],
    noChangesEvents: params.noChangesEvents || [],
    taskStates: params.taskStates || new Map(),
  });
}

function getStageStatus(summary: ReturnType<typeof buildSummary>, stageId: string) {
  return summary.stages.find((stage: ReturnType<typeof buildSummary>['stages'][number]) => stage.id === stageId)?.status;
}

describe('buildWorkflowSummary', () => {
  it('returns workflow stages and no jobs when no plan exists', () => {
    const events: ItemEvent[] = [
      {
        id: 'clone-1',
        type: 'clone_completed',
        timestamp: '2026-01-01T00:00:00Z',
        itemId: 'ITEM-1',
        repoName: 'repo-a',
        success: true,
      },
    ];

    const summary = buildSummary({
      itemStatus: 'planning',
      events,
      repoStatuses: new Map([['repo-a', makeRepoState({ status: 'ready' })]]),
    });

    expect(getStageStatus(summary, 'workspace')).toBe('completed');
    expect(getStageStatus(summary, 'planning')).toBe('running');
    expect(getStageStatus(summary, 'execution')).toBe('pending');
    expect(getStageStatus(summary, 'completed_review')).toBe('pending');
    expect(summary.jobs).toEqual([]);
  });

  it('synthesizes pending steps when plan exists but task state is missing', () => {
    const summary = buildSummary({
      plan: makePlan([
        { id: 'T1', repository: 'repo-a', title: 'Task 1' },
        { id: 'T2', repository: 'repo-a', title: 'Task 2' },
      ]),
      repoStatuses: new Map([['repo-a', makeRepoState({ inCurrentPlan: true })]]),
    });

    expect(summary.jobs).toHaveLength(1);
    expect(summary.jobs[0].steps.map((step: ReturnType<typeof buildSummary>['jobs'][number]['steps'][number]) => step.status)).toEqual(['pending', 'pending']);
    expect(getStageStatus(summary, 'execution')).toBe('pending');
  });

  it('marks hooks as the current execution activity', () => {
    const plan = makePlan([{ id: 'T1', repository: 'repo-a', title: 'Task 1' }]);
    const taskStates = new Map([
      ['repo-a', makeTaskState('repo-a', [{ id: 'T1', title: 'Task 1', status: 'in_review', currentPhase: 'hooks', attempts: 1 }])],
    ]);

    const summary = buildSummary({
      itemStatus: 'running',
      plan,
      repoStatuses: new Map([['repo-a', makeRepoState({ status: 'running', activePhase: 'engineer', inCurrentPlan: true })]]),
      taskStates,
    });

    expect(getStageStatus(summary, 'execution')).toBe('running');
    expect(summary.currentActivity).toEqual(
      expect.objectContaining({
        repoName: 'repo-a',
        stage: 'execution',
        taskId: 'T1',
        phase: 'hooks',
      })
    );
  });

  it('does not count stale in-review work as running execution', () => {
    const summary = buildSummary({
      itemStatus: 'ready',
      plan: makePlan([{ id: 'T1', repository: 'repo-a', title: 'Task 1' }]),
      events: [
        {
          id: 'plan-1',
          type: 'plan_created',
          timestamp: '2026-01-01T00:00:00Z',
          itemId: 'ITEM-1',
          planPath: '/plan.yaml',
        },
        {
          id: 'eng-1',
          type: 'agent_started',
          timestamp: '2026-01-01T00:01:00Z',
          itemId: 'ITEM-1',
          agentId: 'eng1',
          role: 'engineer',
          repoName: 'repo-a',
          pid: 0,
        },
        {
          id: 'eng-2',
          type: 'agent_exited',
          timestamp: '2026-01-01T00:02:00Z',
          itemId: 'ITEM-1',
          agentId: 'eng1',
          exitCode: 0,
        },
        {
          id: 'rev-1',
          type: 'agent_started',
          timestamp: '2026-01-01T00:03:00Z',
          itemId: 'ITEM-1',
          agentId: 'review1',
          role: 'review',
          repoName: 'repo-a',
          pid: 0,
        },
        {
          id: 'rev-2',
          type: 'status_changed',
          timestamp: '2026-01-01T00:04:00Z',
          itemId: 'ITEM-1',
          agentId: 'review1',
          previousStatus: 'running',
          newStatus: 'stopped',
        },
      ],
      repoStatuses: new Map([['repo-a', makeRepoState({ status: 'ready', inCurrentPlan: true })]]),
      taskStates: new Map([
        ['repo-a', makeTaskState('repo-a', [{ id: 'T1', title: 'Task 1', status: 'in_review', currentPhase: 'hooks', attempts: 1 }])],
      ]),
    });

    expect(getStageStatus(summary, 'execution')).toBe('pending');
    expect(summary.jobs[0]).toEqual(
      expect.objectContaining({
        status: 'pending',
        activeStage: undefined,
        currentTaskId: 'T1',
        currentPhase: 'hooks',
      })
    );
    expect(summary.currentActivity).toBeUndefined();
  });

  it('surfaces execution errors from failed task state', () => {
    const summary = buildSummary({
      itemStatus: 'error',
      plan: makePlan([{ id: 'T1', repository: 'repo-a', title: 'Task 1' }]),
      repoStatuses: new Map([['repo-a', makeRepoState({ status: 'error', activePhase: 'hooks', inCurrentPlan: true })]]),
      taskStates: new Map([
        ['repo-a', makeTaskState('repo-a', [{ id: 'T1', title: 'Task 1', status: 'failed', currentPhase: 'hooks', lastError: 'hook failed' }])],
      ]),
    });

    expect(getStageStatus(summary, 'execution')).toBe('error');
    expect(summary.jobs[0].steps[0]).toEqual(
      expect.objectContaining({
        status: 'failed',
        currentPhase: 'hooks',
        lastError: 'hook failed',
      })
    );
  });

  it('marks completed review as running after all steps complete but before PR creation', () => {
    const summary = buildSummary({
      itemStatus: 'running',
      plan: makePlan([{ id: 'T1', repository: 'repo-a', title: 'Task 1' }]),
      repoStatuses: new Map([['repo-a', makeRepoState({ status: 'running', inCurrentPlan: true })]]),
      taskStates: new Map([
        ['repo-a', makeTaskState('repo-a', [{ id: 'T1', title: 'Task 1', status: 'completed', attempts: 1 }])],
      ]),
    });

    expect(getStageStatus(summary, 'execution')).toBe('completed');
    expect(getStageStatus(summary, 'completed_review')).toBe('running');
    expect(getStageStatus(summary, 'publish')).toBe('pending');
    expect(summary.jobs[0]).toEqual(
      expect.objectContaining({
        status: 'running',
        activeStage: 'completed_review',
      })
    );
  });

  it('treats completed review as completed when resolved policy is regression_only', () => {
    const summary = buildSummary({
      itemStatus: 'running',
      plan: makePlan(
        [{ id: 'T1', repository: 'repo-a', title: 'Task 1' }],
        'regression_only',
        'Single-repository behavior change needs regression coverage.'
      ),
      testPlan: makeTestPlan(
        'regression_only',
        'Single-repository behavior change needs regression coverage.'
      ),
      testPlanApproval: {
        status: 'approved',
        planFingerprint: 'fingerprint',
        testPlanFingerprint: 'tp-1',
      },
      repoStatuses: new Map([['repo-a', makeRepoState({ status: 'running', inCurrentPlan: true })]]),
      taskStates: new Map([
        ['repo-a', makeTaskState('repo-a', [{ id: 'T1', title: 'Task 1', status: 'completed', attempts: 1 }])],
      ]),
    });

    expect(getStageStatus(summary, 'execution')).toBe('completed');
    expect(getStageStatus(summary, 'completed_review')).toBe('completed');
    expect(getStageStatus(summary, 'publish')).toBe('running');
    expect(summary.jobs[0]).toEqual(
      expect.objectContaining({
        status: 'running',
        activeStage: 'publish',
      })
    );
  });

  it('keeps completed repos finished when another repo is still failing', () => {
    const plan = makePlan([
      { id: 'T1', repository: 'repo-a', title: 'Task 1' },
      { id: 'T2', repository: 'repo-b', title: 'Task 2' },
    ]);

    const summary = buildSummary({
      itemStatus: 'error',
      plan,
      config: makeConfig([{ name: 'repo-a' }, { name: 'repo-b' }]),
      repoStatuses: new Map([
        ['repo-a', makeRepoState({ status: 'completed', inCurrentPlan: true })],
        ['repo-b', makeRepoState({ status: 'error', activePhase: 'review', inCurrentPlan: true })],
      ]),
      taskStates: new Map([
        ['repo-a', makeTaskState('repo-a', [{ id: 'T1', title: 'Task 1', status: 'completed', attempts: 1 }])],
        ['repo-b', makeTaskState('repo-b', [{ id: 'T2', title: 'Task 2', status: 'failed', currentPhase: 'review', attempts: 1, lastError: 'review failed' }])],
      ]),
    });

    expect(getStageStatus(summary, 'execution')).toBe('error');
    expect(getStageStatus(summary, 'completed_review')).toBe('pending');
    expect(summary.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repoName: 'repo-a',
          status: 'completed',
          activeStage: undefined,
        }),
        expect.objectContaining({
          repoName: 'repo-b',
          status: 'error',
          activeStage: 'execution',
        }),
      ])
    );
    expect(summary.currentActivity?.stage).not.toBe('completed_review');
  });

  it('keeps review-exhausted completed tasks in publish flow without increasing failed steps', () => {
    const summary = buildSummary({
      itemStatus: 'running',
      plan: makePlan([{ id: 'T1', repository: 'repo-a', title: 'Task 1' }]),
      repoStatuses: new Map([['repo-a', makeRepoState({ status: 'running', inCurrentPlan: true })]]),
      taskStates: new Map([
        ['repo-a', makeTaskState('repo-a', [{
          id: 'T1',
          title: 'Task 1',
          status: 'completed',
          attempts: 1,
          reviewRounds: 3,
          reviewExhausted: true,
        }])],
      ]),
    });

    expect(summary.jobs[0]).toEqual(
      expect.objectContaining({
        status: 'running',
        activeStage: 'completed_review',
        completedSteps: 1,
        failedSteps: 0,
      })
    );
    expect(summary.jobs[0].steps[0]).toEqual(
      expect.objectContaining({
        status: 'completed',
        reviewExhausted: true,
      })
    );
  });

  it('keeps hooks-exhausted completed tasks in publish flow without increasing failed steps', () => {
    const summary = buildSummary({
      itemStatus: 'running',
      plan: makePlan([{ id: 'T1', repository: 'repo-a', title: 'Task 1' }]),
      repoStatuses: new Map([['repo-a', makeRepoState({ status: 'running', inCurrentPlan: true })]]),
      taskStates: new Map([
        ['repo-a', makeTaskState('repo-a', [{
          id: 'T1',
          title: 'Task 1',
          status: 'completed',
          attempts: 1,
          hooksExhausted: true,
        }])],
      ]),
    });

    expect(summary.jobs[0]).toEqual(
      expect.objectContaining({
        status: 'running',
        activeStage: 'completed_review',
        completedSteps: 1,
        failedSteps: 0,
      })
    );
    expect(summary.jobs[0].steps[0]).toEqual(
      expect.objectContaining({
        status: 'completed',
        hooksExhausted: true,
      })
    );
  });

  it('shows review_receive only when a current-plan repo has a PR', () => {
    const plan = makePlan([{ id: 'T1', repository: 'repo-a', title: 'Task 1' }]);
    const prEvent: PrCreatedEvent = {
      id: 'pr-1',
      type: 'pr_created',
      timestamp: '2026-01-01T01:00:00Z',
      itemId: 'ITEM-1',
      repoName: 'repo-a',
      prUrl: 'https://example.com/pr/1',
      prNumber: 1,
      branch: 'work/ITEM-1/repo-a',
      commitHash: 'abc123',
    };

    const withoutPr = buildSummary({
      plan,
      repoStatuses: new Map([['repo-a', makeRepoState({ inCurrentPlan: true })]]),
    });
    expect(withoutPr.stages.some((stage: ReturnType<typeof buildSummary>['stages'][number]) => stage.id === 'review_receive')).toBe(false);

    const withPr = buildSummary({
      plan,
      prEvents: [prEvent],
      repoStatuses: new Map([['repo-a', makeRepoState({ inCurrentPlan: true })]]),
      taskStates: new Map([
        ['repo-a', makeTaskState('repo-a', [{ id: 'T1', title: 'Task 1', status: 'completed' }])],
      ]),
    });

    expect(withPr.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'review_receive', status: 'pending', optional: true }),
      ])
    );
  });
});
