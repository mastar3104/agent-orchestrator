import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ItemDetail } from '@agent-orch/shared';
import { ItemDetailPage } from '../ItemDetailPage';

vi.mock('../../hooks/useItems', () => ({
  useItem: vi.fn(),
}));

vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

import { useItem } from '../../hooks/useItems';
import { useWebSocket } from '../../hooks/useWebSocket';

const mockUseItem = vi.mocked(useItem);
const mockUseWebSocket = vi.mocked(useWebSocket);
const startPlanner = vi.fn();
const startTestPlanner = vi.fn();
const startCompletedReview = vi.fn();
const startWorkers = vi.fn();
const submitPlanFeedback = vi.fn();
const submitTestPlanFeedback = vi.fn();
const approveCurrentTestPlan = vi.fn();
const refresh = vi.fn();

type UseItemResult = ReturnType<typeof useItem>;

function makeItem(overrides: Partial<ItemDetail> = {}): ItemDetail {
  const base: ItemDetail = {
    id: 'ITEM-1',
    name: 'Workflow Item',
    description: 'desc',
    repositories: [
      { name: 'repo-a', type: 'remote' as const, url: 'https://example.com/repo-a.git' },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    status: 'running' as const,
    plan: {
      version: '1',
      itemId: 'ITEM-1',
      summary: 'Plan summary',
      createdAt: '2026-01-01T00:00:00Z',
      tasks: [
        {
          id: 'T1',
          title: 'Implement workflow',
          description: 'desc',
          repository: 'repo-a',
          dependencies: [],
          files: [],
        },
      ],
    },
    agents: [],
    pendingApprovals: [],
    testPlanApproval: {
      status: 'missing',
    },
    completedReview: {
      status: 'not_started',
      findings: [],
    },
    repos: [
      {
        repoName: 'repo-a',
        status: 'running' as const,
        activePhase: 'hooks' as const,
        noChanges: false,
        inCurrentPlan: true,
        prUrl: 'https://example.com/pr/1',
        prNumber: 1,
      },
    ],
    workflow: {
      stages: [
        { id: 'workspace' as const, label: 'Workspace', status: 'completed' as const },
        { id: 'planning' as const, label: 'Planning', status: 'completed' as const },
        { id: 'test_planning' as const, label: 'Test Planning', status: 'completed' as const },
        { id: 'execution' as const, label: 'Execution', status: 'running' as const },
        { id: 'completed_review' as const, label: 'Completed Review', status: 'pending' as const },
        { id: 'publish' as const, label: 'Publish', status: 'pending' as const },
        { id: 'review_receive' as const, label: 'Review Receive', status: 'pending' as const, optional: true },
      ],
      jobs: [
        {
          repoName: 'repo-a',
          status: 'running' as const,
          activeStage: 'execution' as const,
          currentTaskId: 'T1',
          currentPhase: 'hooks' as const,
          totalSteps: 1,
          completedSteps: 0,
          failedSteps: 0,
          steps: [
            {
              taskId: 'T1',
              title: 'Implement workflow',
              status: 'in_review' as const,
              currentPhase: 'hooks' as const,
              attempts: 1,
              reviewRounds: 0,
            },
          ],
        },
      ],
      overall: {
        totalSteps: 1,
        completedSteps: 0,
        failedSteps: 0,
        runningStepId: 'T1',
      },
      currentActivity: {
        repoName: 'repo-a',
        stage: 'execution' as const,
        taskId: 'T1',
        phase: 'hooks' as const,
        moreRunningCount: 0,
      },
    },
  };
  return {
    ...base,
    ...overrides,
    repositories: overrides.repositories ?? base.repositories,
    plan: Object.prototype.hasOwnProperty.call(overrides, 'plan') ? overrides.plan : base.plan,
    repos: overrides.repos ?? base.repos,
    workflow: overrides.workflow ?? base.workflow,
  };
}

function makeUseItemResult(overrides: Partial<UseItemResult> = {}): UseItemResult {
  return {
    item: makeItem(),
    loading: false,
    error: null,
    refresh,
    startPlanner,
    startTestPlanner,
    startCompletedReview,
    startWorkers,
    stopAgent: vi.fn(),
    startReviewReceive: vi.fn(),
    reviewReceiveError: null,
    testPlannerError: null,
    completedReviewError: null,
    submitPlanFeedback,
    planFeedbackSubmitting: false,
    planFeedbackError: null,
    submitTestPlanFeedback,
    testPlanFeedbackSubmitting: false,
    testPlanFeedbackError: null,
    approveCurrentTestPlan,
    testPlanApproveSubmitting: false,
    testPlanApproveError: null,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/items/ITEM-1']}>
      <Routes>
        <Route path="/items/:id" element={<ItemDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('ItemDetailPage workflow UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startPlanner.mockReset();
    startTestPlanner.mockReset();
    startCompletedReview.mockReset();
    startWorkers.mockReset();
    submitPlanFeedback.mockReset();
    submitTestPlanFeedback.mockReset();
    approveCurrentTestPlan.mockReset();
    mockUseItem.mockReturnValue(makeUseItemResult());
    mockUseWebSocket.mockReturnValue({
      isConnected: true,
      lastEvent: null,
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    });
  });

  it('renders workflow strip, current activity, and job cards', () => {
    const view = renderPage();

    expect(view.getByText('Workflow')).toBeInTheDocument();
    expect(view.getByText('Current Activity')).toBeInTheDocument();
    expect(view.getByText('Jobs')).toBeInTheDocument();
    expect(view.getByText('Workspace')).toBeInTheDocument();
    expect(view.getByText('Execution')).toBeInTheDocument();
    expect(view.getByText('Completed Review')).toBeInTheDocument();
    expect(view.getByText('repo-a: T1: Implement workflow (Hooks)')).toBeInTheDocument();
    expect(view.getByText('0 / 1 steps')).toBeInTheDocument();
    expect(view.getAllByText('Hooks').length).toBeGreaterThan(0);
    expect(view.getByText('PR #1')).toBeInTheDocument();
  });

  it('refreshes when task_state_changed is received', () => {
    renderPage();

    const wsOptions = mockUseWebSocket.mock.calls[0][0];
    act(() => {
      wsOptions.onEvent?.({
        id: 'evt-1',
        type: 'task_state_changed',
        timestamp: '2026-01-01T00:00:00Z',
        itemId: 'ITEM-1',
        repoName: 'repo-a',
        taskId: 'T1',
        status: 'in_review',
        currentPhase: 'hooks',
      });
    });

    expect(refresh).toHaveBeenCalled();
  });

  it('sends retry_failed mode when Retry Workflow is clicked', () => {
    mockUseItem.mockReturnValue(makeUseItemResult({
      item: makeItem({
        status: 'error',
        repos: [
          {
            repoName: 'repo-a',
            status: 'error',
            activePhase: 'hooks',
            noChanges: false,
            inCurrentPlan: true,
          },
        ],
      }),
    }));

    const view = renderPage();
    view.getByRole('button', { name: 'Retry Workflow' }).click();

    expect(startWorkers).toHaveBeenCalledWith({ mode: 'retry_failed' });
  });

  it('starts workers without retry mode for ready items', () => {
    mockUseItem.mockReturnValue(makeUseItemResult({
      item: makeItem({
        status: 'ready',
        testPlanApproval: {
          status: 'approved',
        },
        repos: [
          {
            repoName: 'repo-a',
            status: 'ready',
            noChanges: false,
            inCurrentPlan: true,
          },
        ],
      }),
    }));

    const view = renderPage();
    view.getByRole('button', { name: 'Start Workers' }).click();

    expect(startWorkers).toHaveBeenCalledWith();
  });

  it('shows Start Planner when the item is errored and has no plan', () => {
    mockUseItem.mockReturnValue(makeUseItemResult({
      item: makeItem({
        status: 'error',
        plan: undefined,
        repos: [
          {
            repoName: 'repo-a',
            status: 'running',
            noChanges: false,
            inCurrentPlan: false,
          },
        ],
      }),
    }));

    const view = renderPage();

    expect(view.getByRole('button', { name: 'Start Planner' })).toBeInTheDocument();
  });

  it('shows a review exhausted badge for completed steps that hit the review cap', () => {
    const baseItem = makeItem();
    mockUseItem.mockReturnValue(makeUseItemResult({
      item: makeItem({
        workflow: {
          ...baseItem.workflow,
          jobs: [
            {
              repoName: 'repo-a',
              status: 'completed',
              totalSteps: 1,
              completedSteps: 1,
              failedSteps: 0,
              steps: [
                {
                  taskId: 'T1',
                  title: 'Implement workflow',
                  status: 'completed',
                  attempts: 1,
                  reviewRounds: 3,
                  reviewExhausted: true,
                },
              ],
            },
          ],
          overall: {
            totalSteps: 1,
            completedSteps: 1,
            failedSteps: 0,
          },
          currentActivity: undefined,
        },
      }),
    }));

    const view = renderPage();

    expect(view.getByText('review exhausted')).toBeInTheDocument();
    expect(view.queryByText('hooks exhausted')).not.toBeInTheDocument();
  });

  it('shows a hooks exhausted badge for completed steps that exhausted hooks retries', () => {
    const baseItem = makeItem();
    mockUseItem.mockReturnValue(makeUseItemResult({
      item: makeItem({
        workflow: {
          ...baseItem.workflow,
          jobs: [
            {
              repoName: 'repo-a',
              status: 'completed',
              totalSteps: 1,
              completedSteps: 1,
              failedSteps: 0,
              steps: [
                {
                  taskId: 'T1',
                  title: 'Implement workflow',
                  status: 'completed',
                  attempts: 1,
                  hooksExhausted: true,
                },
              ],
            },
          ],
          overall: {
            totalSteps: 1,
            completedSteps: 1,
            failedSteps: 0,
          },
          currentActivity: undefined,
        },
      }),
    }));

    const view = renderPage();

    expect(view.getByText('hooks exhausted')).toBeInTheDocument();
    expect(view.queryByText('review exhausted')).not.toBeInTheDocument();
  });

  it('shows both warning badges when review and hooks both exhaust', () => {
    const baseItem = makeItem();
    mockUseItem.mockReturnValue(makeUseItemResult({
      item: makeItem({
        workflow: {
          ...baseItem.workflow,
          jobs: [
            {
              repoName: 'repo-a',
              status: 'completed',
              totalSteps: 1,
              completedSteps: 1,
              failedSteps: 0,
              steps: [
                {
                  taskId: 'T1',
                  title: 'Implement workflow',
                  status: 'completed',
                  attempts: 1,
                  reviewRounds: 3,
                  reviewExhausted: true,
                  hooksExhausted: true,
                },
              ],
            },
          ],
          overall: {
            totalSteps: 1,
            completedSteps: 1,
            failedSteps: 0,
          },
          currentActivity: undefined,
        },
      }),
    }));

    const view = renderPage();

    expect(view.getByText('review exhausted')).toBeInTheDocument();
    expect(view.getByText('hooks exhausted')).toBeInTheDocument();
  });

  it('does not show a review exhausted badge for normally completed steps', () => {
    const baseItem = makeItem();
    mockUseItem.mockReturnValue(makeUseItemResult({
      item: makeItem({
        workflow: {
          ...baseItem.workflow,
          jobs: [
            {
              repoName: 'repo-a',
              status: 'completed',
              totalSteps: 1,
              completedSteps: 1,
              failedSteps: 0,
              steps: [
                {
                  taskId: 'T1',
                  title: 'Implement workflow',
                  status: 'completed',
                  attempts: 1,
                  reviewRounds: 1,
                },
              ],
            },
          ],
          overall: {
            totalSteps: 1,
            completedSteps: 1,
            failedSteps: 0,
          },
          currentActivity: undefined,
        },
      }),
    }));

    const view = renderPage();

    expect(view.queryByText('review exhausted')).not.toBeInTheDocument();
    expect(view.queryByText('hooks exhausted')).not.toBeInTheDocument();
  });
});
