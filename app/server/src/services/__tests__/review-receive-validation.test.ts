import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ItemEvent } from '@agent-orch/shared';

vi.mock('../../lib/jsonl', () => ({
  readJsonl: vi.fn(),
  appendJsonl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/paths', () => ({
  getItemEventsPath: vi.fn().mockReturnValue('/events.jsonl'),
  getItemPlanPath: vi.fn().mockReturnValue('/workspace/plan.yaml'),
  getWorkspaceRoot: vi.fn().mockReturnValue('/workspace'),
  getAgentEventsPath: vi.fn().mockReturnValue('/agent-events.jsonl'),
  getRepoWorkspaceDir: vi.fn().mockReturnValue('/workspace/repo'),
}));

vi.mock('../../lib/yaml', () => ({
  readYamlSafe: vi.fn().mockResolvedValue(null),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock('fs/promises', () => ({
  readdir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn().mockResolvedValue(''),
}));

vi.mock('../item-service', () => ({
  getItemConfig: vi.fn().mockResolvedValue({
    id: 'item-1',
    name: 'Test Item',
    description: 'test',
    repositories: [{ name: 'repoA', type: 'remote' }],
  }),
}));

vi.mock('../agent-service', () => ({
  getAgentsByItem: vi.fn().mockResolvedValue([]),
  executeAgent: vi.fn().mockResolvedValue(undefined),
  generateAgentId: vi.fn().mockReturnValue('agent-1'),
}));

vi.mock('../event-bus', () => ({
  eventBus: { emit: vi.fn() },
}));

vi.mock('../git-pr-service', () => ({
  fetchPrComments: vi.fn().mockResolvedValue([]),
  execGitInRepo: vi.fn().mockResolvedValue('main'),
}));

vi.mock('../../lib/events', () => ({
  createReviewReceiveStartedEvent: vi.fn().mockReturnValue({ type: 'review_receive_started' }),
  createReviewReceiveCompletedEvent: vi.fn().mockReturnValue({ type: 'review_receive_completed' }),
  createPlanCreatedEvent: vi.fn().mockReturnValue({ type: 'plan_created' }),
  createErrorEvent: vi.fn().mockReturnValue({ type: 'error' }),
}));

vi.mock('../../lib/role-loader', () => ({
  getRole: vi.fn().mockReturnValue({ promptTemplate: '', allowedTools: [], jsonSchema: undefined }),
}));

vi.mock('../planner-service', () => ({
  archiveCurrentExecutionArtifacts: vi.fn().mockResolvedValue({
    archiveTag: '20260307_000000_abc123',
    archivedPlanPaths: [],
    archivedTaskStatePaths: [],
  }),
  finalizeGeneratedPlan: vi.fn().mockResolvedValue(undefined),
}));

import { validateReviewReceivePreConditions, ReviewReceiveValidationError } from '../review-receive-service';
import { readJsonl } from '../../lib/jsonl';
import { readYamlSafe } from '../../lib/yaml';

const mockReadJsonl = vi.mocked(readJsonl);
const mockReadYamlSafe = vi.mocked(readYamlSafe);

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

describe('validateReviewReceivePreConditions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadYamlSafe.mockResolvedValue(null);
  });

  it('rejects when no PR exists (repoName omitted)', async () => {
    mockReadJsonl.mockResolvedValue([]);
    await expect(
      validateReviewReceivePreConditions('item-1')
    ).rejects.toThrow(ReviewReceiveValidationError);
    await expect(
      validateReviewReceivePreConditions('item-1')
    ).rejects.toThrow('No PR found');
  });

  it('rejects when multiple repos have PRs and repoName is omitted', async () => {
    setPlanRepos(['repoA', 'repoB']);
    const events = [
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 0 }),
      makeEvent('pr_created', { repoName: 'repoA', prNumber: 1, prUrl: 'https://github.com/pr/1' }),
      makeEvent('agent_started', { agentId: 'B', role: 'engineer', repoName: 'repoB' }),
      makeEvent('agent_exited', { agentId: 'B', exitCode: 0 }),
      makeEvent('pr_created', { repoName: 'repoB', prNumber: 2, prUrl: 'https://github.com/pr/2' }),
    ];
    mockReadJsonl.mockResolvedValue(events);

    await expect(
      validateReviewReceivePreConditions('item-1')
    ).rejects.toThrow('Multiple repos have PRs');
  });

  it('passes when single PR exists and repo is completed (repoName omitted)', async () => {
    setPlanRepos(['repoA']);
    const events = [
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 0 }),
      makeEvent('pr_created', { repoName: 'repoA', prNumber: 1, prUrl: 'https://github.com/pr/1' }),
    ];
    mockReadJsonl.mockResolvedValue(events);

    await expect(
      validateReviewReceivePreConditions('item-1')
    ).resolves.toBeUndefined();
  });

  it('rejects when single PR exists but repo is running (repoName omitted)', async () => {
    setPlanRepos(['repoA']);
    const events = [
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'repoA' }),
      makeEvent('pr_created', { repoName: 'repoA', prNumber: 1, prUrl: 'https://github.com/pr/1' }),
      // Agent still running (engineer started after pr_created, simulating re-run)
      makeEvent('agent_started', { agentId: 'B', role: 'engineer', repoName: 'repoA' }),
    ];
    mockReadJsonl.mockResolvedValue(events);

    await expect(
      validateReviewReceivePreConditions('item-1')
    ).rejects.toThrow("is in 'running' status");
  });

  it('passes when repoName is specified and that repo is completed', async () => {
    setPlanRepos(['repoA', 'repoB']);
    const events = [
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'A', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 0 }),
      makeEvent('pr_created', { repoName: 'repoA', prNumber: 1, prUrl: 'https://github.com/pr/1' }),
      makeEvent('agent_started', { agentId: 'B', role: 'engineer', repoName: 'repoB' }),
      // repoB still running
    ];
    mockReadJsonl.mockResolvedValue(events);

    await expect(
      validateReviewReceivePreConditions('item-1', 'repoA')
    ).resolves.toBeUndefined();
  });
});
