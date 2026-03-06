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

vi.mock('child_process', () => {
  const EventEmitter = require('events');
  return {
    spawn: vi.fn().mockImplementation((_cmd: string, args: string[]) => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
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

import { isDevRole } from '@agent-orch/shared';
import { executeAgent } from '../agent-service';
import { getPlan } from '../planner-service';
import { getItemConfig } from '../item-service';
import { startWorkers } from '../worker-service';

const mockExecuteAgent = vi.mocked(executeAgent);
const mockGetPlan = vi.mocked(getPlan);
const mockGetItemConfig = vi.mocked(getItemConfig);
const mockSpawn = vi.mocked(require('child_process').spawn);

// ─── Fixtures ───

const ITEM_ID = 'ITEM-dev-role';

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

function failureResult() {
  return {
    result: {
      output: { status: 'failure' as const, files_modified: [], error_message: 'something went wrong' },
    },
  };
}

function emptyFilesResult() {
  return {
    result: {
      output: { status: 'success' as const, files_modified: [] },
    },
  };
}

function reviewApproveResult() {
  return {
    result: { output: { review_status: 'approve', comments: [] } },
  };
}

function reviewRequestChangesResult() {
  return {
    result: {
      output: {
        review_status: 'request_changes',
        comments: [{ file_path: 'file.ts', line: 1, comment: 'fix this', severity: 'critical' }],
      },
    },
  };
}

// ─── Tests ───

describe('isDevRole', () => {
  it('returns true for "engineer"', () => {
    expect(isDevRole('engineer')).toBe(true);
  });

  it('returns true for "developer"', () => {
    expect(isDevRole('developer')).toBe(true);
  });

  it('returns false for "review"', () => {
    expect(isDevRole('review')).toBe(false);
  });

  it('returns false for "planner"', () => {
    expect(isDevRole('planner')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isDevRole('')).toBe(false);
  });
});

describe('Worker with agent: "developer"', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetItemConfig.mockResolvedValue(makeItemConfig(['repo-a']) as any);
  });

  it('should start worker for agent: "developer" tasks', async () => {
    mockGetPlan.mockResolvedValue({
      tasks: [{
        id: 'T1',
        title: 'Dev task',
        description: 'desc',
        agent: 'developer' as const,
        repository: 'repo-a',
        files: [],
        dependencies: [],
      }],
    } as any);

    mockExecuteAgent
      .mockResolvedValueOnce(successResult() as any)  // developer engineer phase
      .mockResolvedValue({
        result: { output: { review_status: 'approve', comments: [] } },
      } as any);

    await startWorkers(ITEM_ID);

    expect(mockExecuteAgent).toHaveBeenCalled();
    const engineerCall = mockExecuteAgent.mock.calls[0];
    expect(engineerCall[0].role).toBe('engineer');
  });

  it('should retry when engineer returns status: "failure"', async () => {
    mockGetPlan.mockResolvedValue({
      tasks: [{
        id: 'T1',
        title: 'Dev task',
        description: 'desc',
        agent: 'developer' as const,
        repository: 'repo-a',
        files: [],
        dependencies: [],
      }],
    } as any);

    // First attempt: failure → retry, second attempt: success → approve review
    mockExecuteAgent
      .mockResolvedValueOnce(failureResult() as any)   // engineer attempt 1 (failure)
      .mockResolvedValueOnce(successResult() as any)    // engineer attempt 2 (success)
      .mockResolvedValue(reviewApproveResult() as any); // review

    await startWorkers(ITEM_ID);

    // Engineer should have been called twice (retry after failure)
    const engineerCalls = mockExecuteAgent.mock.calls.filter(c => c[0].role === 'engineer');
    expect(engineerCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('should retry when engineer returns empty files_modified', async () => {
    mockGetPlan.mockResolvedValue({
      tasks: [{
        id: 'T1',
        title: 'Dev task',
        description: 'desc',
        agent: 'developer' as const,
        repository: 'repo-a',
        files: [],
        dependencies: [],
      }],
    } as any);

    // First attempt: empty files → retry, second attempt: success → approve review
    mockExecuteAgent
      .mockResolvedValueOnce(emptyFilesResult() as any) // engineer attempt 1 (no files)
      .mockResolvedValueOnce(successResult() as any)     // engineer attempt 2 (success)
      .mockResolvedValue(reviewApproveResult() as any);  // review

    await startWorkers(ITEM_ID);

    // Engineer should have been called twice (retry after empty files)
    const engineerCalls = mockExecuteAgent.mock.calls.filter(c => c[0].role === 'engineer');
    expect(engineerCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('should mark feedbackFailed when feedback engineer returns failure status', async () => {
    mockGetPlan.mockResolvedValue({
      tasks: [{
        id: 'T1',
        title: 'Dev task',
        description: 'desc',
        agent: 'developer' as const,
        repository: 'repo-a',
        files: [],
        dependencies: [],
      }],
    } as any);

    // Phase 1: engineer success, review requests changes
    // Feedback: engineer fails both attempts → feedbackFailed → no more rounds
    mockExecuteAgent
      .mockResolvedValueOnce(successResult() as any)              // engineer phase 1
      .mockResolvedValueOnce(reviewRequestChangesResult() as any) // review round 1
      .mockResolvedValueOnce(failureResult() as any)              // feedback engineer attempt 1
      .mockResolvedValueOnce(failureResult() as any)              // feedback engineer attempt 2 (retry)
      .mockResolvedValue(reviewApproveResult() as any);           // should NOT be reached

    await startWorkers(ITEM_ID);

    // Feedback engineer was called twice (original + 1 retry), then gave up
    const engineerCalls = mockExecuteAgent.mock.calls.filter(c => c[0].role === 'engineer');
    // Phase 1 engineer (1) + feedback engineer attempts (2) = 3
    expect(engineerCalls).toHaveLength(3);
  });

  it('should skip repo with only review tasks (no dev tasks)', async () => {
    mockGetPlan.mockResolvedValue({
      tasks: [{
        id: 'T1',
        title: 'Review task',
        description: 'desc',
        agent: 'review' as const,
        repository: 'repo-a',
        files: [],
        dependencies: [],
      }],
    } as any);

    mockExecuteAgent.mockResolvedValue(successResult() as any);

    await startWorkers(ITEM_ID);

    // No engineer/developer executeAgent call should be made
    const engineerCalls = mockExecuteAgent.mock.calls.filter(
      call => call[0].role === 'engineer'
    );
    expect(engineerCalls).toHaveLength(0);
  });
});
