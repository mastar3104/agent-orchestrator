import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, ItemConfig, ItemEvent, Plan, TestPlan } from '@agent-orch/shared';

const events = vi.hoisted(() => [] as ItemEvent[]);
const agents = vi.hoisted(() => [] as AgentInfo[]);
const repoHeads = vi.hoisted(() => new Map<string, string>());
const repoPorcelain = vi.hoisted(() => new Map<string, string>());
const testPaths = vi.hoisted(() => {
  const workspaceRoot = '/workspace/item-1';
  return {
    workspaceRoot,
    eventsPath: '/workspace/item-1/events.jsonl',
    hookLogDir: '/workspace/item-1/.logs',
  };
});

function nextTimestamp() {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, events.length)).toISOString();
}

vi.mock('fs', () => ({
  existsSync: vi.fn((path: string) => {
    return (
      path === `${testPaths.workspaceRoot}/repo-a` ||
      path === `${testPaths.workspaceRoot}/repo-b`
    );
  }),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/jsonl', () => ({
  appendJsonl: vi.fn().mockImplementation(async (_path: string, event: ItemEvent) => {
    events.push(event);
  }),
  readJsonl: vi.fn().mockImplementation(async () => [...events]),
}));

vi.mock('../../lib/paths', () => ({
  getWorkspaceRoot: vi.fn().mockReturnValue(testPaths.workspaceRoot),
  getRepoWorkspaceDir: vi.fn(
    (_itemId: string, repoName: string) => `${testPaths.workspaceRoot}/${repoName}`
  ),
  getItemEventsPath: vi.fn().mockReturnValue(testPaths.eventsPath),
  getHookLogDir: vi.fn(
    (_itemId: string, repoName: string) => `${testPaths.hookLogDir}/${repoName}`
  ),
}));

vi.mock('../../lib/yaml', () => ({
  stringifyYaml: vi.fn().mockImplementation((value: unknown) => JSON.stringify(value, null, 2)),
}));

vi.mock('../../lib/role-loader', () => ({
  getRole: vi.fn((roleKey: string) => {
    if (roleKey === 'completedReviewer') {
      return {
        systemPrompt: 'You are a completed reviewer.',
        allowedTools: ['Read', 'Glob', 'Grep', 'Skill'],
        jsonSchema: {},
      };
    }
    if (roleKey === 'engineer') {
      return {
        systemPrompt: 'You are an engineer.',
        allowedTools: ['Read', 'Write', 'Edit', 'Skill'],
        jsonSchema: {},
      };
    }
    throw new Error(`Unexpected role lookup: ${roleKey}`);
  }),
  mergeAllowedTools: vi.fn((roleTools: string[], repoTools?: string[]) => {
    return [...new Set([...(roleTools || []), ...((repoTools || []) as string[])])];
  }),
}));

vi.mock('../../lib/repository-role-prompts', () => ({
  composeWorkspaceRolePrompts: vi.fn((prompt: string, repositories: ItemConfig['repositories'], roleKey: string) => {
    const prompts = repositories
      .map((repository) => repository.rolePrompts?.[roleKey as keyof typeof repository.rolePrompts])
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (prompts.length === 0) {
      return prompt;
    }
    return `## Repository-Specific Instructions\n${prompts.join('\n\n')}\n\n${prompt}`;
  }),
  composeRepositoryRolePrompt: vi.fn((prompt: string, rolePrompts: ItemConfig['repositories'][number]['rolePrompts'], roleKey: string) => {
    const repoPrompt = rolePrompts?.[roleKey as keyof typeof rolePrompts];
    if (!repoPrompt) {
      return prompt;
    }
    return `## Repository-Specific Instructions\n${repoPrompt}\n\n${prompt}`;
  }),
}));

