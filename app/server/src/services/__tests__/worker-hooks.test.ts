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
  getHookLogDir: vi.fn((_itemId: string, repoName: string) => `/hooks/${repoName}`),
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
  createHooksExecutedEvent: vi.fn().mockImplementation(
    (_itemId: string, repoName: string, results: any[], allPassed: boolean, attempt: number) => ({
      type: 'hooks_executed',
      repoName,
      results,
      allPassed,
      attempt,
    })
  ),
  createErrorEvent: vi.fn().mockImplementation(
    (_itemId: string, message: string) => ({
      type: 'error',
      message,
    })
  ),
}));

vi.mock('../../lib/role-loader', () => ({
  getRole: vi.fn().mockReturnValue({
    promptTemplate: 'You are an engineer.',
    allowedTools: ['Read', 'Write'],
    jsonSchema: {},
  }),
  mergeAllowedTools: vi.fn().mockReturnValue(['Read', 'Write']),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('tasks:\n  - id: T1\n    title: Test Task'),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('stream/promises', () => ({
  finished: vi.fn().mockResolvedValue(undefined),
}));

// Mock createWriteStream to return a dummy writable stream
vi.mock('fs', () => {
  const { PassThrough } = require('stream');
  return {
    createWriteStream: vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      // Make end() a no-op that marks the stream as finished
      stream.end = vi.fn().mockImplementation(() => {
        stream.emit('finish');
        return stream;
      });
      return stream;
    }),
  };
});

// Mock child_process spawn for git commands AND hook commands
const mockSpawn = vi.fn();
vi.mock('child_process', () => {
  const EventEmitter = require('events');
  return {
    spawn: (...args: any[]) => mockSpawn(...args),
  };
});

import { executeAgent } from '../agent-service';
import { getPlan } from '../planner-service';
import { getItemConfig } from '../item-service';
import { createDraftPrsForAllRepos } from '../git-pr-service';
import { startWorkers } from '../worker-service';
import { appendJsonl } from '../../lib/jsonl';
import { createHooksExecutedEvent, createErrorEvent } from '../../lib/events';
import { eventBus } from '../event-bus';
import { mkdir } from 'fs/promises';

const mockExecuteAgent = vi.mocked(executeAgent);
const mockGetPlan = vi.mocked(getPlan);
const mockGetItemConfig = vi.mocked(getItemConfig);
const mockCreateDraftPrsForAllRepos = vi.mocked(createDraftPrsForAllRepos);
const mockAppendJsonl = vi.mocked(appendJsonl);
const mockCreateHooksExecutedEvent = vi.mocked(createHooksExecutedEvent);
const mockCreateErrorEvent = vi.mocked(createErrorEvent);
const mockMkdir = vi.mocked(mkdir);

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

function makeItemConfig(repos: string[], hooks?: Record<string, string[]>) {
  return {
    id: ITEM_ID,
    title: 'Test Item',
    description: '',
    repositories: repos.map(name => ({
      name,
      url: `https://github.com/test/${name}`,
      branch: 'main',
      hooks: hooks?.[name],
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

function createGitProc(output: string = 'abc123') {
  const EventEmitter = require('events');
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  setTimeout(() => {
    proc.stdout.emit('data', output);
    proc.emit('close', 0);
  }, 0);
  return proc;
}

function createHookProc(exitCode: number, stdout: string = '', stderr: string = '') {
  const EventEmitter = require('events');
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  // Add pipe method for stream piping
  proc.stdout.pipe = vi.fn().mockReturnValue(proc.stdout);
  proc.stderr.pipe = vi.fn().mockReturnValue(proc.stderr);
  setTimeout(() => {
    if (stdout) proc.stdout.emit('data', stdout);
    if (stderr) proc.stderr.emit('data', stderr);
    proc.emit('close', exitCode);
  }, 0);
  return proc;
}

// ─── Setup spawn mock ───

function setupSpawnMock(hookResults: { exitCode: number; stdout?: string; stderr?: string }[]) {
  let hookCallIndex = 0;

  mockSpawn.mockImplementation((cmd: string, args: string[], _opts?: any) => {
    if (cmd === 'git') {
      if (args[0] === 'rev-parse') return createGitProc('abc123');
      if (args[0] === 'merge-base') return createGitProc('base123');
      if (args[0] === 'diff') {
        if (args.includes('--cached') && args.includes('--name-only')) return createGitProc('file.ts');
        if (args.includes('--name-status')) return createGitProc('M\tfile.ts');
        if (args.includes('--numstat')) return createGitProc('10\t5\tfile.ts');
        return createGitProc('diff content');
      }
      if (args[0] === 'show') return createGitProc('// file content');
      if (args[0] === 'cat-file') return createGitProc('1024');
      if (args[0] === 'add' || args[0] === 'reset' || args[0] === 'commit') return createGitProc('');
      return createGitProc('');
    }
    if (cmd === 'sh') {
      const result = hookResults[hookCallIndex] || { exitCode: 0 };
      hookCallIndex++;
      return createHookProc(result.exitCode, result.stdout, result.stderr);
    }
    return createGitProc('');
  });
}

// ─── Tests ───

describe('Worker hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should proceed to review when no hooks are configured', async () => {
    mockGetPlan.mockResolvedValue(makePlan(['repo-a']) as any);
    mockGetItemConfig.mockResolvedValue(makeItemConfig(['repo-a']) as any);
    setupSpawnMock([]);

    mockExecuteAgent
      .mockResolvedValueOnce(successResult() as any) // engineer
      .mockResolvedValueOnce({
        result: { output: { review_status: 'approve', comments: [] } },
      } as any); // reviewer

    await startWorkers(ITEM_ID);

    // hooks_executed event should not have been created
    expect(mockCreateHooksExecutedEvent).not.toHaveBeenCalled();
    // Should have called reviewer
    const reviewerCall = mockExecuteAgent.mock.calls.find(
      (call) => call[0].role === 'review'
    );
    expect(reviewerCall).toBeDefined();
  });

  it('should proceed to review when all hooks pass', async () => {
    mockGetPlan.mockResolvedValue(makePlan(['repo-a']) as any);
    mockGetItemConfig.mockResolvedValue(
      makeItemConfig(['repo-a'], { 'repo-a': ['npm run lint', 'npm test'] }) as any
    );
    setupSpawnMock([
      { exitCode: 0, stdout: 'lint ok' },
      { exitCode: 0, stdout: 'tests pass' },
    ]);

    mockExecuteAgent
      .mockResolvedValueOnce(successResult() as any) // engineer
      .mockResolvedValueOnce({
        result: { output: { review_status: 'approve', comments: [] } },
      } as any); // reviewer

    await startWorkers(ITEM_ID);

    expect(mockCreateHooksExecutedEvent).toHaveBeenCalledWith(
      ITEM_ID,
      'repo-a',
      expect.any(Array),
      true,  // allPassed
      1      // attempt
    );

    // Should have called reviewer
    const reviewerCall = mockExecuteAgent.mock.calls.find(
      (call) => call[0].role === 'review'
    );
    expect(reviewerCall).toBeDefined();
  });

  it('should retry with engineer fix when hooks fail, then succeed', async () => {
    mockGetPlan.mockResolvedValue(makePlan(['repo-a']) as any);
    mockGetItemConfig.mockResolvedValue(
      makeItemConfig(['repo-a'], { 'repo-a': ['npm test'] }) as any
    );

    // First hook run: fail, second hook run: pass
    setupSpawnMock([
      { exitCode: 1, stderr: 'test failed' },
      { exitCode: 0, stdout: 'tests pass' },
    ]);

    mockExecuteAgent
      .mockResolvedValueOnce(successResult() as any) // initial engineer
      .mockResolvedValueOnce(successResult() as any) // fix engineer
      .mockResolvedValueOnce({
        result: { output: { review_status: 'approve', comments: [] } },
      } as any); // reviewer

    await startWorkers(ITEM_ID);

    // hooks_executed should be called twice (attempt 1: fail, attempt 2: pass)
    expect(mockCreateHooksExecutedEvent).toHaveBeenCalledTimes(2);
    expect(mockCreateHooksExecutedEvent).toHaveBeenCalledWith(
      ITEM_ID, 'repo-a', expect.any(Array), false, 1
    );
    expect(mockCreateHooksExecutedEvent).toHaveBeenCalledWith(
      ITEM_ID, 'repo-a', expect.any(Array), true, 2
    );

    // Fix engineer should have been called
    expect(mockExecuteAgent).toHaveBeenCalledTimes(3);
  });

  it('should fire error event and skip review/PR when hooks fail after max retries', async () => {
    mockGetPlan.mockResolvedValue(makePlan(['repo-a']) as any);
    mockGetItemConfig.mockResolvedValue(
      makeItemConfig(['repo-a'], { 'repo-a': ['npm test'] }) as any
    );

    // All hook runs fail
    setupSpawnMock([
      { exitCode: 1, stderr: 'test failed attempt 1' },
      { exitCode: 1, stderr: 'test failed attempt 2' },
    ]);

    mockExecuteAgent
      .mockResolvedValueOnce(successResult() as any) // initial engineer
      .mockResolvedValueOnce(successResult() as any); // fix engineer

    await expect(startWorkers(ITEM_ID)).rejects.toThrow('All engineer agents failed');

    // Error event should have been created
    expect(mockCreateErrorEvent).toHaveBeenCalledWith(
      ITEM_ID,
      expect.stringContaining('Hooks validation failed for repo-a'),
      { repoName: 'repo-a', phase: 'hooks' }
    );

    // No reviewer should have been called
    const reviewerCall = mockExecuteAgent.mock.calls.find(
      (call) => call[0].role === 'review'
    );
    expect(reviewerCall).toBeUndefined();
  });

  it('should record HooksExecutedEvent with correct fields', async () => {
    mockGetPlan.mockResolvedValue(makePlan(['repo-a']) as any);
    mockGetItemConfig.mockResolvedValue(
      makeItemConfig(['repo-a'], { 'repo-a': ['echo ok'] }) as any
    );
    setupSpawnMock([{ exitCode: 0, stdout: 'ok' }]);

    mockExecuteAgent
      .mockResolvedValueOnce(successResult() as any) // engineer
      .mockResolvedValueOnce({
        result: { output: { review_status: 'approve', comments: [] } },
      } as any); // reviewer

    await startWorkers(ITEM_ID);

    expect(mockCreateHooksExecutedEvent).toHaveBeenCalledTimes(1);
    const [, repoName, , allPassed, attempt] = mockCreateHooksExecutedEvent.mock.calls[0];
    expect(repoName).toBe('repo-a');
    expect(allPassed).toBe(true);
    expect(attempt).toBe(1);

    // Event should be appended to jsonl
    expect(mockAppendJsonl).toHaveBeenCalledWith(
      '/events.jsonl',
      expect.objectContaining({ type: 'hooks_executed' })
    );
  });

  it('should skip PR creation for hooks-failed repos in multi-repo setup', async () => {
    mockGetPlan.mockResolvedValue(makePlan(['repo-a', 'repo-b']) as any);
    mockGetItemConfig.mockResolvedValue(
      makeItemConfig(['repo-a', 'repo-b'], { 'repo-a': ['exit 1'] }) as any
    );

    mockSpawn.mockImplementation((cmd: string, args: string[], _opts?: any) => {
      if (cmd === 'git') {
        if (args[0] === 'rev-parse') return createGitProc('abc123');
        if (args[0] === 'merge-base') return createGitProc('base123');
        if (args[0] === 'diff') {
          if (args.includes('--cached') && args.includes('--name-only')) return createGitProc('file.ts');
          if (args.includes('--name-status')) return createGitProc('M\tfile.ts');
          if (args.includes('--numstat')) return createGitProc('10\t5\tfile.ts');
          return createGitProc('diff content');
        }
        if (args[0] === 'show') return createGitProc('// file content');
        if (args[0] === 'cat-file') return createGitProc('1024');
        if (args[0] === 'add' || args[0] === 'reset' || args[0] === 'commit') return createGitProc('');
        return createGitProc('');
      }
      if (cmd === 'sh') {
        // All hook attempts fail
        return createHookProc(1, '', 'hook failed');
      }
      return createGitProc('');
    });

    mockExecuteAgent.mockResolvedValue(successResult() as any);

    // Should not throw because repo-b succeeds
    await startWorkers(ITEM_ID);

    // createDraftPrsForAllRepos should be called with only repo-b as successful
    expect(mockCreateDraftPrsForAllRepos).toHaveBeenCalledWith(
      ITEM_ID,
      expect.any(Set)
    );

    const successSet = mockCreateDraftPrsForAllRepos.mock.calls[0][1] as Set<string>;
    expect(successSet.has('repo-b')).toBe(true);
    expect(successSet.has('repo-a')).toBe(false);
  });

  it('fix prompt should not contain role promptTemplate', async () => {
    mockGetPlan.mockResolvedValue(makePlan(['repo-a']) as any);
    mockGetItemConfig.mockResolvedValue(
      makeItemConfig(['repo-a'], { 'repo-a': ['npm test'] }) as any
    );

    // First hook run: fail, second hook run: pass
    setupSpawnMock([
      { exitCode: 1, stderr: 'test failed' },
      { exitCode: 0, stdout: 'tests pass' },
    ]);

    mockExecuteAgent
      .mockResolvedValueOnce(successResult() as any) // initial engineer
      .mockResolvedValueOnce(successResult() as any) // fix engineer
      .mockResolvedValueOnce({
        result: { output: { review_status: 'approve', comments: [] } },
      } as any); // reviewer

    await startWorkers(ITEM_ID);

    // Fix engineer call should NOT contain promptTemplate
    const fixCall = mockExecuteAgent.mock.calls[1];
    expect(fixCall[0].prompt).not.toContain('You are an engineer.');
  });

  it('fix prompt should contain log file paths', async () => {
    mockGetPlan.mockResolvedValue(makePlan(['repo-a']) as any);
    mockGetItemConfig.mockResolvedValue(
      makeItemConfig(['repo-a'], { 'repo-a': ['npm test'] }) as any
    );

    setupSpawnMock([
      { exitCode: 1, stderr: 'test failed' },
      { exitCode: 0, stdout: 'tests pass' },
    ]);

    mockExecuteAgent
      .mockResolvedValueOnce(successResult() as any)
      .mockResolvedValueOnce(successResult() as any)
      .mockResolvedValueOnce({
        result: { output: { review_status: 'approve', comments: [] } },
      } as any);

    await startWorkers(ITEM_ID);

    const fixCall = mockExecuteAgent.mock.calls[1];
    expect(fixCall[0].prompt).toContain('.stdout.log');
    expect(fixCall[0].prompt).toContain('.stderr.log');
  });

  it('fix prompt should not embed raw hook output', async () => {
    mockGetPlan.mockResolvedValue(makePlan(['repo-a']) as any);
    mockGetItemConfig.mockResolvedValue(
      makeItemConfig(['repo-a'], { 'repo-a': ['npm test'] }) as any
    );

    setupSpawnMock([
      { exitCode: 1, stdout: 'UNIQUE_STDOUT_MARKER', stderr: 'UNIQUE_STDERR_MARKER' },
      { exitCode: 0, stdout: 'tests pass' },
    ]);

    mockExecuteAgent
      .mockResolvedValueOnce(successResult() as any)
      .mockResolvedValueOnce(successResult() as any)
      .mockResolvedValueOnce({
        result: { output: { review_status: 'approve', comments: [] } },
      } as any);

    await startWorkers(ITEM_ID);

    const fixCall = mockExecuteAgent.mock.calls[1];
    expect(fixCall[0].prompt).not.toContain('UNIQUE_STDOUT_MARKER');
    expect(fixCall[0].prompt).not.toContain('UNIQUE_STDERR_MARKER');
  });

  it('should handle hook with signal kill as failure', async () => {
    mockGetPlan.mockResolvedValue(makePlan(['repo-a']) as any);
    mockGetItemConfig.mockResolvedValue(
      makeItemConfig(['repo-a'], { 'repo-a': ['sleep 999'] }) as any
    );

    // Create a spawn mock that simulates process killed by signal
    mockSpawn.mockImplementation((cmd: string, args: string[], _opts?: any) => {
      if (cmd === 'git') {
        if (args[0] === 'rev-parse') return createGitProc('abc123');
        if (args[0] === 'merge-base') return createGitProc('base123');
        if (args[0] === 'diff') {
          if (args.includes('--cached') && args.includes('--name-only')) return createGitProc('file.ts');
          if (args.includes('--name-status')) return createGitProc('M\tfile.ts');
          if (args.includes('--numstat')) return createGitProc('10\t5\tfile.ts');
          return createGitProc('diff content');
        }
        if (args[0] === 'show') return createGitProc('// file content');
        if (args[0] === 'cat-file') return createGitProc('1024');
        if (args[0] === 'add' || args[0] === 'reset' || args[0] === 'commit') return createGitProc('');
        return createGitProc('');
      }
      if (cmd === 'sh') {
        const EventEmitter = require('events');
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stdout.pipe = vi.fn().mockReturnValue(proc.stdout);
        proc.stderr.pipe = vi.fn().mockReturnValue(proc.stderr);
        // Simulate process killed by signal (null exit code + signal)
        setTimeout(() => {
          proc.emit('close', null, 'SIGTERM');
        }, 0);
        return proc;
      }
      return createGitProc('');
    });

    mockExecuteAgent.mockResolvedValue(successResult() as any);

    await expect(startWorkers(ITEM_ID)).rejects.toThrow('All engineer agents failed');

    // Should have created hooks executed events with failures (null exitCode !== 0)
    expect(mockCreateHooksExecutedEvent).toHaveBeenCalled();
    const firstCall = mockCreateHooksExecutedEvent.mock.calls[0];
    expect(firstCall[3]).toBe(false); // allPassed = false
  });

  it('should run hooks after feedback engineer in review loop and continue to next review cycle', async () => {
    mockGetPlan.mockResolvedValue(makePlan(['repo-a']) as any);
    mockGetItemConfig.mockResolvedValue(
      makeItemConfig(['repo-a'], { 'repo-a': ['npm test'] }) as any
    );

    // Phase 1 hook: pass, Post-feedback hook: pass
    setupSpawnMock([
      { exitCode: 0, stdout: 'tests pass' },   // Phase 1 hook
      { exitCode: 0, stdout: 'tests pass' },   // Post-feedback hook
    ]);

    mockExecuteAgent
      .mockResolvedValueOnce(successResult() as any) // initial engineer
      .mockResolvedValueOnce({                       // reviewer cycle 1: request_changes
        result: { output: { review_status: 'request_changes', comments: [{ file: 'file.ts', line: 1, comment: 'fix this', severity: 'major' }] } },
      } as any)
      .mockResolvedValueOnce(successResult() as any) // feedback engineer
      .mockResolvedValueOnce({                       // reviewer cycle 2: approve
        result: { output: { review_status: 'approve', comments: [] } },
      } as any);

    await startWorkers(ITEM_ID);

    // createHooksExecutedEvent should be called 2 times (Phase 1 + Post-feedback)
    expect(mockCreateHooksExecutedEvent).toHaveBeenCalledTimes(2);

    // Review should have been called twice (review loop continued after post-feedback hooks passed)
    const reviewCalls = mockExecuteAgent.mock.calls.filter(call => call[0].role === 'review');
    expect(reviewCalls).toHaveLength(2);
  });

  it('should emit error event and still create PR when post-feedback hooks exhaust retries', async () => {
    mockGetPlan.mockResolvedValue(makePlan(['repo-a']) as any);
    mockGetItemConfig.mockResolvedValue(
      makeItemConfig(['repo-a'], { 'repo-a': ['npm test'] }) as any
    );

    // Phase 1 hook: pass, Post-feedback hooks: fail x2
    setupSpawnMock([
      { exitCode: 0, stdout: 'tests pass' },           // Phase 1 hook
      { exitCode: 1, stderr: 'test failed attempt 1' }, // Post-feedback hook attempt 1
      { exitCode: 1, stderr: 'test failed attempt 2' }, // Post-feedback hook attempt 2
    ]);

    mockExecuteAgent
      .mockResolvedValueOnce(successResult() as any) // initial engineer
      .mockResolvedValueOnce({                       // reviewer: request_changes
        result: { output: { review_status: 'request_changes', comments: [{ file: 'file.ts', line: 1, comment: 'fix this', severity: 'major' }] } },
      } as any)
      .mockResolvedValueOnce(successResult() as any) // feedback engineer
      .mockResolvedValueOnce(successResult() as any); // hook-fix engineer

    await startWorkers(ITEM_ID);

    // Error event should mention post-feedback hooks failure
    expect(mockCreateErrorEvent).toHaveBeenCalledWith(
      ITEM_ID,
      expect.stringContaining('Post-feedback hooks validation failed'),
      { repoName: 'repo-a', phase: 'hooks' }
    );

    // PR should still be created (repo-a should be in the set)
    expect(mockCreateDraftPrsForAllRepos).toHaveBeenCalledWith(
      ITEM_ID,
      expect.any(Set)
    );
    const successSet = mockCreateDraftPrsForAllRepos.mock.calls[0][1] as Set<string>;
    expect(successSet.has('repo-a')).toBe(true);
  });

  it('should use isolated log dir for post-feedback hooks', async () => {
    mockGetPlan.mockResolvedValue(makePlan(['repo-a']) as any);
    mockGetItemConfig.mockResolvedValue(
      makeItemConfig(['repo-a'], { 'repo-a': ['npm test'] }) as any
    );

    // Phase 1 hook: pass, Post-feedback hook: pass
    setupSpawnMock([
      { exitCode: 0, stdout: 'tests pass' }, // Phase 1 hook
      { exitCode: 0, stdout: 'tests pass' }, // Post-feedback hook
    ]);

    mockExecuteAgent
      .mockResolvedValueOnce(successResult() as any) // initial engineer
      .mockResolvedValueOnce({                       // reviewer: request_changes
        result: { output: { review_status: 'request_changes', comments: [{ file: 'file.ts', line: 1, comment: 'fix this', severity: 'major' }] } },
      } as any)
      .mockResolvedValueOnce(successResult() as any) // feedback engineer
      .mockResolvedValueOnce({                       // reviewer: approve
        result: { output: { review_status: 'approve', comments: [] } },
      } as any);

    await startWorkers(ITEM_ID);

    // Check that mkdir was called with a path containing feedback-cycle-1
    const mkdirCalls = mockMkdir.mock.calls.map(call => call[0]);
    const feedbackCycleDirs = mkdirCalls.filter(path =>
      typeof path === 'string' && path.includes('feedback-cycle-1')
    );
    expect(feedbackCycleDirs.length).toBeGreaterThan(0);
  });
});
