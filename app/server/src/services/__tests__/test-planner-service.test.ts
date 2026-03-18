import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemConfig, Plan, TestPlan } from '@agent-orch/shared';

const files = vi.hoisted(() => new Map<string, string>());
const events = vi.hoisted(() => [] as any[]);
const testPaths = vi.hoisted(() => {
  const workspaceRoot = '/workspace/item-1';
  return {
    workspaceRoot,
    planPath: `${workspaceRoot}/plan.yaml`,
    testPlanPath: `${workspaceRoot}/test-plan.yaml`,
    generatedTestPlanPath: `${workspaceRoot}/.test-planner/test-plan.yaml`,
  };
});

vi.mock('fs', () => ({
  existsSync: vi.fn((path: string) => {
    return (
      path === `${testPaths.workspaceRoot}/repo-a` ||
      path === `${testPaths.workspaceRoot}/repo-b` ||
      files.has(path)
    );
  }),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockImplementation(async (path: string) => {
    files.delete(path);
  }),
  readFile: vi.fn().mockImplementation(async (path: string) => {
    const content = files.get(path);
    if (content == null) {
      throw new Error(`ENOENT: ${path}`);
    }
    return content;
  }),
  rename: vi.fn().mockImplementation(async (from: string, to: string) => {
    const content = files.get(from);
    if (content != null) {
      files.set(to, content);
      files.delete(from);
    }
  }),
  writeFile: vi.fn().mockImplementation(async (path: string, content: string) => {
    files.set(path, content);
  }),
}));

vi.mock('../item-service', () => ({
  getItemConfig: vi.fn(),
}));

vi.mock('../agent-service', () => ({
  getAgentsByItem: vi.fn().mockResolvedValue([]),
  executeAgent: vi.fn(),
}));

vi.mock('../../lib/jsonl', () => ({
  appendJsonl: vi.fn().mockImplementation(async (_path: string, event: any) => {
    events.push(event);
  }),
  readJsonl: vi.fn().mockImplementation(async () => [...events]),
}));

vi.mock('../../lib/paths', () => ({
  getWorkspaceRoot: vi.fn().mockReturnValue(testPaths.workspaceRoot),
  getItemPlanPath: vi.fn().mockReturnValue(testPaths.planPath),
  getItemTestPlanPath: vi.fn().mockReturnValue(testPaths.testPlanPath),
  getItemEventsPath: vi.fn().mockReturnValue('/events.jsonl'),
  getRepoWorkspaceDir: vi.fn(
    (_itemId: string, repoName: string) => `${testPaths.workspaceRoot}/${repoName}`
  ),
}));

vi.mock('../event-bus', () => ({
  eventBus: { emit: vi.fn() },
}));

vi.mock('../../lib/yaml', () => ({
  readYamlSafe: vi.fn().mockImplementation(async (path: string) => {
    const content = files.get(path);
    return content ? JSON.parse(content) : null;
  }),
  parseYaml: vi.fn().mockImplementation((content: string) => JSON.parse(content)),
  stringifyYaml: vi.fn().mockImplementation((value: unknown) => JSON.stringify(value)),
}));

vi.mock('../../lib/events', () => ({
  createTestPlanCreatedEvent: vi.fn().mockImplementation(
    (itemId: string, testPlanPath: string, planFingerprint: string, testPlanFingerprint: string) => ({
      id: `created-${events.length + 1}`,
      type: 'test_plan_created',
      timestamp: new Date().toISOString(),
      itemId,
      testPlanPath,
      planFingerprint,
      testPlanFingerprint,
    })
  ),
  createTestPlanApprovedEvent: vi.fn().mockImplementation(
    (
      itemId: string,
      planFingerprint: string,
      testPlanFingerprint: string,
      approvedBy: 'user' | 'auto'
    ) => ({
      id: `approved-${events.length + 1}`,
      type: 'test_plan_approved',
      timestamp: new Date().toISOString(),
      itemId,
      planFingerprint,
      testPlanFingerprint,
      approvedBy,
    })
  ),
}));

vi.mock('../../lib/role-loader', () => ({
  getRole: vi.fn().mockReturnValue({
    systemPrompt: 'You are a test planner.',
    allowedTools: ['Read', 'Write', 'Skill'],
    jsonSchema: {},
  }),
}));

vi.mock('../task-state-service', () => ({
  createArchiveTag: vi.fn().mockReturnValue('20260316_000000_abc123'),
  createPlanFingerprint: vi.fn().mockImplementation((plan: Plan) => {
    const ids = (plan.tasks || []).map((task) => task.id).join(',');
    return `plan:${ids}`;
  }),
}));

import { executeAgent } from '../agent-service';
import { getItemConfig } from '../item-service';
import {
  approveTestPlan,
  deriveTestPlanApproval,
  startTestPlanner,
} from '../test-planner-service';

const mockExecuteAgent = vi.mocked(executeAgent);
const mockGetItemConfig = vi.mocked(getItemConfig);

