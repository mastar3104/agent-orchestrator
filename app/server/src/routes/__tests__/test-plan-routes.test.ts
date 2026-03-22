import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { agentRoutes } from '../agents';

vi.mock('../../services/agent-service', () => ({
  stopAgent: vi.fn(),
  getAgent: vi.fn(),
  getAgentsByItem: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../services/planner-service', () => ({
  startPlanner: vi.fn().mockResolvedValue(undefined),
  getPlan: vi.fn().mockResolvedValue(null),
  getPlanContent: vi.fn().mockResolvedValue(null),
  updatePlanContent: vi.fn().mockResolvedValue({
    plan: { version: '1', itemId: 'item-1', summary: 'Plan', createdAt: '2026-01-01T00:00:00Z', tasks: [] },
    content: 'version: "1"',
  }),
  planFeedback: vi.fn().mockResolvedValue(undefined),
  validatePlanFeedback: vi.fn().mockReturnValue([]),
}));

vi.mock('../../services/test-planner-service', () => ({
  startTestPlanner: vi.fn().mockResolvedValue(undefined),
  getTestPlan: vi.fn(),
  getTestPlanContent: vi.fn(),
  updateTestPlanContent: vi.fn(),
  validateTestPlanFeedback: vi.fn().mockReturnValue([]),
  testPlanFeedback: vi.fn().mockResolvedValue(undefined),
  approveTestPlan: vi.fn(),
  deriveTestPlanApproval: vi.fn(),
}));

vi.mock('../../services/worker-service', () => ({
  startWorkers: vi.fn().mockResolvedValue(undefined),
  getWorkerStatus: vi.fn().mockResolvedValue([]),
  validateWorkerStartPreconditions: vi.fn().mockResolvedValue(undefined),
  WorkerStartValidationError: class WorkerStartValidationError extends Error {},
}));

vi.mock('../../services/git-snapshot-service', () => ({
  stopAllGitSnapshots: vi.fn(),
}));

const mockIsItemLocked = vi.fn().mockReturnValue(false);
const mockWithItemLock = vi.fn().mockImplementation(async (_id: string, fn: () => Promise<any>) => {
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
  getItemPlanPath: vi.fn().mockReturnValue('/workspace/plan.yaml'),
  getItemEventsPath: vi.fn().mockReturnValue('/events.jsonl'),
}));

vi.mock('../../services/event-bus', () => ({
  eventBus: { emit: vi.fn() },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('version: "1"'),
}));

vi.mock('../../lib/yaml', () => ({
  parseYaml: vi.fn().mockReturnValue({
    version: '1',
    itemId: 'item-1',
    tasks: [{ id: 'task-1', title: 'Task 1', repository: 'repo-a' }],
  }),
}));

import {
  startWorkers,
  validateWorkerStartPreconditions,
  WorkerStartValidationError,
} from '../../services/worker-service';
import {
  approveTestPlan,
  deriveTestPlanApproval,
  getTestPlan,
  startTestPlanner,
  testPlanFeedback,
  updateTestPlanContent,
} from '../../services/test-planner-service';
import { updatePlanContent } from '../../services/planner-service';

const mockStartWorkers = vi.mocked(startWorkers);
const mockStartTestPlanner = vi.mocked(startTestPlanner);
const mockGetTestPlan = vi.mocked(getTestPlan);
const mockUpdateTestPlanContent = vi.mocked(updateTestPlanContent);
const mockTestPlanFeedback = vi.mocked(testPlanFeedback);
const mockApproveTestPlan = vi.mocked(approveTestPlan);
const mockDeriveTestPlanApproval = vi.mocked(deriveTestPlanApproval);
const mockUpdatePlanContent = vi.mocked(updatePlanContent);
const mockValidateWorkerStartPreconditions = vi.mocked(validateWorkerStartPreconditions);

function buildApp() {
  const app = Fastify();
  app.register(agentRoutes, { prefix: '/api' });
  return app;
}