vi.mock('../../lib/events', () => ({
  createCompletedReviewFindingsExtractedEvent: vi.fn().mockImplementation(
    (itemId: string, agentId: string, findings: unknown[], summary: string, round: number) => ({
      id: `event-${events.length + 1}`,
      type: 'completed_review_findings_extracted',
      timestamp: nextTimestamp(),
      itemId,
      agentId,
      findings,
      summary,
      round,
    })
  ),
  createCompletedReviewPassedEvent: vi.fn().mockImplementation(
    (itemId: string, agentId: string, summary: string, round: number) => ({
      id: `event-${events.length + 1}`,
      type: 'completed_review_passed',
      timestamp: nextTimestamp(),
      itemId,
      agentId,
      summary,
      round,
    })
  ),
  createCompletedReviewSkippedEvent: vi.fn().mockImplementation(
    (itemId: string, agentId: string, policy: string, reason: string) => ({
      id: `event-${events.length + 1}`,
      type: 'completed_review_skipped',
      timestamp: nextTimestamp(),
      itemId,
      agentId,
      policy,
      reason,
    })
  ),
  createErrorEvent: vi.fn().mockImplementation(
    (itemId: string, message: string, extra: Record<string, unknown> = {}) => ({
      id: `event-${events.length + 1}`,
      type: 'error',
      timestamp: nextTimestamp(),
      itemId,
      message,
      phase: 'completed_review',
      ...extra,
    })
  ),
  createHooksExecutedEvent: vi.fn().mockImplementation(
    (itemId: string, repoName: string, results: unknown[], allPassed: boolean, attempt: number) => ({
      id: `event-${events.length + 1}`,
      type: 'hooks_executed',
      timestamp: nextTimestamp(),
      itemId,
      repoName,
      results,
      allPassed,
      attempt,
    })
  ),
  createTasksCompletedEvent: vi.fn().mockImplementation((itemId: string, agentId: string) => ({
    id: `event-${events.length + 1}`,
    type: 'tasks_completed',
    timestamp: nextTimestamp(),
    itemId,
    agentId,
  })),
}));

vi.mock('../event-bus', () => ({
  eventBus: { emit: vi.fn() },
}));

vi.mock('../item-service', () => ({
  getItemConfig: vi.fn(),
}));

vi.mock('../planner-service', () => ({
  getPlan: vi.fn(),
}));

vi.mock('../test-planner-service', () => ({
  getTestPlan: vi.fn(),
  ensureApprovedTestPlan: vi.fn().mockResolvedValue(undefined),
  resolveVerificationPolicy: vi.fn().mockImplementation((plan, testPlan) => ({
    planPolicy: plan.verificationPolicy,
    resolvedPolicy: testPlan.verificationPolicy,
    planRationale: plan.verificationRationale,
    resolvedRationale: testPlan.verificationRationale,
    promotedByTestPlan: false,
  })),
}));

vi.mock('../agent-service', () => ({
  executeAgent: vi.fn(),
  getAgentsByItem: vi.fn().mockImplementation(async () => [...agents]),
}));

vi.mock('../git-pr-service', () => ({
  createDraftPrsForAllRepos: vi.fn().mockResolvedValue({ results: [] }),
  execGitInRepo: vi.fn().mockImplementation(async (args: string[], cwd: string) => {
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'feature/item-1';
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return repoHeads.get(cwd) || 'head-0';
    if (args[0] === 'rev-list') return '1';
    if (args[0] === 'diff' && args[1] === '--name-only') return 'src/index.ts\n';
    if (args[0] === 'diff' && args[1] === '--stat') return ' src/index.ts | 2 +-\n';
    if (args[0] === 'diff') return 'diff --git a/src/index.ts b/src/index.ts\n+change';
    if (args[0] === 'status') return repoPorcelain.get(cwd) || '';
    if (args[0] === 'reset') {
      repoHeads.set(cwd, args[2] || 'head-0');
      repoPorcelain.set(cwd, '');
      return '';
    }
    if (args[0] === 'clean') {
      repoPorcelain.set(cwd, '');
      return '';
    }
    return '';
  }),
}));

vi.mock('../task-state-service', () => ({
  readRepoTaskState: vi.fn(),
}));

vi.mock('../../lib/command-runner', () => ({
  runShellCommands: vi.fn().mockResolvedValue([]),
}));

import { executeAgent } from '../agent-service';
import { createDraftPrsForAllRepos } from '../git-pr-service';
import { getItemConfig } from '../item-service';
import { getPlan } from '../planner-service';
import { readRepoTaskState } from '../task-state-service';
import { getTestPlan } from '../test-planner-service';
import { runShellCommands } from '../../lib/command-runner';
import {
  getLatestCompletedReview,
  maybeStartCompletedReviewAfterTasks,
  startCompletedReview,
} from '../completed-review-service';

