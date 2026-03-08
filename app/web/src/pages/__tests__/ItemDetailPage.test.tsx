import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
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
const startWorkers = vi.fn();

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
        { id: 'execution' as const, label: 'Execution', status: 'running' as const },
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
    plan: overrides.plan ?? base.plan,
    repos: overrides.repos ?? base.repos,
    workflow: overrides.workflow ?? base.workflow,
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
  const refresh = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    startWorkers.mockReset();
    mockUseItem.mockReturnValue({
      item: makeItem(),
      loading: false,
      error: null,
      refresh,
      startPlanner: vi.fn(),
      startWorkers,
      stopAgent: vi.fn(),
      startReviewReceive: vi.fn(),
      reviewReceiveError: null,
      submitPlanFeedback: vi.fn(),
      planFeedbackSubmitting: false,
      planFeedbackError: null,
    });
    mockUseWebSocket.mockReturnValue({
      isConnected: true,
      lastEvent: null,
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    });
  });

  it('renders workflow strip, current activity, and job cards', () => {
    renderPage();

    expect(screen.getByText('Workflow')).toBeInTheDocument();
    expect(screen.getByText('Current Activity')).toBeInTheDocument();
    expect(screen.getByText('Jobs')).toBeInTheDocument();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(screen.getByText('Execution')).toBeInTheDocument();
    expect(screen.getByText('repo-a: T1: Implement workflow (Hooks)')).toBeInTheDocument();
    expect(screen.getByText('0 / 1 steps')).toBeInTheDocument();
    expect(screen.getAllByText('Hooks').length).toBeGreaterThan(0);
    expect(screen.getByText('PR #1')).toBeInTheDocument();
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

  it('sends retry_failed mode when Retry Failed is clicked', () => {
    mockUseItem.mockReturnValue({
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
      loading: false,
      error: null,
      refresh,
      startPlanner: vi.fn(),
      startWorkers,
      stopAgent: vi.fn(),
      startReviewReceive: vi.fn(),
      reviewReceiveError: null,
      submitPlanFeedback: vi.fn(),
      planFeedbackSubmitting: false,
      planFeedbackError: null,
    });

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Failed (repo-a)' }));

    expect(startWorkers).toHaveBeenCalledWith({ repos: ['repo-a'], mode: 'retry_failed' });
  });

  it('starts workers without retry mode for ready items', () => {
    mockUseItem.mockReturnValue({
      item: makeItem({
        status: 'ready',
        repos: [
          {
            repoName: 'repo-a',
            status: 'ready',
            noChanges: false,
            inCurrentPlan: true,
          },
        ],
      }),
      loading: false,
      error: null,
      refresh,
      startPlanner: vi.fn(),
      startWorkers,
      stopAgent: vi.fn(),
      startReviewReceive: vi.fn(),
      reviewReceiveError: null,
      submitPlanFeedback: vi.fn(),
      planFeedbackSubmitting: false,
      planFeedbackError: null,
    });

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Start Workers' }));

    expect(startWorkers).toHaveBeenCalledWith();
  });
});
