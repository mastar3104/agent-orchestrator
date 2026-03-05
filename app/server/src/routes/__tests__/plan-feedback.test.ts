import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { agentRoutes } from '../agents';

// ─── Mocks ───

vi.mock('../../services/agent-service', () => ({
  stopAgent: vi.fn(),
  getAgent: vi.fn(),
  getAgentsByItem: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../services/planner-service', () => ({
  startPlanner: vi.fn().mockResolvedValue(undefined),
  getPlan: vi.fn(),
  getPlanContent: vi.fn(),
  updatePlanContent: vi.fn(),
  planFeedback: vi.fn().mockResolvedValue(undefined),
  validatePlanFeedback: vi.fn().mockReturnValue([]),
}));

vi.mock('../../services/worker-service', () => ({
  startWorkers: vi.fn(),
  startWorkerForRepo: vi.fn(),
  getWorkerStatus: vi.fn(),
}));

vi.mock('../../services/git-snapshot-service', () => ({
  stopAllGitSnapshots: vi.fn(),
}));

const mockIsItemLocked = vi.fn().mockReturnValue(false);
const mockWithItemLock = vi.fn().mockImplementation((_id: string, fn: () => Promise<any>) => {
  return fn();
});

vi.mock('../../lib/locks', () => ({
  isItemLocked: (...args: any[]) => mockIsItemLocked(...args),
  withItemLock: (...args: any[]) => mockWithItemLock(...args),
}));

vi.mock('../../lib/events', () => ({
  createErrorEvent: vi.fn().mockReturnValue({ type: 'error', id: 'err-1' }),
}));

vi.mock('../../lib/jsonl', () => ({
  appendJsonl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/paths', () => ({
  getWorkspaceRoot: vi.fn().mockReturnValue('/workspace'),
  getAgentOutputPath: vi.fn().mockReturnValue('/output.json'),
  getItemPlanPath: vi.fn().mockReturnValue('/tmp/test-plan.yaml'),
  getItemEventsPath: vi.fn().mockReturnValue('/events.jsonl'),
}));

vi.mock('../../services/event-bus', () => ({
  eventBus: { emit: vi.fn() },
}));

const mockExistsSync = vi.fn().mockReturnValue(true);
vi.mock('fs', () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
}));

const mockReadFile = vi.fn();
vi.mock('fs/promises', () => ({
  readFile: (...args: any[]) => mockReadFile(...args),
}));

vi.mock('../../lib/yaml', () => ({
  parseYaml: vi.fn().mockReturnValue({
    version: '1',
    itemId: 'item-1',
    tasks: [
      { id: 'task-1', title: 'Task 1', agent: 'engineer', repository: 'repo' },
      { id: 'task-2', title: 'Task 2', agent: 'engineer', repository: 'repo' },
    ],
  }),
}));

import { planFeedback, validatePlanFeedback } from '../../services/planner-service';
import { createErrorEvent } from '../../lib/events';
import { appendJsonl } from '../../lib/jsonl';
import { eventBus } from '../../services/event-bus';

function buildApp() {
  const app = Fastify();
  app.register(agentRoutes, { prefix: '/api' });
  return app;
}

const VALID_BODY = {
  feedbacks: [
    { taskId: 'task-1', feedback: 'Fix the bug' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIsItemLocked.mockReturnValue(false);
  mockExistsSync.mockReturnValue(true);
  mockReadFile.mockResolvedValue('version: "1"\ntasks: []');
  vi.mocked(validatePlanFeedback).mockReturnValue([]);
  vi.mocked(planFeedback).mockResolvedValue(undefined);
});

describe('POST /api/items/:id/plan/feedback', () => {
  it('returns 409 when item is locked', async () => {
    mockIsItemLocked.mockReturnValue(true);
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/plan/feedback',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.success).toBe(false);
  });

  it('returns 400 when feedbacks is undefined', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/plan/feedback',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('feedbacks must be an array');
  });

  it('returns 400 when feedbacks is not an array', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/plan/feedback',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ feedbacks: 'not-array' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('feedbacks must be an array');
  });

  it('returns 400 when feedbacks is empty array', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/plan/feedback',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ feedbacks: [] }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('empty');
  });

  it('returns 400 when element has wrong types', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/plan/feedback',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ feedbacks: [{ taskId: 123, feedback: 'fix' }] }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('string taskId and feedback');
  });

  it('returns 400 when taskId is empty string', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/plan/feedback',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ feedbacks: [{ taskId: '', feedback: 'fix' }] }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('taskId must not be empty');
  });

  it('returns 400 when taskId is whitespace only', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/plan/feedback',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ feedbacks: [{ taskId: '   ', feedback: 'fix' }] }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('taskId must not be empty');
  });

  it('returns 400 when feedback is whitespace only', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/plan/feedback',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ feedbacks: [{ taskId: 'task-1', feedback: '   ' }] }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('feedback must not be empty');
  });

  it('returns 400 for duplicate taskIds', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/plan/feedback',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        feedbacks: [
          { taskId: 'task-1', feedback: 'a' },
          { taskId: 'task-1', feedback: 'b' },
        ],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Duplicate');
  });

  it('returns 400 when plan.yaml does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/plan/feedback',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('No plan exists yet');
  });

  it('returns 400 when taskId does not exist in plan', async () => {
    vi.mocked(validatePlanFeedback).mockReturnValue(['taskId not found in plan: nonexistent']);
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/plan/feedback',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ feedbacks: [{ taskId: 'nonexistent', feedback: 'fix' }] }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('not found');
  });

  it('returns 202 for valid feedbacks', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/plan/feedback',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.started).toBe(true);
  });

  it('logs error event when planFeedback fails after 202', async () => {
    vi.mocked(planFeedback).mockRejectedValue(new Error('Agent failed'));
    // withItemLock will call the function and the promise will reject
    // We need to wait for the catch handler
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/plan/feedback',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(VALID_BODY),
    });
    expect(res.statusCode).toBe(202);

    // Wait for the async error handler
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(createErrorEvent).toHaveBeenCalledWith('item-1', 'Agent failed');
    expect(appendJsonl).toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith('event', expect.objectContaining({
      itemId: 'item-1',
    }));
  });
});
