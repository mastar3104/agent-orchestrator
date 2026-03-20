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
  updatePlanContent: vi.fn(),
  planFeedback: vi.fn().mockResolvedValue(undefined),
  validatePlanFeedback: vi.fn().mockReturnValue([]),
}));

vi.mock('../../services/test-planner-service', () => ({
  startTestPlanner: vi.fn().mockResolvedValue(undefined),
  getTestPlan: vi.fn().mockResolvedValue(null),
  getTestPlanContent: vi.fn().mockResolvedValue(null),
  updateTestPlanContent: vi.fn(),
  validateTestPlanFeedback: vi.fn().mockReturnValue([]),
  testPlanFeedback: vi.fn().mockResolvedValue(undefined),
  approveTestPlan: vi.fn(),
  deriveTestPlanApproval: vi.fn(),
}));

vi.mock('../../services/completed-review-service', () => ({
  startCompletedReview: vi.fn().mockResolvedValue(undefined),
  getLatestCompletedReview: vi.fn(),
}));

vi.mock('../../services/worker-service', () => ({
  startWorkers: vi.fn().mockResolvedValue(undefined),
  getWorkerStatus: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../services/git-snapshot-service', () => ({
  stopAllGitSnapshots: vi.fn(),
}));

const mockIsItemLocked = vi.fn().mockReturnValue(false);
const mockWithItemLock = vi.fn().mockImplementation(async (_id: string, fn: () => Promise<any>) => fn());

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

import { getLatestCompletedReview, startCompletedReview } from '../../services/completed-review-service';

const mockGetLatestCompletedReview = vi.mocked(getLatestCompletedReview);
const mockStartCompletedReview = vi.mocked(startCompletedReview);

function buildApp() {
  const app = Fastify();
  app.register(agentRoutes, { prefix: '/api' });
  return app;
}

describe('completed review routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsItemLocked.mockReturnValue(false);
    mockWithItemLock.mockImplementation(async (_id: string, fn: () => Promise<any>) => fn());
    mockGetLatestCompletedReview.mockResolvedValue({
      status: 'needs_fixes',
      summary: 'One gap remains.',
      round: 1,
      findings: [
        {
          id: 'F1',
          scenarioId: 'S1',
          targetRepository: 'repo-a',
          relatedRepositories: [],
          severity: 'major',
          summary: 'Repo-a gap',
          details: 'details',
          suggestedFix: 'fix it',
        },
      ],
    });
    mockStartCompletedReview.mockResolvedValue(undefined);
  });

  it('starts completed review asynchronously', async () => {
    const app = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/items/item-1/completed-review/start',
    });

    expect(res.statusCode).toBe(202);
    expect(mockStartCompletedReview).toHaveBeenCalledWith('item-1');
  });

  it('returns the latest completed review result', async () => {
    const app = buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/items/item-1/completed-review',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: {
        completedReview: {
          status: 'needs_fixes',
          summary: 'One gap remains.',
          round: 1,
          findings: [
            {
              id: 'F1',
              scenarioId: 'S1',
              targetRepository: 'repo-a',
              relatedRepositories: [],
              severity: 'major',
              summary: 'Repo-a gap',
              details: 'details',
              suggestedFix: 'fix it',
            },
          ],
        },
      },
    });
  });
});