const mockExecuteAgent = vi.mocked(executeAgent);
const mockCreateDraftPrsForAllRepos = vi.mocked(createDraftPrsForAllRepos);
const mockGetItemConfig = vi.mocked(getItemConfig);
const mockGetPlan = vi.mocked(getPlan);
const mockReadRepoTaskState = vi.mocked(readRepoTaskState);
const mockGetTestPlan = vi.mocked(getTestPlan);
const mockRunShellCommands = vi.mocked(runShellCommands);

function makeConfig(): ItemConfig {
  return {
    id: 'item-1',
    name: 'Item 1',
    description: 'desc',
    repositories: [
      {
        name: 'repo-a',
        type: 'remote',
        branch: 'main',
        rolePrompts: {
          completedReviewer: 'Check repo-a acceptance conditions.',
          engineer: 'Keep repo-a changes minimal.',
        },
        allowedTools: ['Bash(npm test:*)'],
        hooks: ['npm test'],
      },
      {
        name: 'repo-b',
        type: 'remote',
        branch: 'main',
      },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function makePlan(): Plan {
  return {
    version: '1',
    itemId: 'item-1',
    summary: 'Plan summary',
    verificationPolicy: 'bdd_required',
    verificationRationale: 'Cross-repository behavior needs BDD coverage.',
    createdAt: '2026-01-01T00:00:00Z',
    tasks: [
      {
        id: 'T1',
        title: 'Implement repo-a work',
        description: 'desc',
        repository: 'repo-a',
        dependencies: [],
        files: ['src/index.ts'],
      },
    ],
  };
}

function makeTestPlan(overrides: Partial<TestPlan> = {}): TestPlan {
  return {
    version: '1.0',
    itemId: 'item-1',
    planFingerprint: 'plan:T1',
    summary: 'Approved test plan',
    verificationPolicy: 'bdd_required',
    verificationRationale: 'Cross-repository behavior needs BDD coverage.',
    createdAt: '2026-01-01T00:00:00Z',
    scenarios: [
      {
        id: 'S1',
        kind: 'bdd',
        title: 'Repo-a accepts the new behavior',
        repositories: ['repo-a'],
        given: 'the feature is deployed',
        when: 'the user triggers the flow',
        then: 'the expected result is visible',
      },
    ],
    ...overrides,
  };
}

describe('completed-review-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    events.length = 0;
    agents.length = 0;
    repoHeads.clear();
    repoPorcelain.clear();
    repoHeads.set(`${testPaths.workspaceRoot}/repo-a`, 'head-0');
    repoHeads.set(`${testPaths.workspaceRoot}/repo-b`, 'head-0');
    repoPorcelain.set(`${testPaths.workspaceRoot}/repo-a`, '');
    repoPorcelain.set(`${testPaths.workspaceRoot}/repo-b`, '');

    mockGetItemConfig.mockResolvedValue(makeConfig());
    mockGetPlan.mockResolvedValue(makePlan());
    mockGetTestPlan.mockResolvedValue(makeTestPlan());
    mockReadRepoTaskState.mockResolvedValue({
      version: '1',
      itemId: 'item-1',
      repository: 'repo-a',
      planFingerprint: 'plan:T1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      tasks: [
        {
          id: 'T1',
          title: 'Implement repo-a work',
          dependencies: [],
          status: 'completed',
          attempts: 1,
        },
      ],
    });
    mockRunShellCommands.mockResolvedValue([]);
  });

  it('auto-starts after tasks complete, emits tasks_completed, and publishes on approval', async () => {
    mockExecuteAgent.mockResolvedValue({
      agent: { id: 'agent-completed-review-1' },
      result: {
        output: {
          review_status: 'approve',
          summary: 'Everything satisfies the test plan.',
          findings: [],
        },
      },
    } as never);

    await maybeStartCompletedReviewAfterTasks('item-1');

    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
    expect(mockExecuteAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'item-1',
        role: 'completed-reviewer',
        workingDir: testPaths.workspaceRoot,
        appendSystemPrompt: 'You are a completed reviewer.',
        addDirs: [`${testPaths.workspaceRoot}/repo-a`, `${testPaths.workspaceRoot}/repo-b`],
        allowedTools: ['Read', 'Glob', 'Grep', 'Skill'],
        schemaFallbackMode: 'result_or_empty',
      })
    );
    expect(mockExecuteAgent.mock.calls[0][0].prompt).toContain('Check repo-a acceptance conditions.');
    expect(events.map((event) => event.type)).toEqual(['tasks_completed', 'completed_review_passed']);
    expect(mockCreateDraftPrsForAllRepos).toHaveBeenCalledWith('item-1', new Set(['repo-a']));

    const completedReview = await getLatestCompletedReview('item-1');
    expect(completedReview).toEqual(
      expect.objectContaining({
        status: 'passed',
        summary: 'Everything satisfies the test plan.',
        round: 1,
      })
    );
  });

  it('runs repo fixes, carries hook failures into the next completed review round, and publishes after approval', async () => {
    mockExecuteAgent
      .mockImplementationOnce(async () => ({
        agent: { id: 'agent-completed-review-1' },
        result: {
          output: {
            review_status: 'needs_fixes',
            summary: 'One acceptance gap remains.',
            findings: [
              {
                id: 'F1',
                scenarioId: 'S1',
                targetRepository: 'repo-a',
                relatedRepositories: [],
                severity: 'major',
                summary: 'Repo-a misses the final visible state.',
                details: 'The new flow does not expose the expected output.',
                suggestedFix: 'Render the final user-visible state after the action completes.',
              },
            ],
          },
        },
      }) as never)
      .mockImplementationOnce(async () => {
        repoHeads.set(`${testPaths.workspaceRoot}/repo-a`, 'head-1');
        repoPorcelain.set(`${testPaths.workspaceRoot}/repo-a`, '');
        return {
          agent: { id: 'agent-engineer-1' },
          result: {
            output: 'Completed review fix applied.',
            usedSchemaFallback: true,
            schemaValidationErrors: ["$: expected type 'object' but got 'string'"],
          },
        } as never;
      })
      .mockImplementationOnce(async () => ({
        agent: { id: 'agent-completed-review-2' },
        result: {
          output: {
            review_status: 'approve',
            summary: 'Acceptance gaps are resolved.',
            findings: [],
          },
        },
      }) as never);
    mockRunShellCommands.mockResolvedValue([
      {
        command: 'npm test',
        exitCode: 1,
        stdoutLogPath: '/logs/stdout.log',
        stderrLogPath: '/logs/stderr.log',
      },
    ] as never);

    await startCompletedReview('item-1');

    expect(mockExecuteAgent).toHaveBeenCalledTimes(3);
    expect(mockExecuteAgent.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        role: 'engineer',
        repoName: 'repo-a',
        currentTask: expect.stringContaining('completed-review-fix:'),
        workingDir: `${testPaths.workspaceRoot}/repo-a`,
        allowedTools: ['Read', 'Write', 'Edit', 'Skill', 'Bash(npm test:*)'],
      })
    );
    expect(mockExecuteAgent.mock.calls[1][0].prompt).toContain('Repo-a misses the final visible state.');
    expect(mockExecuteAgent.mock.calls[1][0].prompt).toContain('Given: the feature is deployed');
    expect(mockExecuteAgent.mock.calls[2][0].prompt).toContain('Recent hook warning:');
    expect(mockExecuteAgent.mock.calls[2][0].prompt).toContain('npm test | exit=1');
    expect(events.map((event) => event.type)).toEqual([
      'completed_review_findings_extracted',
      'hooks_executed',
      'completed_review_passed',
    ]);
    expect(mockCreateDraftPrsForAllRepos).toHaveBeenCalledWith('item-1', new Set(['repo-a']));

    const completedReview = await getLatestCompletedReview('item-1');
    expect(completedReview).toEqual(
      expect.objectContaining({
        status: 'passed',
        summary: 'Acceptance gaps are resolved.',
        round: 2,
      })
    );
  });

  it('skips completed review when resolved policy does not require BDD', async () => {
    mockGetTestPlan.mockResolvedValue(
      makeTestPlan({
        verificationPolicy: 'regression_only',
        verificationRationale: 'Regression coverage is sufficient for this change.',
        scenarios: [
          {
            id: 'S1',
            kind: 'regression',
            title: 'Existing behavior remains stable',
            repositories: ['repo-a'],
            given: 'the current user flow',
            when: 'the flow is exercised again',
            then: 'the prior behavior still works',
          },
        ],
      })
    );

    await maybeStartCompletedReviewAfterTasks('item-1');

    expect(mockExecuteAgent).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      'tasks_completed',
      'completed_review_skipped',
    ]);
    expect(mockCreateDraftPrsForAllRepos).toHaveBeenCalledWith('item-1', new Set(['repo-a']));

    const completedReview = await getLatestCompletedReview('item-1');
    expect(completedReview).toEqual(
      expect.objectContaining({
        status: 'skipped',
        summary: expect.stringContaining('verificationPolicy=regression_only'),
      })
    );
  });

  it('treats semantically invalid completed reviewer findings as an invalid round and can still pass later', async () => {
    mockExecuteAgent
      .mockResolvedValueOnce({
        agent: { id: 'agent-completed-review-invalid' },
        result: {
          output: {
            review_status: 'needs_fixes',
            summary: 'Invalid review output.',
            findings: [
              {
                id: 'F1',
                scenarioId: 'S1',
                targetRepository: '',
                relatedRepositories: [],
                severity: 'major',
                summary: 'Missing target repo.',
                details: 'A repo must be assigned.',
                suggestedFix: 'Assign the repo.',
              },
            ],
          },
        },
      } as never)
      .mockResolvedValueOnce({
        agent: { id: 'agent-completed-review-approve' },
        result: {
          output: {
            review_status: 'approve',
            summary: 'Everything is acceptable now.',
            findings: [],
          },
        },
      } as never);

    await startCompletedReview('item-1');

    expect(events.map((event) => event.type)).toEqual([
      'completed_review_findings_extracted',
      'completed_review_passed',
    ]);
    expect(events[0]).toEqual(
      expect.objectContaining({
        type: 'completed_review_findings_extracted',
        findings: [],
        summary: expect.stringContaining('Finding F1 missing targetRepository'),
      })
    );
    expect(mockCreateDraftPrsForAllRepos).toHaveBeenCalledWith('item-1', new Set(['repo-a']));

    const completedReview = await getLatestCompletedReview('item-1');
    expect(completedReview).toEqual(
      expect.objectContaining({
        status: 'passed',
        summary: 'Everything is acceptable now.',
        round: 2,
      })
    );
  });

  it('skips completed review after repeated invalid completed reviewer output', async () => {
    mockExecuteAgent.mockResolvedValue({
      agent: { id: 'agent-completed-review-invalid' },
      result: {
        output: 'Freeform completed review response.',
        usedSchemaFallback: true,
        schemaValidationErrors: ["$: expected type 'object' but got 'string'"],
      },
    } as never);

    await startCompletedReview('item-1');

    expect(mockExecuteAgent).toHaveBeenCalledTimes(3);
    expect(events.map((event) => event.type)).toEqual([
      'completed_review_findings_extracted',
      'completed_review_findings_extracted',
      'completed_review_findings_extracted',
      'completed_review_skipped',
    ]);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: 'completed_review_skipped',
        reason: expect.stringContaining('invalid/non-actionable output'),
      })
    );
    expect(mockCreateDraftPrsForAllRepos).toHaveBeenCalledWith('item-1', new Set(['repo-a']));

    const completedReview = await getLatestCompletedReview('item-1');
    expect(completedReview).toEqual(
      expect.objectContaining({
        status: 'skipped',
        summary: expect.stringContaining('invalid/non-actionable output'),
      })
    );
  });

  it('ignores stale completed review results from before the latest plan cycle', async () => {
    events.push({
      id: 'event-1',
      type: 'completed_review_passed',
      timestamp: '2026-01-01T00:00:00.000Z',
      itemId: 'item-1',
      agentId: 'agent-old',
      summary: 'Old pass',
      round: 1,
    } as ItemEvent);
    events.push({
      id: 'event-2',
      type: 'plan_created',
      timestamp: '2026-01-01T00:00:01.000Z',
      itemId: 'item-1',
      agentId: 'planner-1',
      planPath: '/workspace/item-1/plan.yaml',
      planFingerprint: 'plan:T1',
    } as ItemEvent);

    const completedReview = await getLatestCompletedReview('item-1');
    expect(completedReview).toEqual({ status: 'not_started', findings: [] });
  });
});