describe('test plan routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsItemLocked.mockReturnValue(false);
    mockWithItemLock.mockImplementation(async (_id: string, fn: () => Promise<any>) => fn());
    mockGetTestPlan.mockResolvedValue({
      version: '1.0',
      itemId: 'item-1',
      planFingerprint: 'plan:T1',
      summary: 'Test plan',
      verificationPolicy: 'bdd_required',
      verificationRationale: 'Cross-repository behavior needs BDD coverage.',
      createdAt: '2026-01-01T00:00:00Z',
      scenarios: [
        {
          id: 'S1',
          kind: 'bdd',
          title: 'Scenario',
          repositories: ['repo-a'],
          given: 'given',
          when: 'when',
          then: 'then',
        },
      ],
    });
    mockUpdateTestPlanContent.mockResolvedValue({
      testPlan: {
        version: '1.0',
        itemId: 'item-1',
        planFingerprint: 'plan:T1',
        summary: 'Updated',
        verificationPolicy: 'none',
        verificationRationale: 'No behavior-level validation is required.',
        createdAt: '2026-01-01T00:00:00Z',
        scenarios: [],
      },
      content: 'version: "1.0"',
      approval: { status: 'pending', planFingerprint: 'plan:T1', testPlanFingerprint: 'tp-1' },
    });
    mockApproveTestPlan.mockResolvedValue({
      status: 'approved',
      planFingerprint: 'plan:T1',
      testPlanFingerprint: 'tp-1',
      approvedAt: '2026-01-01T00:00:00Z',
      approvedBy: 'user',
    });
    mockDeriveTestPlanApproval.mockResolvedValue({
      status: 'approved',
      planFingerprint: 'plan:T1',
      testPlanFingerprint: 'tp-1',
      approvedAt: '2026-01-01T00:00:00Z',
      approvedBy: 'user',
    });
  });

  it('starts the test planner asynchronously', async () => {
    const app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/test-planner/start',
    });

    expect(res.statusCode).toBe(202);
    expect(mockStartTestPlanner).toHaveBeenCalledWith('item-1');
  });

  it('triggers background test planning after manual plan updates', async () => {
    const app = buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/items/item-1/plan',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ content: 'version: "1"' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.statusCode).toBe(200);
    expect(mockUpdatePlanContent).toHaveBeenCalledWith('item-1', 'version: "1"');
    expect(mockStartTestPlanner).toHaveBeenCalledWith('item-1');
  });

  it('rejects duplicate scenario ids in test-plan feedback', async () => {
    const app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/test-plan/feedback',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        feedbacks: [
          { scenarioId: 'S1', feedback: 'a' },
          { scenarioId: 'S1', feedback: 'b' },
        ],
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Duplicate scenarioId');
    expect(mockTestPlanFeedback).not.toHaveBeenCalled();
  });

  it('approves the current test plan', async () => {
    const app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/test-plan/approve',
    });

    expect(res.statusCode).toBe(200);
    expect(mockApproveTestPlan).toHaveBeenCalledWith('item-1');
    expect(res.json().data.approval.status).toBe('approved');
  });

  it('rejects worker start when test plan approval is pending', async () => {
    mockDeriveTestPlanApproval.mockResolvedValueOnce({
      status: 'pending',
      planFingerprint: 'plan:T1',
      testPlanFingerprint: 'tp-1',
    });
    const app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/workers/start',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Test plan approval is required');
    expect(mockValidateWorkerStartPreconditions).not.toHaveBeenCalled();
    expect(mockStartWorkers).not.toHaveBeenCalled();
  });

  it('starts workers asynchronously when worker preconditions pass', async () => {
    const app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/workers/start',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ repos: ['repo-b'], mode: 'retry_failed' }),
    });

    expect(res.statusCode).toBe(202);
    expect(mockValidateWorkerStartPreconditions).toHaveBeenCalledWith('item-1', {
      targetRepos: ['repo-b'],
      mode: 'retry_failed',
    });
    expect(mockStartWorkers).toHaveBeenCalledWith('item-1', {
      targetRepos: ['repo-b'],
      mode: 'retry_failed',
    });
  });

  it('rejects worker start when no actionable worker tasks remain', async () => {
    mockValidateWorkerStartPreconditions.mockRejectedValueOnce(
      new WorkerStartValidationError('No retryable failed tasks remain for item item-1: task-3')
    );
    const app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/workers/start',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ repos: ['repo-b'], mode: 'retry_failed' }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('No retryable failed tasks remain');
    expect(mockStartWorkers).not.toHaveBeenCalled();
  });
});