function makeConfig(): ItemConfig {
  return {
    id: 'item-1',
    name: 'Item 1',
    description: 'desc',
    repositories: [
      {
        name: 'repo-a',
        type: 'remote',
        rolePrompts: {
          testPlanner: 'Focus on repo-a user flows first.',
        },
      },
      {
        name: 'repo-b',
        type: 'remote',
      },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function writeCurrentPlan(plan: Plan) {
  files.set(testPaths.planPath, JSON.stringify(plan));
}

function makePlan(tasks: Plan['tasks']): Plan {
  return {
    version: '1',
    itemId: 'item-1',
    summary: 'Plan summary',
    createdAt: '2026-01-01T00:00:00Z',
    tasks,
  };
}

function makeGeneratedTestPlan(planFingerprint: string): TestPlan {
  return {
    version: '1.0',
    itemId: 'item-1',
    planFingerprint,
    summary: 'Test plan summary',
    createdAt: '2026-01-01T00:00:00Z',
    scenarios: [
      {
        id: 'S1',
        kind: 'bdd',
        title: 'User can complete the new flow',
        repositories: ['repo-a'],
        given: 'a valid workspace',
        when: 'the user triggers the flow',
        then: 'the change is visible',
      },
    ],
  };
}

describe('test-planner-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    files.clear();
    events.length = 0;
    mockGetItemConfig.mockResolvedValue(makeConfig());
  });

  it('runs the test planner, persists test-plan.yaml, and leaves approval pending', async () => {
    const currentPlan = makePlan([
      {
        id: 'T1',
        title: 'Task 1',
        description: 'desc',
        repository: 'repo-a',
        dependencies: [],
        files: [],
      },
    ]);
    writeCurrentPlan(currentPlan);
    mockExecuteAgent.mockImplementation(async () => {
      files.set(
        testPaths.generatedTestPlanPath,
        JSON.stringify(makeGeneratedTestPlan('plan:T1'))
      );
      return undefined as never;
    });

    await startTestPlanner('item-1');

    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
    expect(mockExecuteAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'item-1',
        role: 'test-planner',
        workingDir: `${testPaths.workspaceRoot}/.test-planner`,
        appendSystemPrompt: 'You are a test planner.',
        addDirs: [`${testPaths.workspaceRoot}/repo-a`, `${testPaths.workspaceRoot}/repo-b`],
        allowedTools: ['Read', 'Write', 'Skill'],
      })
    );
    expect(mockExecuteAgent.mock.calls[0][0].prompt).toContain('Focus on repo-a user flows first.');
    expect(files.has(testPaths.testPlanPath)).toBe(true);
    expect(events.map((event) => event.type)).toEqual(['test_plan_created']);

    const approval = await deriveTestPlanApproval('item-1');
    expect(approval.status).toBe('pending');
    expect(approval.planFingerprint).toBe('plan:T1');
  });

  it('auto-approves an empty plan without calling the agent', async () => {
    writeCurrentPlan(makePlan([]));

    await startTestPlanner('item-1');

    expect(mockExecuteAgent).not.toHaveBeenCalled();
    expect(files.has(testPaths.testPlanPath)).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      'test_plan_created',
      'test_plan_approved',
    ]);

    const approval = await deriveTestPlanApproval('item-1');
    expect(approval.status).toBe('approved');
    expect(approval.approvedBy).toBe('auto');
  });

  it('returns stale when the current test plan fingerprint does not match the live plan', async () => {
    const currentPlan = makePlan([
      {
        id: 'T1',
        title: 'Task 1',
        description: 'desc',
        repository: 'repo-a',
        dependencies: [],
        files: [],
      },
    ]);
    const staleTestPlan = makeGeneratedTestPlan('plan:OLD');

    const approval = await deriveTestPlanApproval('item-1', currentPlan, staleTestPlan);

    expect(approval).toEqual({
      status: 'stale',
      planFingerprint: 'plan:T1',
      testPlanFingerprint: expect.any(String),
    });
  });

  it('records a user approval for the current live test plan', async () => {
    const currentPlan = makePlan([
      {
        id: 'T1',
        title: 'Task 1',
        description: 'desc',
        repository: 'repo-a',
        dependencies: [],
        files: [],
      },
    ]);
    writeCurrentPlan(currentPlan);
    files.set(testPaths.testPlanPath, JSON.stringify(makeGeneratedTestPlan('plan:T1')));
    events.push({
      id: 'created-1',
      type: 'test_plan_created',
      timestamp: '2026-01-01T00:00:00Z',
      itemId: 'item-1',
      testPlanPath: testPaths.testPlanPath,
      planFingerprint: 'plan:T1',
      testPlanFingerprint: 'placeholder',
    });

    const approval = await approveTestPlan('item-1');

    expect(approval.status).toBe('approved');
    expect(approval.approvedBy).toBe('user');
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: 'test_plan_approved',
        approvedBy: 'user',
        planFingerprint: 'plan:T1',
      })
    );
  });
});
