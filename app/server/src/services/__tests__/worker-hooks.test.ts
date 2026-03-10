import { describe, it, expect, vi, beforeEach } from 'vitest';

const taskStateStore = vi.hoisted(() => new Map<string, any>());
const gitMockState = vi.hoisted(() => ({
  currentHead: 'head-0',
  nextCommitId: 1,
  committedPaths: ['file.ts'] as string[],
  statusPorcelain: '',
  diffRanges: {} as Record<string, string[]>,
}));

// ─── Mocks ───

vi.mock('../agent-service', () => ({
  executeAgent: vi.fn(),
  getAgentsByItem: vi.fn().mockResolvedValue([]),
  stopAgent: vi.fn(),
}));

vi.mock('../planner-service', () => ({
  getPlan: vi.fn(),
}));

vi.mock('../task-state-service', () => ({
  ensureTaskStatesForPlan: vi.fn().mockImplementation(async (itemId: string, plan: any) => {
    for (const task of plan.tasks || []) {
      if (!taskStateStore.has(task.repository)) {
        taskStateStore.set(task.repository, {
          version: '1',
          itemId,
          repository: task.repository,
          planFingerprint: 'fingerprint',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          tasks: (plan.tasks || [])
            .filter((candidate: any) => candidate.repository === task.repository)
            .map((candidate: any) => ({
              id: candidate.id,
              title: candidate.title,
              dependencies: candidate.dependencies || [],
              status: 'pending',
              attempts: 0,
            })),
        });
      }
    }
    return [...taskStateStore.values()];
  }),
  readRepoTaskState: vi.fn().mockImplementation(async (_itemId: string, repoName: string) => {
    const state = taskStateStore.get(repoName);
    return state ? JSON.parse(JSON.stringify(state)) : null;
  }),
  writeRepoTaskState: vi.fn().mockImplementation(async (_itemId: string, state: any) => {
    taskStateStore.set(state.repository, JSON.parse(JSON.stringify(state)));
  }),
}));

vi.mock('../state-service', () => ({
  deriveRepoStatuses: vi.fn().mockResolvedValue(new Map()),
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
  createTaskStateChangedEvent: vi.fn().mockImplementation(
    (_itemId: string, repoName: string, taskId: string, status: string, currentPhase?: string) => ({
      type: 'task_state_changed',
      repoName,
      taskId,
      status,
      currentPhase,
    })
  ),
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
    allowedTools: ['Read', 'Write', 'Edit', 'Bash(git add:*)', 'Bash(git commit -m:*)', 'Bash(git status:*)'],
    jsonSchema: {},
  }),
  mergeAllowedTools: vi.fn().mockReturnValue(['Read', 'Write', 'Edit', 'Bash(git add:*)', 'Bash(git commit -m:*)', 'Bash(git status:*)']),
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

function makePlanFromTasks(tasks: Array<{
  id: string;
  title: string;
  repository: string;
  dependencies?: string[];
}>) {
  return {
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: 'desc',
      repository: task.repository,
      files: [],
      dependencies: task.dependencies || [],
    })),
  };
}

function makePlan(repos: string[]) {
  return makePlanFromTasks(
    repos.map((repoName, index) => ({
      id: `T${index + 1}`,
      title: `Task for ${repoName}`,
      repository: repoName,
    }))
  );
}

function makeItemConfig(
  repos: string[],
  hooks?: Record<string, string[]>,
  hooksMaxAttempts?: Record<string, unknown>
) {
  return {
    id: ITEM_ID,
    title: 'Test Item',
    description: '',
    repositories: repos.map(name => ({
      name,
      url: `https://github.com/test/${name}`,
      branch: 'main',
      hooks: hooks?.[name],
      hooksMaxAttempts: hooksMaxAttempts?.[name] as number | undefined,
    })),
  };
}

function simulateEngineerCommit(
  filesModified: string[] = ['file.ts'],
  options?: { dirtyStatus?: string; skipCommit?: boolean }
) {
  if (options?.skipCommit) {
    gitMockState.statusPorcelain = options.dirtyStatus || '';
    return;
  }

  const preCommitHead = gitMockState.currentHead;
  const commitHash = `head-${gitMockState.nextCommitId++}`;
  gitMockState.currentHead = commitHash;
  gitMockState.committedPaths = filesModified;
  gitMockState.diffRanges[`${preCommitHead}..${commitHash}`] = filesModified;
  gitMockState.statusPorcelain = options?.dirtyStatus || '';
}

