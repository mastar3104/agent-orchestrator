import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ItemEvent } from '@agent-orch/shared';

vi.mock('../../lib/jsonl', () => ({
  readJsonl: vi.fn(),
}));

vi.mock('../../lib/paths', () => ({
  getItemEventsPath: vi.fn().mockReturnValue('/events.jsonl'),
  getAgentEventsPath: vi.fn().mockReturnValue('/agent-events.jsonl'),
  getItemPlanPath: vi.fn().mockReturnValue('/workspace/plan.yaml'),
  getWorkspaceRoot: vi.fn().mockReturnValue('/workspace'),
}));

vi.mock('../../lib/yaml', () => ({
  readYamlSafe: vi.fn().mockResolvedValue(null),
}));

vi.mock('../task-state-service', () => ({
  readRepoTaskState: vi.fn().mockResolvedValue(null),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock('fs/promises', () => ({
  readdir: vi.fn().mockResolvedValue([]),
}));

import { deriveItemStatus, deriveRepoStatuses } from '../state-service';
import { readJsonl } from '../../lib/jsonl';
import { readYamlSafe } from '../../lib/yaml';
import { readRepoTaskState } from '../task-state-service';

const mockReadJsonl = vi.mocked(readJsonl);
const mockReadYamlSafe = vi.mocked(readYamlSafe);
const mockReadRepoTaskState = vi.mocked(readRepoTaskState);

function makeEvent(type: string, extra: Record<string, unknown> = {}): ItemEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    type: type as ItemEvent['type'],
    timestamp: new Date().toISOString(),
    itemId: 'item-1',
    ...extra,
  } as ItemEvent;
}

function setPlanRepos(repos: string[]) {
  mockReadYamlSafe.mockResolvedValue({
    summary: 'test',
    tasks: repos.map(r => ({ id: `T-${r}`, title: 'test', description: 'test', repository: r })),
  } as any);
}

function makeTaskState(
  repoName: string,
  tasks: Array<Record<string, unknown>>
) {
  return {
    version: '1',
    itemId: 'item-1',
    repository: repoName,
    planFingerprint: 'fingerprint',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    tasks,
  } as any;
}

describe('deriveItemStatus - basic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadYamlSafe.mockResolvedValue(null);
    mockReadRepoTaskState.mockReset();
    mockReadRepoTaskState.mockResolvedValue(null);
  });

  it('returns created for no events', async () => {
    mockReadJsonl.mockResolvedValue([]);
    expect(await deriveItemStatus('item-1')).toBe('created');
  });
});

describe('deriveItemStatus - error check after running check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadYamlSafe.mockResolvedValue(null);
    mockReadRepoTaskState.mockReset();
    mockReadRepoTaskState.mockResolvedValue(null);
  });

  it('returns running when agent errored but retry is running', async () => {
    setPlanRepos(['repoA']);
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'repoA' }),
      makeEvent('error', { agentId: 'A', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 1 }),
      makeEvent('agent_started', { agentId: 'B', role: 'engineer', repoName: 'repoA' }),
    ]);

    expect(await deriveItemStatus('item-1')).toBe('running');
  });

  it('returns review_receiving when review is in progress', async () => {
    setPlanRepos(['repoA']);
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 0 }),
      makeEvent('pr_created', { repoName: 'repoA', prUrl: 'http://pr', prNumber: 1 }),
      makeEvent('review_receive_started', { agentId: 'C', repoName: 'repoA', prNumber: 1, prUrl: 'http://pr' }),
      makeEvent('agent_started', { agentId: 'C', role: 'review-receiver', repoName: 'repoA' }),
    ]);

    expect(await deriveItemStatus('item-1')).toBe('review_receiving');
  });

  it('returns error when all retries failed and all agents stopped', async () => {
    setPlanRepos(['repoA']);
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'repoA' }),
      makeEvent('error', { agentId: 'A', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 1 }),
      makeEvent('agent_started', { agentId: 'B', role: 'engineer', repoName: 'repoA' }),
      makeEvent('error', { agentId: 'B', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'B', exitCode: 1 }),
    ]);

    expect(await deriveItemStatus('item-1')).toBe('error');
  });

  it('returns running when item-level error occurred but new agent is running', async () => {
    setPlanRepos(['repoA']);
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 1 }),
      makeEvent('error', { message: 'Something failed' }), // item-level error, no agentId
      makeEvent('agent_started', { agentId: 'C', role: 'engineer', repoName: 'repoA' }),
    ]);

    expect(await deriveItemStatus('item-1')).toBe('running');
  });

  it('returns error when item-level error occurred and all agents stopped', async () => {
    setPlanRepos(['repoA']);
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 1 }),
      makeEvent('error', { message: 'Something failed' }), // item-level error, no agentId
    ]);

    expect(await deriveItemStatus('item-1')).toBe('error');
  });

  it('returns completed when error exists but PR created', async () => {
    setPlanRepos(['repoA']);
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'repoA' }),
      makeEvent('error', { agentId: 'A', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 1 }),
      makeEvent('agent_started', { agentId: 'B', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'B', exitCode: 0 }),
      makeEvent('pr_created', { repoName: 'repoA', prUrl: 'http://pr', prNumber: 1 }),
    ]);

    expect(await deriveItemStatus('item-1')).toBe('completed');
  });

  it('returns error when error exists and PR created but item-level error after PR', async () => {
    setPlanRepos(['repoA']);
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 0 }),
      makeEvent('pr_created', { repoName: 'repoA', prUrl: 'http://pr', prNumber: 1 }),
      makeEvent('error', { message: 'Post-PR error' }), // item-level error after PR
    ]);

    expect(await deriveItemStatus('item-1')).toBe('error');
  });
});

