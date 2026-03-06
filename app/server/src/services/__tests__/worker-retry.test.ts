import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───

vi.mock('../agent-service', () => ({
  executeAgent: vi.fn(),
  getAgentsByItem: vi.fn().mockResolvedValue([]),
  stopAgent: vi.fn(),
}));

vi.mock('../planner-service', () => ({
  getPlan: vi.fn(),
}));

vi.mock('../item-service', () => ({
  getItemConfig: vi.fn(),
}));

vi.mock('../git-snapshot-service', () => ({
  startGitSnapshot: vi.fn().mockResolvedValue(undefined),
  stopGitSnapshot: vi.fn(),
  stopAllGitSnapshots: vi.fn(),
}));

vi.mock('../git-pr-service', () => ({
  createDraftPrsForAllRepos: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/paths', () => ({
  getWorkspaceRoot: vi.fn().mockReturnValue('/workspace'),
  getRepoWorkspaceDir: vi.fn((_itemId: string, repoName: string) => `/workspace/${repoName}`),
  getItemEventsPath: vi.fn().mockReturnValue('/events.jsonl'),
  getItemPlanPath: vi.fn().mockReturnValue('/plan.yaml'),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('tasks:\n  - id: T1\n    title: Test Task'),
}));

vi.mock('../event-bus', () => ({
  eventBus: { publish: vi.fn(), emit: vi.fn() },
}));

vi.mock('../../lib/jsonl', () => ({
  appendJsonl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/events', () => ({
  createReviewFindingsExtractedEvent: vi.fn().mockReturnValue({ type: 'review' }),
  createStatusChangedEvent: vi.fn().mockReturnValue({ type: 'status' }),
  createHooksExecutedEvent: vi.fn().mockReturnValue({ type: 'hooks_executed' }),
  createErrorEvent: vi.fn().mockReturnValue({ type: 'error' }),
}));

vi.mock('../../lib/role-loader', () => ({
  getRole: vi.fn().mockReturnValue({
    promptTemplate: 'You are an engineer.',
    allowedTools: ['Read', 'Write'],
    jsonSchema: {},
  }),
  mergeAllowedTools: vi.fn().mockReturnValue(['Read', 'Write']),
}));

// Mock child_process spawn for git commands
vi.mock('child_process', () => {
  const EventEmitter = require('events');
  return {
    spawn: vi.fn().mockImplementation((cmd: string, args: string[]) => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      // Simulate successful git command
      setTimeout(() => {
        if (args[0] === 'rev-parse') {
          proc.stdout.emit('data', 'abc123');
        } else if (args[0] === 'merge-base') {
          proc.stdout.emit('data', 'base123');
        } else if (args[0] === 'diff') {
          if (args.includes('--cached') && args.includes('--name-only')) {
            proc.stdout.emit('data', 'file.ts');
          } else if (args.includes('--name-status')) {
            proc.stdout.emit('data', 'M\tfile.ts');
          } else if (args.includes('--numstat')) {
            proc.stdout.emit('data', '10\t5\tfile.ts');
          } else {
            proc.stdout.emit('data', 'diff content');
          }
        } else if (args[0] === 'show') {
          proc.stdout.emit('data', '// file content');
        } else if (args[0] === 'cat-file') {
          proc.stdout.emit('data', '1024');
        }
        proc.emit('close', 0);
      }, 0);
      return proc;
    }),
  };
});

import { executeAgent } from '../agent-service';
import { getPlan } from '../planner-service';
import { getItemConfig } from '../item-service';
import { startGitSnapshot, stopGitSnapshot } from '../git-snapshot-service';
import { startWorkers } from '../worker-service';

const mockExecuteAgent = vi.mocked(executeAgent);
const mockGetPlan = vi.mocked(getPlan);
const mockGetItemConfig = vi.mocked(getItemConfig);
const mockStartGitSnapshot = vi.mocked(startGitSnapshot);
const mockStopGitSnapshot = vi.mocked(stopGitSnapshot);

// ─── Fixtures ───

const ITEM_ID = 'ITEM-test';

function makePlan(repos: string[]) {
  return {
    tasks: repos.map((r, i) => ({
      id: `T${i + 1}`,
      title: `Task for ${r}`,
      description: 'desc',
      agent: 'engineer' as const,
      repository: r,
      files: [],
      dependencies: [],
    })),
  };
}

