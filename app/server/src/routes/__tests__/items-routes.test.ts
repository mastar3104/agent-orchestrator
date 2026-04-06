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

import { createItem } from '../../services/item-service';
import { ensureCompletedReviewPassed } from '../../services/completed-review-service';
import { createDraftPrsForAllRepos } from '../../services/git-pr-service';

const mockCreateItem = vi.mocked(createItem);
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

  it('returns 400 when setup is provided for a local repository in POST /items', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/items',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Item',
        description: 'desc',
        repositories: [
          {
            name: 'repo-a',
            repository: {
              type: 'local',
              localPath: '/tmp/repo-a',
              setup: ['npm install'],
            },
          },
        ],
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('setup is only supported for remote repositories');
    expect(mockCreateItem).not.toHaveBeenCalled();
  });

  it('returns 400 when setup is a string instead of an array in POST /items', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/items',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Item',
        description: 'desc',
        repositories: [
          {
            name: 'repo-a',
            repository: {
              type: 'remote',
              url: 'https://github.com/test/repo.git',
              setup: 'npm install',
            },
          },
        ],
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('setup must be an array');
    expect(mockCreateItem).not.toHaveBeenCalled();
  });

  it('returns 400 when setup contains non-string entries in POST /items', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/items',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Item',
        description: 'desc',
        repositories: [
          {
            name: 'repo-a',
            repository: {
              type: 'remote',
              url: 'https://github.com/test/repo.git',
              setup: ['npm install', 123],
            },
          },
        ],
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Each setup command must be a non-empty string');
    expect(mockCreateItem).not.toHaveBeenCalled();
  });

  it('returns type-check error before format error for local repo with non-array setup', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/items',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Item',
        description: 'desc',
        repositories: [
          {
            name: 'repo-a',
            repository: {
              type: 'local',
              localPath: '/tmp/repo-a',
              setup: 'not-an-array',
            },
          },
        ],
      }),
    });

    expect(res.statusCode).toBe(400);
    // Type check comes first — user learns the feature is unsupported before format errors
    expect(res.json().error).toBe('setup is only supported for remote repositories');
    expect(mockCreateItem).not.toHaveBeenCalled();
  });

  it('returns 400 for second repo with invalid setup when first repo is valid', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/items',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Item',
        description: 'desc',
        repositories: [
          {
            name: 'repo-a',
            repository: {
              type: 'remote',
              url: 'https://github.com/test/repo-a.git',
              setup: ['npm install'],
            },
          },
          {
            name: 'repo-b',
            repository: {
              type: 'remote',
              url: 'https://github.com/test/repo-b.git',
              setup: 'bad',
            },
          },
        ],
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('setup must be an array');
    expect(mockCreateItem).not.toHaveBeenCalled();
  });

  it('normalizes setup to empty array when all entries are blank', async () => {
    mockCreateItem.mockResolvedValue({
      id: 'ITEM-test',
      name: 'Item',
      description: 'desc',
      repositories: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/items',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Item',
        description: 'desc',
        repositories: [
          {
            name: 'repo-a',
            repository: {
              type: 'remote',
              url: 'https://github.com/test/repo.git',
              setup: ['  ', ''],
            },
          },
        ],
      }),
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreateItem).toHaveBeenCalledWith(
      expect.objectContaining({
        repositories: [
          expect.objectContaining({
            repository: expect.objectContaining({
              setup: [],
            }),
          }),
        ],
      }),
    );
  });

  it('creates item with remote repo when setup is omitted', async () => {
    mockCreateItem.mockResolvedValue({
      id: 'ITEM-test',
      name: 'Item',
      description: 'desc',
      repositories: [
        {
          name: 'repo-a',
          type: 'remote',
          url: 'https://github.com/test/repo.git',
          workBranch: 'work/ITEM-test/repo-a',
        },
      ],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/items',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Item',
        description: 'desc',
        repositories: [
          {
            name: 'repo-a',
            repository: {
              type: 'remote',
              url: 'https://github.com/test/repo.git',
            },
          },
        ],
      }),
    });

    expect(res.statusCode).toBe(201);
    const callArg = mockCreateItem.mock.calls[0][0];
    expect(callArg.repositories[0].repository).not.toHaveProperty('setup');
  });

  it('normalizes setup commands and passes them through to createItem', async () => {
    mockCreateItem.mockResolvedValue({
      id: 'ITEM-test',
      name: 'Item',
      description: 'desc',
      repositories: [
        {
          name: 'repo-a',
          type: 'remote',
          url: 'https://github.com/test/repo.git',
          workBranch: 'work/ITEM-test/repo-a',
          setup: ['npm install', 'npm run build'],
        },
      ],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/items',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Item',
        description: 'desc',
        repositories: [
          {
            name: 'repo-a',
            repository: {
              type: 'remote',
              url: 'https://github.com/test/repo.git',
              setup: ['  npm install  ', '   ', 'npm run build'],
            },
          },
        ],
      }),
    });

    expect(res.statusCode).toBe(201);
    // Verify normalized setup was passed to createItem (trimmed, blanks removed)
    expect(mockCreateItem).toHaveBeenCalledWith(
      expect.objectContaining({
        repositories: [
          expect.objectContaining({
            repository: expect.objectContaining({
              setup: ['npm install', 'npm run build'],
            }),
          }),
        ],
      })
    );
  });

  it('rejects publish before completed review passes', async () => {
    mockEnsureCompletedReviewPassed.mockRejectedValue(
      new Error('Completed review must be satisfied before publish (current status: needs_fixes)')
    );
    const app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/create-pr',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      success: false,
      error: 'Completed review must be satisfied before publish (current status: needs_fixes)',
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