describe('deriveRepoStatuses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadYamlSafe.mockResolvedValue(null);
  });

  it('hooks failure → retry success → PR created → repo=completed', async () => {
    setPlanRepos(['repoA']);
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 0 }),
      makeEvent('hooks_executed', { repoName: 'repoA', allPassed: false, attempt: 1, results: [] }),
      makeEvent('error', { repoName: 'repoA', phase: 'hooks', message: 'Hooks validation failed for repoA after 2 attempts' }),
      // Retry with new agent
      makeEvent('agent_started', { agentId: 'B', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'B', exitCode: 0 }),
      makeEvent('hooks_executed', { repoName: 'repoA', allPassed: true, attempt: 1, results: [] }),
      makeEvent('pr_created', { repoName: 'repoA', prUrl: 'http://pr', prNumber: 1 }),
    ]);

    const statuses = await deriveRepoStatuses('item-1');
    expect(statuses.get('repoA')?.status).toBe('completed');
  });

  it('all tasks completed and no PR yet → repo=running', async () => {
    setPlanRepos(['repoA']);
    mockReadRepoTaskState.mockResolvedValue({
      version: '1',
      itemId: 'item-1',
      repository: 'repoA',
      planFingerprint: 'fingerprint',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      tasks: [
        {
          id: 'T1',
          title: 'Task 1',
          dependencies: [],
          status: 'completed',
          attempts: 1,
        },
      ],
    } as any);
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'B', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'B', exitCode: 0 }),
      makeEvent('hooks_executed', { repoName: 'repoA', allPassed: true, attempt: 1, results: [] }),
    ]);

    const statuses = await deriveRepoStatuses('item-1');
    expect(statuses.get('repoA')?.status).toBe('running');
    expect(statuses.get('repoA')?.activePhase).toBe('pr');
  });

  it('retry success with pending tasks remaining → repo/item ready', async () => {
    setPlanRepos(['repoA']);
    mockReadRepoTaskState.mockResolvedValue({
      version: '1',
      itemId: 'item-1',
      repository: 'repoA',
      planFingerprint: 'fingerprint',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      tasks: [
        {
          id: 'T1',
          title: 'Task 1',
          dependencies: [],
          status: 'completed',
          attempts: 2,
        },
        {
          id: 'T2',
          title: 'Task 2',
          dependencies: [],
          status: 'pending',
          attempts: 0,
        },
      ],
    } as any);
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'repoA' }),
      makeEvent('error', { repoName: 'repoA', phase: 'hooks', message: 'Hooks failed' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 1 }),
      makeEvent('agent_started', { agentId: 'B', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'B', exitCode: 0 }),
      makeEvent('hooks_executed', { repoName: 'repoA', allPassed: true, attempt: 1, results: [] }),
    ]);

    const statuses = await deriveRepoStatuses('item-1');
    expect(statuses.get('repoA')?.status).toBe('ready');
    expect(statuses.get('repoA')?.activePhase).toBeUndefined();
    expect(await deriveItemStatus('item-1')).toBe('ready');
  });

  it('multi-repo: repoA hooks failure, repoB hooks pass', async () => {
    setPlanRepos(['repoA', 'repoB']);
    mockReadRepoTaskState.mockImplementation(async (_itemId, repoName) => {
      if (repoName === 'repoA') {
        return makeTaskState('repoA', [
          {
            id: 'T1',
            title: 'Task 1',
            dependencies: [],
            status: 'failed',
            currentPhase: 'hooks',
            attempts: 1,
            lastError: 'Hooks validation failed for repoA after 2 attempts',
          },
        ]);
      }
      return null;
    });
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      // repoA fails
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 0 }),
      makeEvent('hooks_executed', { repoName: 'repoA', allPassed: false, attempt: 1, results: [] }),
      makeEvent('error', { repoName: 'repoA', phase: 'hooks', message: 'Hooks validation failed for repoA after 2 attempts' }),
      // repoB succeeds
      makeEvent('agent_started', { agentId: 'B', role: 'engineer', repoName: 'repoB' }),
      makeEvent('agent_exited', { agentId: 'B', exitCode: 0 }),
      makeEvent('hooks_executed', { repoName: 'repoB', allPassed: true, attempt: 1, results: [] }),
      makeEvent('pr_created', { repoName: 'repoB', prUrl: 'http://pr', prNumber: 1 }),
    ]);

    const statuses = await deriveRepoStatuses('item-1');
    expect(statuses.get('repoA')?.status).toBe('error');
    expect(statuses.get('repoB')?.status).toBe('completed');

    // item status should be error since in-scope repoA is error
    expect(await deriveItemStatus('item-1')).toBe('error');
  });

  it('multi-repo: repoA=pr_created, repoB=repo_no_changes → completed', async () => {
    setPlanRepos(['repoA', 'repoB']);
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 0 }),
      makeEvent('pr_created', { repoName: 'repoA', prUrl: 'http://pr', prNumber: 1 }),
      makeEvent('repo_no_changes', { repoName: 'repoB' }),
    ]);

    expect(await deriveItemStatus('item-1')).toBe('completed');
  });

  it('review_receive_completed (no new comments, originally completed) → restores completed', async () => {
    setPlanRepos(['repoA']);
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 0 }),
      makeEvent('pr_created', { repoName: 'repoA', prUrl: 'http://pr', prNumber: 1 }),
      makeEvent('review_receive_started', { agentId: 'RR1', repoName: 'repoA', prNumber: 1, prUrl: 'http://pr' }),
      makeEvent('review_receive_completed', { agentId: 'RR1', repoName: 'repoA', prNumber: 1, commentsCutoffAt: null, totalComments: 0, newComments: 0, filteredComments: 0 }),
    ]);

    const statuses = await deriveRepoStatuses('item-1');
    expect(statuses.get('repoA')?.status).toBe('completed');
  });

  it('review_receive_completed (no new comments, originally error) → restores error', async () => {
    setPlanRepos(['repoA']);
    mockReadRepoTaskState.mockResolvedValue(
      makeTaskState('repoA', [
        {
          id: 'T1',
          title: 'Task 1',
          dependencies: [],
          status: 'failed',
          currentPhase: 'hooks',
          attempts: 1,
          lastError: 'Hooks failed',
        },
      ])
    );
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'repoA' }),
      makeEvent('error', { repoName: 'repoA', phase: 'hooks', message: 'Hooks failed' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 1 }),
      makeEvent('review_receive_started', { agentId: 'RR1', repoName: 'repoA', prNumber: 1, prUrl: 'http://pr' }),
      makeEvent('review_receive_completed', { agentId: 'RR1', repoName: 'repoA', prNumber: 1, commentsCutoffAt: null, totalComments: 0, newComments: 0, filteredComments: 0 }),
    ]);

    const statuses = await deriveRepoStatuses('item-1');
    expect(statuses.get('repoA')?.status).toBe('error');
  });

  it('review_receive_started → plan_created(repo in plan) → review_receive_completed → ready', async () => {
    setPlanRepos(['repoA']);
    mockReadRepoTaskState.mockResolvedValue(null);
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 0 }),
      makeEvent('pr_created', { repoName: 'repoA', prUrl: 'http://pr', prNumber: 1 }),
      makeEvent('review_receive_started', { agentId: 'RR1', repoName: 'repoA', prNumber: 1, prUrl: 'http://pr' }),
      makeEvent('plan_created', { planPath: '/plan.yaml' }), // new plan with repoA
      makeEvent('review_receive_completed', { agentId: 'RR1', repoName: 'repoA', prNumber: 1, commentsCutoffAt: '2024-01-01', totalComments: 5, newComments: 3, filteredComments: 2 }),
    ]);

    const statuses = await deriveRepoStatuses('item-1');
    expect(statuses.get('repoA')?.status).toBe('ready');
  });

  it('plan archive → repo retains previous completed status with inCurrentPlan from last plan', async () => {
    // Simulate: plan existed with repoA, repoA completed, plan archived (plan.yaml removed)
    // Fallback to no plan → all repos get inCurrentPlan=false
    mockReadYamlSafe.mockResolvedValue(null); // no plan.yaml
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 0 }),
      makeEvent('pr_created', { repoName: 'repoA', prUrl: 'http://pr', prNumber: 1 }),
    ]);

    const statuses = await deriveRepoStatuses('item-1');
    expect(statuses.get('repoA')?.status).toBe('completed');
    // Without plan, inCurrentPlan is false
    expect(statuses.get('repoA')?.inCurrentPlan).toBe(false);

    // Item status should be completed (rule 11)
    expect(await deriveItemStatus('item-1')).toBe('completed');
  });

  it('plan created → in-scope repos ready, item.status=ready', async () => {
    setPlanRepos(['repoA']);
    mockReadRepoTaskState.mockResolvedValue(null);
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
    ]);

    const statuses = await deriveRepoStatuses('item-1');
    expect(statuses.get('repoA')?.status).toBe('ready');
    expect(await deriveItemStatus('item-1')).toBe('ready');
  });

  it('new plan_created after error cycle → old errors dont leak to new cycle', async () => {
    setPlanRepos(['repoA']);
    mockReadRepoTaskState.mockResolvedValue(null);
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'repoA' }),
      makeEvent('error', { agentId: 'A', repoName: 'repoA', message: 'old error' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 1 }),
      // New plan created → should reset repoA to ready
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
    ]);

    const statuses = await deriveRepoStatuses('item-1');
    expect(statuses.get('repoA')?.status).toBe('ready');
    expect(await deriveItemStatus('item-1')).toBe('ready');
  });

  it('legacy error (agentId only) is attributed to repo via agent map', async () => {
    setPlanRepos(['repoA']);
    mockReadRepoTaskState.mockResolvedValue(
      makeTaskState('repoA', [
        {
          id: 'T1',
          title: 'Task 1',
          dependencies: [],
          status: 'failed',
          currentPhase: 'engineer',
          attempts: 1,
          lastError: 'Something failed',
        },
      ])
    );
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'repoA' }),
      makeEvent('error', { agentId: 'A', message: 'Something failed' }), // legacy: no repoName
      makeEvent('agent_exited', { agentId: 'A', exitCode: 1 }),
    ]);

    const statuses = await deriveRepoStatuses('item-1');
    expect(statuses.get('repoA')?.status).toBe('error');
  });

  it('legacy hooks error message resolves repo via regex', async () => {
    setPlanRepos(['myrepo']);
    mockReadRepoTaskState.mockResolvedValue(
      makeTaskState('myrepo', [
        {
          id: 'T1',
          title: 'Task 1',
          dependencies: [],
          status: 'failed',
          currentPhase: 'hooks',
          attempts: 1,
          lastError: 'Hooks validation failed for myrepo after 2 attempts',
        },
      ])
    );
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'myrepo' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 0 }),
      makeEvent('error', { message: 'Hooks validation failed for myrepo after 2 attempts' }), // legacy: no repoName, no agentId
    ]);

    const statuses = await deriveRepoStatuses('item-1');
    expect(statuses.get('myrepo')?.status).toBe('error');
  });

  it('structured error (repoName + phase) is correctly attributed', async () => {
    setPlanRepos(['repoA']);
    mockReadRepoTaskState.mockResolvedValue(
      makeTaskState('repoA', [
        {
          id: 'T1',
          title: 'Task 1',
          dependencies: [],
          status: 'failed',
          currentPhase: 'hooks',
          attempts: 1,
          lastError: 'Hooks failed',
        },
      ])
    );
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 0 }),
      makeEvent('error', { repoName: 'repoA', phase: 'hooks', message: 'Hooks failed' }),
    ]);

    const statuses = await deriveRepoStatuses('item-1');
    expect(statuses.get('repoA')?.status).toBe('error');
    expect(statuses.get('repoA')?.activePhase).toBe('hooks');
    expect(statuses.get('repoA')?.lastErrorMessage).toBe('Hooks failed');
  });
});

