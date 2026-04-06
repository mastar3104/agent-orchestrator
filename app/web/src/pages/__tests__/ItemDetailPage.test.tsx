import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, render, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ItemDetail } from '@agent-orch/shared';
import { ItemDetailPage } from '../ItemDetailPage';

vi.mock('../../hooks/useItems', () => ({
  useItem: vi.fn(),
}));

vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  updateRepoSetup: vi.fn(),
  runRepoSetup: vi.fn(),
  getPlanContent: vi.fn(),
  updatePlan: vi.fn(),
  getTestPlanContent: vi.fn(),
  updateTestPlan: vi.fn(),
}));

import { useItem } from '../../hooks/useItems';
import { useWebSocket } from '../../hooks/useWebSocket';
import * as api from '../../api/client';

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
      verificationPolicy: 'bdd_required',
      verificationRationale: 'Cross-repository behavior needs BDD coverage.',
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

  // Setup Commands UI tests

  it('hides Setup Commands section when all repos are local', () => {
    mockUseItem.mockReturnValue(makeUseItemResult({
      item: makeItem({
        repositories: [
          { name: 'local-repo', type: 'local' as const, localPath: '/tmp/repo' },
        ],
      }),
    }));

    const view = renderPage();

    expect(view.queryByText('Setup Commands')).not.toBeInTheDocument();
  });

  it('renders Setup pending badge and Run Setup button for remote repo with setup commands', () => {
    mockUseItem.mockReturnValue(makeUseItemResult({
      item: makeItem({
        repositories: [
          { name: 'repo-a', type: 'remote' as const, url: 'https://example.com/repo-a.git', setup: ['npm install'] },
        ],
        repos: [
          {
            repoName: 'repo-a',
            status: 'not_started' as const,
            noChanges: false,
            inCurrentPlan: true,
          },
        ],
      }),
    }));

    const view = renderPage();

    expect(view.getByText('Setup Commands')).toBeInTheDocument();
    expect(view.getByText('Setup pending')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Run Setup' })).toBeInTheDocument();
  });

  it('renders No setup commands badge for remote repo without setup', () => {
    mockUseItem.mockReturnValue(makeUseItemResult({
      item: makeItem({
        repositories: [
          { name: 'repo-a', type: 'remote' as const, url: 'https://example.com/repo-a.git' },
        ],
      }),
    }));

    const view = renderPage();

    expect(view.getByText('Setup Commands')).toBeInTheDocument();
    expect(view.getByText('No setup commands')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Run Setup' })).not.toBeInTheDocument();
  });

  it('renders Setup completed badge without run button when repo is in a post-setup phase', () => {
    mockUseItem.mockReturnValue(makeUseItemResult({
      item: makeItem({
        repositories: [
          { name: 'repo-a', type: 'remote' as const, url: 'https://example.com/repo-a.git', setup: ['npm install'] },
        ],
        repos: [
          {
            repoName: 'repo-a',
            status: 'running' as const,
            activePhase: 'engineer' as const,
            noChanges: false,
            inCurrentPlan: true,
          },
        ],
      }),
    }));

    const view = renderPage();

    expect(view.getByText('Setup completed')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Run Setup' })).not.toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Re-run Setup' })).not.toBeInTheDocument();
  });

  it('renders Setup failed badge with Re-run Setup button when status is error', () => {
    mockUseItem.mockReturnValue(makeUseItemResult({
      item: makeItem({
        repositories: [
          { name: 'repo-a', type: 'remote' as const, url: 'https://example.com/repo-a.git', setup: ['npm install'] },
        ],
        repos: [
          {
            repoName: 'repo-a',
            status: 'error' as const,
            noChanges: false,
            inCurrentPlan: true,
          },
        ],
      }),
    }));

    const view = renderPage();

    expect(view.getByText('Setup failed')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Re-run Setup' })).toBeInTheDocument();
  });

  it('calls runRepoSetup when Run Setup is clicked', async () => {
    vi.mocked(api.runRepoSetup).mockResolvedValue({ started: true });
    refresh.mockResolvedValue(undefined);

    mockUseItem.mockReturnValue(makeUseItemResult({
      item: makeItem({
        repositories: [
          { name: 'repo-a', type: 'remote' as const, url: 'https://example.com/repo-a.git', setup: ['npm install'] },
        ],
        repos: [
          {
            repoName: 'repo-a',
            status: 'not_started' as const,
            noChanges: false,
            inCurrentPlan: true,
          },
        ],
      }),
    }));

    const view = renderPage();
    await act(async () => {
      view.getByRole('button', { name: 'Run Setup' }).click();
    });

    expect(api.runRepoSetup).toHaveBeenCalledWith('ITEM-1', 'repo-a');
  });

  it('transitions to Setup running on repo_setup_started event', () => {
    mockUseItem.mockReturnValue(makeUseItemResult({
      item: makeItem({
        repositories: [
          { name: 'repo-a', type: 'remote' as const, url: 'https://example.com/repo-a.git', setup: ['npm install'] },
        ],
        repos: [
          {
            repoName: 'repo-a',
            status: 'running' as const,
            activePhase: 'setup' as const,
            noChanges: false,
            inCurrentPlan: true,
          },
        ],
      }),
    }));

    const view = renderPage();

    const wsOptions = mockUseWebSocket.mock.calls[0][0];
    act(() => {
      wsOptions.onEvent?.({
        id: 'evt-setup-1',
        type: 'repo_setup_started',
        timestamp: '2026-01-01T00:00:00Z',
        itemId: 'ITEM-1',
        repoName: 'repo-a',
      } as any);
    });

    // After repo_setup_started, setupResults map has no entry for repo-a,
    // so status falls through to activePhase='setup' → 'running'
    expect(view.getByText('Setup running')).toBeInTheDocument();
  });

  it('shows Setup completed on repo_setup_completed with allPassed=true', () => {
    mockUseItem.mockReturnValue(makeUseItemResult({
      item: makeItem({
        repositories: [
          { name: 'repo-a', type: 'remote' as const, url: 'https://example.com/repo-a.git', setup: ['npm install'] },
        ],
        repos: [
          {
            repoName: 'repo-a',
            status: 'running' as const,
            activePhase: 'setup' as const,
            noChanges: false,
            inCurrentPlan: true,
          },
        ],
      }),
    }));

    const view = renderPage();

    const wsOptions = mockUseWebSocket.mock.calls[0][0];
    act(() => {
      wsOptions.onEvent?.({
        id: 'evt-setup-2',
        type: 'repo_setup_completed',
        timestamp: '2026-01-01T00:00:00Z',
        itemId: 'ITEM-1',
        repoName: 'repo-a',
        allPassed: true,
      } as any);
    });

    expect(view.getByText('Setup completed')).toBeInTheDocument();
  });

  it('shows Setup failed and Re-run Setup on repo_setup_completed with allPassed=false', () => {
    mockUseItem.mockReturnValue(makeUseItemResult({
      item: makeItem({
        repositories: [
          { name: 'repo-a', type: 'remote' as const, url: 'https://example.com/repo-a.git', setup: ['npm install'] },
        ],
        repos: [
          {
            repoName: 'repo-a',
            status: 'running' as const,
            activePhase: 'setup' as const,
            noChanges: false,
            inCurrentPlan: true,
          },
        ],
      }),
    }));

    const view = renderPage();

    const wsOptions = mockUseWebSocket.mock.calls[0][0];
    act(() => {
      wsOptions.onEvent?.({
        id: 'evt-setup-3',
        type: 'repo_setup_completed',
        timestamp: '2026-01-01T00:00:00Z',
        itemId: 'ITEM-1',
        repoName: 'repo-a',
        allPassed: false,
      } as any);
    });

    expect(view.getByText('Setup failed')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Re-run Setup' })).toBeInTheDocument();
  });

  it('displays current setup commands in non-editing mode', () => {
    mockUseItem.mockReturnValue(makeUseItemResult({
      item: makeItem({
        repositories: [
          { name: 'repo-a', type: 'remote' as const, url: 'https://example.com/repo-a.git', setup: ['npm install', 'npm run build'] },
        ],
        repos: [
          {
            repoName: 'repo-a',
            status: 'not_started' as const,
            noChanges: false,
            inCurrentPlan: true,
          },
        ],
      }),
    }));

    const view = renderPage();

    expect(view.getByText('npm install')).toBeInTheDocument();
    expect(view.getByText('npm run build')).toBeInTheDocument();
  });

  it('saves edited setup commands via updateRepoSetup and closes editor', async () => {
    vi.mocked(api.updateRepoSetup).mockResolvedValue(undefined as any);
    refresh.mockResolvedValue(undefined);

    mockUseItem.mockReturnValue(makeUseItemResult({
      item: makeItem({
        repositories: [
          { name: 'repo-a', type: 'remote' as const, url: 'https://example.com/repo-a.git', setup: ['npm install'] },
        ],
        repos: [
          {
            repoName: 'repo-a',
            status: 'not_started' as const,
            noChanges: false,
            inCurrentPlan: true,
          },
        ],
      }),
    }));

    const view = renderPage();

    // Click Edit to open the editor
    fireEvent.click(view.getByRole('button', { name: 'Edit' }));

    // Textarea should appear pre-filled with existing commands
    const textarea = view.getByPlaceholderText('One command per line...');
    expect(textarea).toBeInTheDocument();
    expect((textarea as HTMLTextAreaElement).value).toBe('npm install');

    // Change the content
    fireEvent.change(textarea, { target: { value: 'npm ci\nnpm run build' } });

    // Click Save
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Save' }));
    });

    expect(api.updateRepoSetup).toHaveBeenCalledWith('ITEM-1', 'repo-a', ['npm ci', 'npm run build']);
    // Editor should be closed (textarea gone)
    expect(view.queryByPlaceholderText('One command per line...')).not.toBeInTheDocument();
  });

  it('displays error message when runRepoSetup fails', async () => {
    vi.mocked(api.runRepoSetup).mockRejectedValue(new Error('Setup execution failed'));

    mockUseItem.mockReturnValue(makeUseItemResult({
      item: makeItem({
        repositories: [
          { name: 'repo-a', type: 'remote' as const, url: 'https://example.com/repo-a.git', setup: ['npm install'] },
        ],
        repos: [
          {
            repoName: 'repo-a',
            status: 'not_started' as const,
            noChanges: false,
            inCurrentPlan: true,
          },
        ],
      }),
    }));

    const view = renderPage();

    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Run Setup' }));
    });

    expect(view.getByText('Setup execution failed')).toBeInTheDocument();
  });

  it('displays error message when updateRepoSetup fails', async () => {
    vi.mocked(api.updateRepoSetup).mockRejectedValue(new Error('Save failed'));

    mockUseItem.mockReturnValue(makeUseItemResult({
      item: makeItem({
        repositories: [
          { name: 'repo-a', type: 'remote' as const, url: 'https://example.com/repo-a.git', setup: ['npm install'] },
        ],
        repos: [
          {
            repoName: 'repo-a',
            status: 'not_started' as const,
            noChanges: false,
            inCurrentPlan: true,
          },
        ],
      }),
    }));

    const view = renderPage();

    fireEvent.click(view.getByRole('button', { name: 'Edit' }));

    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Save' }));
    });

    expect(view.getByText('Save failed')).toBeInTheDocument();
  });
});