function successResult(
  filesModified: string[] = ['file.ts'],
  options?: { dirtyStatus?: string; skipCommit?: boolean }
) {
  let applied = false;
  return {
    get result() {
      if (!applied) {
        simulateEngineerCommit(filesModified, options);
        applied = true;
      }
      return {
        output: { status: 'success' as const },
      };
    },
  };
}

function handleGitSpawn(args: string[]) {
  if (args[0] === 'rev-parse') return createGitProc(gitMockState.currentHead);
  if (args[0] === 'merge-base') return createGitProc('base123');
  if (args[0] === 'status' && args[1] === '--porcelain') return createGitProc(gitMockState.statusPorcelain);
  if (args[0] === 'diff') {
    const rangeKey = args[2] && args[3] ? `${args[2]}..${args[3]}` : '';
    const changedPaths = gitMockState.diffRanges[rangeKey] || gitMockState.committedPaths;
    if (args.includes('--name-only')) return createGitProc(changedPaths.join('\n'));
    if (args.includes('--name-status')) return createGitProc(changedPaths.map((path) => `M\t${path}`).join('\n'));
    if (args.includes('--numstat')) return createGitProc(changedPaths.map((path) => `10\t5\t${path}`).join('\n'));
    return createGitProc('diff content');
  }
  if (args[0] === 'show') return createGitProc('// file content');
  if (args[0] === 'cat-file') return createGitProc('1024');
  if (args[0] === 'reset' && args[1] === '--hard') {
    if (args[2] && args[2] !== 'HEAD') {
      gitMockState.currentHead = args[2];
    }
    gitMockState.statusPorcelain = '';
    return createGitProc('');
  }
  if (args[0] === 'clean' && args[1] === '-fd') {
    gitMockState.statusPorcelain = '';
    return createGitProc('');
  }
  return createGitProc('');
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
      return handleGitSpawn(args);
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
    taskStateStore.clear();
    gitMockState.currentHead = 'head-0';
    gitMockState.nextCommitId = 1;
    gitMockState.committedPaths = ['file.ts'];
    gitMockState.statusPorcelain = '';
    gitMockState.diffRanges = {};
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

    const repoState = taskStateStore.get('repo-a');
    expect(repoState.tasks[0]).toMatchObject({
      id: 'T1',
      status: 'completed',
    });
    expect(repoState.tasks[0].currentPhase).toBeUndefined();

    const taskStateEvents = vi.mocked(eventBus).publish.mock.calls
      .map(([, event]) => event)
      .filter((event: any) => event.type === 'task_state_changed');
    expect(taskStateEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repoName: 'repo-a', taskId: 'T1', status: 'in_review', currentPhase: 'hooks' }),
        expect.objectContaining({ repoName: 'repo-a', taskId: 'T1', status: 'in_review', currentPhase: 'review' }),
      ])
    );
  });

  it('should mark the current task failed when hooks fail after max retries', async () => {
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

    await expect(startWorkers(ITEM_ID)).resolves.toBeUndefined();

    expect(mockCreateErrorEvent).toHaveBeenCalledWith(
      ITEM_ID,
      expect.stringContaining('Hooks validation failed for repo-a'),
      { repoName: 'repo-a', phase: 'hooks' }
    );

    expect(taskStateStore.get('repo-a').tasks[0]).toMatchObject({
      id: 'T1',
      status: 'failed',
      currentPhase: 'hooks',
      lastError: 'Hooks validation failed for repo-a during task T1 after 2 attempts',
    });

    const reviewerCall = mockExecuteAgent.mock.calls.find(
      (call) => call[0].role === 'review'
    );
    expect(reviewerCall).toBeUndefined();
  });

  it('should respect hooksMaxAttempts=1', async () => {
    mockGetPlan.mockResolvedValue(makePlan(['repo-a']) as any);
    mockGetItemConfig.mockResolvedValue(
      makeItemConfig(['repo-a'], { 'repo-a': ['npm test'] }, { 'repo-a': 1 }) as any
    );

    setupSpawnMock([{ exitCode: 1, stderr: 'test failed attempt 1' }]);

    mockExecuteAgent.mockResolvedValueOnce(successResult() as any);

    await expect(startWorkers(ITEM_ID)).resolves.toBeUndefined();

    expect(mockCreateHooksExecutedEvent).toHaveBeenCalledTimes(1);
    expect(mockCreateErrorEvent).toHaveBeenCalledWith(
      ITEM_ID,
      expect.stringContaining('after 1 attempts'),
      { repoName: 'repo-a', phase: 'hooks' }
    );
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
  });

  it('should respect hooksMaxAttempts=3', async () => {
    mockGetPlan.mockResolvedValue(makePlan(['repo-a']) as any);
    mockGetItemConfig.mockResolvedValue(
      makeItemConfig(['repo-a'], { 'repo-a': ['npm test'] }, { 'repo-a': 3 }) as any
    );

    setupSpawnMock([
      { exitCode: 1, stderr: 'test failed attempt 1' },
      { exitCode: 1, stderr: 'test failed attempt 2' },
      { exitCode: 0, stdout: 'tests pass' },
    ]);

    mockExecuteAgent
      .mockResolvedValueOnce(successResult() as any)
      .mockResolvedValueOnce(successResult() as any)
      .mockResolvedValueOnce(successResult() as any)
      .mockResolvedValueOnce({
        result: { output: { review_status: 'approve', comments: [] } },
      } as any);

    await expect(startWorkers(ITEM_ID)).resolves.toBeUndefined();

    expect(mockCreateHooksExecutedEvent).toHaveBeenCalledTimes(3);
    expect(mockCreateHooksExecutedEvent).toHaveBeenNthCalledWith(
      3,
      ITEM_ID,
      'repo-a',
      expect.any(Array),
      true,
      3
    );
  });

  it('should fall back to the default hooksMaxAttempts when config is invalid', async () => {
    mockGetPlan.mockResolvedValue(makePlan(['repo-a']) as any);
    mockGetItemConfig.mockResolvedValue(
      makeItemConfig(['repo-a'], { 'repo-a': ['npm test'] }, { 'repo-a': 'invalid' }) as any
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

    await expect(startWorkers(ITEM_ID)).resolves.toBeUndefined();

    expect(mockCreateHooksExecutedEvent).toHaveBeenCalledTimes(2);
    expect(mockCreateHooksExecutedEvent).toHaveBeenCalledWith(
      ITEM_ID,
      'repo-a',
      expect.any(Array),
      true,
      2
    );
  });

  it('should continue to an independent later task in the same repo after hooks fail', async () => {
    mockGetPlan.mockResolvedValue(
      makePlanFromTasks([
        { id: 'T1', title: 'Task 1', repository: 'repo-a' },
        { id: 'T2', title: 'Task 2', repository: 'repo-a', dependencies: ['T1'] },
        { id: 'T3', title: 'Task 3', repository: 'repo-a' },
      ]) as any
    );
    mockGetItemConfig.mockResolvedValue(
      makeItemConfig(['repo-a'], { 'repo-a': ['npm test'] }) as any
    );

    setupSpawnMock([
      { exitCode: 1, stderr: 'test failed attempt 1' },
      { exitCode: 1, stderr: 'test failed attempt 2' },
      { exitCode: 0, stdout: 'tests pass' },
    ]);

    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      if (params.role === 'review') {
        return {
          result: { output: { review_status: 'approve', comments: [] } },
        } as any;
      }
      return successResult() as any;
    });

    await expect(startWorkers(ITEM_ID)).resolves.toBeUndefined();

    expect(taskStateStore.get('repo-a').tasks).toEqual([
      expect.objectContaining({ id: 'T1', status: 'failed', currentPhase: 'hooks' }),
      expect.objectContaining({ id: 'T2', status: 'pending' }),
      expect.objectContaining({ id: 'T3', status: 'completed' }),
    ]);
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

  it('should continue to later repos when an earlier task fails hooks', async () => {
    mockGetPlan.mockResolvedValue(makePlan(['repo-a', 'repo-b']) as any);
    mockGetItemConfig.mockResolvedValue(
      makeItemConfig(['repo-a', 'repo-b'], { 'repo-a': ['exit 1'] }) as any
    );

    mockSpawn.mockImplementation((cmd: string, args: string[], _opts?: any) => {
      if (cmd === 'git') {
        return handleGitSpawn(args);
      }
      if (cmd === 'sh') {
        // All hook attempts fail
        return createHookProc(1, '', 'hook failed');
      }
      return createGitProc('');
    });

    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      if (params.role === 'review') {
        return {
          result: { output: { review_status: 'approve', comments: [] } },
        } as any;
      }
      return successResult() as any;
    });

    await expect(startWorkers(ITEM_ID)).resolves.toBeUndefined();

    expect(mockCreateDraftPrsForAllRepos).toHaveBeenCalledWith(
      ITEM_ID,
      new Set(['repo-b'])
    );
    const engineerTaskCalls = mockExecuteAgent.mock.calls
      .filter((call) => call[0].role === 'engineer')
      .map((call) => call[0].currentTask);
    expect(engineerTaskCalls).toContain('T1: Task for repo-a');
    expect(engineerTaskCalls).toContain('T2: Task for repo-b');
    expect(taskStateStore.get('repo-a').tasks[0]).toMatchObject({ id: 'T1', status: 'failed' });
    expect(taskStateStore.get('repo-b').tasks[0]).toMatchObject({ id: 'T2', status: 'completed' });
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
    expect(fixCall[0].prompt).toContain('git add -A -- <paths>');
    expect(fixCall[0].prompt).toContain('git commit -m');
    expect(fixCall[0].prompt).toContain('Return {"status": "success"}');
    expect(fixCall[0].prompt).not.toContain('files_modified');
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
        return handleGitSpawn(args);
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

    await expect(startWorkers(ITEM_ID)).resolves.toBeUndefined();

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
    const reviewFixCalls = mockExecuteAgent.mock.calls.filter(call => call[0].currentTask === 'T1: review-fix');
    expect(reviewFixCalls).toHaveLength(1);
  });

  it('review-fix prompt should use self-commit instructions', async () => {
    mockGetPlan.mockResolvedValue(makePlan(['repo-a']) as any);
    mockGetItemConfig.mockResolvedValue(
      makeItemConfig(['repo-a'], { 'repo-a': ['npm test'] }) as any
    );

    setupSpawnMock([
      { exitCode: 0, stdout: 'tests pass' },
      { exitCode: 0, stdout: 'tests pass' },
    ]);

    mockExecuteAgent
      .mockResolvedValueOnce(successResult() as any)
      .mockResolvedValueOnce({
        result: { output: { review_status: 'request_changes', comments: [{ file: 'file.ts', line: 1, comment: 'fix this', severity: 'major' }] } },
      } as any)
      .mockResolvedValueOnce(successResult() as any)
      .mockResolvedValueOnce({
        result: { output: { review_status: 'approve', comments: [] } },
      } as any);

    await startWorkers(ITEM_ID);

    const reviewFixCall = mockExecuteAgent.mock.calls.find(call => call[0].currentTask === 'T1: review-fix');
    expect(reviewFixCall?.[0].prompt).toContain('git add -A -- <paths>');
    expect(reviewFixCall?.[0].prompt).toContain('git commit -m');
    expect(reviewFixCall?.[0].prompt).toContain('Return {"status": "success"}');
    expect(reviewFixCall?.[0].prompt).not.toContain('files_modified');
  });

  it('should allow three review cycles with two review-fix rounds before approval', async () => {
    mockGetPlan.mockResolvedValue(makePlan(['repo-a']) as any);
    mockGetItemConfig.mockResolvedValue(
      makeItemConfig(['repo-a'], { 'repo-a': ['npm test'] }) as any
    );

    setupSpawnMock([
      { exitCode: 0, stdout: 'tests pass' }, // Phase 1 hook
      { exitCode: 0, stdout: 'tests pass' }, // Post-feedback hook 1
      { exitCode: 0, stdout: 'tests pass' }, // Post-feedback hook 2
    ]);

    mockExecuteAgent
      .mockResolvedValueOnce(successResult() as any) // initial engineer
      .mockResolvedValueOnce({
        result: { output: { review_status: 'request_changes', comments: [{ file: 'file.ts', line: 1, comment: 'fix this', severity: 'major' }] } },
      } as any)
      .mockResolvedValueOnce(successResult() as any) // feedback engineer 1
      .mockResolvedValueOnce({
        result: { output: { review_status: 'request_changes', comments: [{ file: 'file.ts', line: 1, comment: 'fix this again', severity: 'major' }] } },
      } as any)
      .mockResolvedValueOnce(successResult() as any) // feedback engineer 2
      .mockResolvedValueOnce({
        result: { output: { review_status: 'approve', comments: [] } },
      } as any);

    await startWorkers(ITEM_ID);

    expect(mockCreateHooksExecutedEvent).toHaveBeenCalledTimes(3);
    const reviewCalls = mockExecuteAgent.mock.calls.filter(call => call[0].role === 'review');
    expect(reviewCalls).toHaveLength(3);
    const reviewFixCalls = mockExecuteAgent.mock.calls.filter(call => call[0].currentTask === 'T1: review-fix');
    expect(reviewFixCalls).toHaveLength(2);
    expect(taskStateStore.get('repo-a').tasks[0]).toMatchObject({
      id: 'T1',
      status: 'completed',
      reviewRounds: 2,
    });
  });

  it('should fail the task after the fourth review rejection exhausts feedback rounds', async () => {
    mockGetPlan.mockResolvedValue(makePlan(['repo-a']) as any);
    mockGetItemConfig.mockResolvedValue(
      makeItemConfig(['repo-a'], { 'repo-a': ['npm test'] }) as any
    );

    setupSpawnMock([
      { exitCode: 0, stdout: 'tests pass' }, // Phase 1 hook
      { exitCode: 0, stdout: 'tests pass' }, // Post-feedback hook 1
      { exitCode: 0, stdout: 'tests pass' }, // Post-feedback hook 2
      { exitCode: 0, stdout: 'tests pass' }, // Post-feedback hook 3
    ]);

    mockExecuteAgent
      .mockResolvedValueOnce(successResult() as any) // initial engineer
      .mockResolvedValueOnce({
        result: { output: { review_status: 'request_changes', comments: [{ file: 'file.ts', line: 1, comment: 'fix this', severity: 'major' }] } },
      } as any)
      .mockResolvedValueOnce(successResult() as any) // feedback engineer 1
      .mockResolvedValueOnce({
        result: { output: { review_status: 'request_changes', comments: [{ file: 'file.ts', line: 1, comment: 'fix this again', severity: 'major' }] } },
      } as any)
      .mockResolvedValueOnce(successResult() as any) // feedback engineer 2
      .mockResolvedValueOnce({
        result: { output: { review_status: 'request_changes', comments: [{ file: 'file.ts', line: 1, comment: 'still broken', severity: 'major' }] } },
      } as any)
      .mockResolvedValueOnce(successResult() as any) // feedback engineer 3
      .mockResolvedValueOnce({
        result: { output: { review_status: 'request_changes', comments: [{ file: 'file.ts', line: 1, comment: 'one more issue', severity: 'major' }] } },
      } as any);

    await expect(startWorkers(ITEM_ID)).rejects.toThrow('Review feedback rounds exhausted');

    const reviewCalls = mockExecuteAgent.mock.calls.filter(call => call[0].role === 'review');
    expect(reviewCalls).toHaveLength(4);
    const reviewFixCalls = mockExecuteAgent.mock.calls.filter(call => call[0].currentTask === 'T1: review-fix');
    expect(reviewFixCalls).toHaveLength(3);
    expect(mockCreateErrorEvent).toHaveBeenCalledWith(
      ITEM_ID,
      expect.stringContaining('Review feedback rounds exhausted'),
      { repoName: 'repo-a', phase: 'review' }
    );
    expect(mockCreateDraftPrsForAllRepos).not.toHaveBeenCalled();
    expect(taskStateStore.get('repo-a').tasks[0]).toMatchObject({
      id: 'T1',
      status: 'failed',
      currentPhase: 'review',
      reviewRounds: 3,
    });
  });

  it('should persist the union of files modified by engineer, hooks-fix, and review-fix', async () => {
    mockGetPlan.mockResolvedValue(makePlan(['repo-a']) as any);
    mockGetItemConfig.mockResolvedValue(
      makeItemConfig(['repo-a'], { 'repo-a': ['npm test'] }) as any
    );

    setupSpawnMock([
      { exitCode: 1, stderr: 'hook failed' },  // initial hooks
      { exitCode: 0, stdout: 'hook ok' },      // after hooks-fix
      { exitCode: 0, stdout: 'hook ok' },      // after review-fix
    ]);

    mockExecuteAgent
      .mockResolvedValueOnce(successResult(['engineer.ts']) as any)
      .mockResolvedValueOnce(successResult(['hooks-fix.ts']) as any)
      .mockResolvedValueOnce({
        result: {
          output: {
            review_status: 'request_changes',
            comments: [{ file: 'file.ts', line: 1, comment: 'fix this', severity: 'major' }],
          },
        },
      } as any)
      .mockResolvedValueOnce(successResult(['review-fix.ts']) as any)
      .mockResolvedValueOnce({
        result: { output: { review_status: 'approve', comments: [] } },
      } as any);

    await startWorkers(ITEM_ID);

    expect(taskStateStore.get('repo-a').tasks[0]).toMatchObject({
      id: 'T1',
      status: 'completed',
      filesModified: expect.arrayContaining(['engineer.ts', 'hooks-fix.ts', 'review-fix.ts']),
    });
  });

  it('should mark the task failed when hooks exhaust retries after review-fix', async () => {
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

    await expect(startWorkers(ITEM_ID)).resolves.toBeUndefined();

    expect(mockCreateErrorEvent).toHaveBeenCalledWith(
      ITEM_ID,
      expect.stringContaining('Hooks validation failed for repo-a during task T1'),
      { repoName: 'repo-a', phase: 'hooks' }
    );

    expect(mockCreateDraftPrsForAllRepos).not.toHaveBeenCalled();
    expect(taskStateStore.get('repo-a').tasks[0]).toMatchObject({
      id: 'T1',
      status: 'failed',
      currentPhase: 'hooks',
    });
  });

  it('should resume an in-review task without rerunning engineer', async () => {
    mockGetPlan.mockResolvedValue(makePlan(['repo-a']) as any);
    mockGetItemConfig.mockResolvedValue(
      makeItemConfig(['repo-a'], { 'repo-a': ['npm test'] }) as any
    );
    setupSpawnMock([{ exitCode: 0, stdout: 'tests pass' }]);

    taskStateStore.set('repo-a', {
      version: '1',
      itemId: ITEM_ID,
      repository: 'repo-a',
      planFingerprint: 'fingerprint',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      tasks: [
        {
          id: 'T1',
          title: 'Task for repo-a',
          dependencies: [],
          status: 'in_review',
          attempts: 1,
          phaseBase: 'phase-base-123',
          reviewRounds: 0,
          filesModified: ['file.ts'],
        },
      ],
    });

    mockExecuteAgent.mockResolvedValueOnce({
      result: { output: { review_status: 'approve', comments: [] } },
    } as any);

    await startWorkers(ITEM_ID);

    const engineerTaskCalls = mockExecuteAgent.mock.calls.filter(
      (call) => call[0].role === 'engineer' && String(call[0].currentTask || '').startsWith('T')
    );
    expect(engineerTaskCalls).toHaveLength(0);
    expect(mockExecuteAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'review',
        repoName: 'repo-a',
        currentTask: 'T1: review',
      })
    );
    expect(mockCreateDraftPrsForAllRepos).toHaveBeenCalledWith(
      ITEM_ID,
      new Set(['repo-a'])
    );
  });

  it('should use isolated log dir per review round', async () => {
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

    // Check that mkdir was called with a path containing review-round-2
    const mkdirCalls = mockMkdir.mock.calls.map(call => call[0]);
    const feedbackCycleDirs = mkdirCalls.filter(path =>
      typeof path === 'string' && path.includes('review-round-2')
    );
    expect(feedbackCycleDirs.length).toBeGreaterThan(0);
  });
});