describe('deriveItemStatus - worker partial re-run scenarios', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadYamlSafe.mockResolvedValue(null);
    mockReadRepoTaskState.mockReset();
    mockReadRepoTaskState.mockResolvedValue(null);
  });

  it('returns ready when plan exists but no workers started', async () => {
    setPlanRepos(['repoA']);
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
    ]);
    expect(await deriveItemStatus('item-1')).toBe('ready');
  });

  it('returns planning when planner is running', async () => {
    mockReadJsonl.mockResolvedValue([
      makeEvent('agent_started', { agentId: 'P', role: 'planner' }),
    ]);
    expect(await deriveItemStatus('item-1')).toBe('planning');
  });

  it('returns error when planner failed and no plan exists', async () => {
    mockReadJsonl.mockResolvedValue([
      makeEvent('agent_started', { agentId: 'P', role: 'planner' }),
      makeEvent('agent_exited', { agentId: 'P', exitCode: 1 }),
    ]);
    expect(await deriveItemStatus('item-1')).toBe('error');
  });
});

describe('deriveRepoStatuses - status_changed(stopped) recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadYamlSafe.mockResolvedValue(null);
    mockReadRepoTaskState.mockReset();
    mockReadRepoTaskState.mockResolvedValue(null);
  });

  it('engineer stopped (running→stopped) → repo error', async () => {
    setPlanRepos(['repoA']);
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'eng1', role: 'engineer', repoName: 'repoA' }),
      makeEvent('status_changed', { agentId: 'eng1', previousStatus: 'running', newStatus: 'stopped' }),
    ]);

    const statuses = await deriveRepoStatuses('item-1');
    expect(statuses.get('repoA')?.status).toBe('error');
    expect(statuses.get('repoA')?.lastErrorMessage).toBe('Agent stopped before completion');

    expect(await deriveItemStatus('item-1')).toBe('error');
  });

  it('review stopped (running→stopped) → repo error', async () => {
    setPlanRepos(['repoA']);
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'eng1', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'eng1', exitCode: 0 }),
      makeEvent('pr_created', { repoName: 'repoA', prUrl: 'http://pr', prNumber: 1 }),
      makeEvent('agent_started', { agentId: 'review1', role: 'review', repoName: 'repoA' }),
      makeEvent('status_changed', { agentId: 'review1', previousStatus: 'running', newStatus: 'stopped' }),
    ]);

    const statuses = await deriveRepoStatuses('item-1');
    expect(statuses.get('repoA')?.status).toBe('error');
  });

  it('stopped then new agent starts → repo running again (recovery)', async () => {
    setPlanRepos(['repoA']);
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'eng1', role: 'engineer', repoName: 'repoA' }),
      makeEvent('status_changed', { agentId: 'eng1', previousStatus: 'running', newStatus: 'stopped' }),
      makeEvent('agent_started', { agentId: 'eng2', role: 'engineer', repoName: 'repoA' }),
    ]);

    const statuses = await deriveRepoStatuses('item-1');
    expect(statuses.get('repoA')?.status).toBe('running');
    expect(await deriveItemStatus('item-1')).toBe('running');
  });

  it('planner stopped → repo status unaffected', async () => {
    setPlanRepos(['repoA']);
    mockReadJsonl.mockResolvedValue([
      makeEvent('agent_started', { agentId: 'planner1', role: 'planner' }),
      makeEvent('status_changed', { agentId: 'planner1', previousStatus: 'running', newStatus: 'stopped' }),
    ]);

    const statuses = await deriveRepoStatuses('item-1');
    expect(statuses.get('repoA')?.status).toBe('ready');
  });

  it('review-receiver stopped (review_receiving→error) → repo error', async () => {
    setPlanRepos(['repoA']);
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'eng1', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'eng1', exitCode: 0 }),
      makeEvent('pr_created', { repoName: 'repoA', prUrl: 'http://pr', prNumber: 1 }),
      makeEvent('review_receive_started', { agentId: 'rr1', repoName: 'repoA', prNumber: 1, prUrl: 'http://pr' }),
      makeEvent('agent_started', { agentId: 'rr1', role: 'review-receiver', repoName: 'repoA' }),
      makeEvent('status_changed', { agentId: 'rr1', previousStatus: 'running', newStatus: 'stopped' }),
    ]);

    const statuses = await deriveRepoStatuses('item-1');
    expect(statuses.get('repoA')?.status).toBe('error');
    expect(statuses.get('repoA')?.lastErrorMessage).toBe('Agent stopped before completion');
    expect(await deriveItemStatus('item-1')).toBe('error');
  });

  it('does not override already-terminal repo status', async () => {
    setPlanRepos(['repoA']);
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'eng1', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'eng1', exitCode: 0 }),
      makeEvent('pr_created', { repoName: 'repoA', prUrl: 'http://pr', prNumber: 1 }),
      // repo is completed now
      makeEvent('status_changed', { agentId: 'eng1', previousStatus: 'completed', newStatus: 'stopped' }),
    ]);

    const statuses = await deriveRepoStatuses('item-1');
    expect(statuses.get('repoA')?.status).toBe('completed');
  });
});
