import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemConfig, ItemEvent } from '@agent-orch/shared';

vi.mock('../../lib/jsonl', () => ({
  readJsonl: vi.fn(),
  appendJsonl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/paths', () => ({
  getItemEventsPath: vi.fn().mockReturnValue('/events.jsonl'),
  getItemPlanPath: vi.fn().mockReturnValue('/workspace/plan.yaml'),
  getWorkspaceRoot: vi.fn().mockReturnValue('/workspace'),
  getRepoWorkspaceDir: vi.fn().mockReturnValue('/workspace/repoA'),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock('fs/promises', () => ({
  rm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../item-service', () => ({
  getItemConfig: vi.fn(),
}));

vi.mock('../agent-service', () => ({
  getAgentsByItem: vi.fn().mockResolvedValue([]),
  executeAgent: vi.fn().mockResolvedValue({}),
  generateAgentId: vi.fn().mockReturnValue('agent-1'),
}));

vi.mock('../event-bus', () => ({
  eventBus: { emit: vi.fn() },
}));

vi.mock('../git-pr-service', () => ({
  fetchPrComments: vi.fn(),
  execGitInRepo: vi.fn().mockResolvedValue('main'),
}));

vi.mock('../../lib/events', () => ({
  createReviewReceiveStartedEvent: vi.fn().mockReturnValue({ type: 'review_receive_started' }),
  createReviewReceiveCompletedEvent: vi.fn().mockReturnValue({ type: 'review_receive_completed' }),
  createErrorEvent: vi.fn().mockReturnValue({ type: 'error' }),
}));

vi.mock('../../lib/role-loader', () => ({
  getRole: vi.fn().mockReturnValue({
    systemPrompt: 'You are a review receiver.',
    allowedTools: ['Read', 'Write', 'Bash(git status:*)'],
    jsonSchema: {},
  }),
}));

vi.mock('../planner-service', () => ({
  archiveCurrentExecutionArtifacts: vi.fn().mockResolvedValue({
    archiveTag: '20260307_000000_abc123',
    archivedPlanPaths: [],
    archivedTaskStatePaths: [],
  }),
  finalizeGeneratedPlan: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../test-planner-service', () => ({
  synchronizeTestPlan: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../state-service', () => ({
  deriveRepoStatuses: vi.fn(),
}));

import { startReviewReceive } from '../review-receive-service';
import { getItemConfig } from '../item-service';
import { readJsonl } from '../../lib/jsonl';
import { executeAgent } from '../agent-service';
import { fetchPrComments } from '../git-pr-service';
import { deriveRepoStatuses } from '../state-service';
import { finalizeGeneratedPlan } from '../planner-service';
import { existsSync } from 'fs';
import { rm } from 'fs/promises';

const mockGetItemConfig = vi.mocked(getItemConfig);
const mockReadJsonl = vi.mocked(readJsonl);
const mockExecuteAgent = vi.mocked(executeAgent);
const mockFetchPrComments = vi.mocked(fetchPrComments);
const mockDeriveRepoStatuses = vi.mocked(deriveRepoStatuses);
const mockFinalizeGeneratedPlan = vi.mocked(finalizeGeneratedPlan);
const mockExistsSync = vi.mocked(existsSync);
const mockRm = vi.mocked(rm);

function makeEvent(type: string, extra: Record<string, unknown> = {}): ItemEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    type: type as ItemEvent['type'],
    timestamp: new Date().toISOString(),
    itemId: 'item-1',
    ...extra,
  } as ItemEvent;
}

function makeItemConfigWithRolePrompts(): ItemConfig {
  return {
    id: 'item-1',
    name: 'Test Item',
    description: 'test',
    repositories: [
      {
        name: 'repoA',
        type: 'remote',
        rolePrompts: {
          reviewReceiver: 'When triaging review comments, preserve repoA module boundaries.',
        },
      },
      {
        name: 'repoB',
        type: 'remote',
        rolePrompts: {
          reviewReceiver: 'Do not use this prompt for repoA.',
        },
      },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('startReviewReceive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetItemConfig.mockResolvedValue(makeItemConfigWithRolePrompts());
    mockReadJsonl.mockResolvedValue([
      makeEvent('pr_created', { repoName: 'repoA', prNumber: 1, prUrl: 'https://github.com/example/repoA/pull/1' }),
    ]);
    mockFetchPrComments.mockResolvedValue([
      {
        author: 'reviewer',
        body: 'Please adjust this implementation.',
        createdAt: '2026-01-01T00:00:00Z',
        path: 'src/file.ts',
        line: 12,
      },
    ]);
    mockDeriveRepoStatuses.mockResolvedValue(new Map([
      ['repoA', { status: 'completed', inCurrentPlan: true }],
    ]));
    mockExistsSync.mockReturnValue(true);
  });

  it('prepends the target repository reviewReceiver prompt, runs in repo cwd, and imports repo plan', async () => {
    await startReviewReceive('item-1');

    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
    const callArgs = mockExecuteAgent.mock.calls[0][0];
    expect(callArgs.prompt).toContain('## Repository-Specific Instructions');
    expect(callArgs.prompt).toContain(
      'When triaging review comments, preserve repoA module boundaries.'
    );
    expect(callArgs.prompt).not.toContain('Do not use this prompt for repoA.');
    expect(callArgs.prompt).toContain('## PR Review Comments');
    expect(callArgs.appendSystemPrompt).toBe('You are a review receiver.');
    expect(callArgs.allowedTools).toEqual(['Read', 'Write', 'Bash(git status:*)']);
    expect(callArgs.workingDir).toBe('/workspace/repoA');
    expect(mockRm).toHaveBeenNthCalledWith(1, '/workspace/repoA/plan.yaml', { force: true });
    expect(mockFinalizeGeneratedPlan).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ id: 'item-1' }),
      { allowEmptyTasks: true, sourcePath: '/workspace/repoA/plan.yaml' }
    );
    expect(mockRm).toHaveBeenNthCalledWith(2, '/workspace/repoA/plan.yaml', { force: true });
    expect(mockRm.mock.invocationCallOrder[0]).toBeLessThan(mockExecuteAgent.mock.invocationCallOrder[0]);
  });

  it('fails when the review receiver succeeds without creating repo-scoped plan.yaml', async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(startReviewReceive('item-1')).rejects.toThrow(
      'Review receiver completed but plan.yaml was not created in repository workspace: /workspace/repoA/plan.yaml'
    );

    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
    expect(mockFinalizeGeneratedPlan).not.toHaveBeenCalled();
    expect(mockRm).toHaveBeenCalledTimes(1);
  });
});