function makeItemConfig(repos: string[]) {
  return {
    id: ITEM_ID,
    title: 'Test Item',
    description: '',
    repositories: repos.map(name => ({
      name,
      url: `https://github.com/test/${name}`,
      branch: 'main',
    })),
  };
}

function successResult() {
  return {
    result: {
      output: { status: 'success' as const, files_modified: ['file.ts'] },
    },
  };
}

// ─── Tests ───

describe('Worker retry logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPlan.mockResolvedValue(makePlan(['repo-a']) as any);
    mockGetItemConfig.mockResolvedValue(makeItemConfig(['repo-a']) as any);
  });

  it('should succeed without retry when executeAgent succeeds first time', async () => {
    mockExecuteAgent.mockResolvedValue(successResult() as any);

    await startWorkers(ITEM_ID);

    // Phase 1 engineer is called exactly once (no retry needed).
    // The first executeAgent call should be for the Phase 1 engineer.
    const firstCall = mockExecuteAgent.mock.calls[0] as any;
    expect(firstCall[0].role).toBe('engineer');

    // Verify no failed repo retry occurred (stopGitSnapshot not called)
    expect(mockStopGitSnapshot).not.toHaveBeenCalled();
  });

  it('should retry engineer once on failure then succeed', async () => {
    mockExecuteAgent
      .mockRejectedValueOnce(new Error('timeout'))       // Phase 1 attempt 1: fail
      .mockResolvedValueOnce(successResult() as any)      // Phase 1 attempt 2: succeed
      .mockResolvedValue(successResult() as any);         // Phase 2 reviewer etc.

    await startWorkers(ITEM_ID);

    // Should have called executeAgent at least 2 times for the engineer
    expect(mockExecuteAgent.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('should retry failed repo after Phase 1 all-attempt failure', async () => {
    // Phase 1 inner loop: 2 failures (attempt 0 + retry 1)
    // Then failedRepos retry: success
    mockExecuteAgent
      .mockRejectedValueOnce(new Error('fail1'))      // Phase 1 attempt 0
      .mockRejectedValueOnce(new Error('fail2'))      // Phase 1 attempt 1 (AGENT_MAX_RETRIES=1)
      .mockResolvedValueOnce(successResult() as any)  // failedRepos retry: success
      .mockResolvedValue(successResult() as any);     // Phase 2

    await startWorkers(ITEM_ID);

    // stopGitSnapshot should have been called for the failed repo cleanup
    expect(mockStopGitSnapshot).toHaveBeenCalledWith(ITEM_ID, expect.stringContaining('repo-a'));
    // startGitSnapshot called for: workspace root + repo initial + repo retry
    expect(mockStartGitSnapshot).toHaveBeenCalledTimes(3);
  });

  it('should throw when all repos fail all retries including failedRepos retry', async () => {
    mockExecuteAgent.mockRejectedValue(new Error('always fails'));

    await expect(startWorkers(ITEM_ID)).rejects.toThrow('All engineer agents failed');
  });

  it('should restart snapshot before failed repo retry', async () => {
    // Phase 1: both attempts fail, then failedRepos retry succeeds
    mockExecuteAgent
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce(successResult() as any)
      .mockResolvedValue(successResult() as any);

    await startWorkers(ITEM_ID);

    // Verify snapshot was stopped then restarted for the failed repo
    expect(mockStopGitSnapshot).toHaveBeenCalledWith(ITEM_ID, expect.stringContaining('repo-a'));
    // startGitSnapshot: workspace root (1) + initial repo (2) + retry repo (3)
    expect(mockStartGitSnapshot).toHaveBeenCalledTimes(3);

    // Verify order: stop happens before the retry start
    const stopCallOrder = mockStopGitSnapshot.mock.invocationCallOrder[0];
    // The 3rd startGitSnapshot call is for the retry
    const retryStartCallOrder = mockStartGitSnapshot.mock.invocationCallOrder[2];
    expect(stopCallOrder).toBeLessThan(retryStartCallOrder);
  });

  describe('Feedback engineer retry', () => {
    beforeEach(() => {
      // Setup: Phase 1 succeeds, reviewer returns needs_fixes
      mockExecuteAgent
        .mockResolvedValueOnce(successResult() as any); // Phase 1 engineer
    });

    it('should retry feedback engineer on failure', async () => {
      mockExecuteAgent
        // Phase 2 cycle 1: reviewer returns needs_fixes
        .mockResolvedValueOnce({
          result: {
            output: {
              review_status: 'needs_fixes',
              comments: [{ file: 'a.ts', line: 1, comment: 'fix this', severity: 'major' }],
            },
          },
        } as any)
        // Feedback engineer attempt 0: fail
        .mockRejectedValueOnce(new Error('feedback fail'))
        // Feedback engineer attempt 1: success
        .mockResolvedValueOnce(successResult() as any)
        // Phase 2 cycle 2: reviewer approves
        .mockResolvedValueOnce({
          result: { output: { review_status: 'approve', comments: [] } },
        } as any);

      await startWorkers(ITEM_ID);

      // executeAgent should have been called 5 times:
      // 1. Phase 1 engineer
      // 2. Reviewer cycle 1
      // 3. Feedback engineer attempt 0 (fail)
      // 4. Feedback engineer attempt 1 (success)
      // 5. Reviewer cycle 2
      expect(mockExecuteAgent).toHaveBeenCalledTimes(5);
    });

    it('should break review cycle loop when feedback engineer fails all retries', async () => {
      mockExecuteAgent
        // Reviewer returns needs_fixes
        .mockResolvedValueOnce({
          result: {
            output: {
              review_status: 'needs_fixes',
              comments: [{ file: 'a.ts', line: 1, comment: 'fix this', severity: 'major' }],
            },
          },
        } as any)
        // Feedback engineer attempt 0: fail
        .mockRejectedValueOnce(new Error('feedback fail 1'))
        // Feedback engineer attempt 1: also fail
        .mockRejectedValueOnce(new Error('feedback fail 2'));

      // Should NOT throw — feedback failure breaks review loop but doesn't throw
      await startWorkers(ITEM_ID);

      // executeAgent should have been called 4 times:
      // 1. Phase 1 engineer
      // 2. Reviewer cycle 1
      // 3. Feedback attempt 0
      // 4. Feedback attempt 1
      // (no more cycles because feedbackFailed → break)
      expect(mockExecuteAgent).toHaveBeenCalledTimes(4);
    });
  });

  it('should not run reviewer after last feedback round', async () => {
    // MAX_FEEDBACK_ROUNDS = 2 の場合:
    // Engineer → [Review → Fix] × 2 → PR（3回目の reviewer は走らない）
    const requestChanges = (comments: Array<{ file: string; line: number; comment: string }>) => ({
      result: { output: { review_status: 'request_changes', comments } },
    });

    mockExecuteAgent
      .mockResolvedValueOnce(successResult() as any) // Phase 1 engineer
      // Cycle 1: reviewer request_changes → feedback engineer
      .mockResolvedValueOnce(requestChanges([{ file: 'a.ts', line: 1, comment: 'fix' }]) as any)
      .mockResolvedValueOnce(successResult() as any)
      // Cycle 2: reviewer request_changes → feedback engineer
      .mockResolvedValueOnce(requestChanges([{ file: 'b.ts', line: 2, comment: 'fix' }]) as any)
      .mockResolvedValueOnce(successResult() as any);
      // 3回目の reviewer は呼ばれない

    await startWorkers(ITEM_ID);

    // 1 engineer + 2×(reviewer + feedback) = 5 calls
    expect(mockExecuteAgent).toHaveBeenCalledTimes(5);

    // role='review' の呼び出しが 2 回であること
    const reviewCalls = mockExecuteAgent.mock.calls.filter(
      call => call[0].role === 'review'
    );
    expect(reviewCalls).toHaveLength(2);

    // 最後の呼び出しが engineer（feedback）であること
    const lastCall = mockExecuteAgent.mock.calls[mockExecuteAgent.mock.calls.length - 1];
    expect(lastCall[0].role).toBe('engineer');
  });

  it('should include plan and changed files sections in reviewer prompt', async () => {
    mockExecuteAgent
      .mockResolvedValueOnce(successResult() as any) // Phase 1 engineer
      .mockResolvedValueOnce({
        result: { output: { review_status: 'approve', comments: [] } }, // Reviewer
      } as any);

    await startWorkers(ITEM_ID);

    const reviewerCall = mockExecuteAgent.mock.calls.find(
      (call) => call[0].role === 'review'
    );
    expect(reviewerCall).toBeDefined();

    const prompt = reviewerCall?.[0].prompt as string;
    expect(prompt).toContain('## Plan');
    expect(prompt).toContain('## Changed Files');
    expect(prompt).toContain('## Implemented Tasks');
  });
});
