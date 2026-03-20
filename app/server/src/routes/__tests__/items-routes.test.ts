import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { itemRoutes } from '../items';

vi.mock('../../services/item-service', () => ({
  createItem: vi.fn(),
  setupWorkspace: vi.fn(),
  listItems: vi.fn().mockResolvedValue([]),
  getItemDetail: vi.fn().mockResolvedValue(null),
  updateItem: vi.fn().mockResolvedValue(null),
  deleteItem: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../services/git-pr-service', () => ({
  createDraftPrsForAllRepos: vi.fn(),
}));

vi.mock('../../services/completed-review-service', () => ({
  ensureCompletedReviewPassed: vi.fn(),
}));

vi.mock('../../services/review-receive-service', () => ({
  startReviewReceive: vi.fn(),
  validateReviewReceivePreConditions: vi.fn(),
  ReviewReceiveValidationError: class ReviewReceiveValidationError extends Error {},
}));

vi.mock('../../lib/locks', () => ({
  withItemLock: vi.fn(async (_id: string, fn: () => Promise<any>) => fn()),
  isItemLocked: vi.fn().mockReturnValue(false),
}));

import { ensureCompletedReviewPassed } from '../../services/completed-review-service';
import { createDraftPrsForAllRepos } from '../../services/git-pr-service';

const mockEnsureCompletedReviewPassed = vi.mocked(ensureCompletedReviewPassed);
const mockCreateDraftPrsForAllRepos = vi.mocked(createDraftPrsForAllRepos);

function buildApp() {
  const app = Fastify();
  app.register(itemRoutes, { prefix: '/api' });
  return app;
}

describe('item routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureCompletedReviewPassed.mockResolvedValue({
      status: 'passed',
      summary: 'All good',
      round: 1,
      findings: [],
    });
    mockCreateDraftPrsForAllRepos.mockResolvedValue({
      results: [
        {
          repoName: 'repo-a',
          prUrl: 'https://github.com/example/repo-a/pull/1',
          prNumber: 1,
          noChanges: false,
        },
      ],
    });
  });

  it('rejects publish before completed review passes', async () => {
    mockEnsureCompletedReviewPassed.mockRejectedValue(
      new Error('Completed review must pass before publish (current status: needs_fixes)')
    );
    const app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/create-pr',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      success: false,
      error: 'Completed review must pass before publish (current status: needs_fixes)',
    });
    expect(mockCreateDraftPrsForAllRepos).not.toHaveBeenCalled();
  });

  it('creates draft PRs after completed review passes', async () => {
    const app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/create-pr',
    });

    expect(res.statusCode).toBe(200);
    expect(mockEnsureCompletedReviewPassed).toHaveBeenCalledWith('item-1');
    expect(mockCreateDraftPrsForAllRepos).toHaveBeenCalledWith('item-1');
    expect(res.json()).toEqual({
      success: true,
      data: {
        results: [
          {
            repoName: 'repo-a',
            prUrl: 'https://github.com/example/repo-a/pull/1',
            prNumber: 1,
            noChanges: false,
          },
        ],
      },
    });
  });
});
