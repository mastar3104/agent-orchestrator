import { beforeEach, describe, expect, it, vi } from 'vitest';

const taskStateStore = vi.hoisted(() => new Map<string, any>());
const gitMockState = vi.hoisted(() => ({
  currentHead: 'head-0',
  nextCommitId: 1,
  committedPaths: ['file.ts'] as string[],
  statusPorcelain: '',
  diffRanges: {} as Record<string, string[]>,
}));
const mockSpawn = vi.hoisted(() => vi.fn());

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
    return [...taskStateStore.values()].map((state) => JSON.parse(JSON.stringify(state)));
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
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('version: "1"\nitemId: ITEM-test\nsummary: test\ntasks:\n  - id: T1'),
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
  createTaskStateChangedEvent: vi.fn().mockImplementation(
    (_itemId: string, repoName: string, taskId: string, status: string, currentPhase?: string) => ({
      type: 'task_state_changed',
      repoName,
      taskId,
      status,
      currentPhase,
    })
  ),
  createErrorEvent: vi.fn().mockImplementation(
    (_itemId: string, message: string, meta?: Record<string, unknown>) => ({
      type: 'error',
      message,
      ...meta,
    })
  ),
}));

vi.mock('../../lib/role-loader', () => ({
  getRole: vi.fn().mockImplementation((role: string) => {
    if (role === 'reviewer') {
      return {
        promptTemplate: 'You are a reviewer.',
        allowedTools: ['Read'],
        jsonSchema: {},
      };
    }
    return {
      promptTemplate: [
        'You are an engineer.',
        'Stage and commit your intentional changes before returning JSON.',
        'Run `git add -A -- <paths>` for the intentional changes you want to keep.',
        'Run `git commit -m "<descriptive message>"` yourself.',
        'Ensure `git status --porcelain` is empty before you return.',
        'Return {"status": "success"}.',
      ].join('\n'),
      allowedTools: ['Read', 'Write', 'Edit', 'Bash(git add:*)', 'Bash(git commit -m:*)', 'Bash(git status:*)'],
      jsonSchema: {},
    };
  }),
  mergeAllowedTools: vi.fn().mockReturnValue(['Read', 'Write', 'Edit', 'Bash(git add:*)', 'Bash(git commit -m:*)', 'Bash(git status:*)']),
}));

vi.mock('child_process', () => {
  const EventEmitter = require('events');
  return {
    spawn: mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setTimeout(() => {
        if (args[0] === 'rev-parse') {
          proc.stdout.emit('data', gitMockState.currentHead);
        } else if (args[0] === 'merge-base') {
          proc.stdout.emit('data', 'merge-base-123');
        } else if (args[0] === 'status' && args[1] === '--porcelain') {
          proc.stdout.emit('data', gitMockState.statusPorcelain);
        } else if (args[0] === 'diff') {
          const rangeKey = args[2] && args[3] ? `${args[2]}..${args[3]}` : '';
          const changedPaths = gitMockState.diffRanges[rangeKey] || gitMockState.committedPaths;
          if (args.includes('--name-only')) {
            proc.stdout.emit('data', changedPaths.join('\n'));
          } else if (args.includes('--name-status')) {
            proc.stdout.emit('data', changedPaths.map((path) => `M\t${path}`).join('\n'));
          } else if (args.includes('--numstat')) {
            proc.stdout.emit('data', changedPaths.map((path) => `10\t5\t${path}`).join('\n'));
          } else {
            proc.stdout.emit('data', 'diff content');
          }
        } else if (args[0] === 'show') {
          proc.stdout.emit('data', '// file content');
        } else if (args[0] === 'cat-file') {
          proc.stdout.emit('data', '1024');
        } else if (args[0] === 'reset' && args[1] === '--hard') {
          if (args[2] && args[2] !== 'HEAD') {
            gitMockState.currentHead = args[2];
          }
          gitMockState.statusPorcelain = '';
        } else if (args[0] === 'clean' && args[1] === '-fd') {
          gitMockState.statusPorcelain = '';
        }
        proc.emit('close', 0);
      }, 0);
      return proc;
    }),
  };
});

import { executeAgent } from '../agent-service';
import { createDraftPrsForAllRepos } from '../git-pr-service';
import { getItemConfig } from '../item-service';
import { getPlan } from '../planner-service';
import { eventBus } from '../event-bus';
import { startWorkers } from '../worker-service';

const mockExecuteAgent = vi.mocked(executeAgent);
const mockCreateDraftPrsForAllRepos = vi.mocked(createDraftPrsForAllRepos);
const mockGetItemConfig = vi.mocked(getItemConfig);
const mockGetPlan = vi.mocked(getPlan);
const mockEventBus = vi.mocked(eventBus);

const ITEM_ID = 'ITEM-test';

function makePlan(tasks: Array<{
  id: string;
  title?: string;
  repository?: string;
  description?: string;
  dependencies?: string[];
  files?: string[];
}>) {
  return {
    version: '1',
    itemId: ITEM_ID,
    summary: 'Test plan',
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title || `Task ${task.id}`,
      description: task.description || `${task.id} description`,
      repository: task.repository || 'repo-a',
      files: task.files || [],
      dependencies: task.dependencies || [],
    })),
  };
}

function makeItemConfig(repos: string[]) {
  return {
    id: ITEM_ID,
    title: 'Test Item',
    description: '',
    repositories: repos.map((name) => ({
      name,
      url: `https://github.com/test/${name}`,
      branch: 'main',
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

function engineerSuccess(
  filesModified: string[] = ['file.ts'],
  options?: { dirtyStatus?: string; skipCommit?: boolean; sessionId?: string }
) {
  let applied = false;
  return {
    agent: {} as any,
    get result() {
      if (!applied) {
        simulateEngineerCommit(filesModified, options);
        applied = true;
      }
      return {
        output: {
          status: 'success' as const,
        },
        sessionId: options?.sessionId ?? 'session-1',
      };
    },
  };
}

function engineerFailure() {
  return {
    agent: {} as any,
    result: {
      output: {
        status: 'failure' as const,
      },
    },
  };
}

function reviewApprove() {
  return {
    agent: {} as any,
    result: {
      output: {
        review_status: 'approve' as const,
        comments: [],
      },
    },
  };
}

function reviewRequestChanges(comment: string = 'fix this') {
  return {
    agent: {} as any,
    result: {
      output: {
        review_status: 'request_changes' as const,
        comments: [
          {
            file: 'file.ts',
            line: 1,
            comment,
            severity: 'major',
          },
        ],
      },
    },
  };
}

function getRepoTaskState(repoName: string) {
  return taskStateStore.get(repoName);
}

describe('Worker task-state execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskStateStore.clear();
    gitMockState.currentHead = 'head-0';
    gitMockState.nextCommitId = 1;
    gitMockState.committedPaths = ['file.ts'];
    gitMockState.statusPorcelain = '';
    gitMockState.diffRanges = {};
    mockGetPlan.mockResolvedValue(
      makePlan([{ id: 'T1', title: 'Task 1', repository: 'repo-a' }]) as any
    );
    mockGetItemConfig.mockResolvedValue(makeItemConfig(['repo-a']) as any);
  });

  it('runs engineer one task at a time with single-task prompts', async () => {
    mockGetPlan.mockResolvedValue(
      makePlan([
        { id: 'T1', title: 'Task 1', repository: 'repo-a' },
        { id: 'T2', title: 'Task 2', repository: 'repo-a' },
      ]) as any
    );

    const engineerPrompts: string[] = [];
    const currentTasks: string[] = [];
    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      if (params.role === 'engineer') {
        engineerPrompts.push(params.prompt);
        currentTasks.push(params.currentTask);
        return engineerSuccess();
      }
      if (params.role === 'review') {
        return reviewApprove();
      }
      throw new Error(`Unexpected role: ${params.role}`);
    });

    await startWorkers(ITEM_ID);

    expect(currentTasks).toEqual(['T1: Task 1', 'T2: Task 2']);
    expect(engineerPrompts[0]).toContain('### Task: T1 - Task 1');
    expect(engineerPrompts[0]).not.toContain('### Task: T2 - Task 2');
    expect(engineerPrompts[1]).toContain('### Task: T2 - Task 2');
    expect(engineerPrompts[1]).not.toContain('### Task: T1 - Task 1');
    expect(engineerPrompts[0]).toContain('git add -A -- <paths>');
    expect(engineerPrompts[0]).toContain('git commit -m');
    expect(engineerPrompts[0]).toContain('Return {"status": "success"}');
    expect(engineerPrompts[0]).not.toContain('files_modified');
  });

  it('respects dependencies even when dependent tasks appear first in plan order', async () => {
    mockGetPlan.mockResolvedValue(
      makePlan([
        { id: 'T2', title: 'Task 2', repository: 'repo-a', dependencies: ['T1'] },
        { id: 'T1', title: 'Task 1', repository: 'repo-a' },
      ]) as any
    );

    const currentTasks: string[] = [];
    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      if (params.role === 'engineer') {
        currentTasks.push(params.currentTask);
        return engineerSuccess();
      }
      if (params.role === 'review') {
        return reviewApprove();
      }
      throw new Error(`Unexpected role: ${params.role}`);
    });

    await startWorkers(ITEM_ID);

    expect(currentTasks).toEqual(['T1: Task 1', 'T2: Task 2']);
  });

  it('retries a failed task inside the same run without changing the persisted task attempt count', async () => {
    let attempts = 0;
    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      if (params.role === 'engineer') {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('timeout');
        }
        return engineerSuccess();
      }
      if (params.role === 'review') {
        return reviewApprove();
      }
      throw new Error(`Unexpected role: ${params.role}`);
    });

    await startWorkers(ITEM_ID);

    const state = getRepoTaskState('repo-a');
    expect(attempts).toBe(2);
    expect(state.tasks[0]).toMatchObject({
      id: 'T1',
      status: 'completed',
      attempts: 1,
    });
  });

  it('stores the committed file list from git diff after the agent commit', async () => {
    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      if (params.role === 'engineer') {
        return engineerSuccess(['committed.ts']);
      }
      if (params.role === 'review') {
        return reviewApprove();
      }
      throw new Error(`Unexpected role: ${params.role}`);
    });

    await startWorkers(ITEM_ID);

    expect(getRepoTaskState('repo-a').tasks[0]).toMatchObject({
      id: 'T1',
      status: 'completed',
      filesModified: ['committed.ts'],
    });
  });

  it('treats clean success without a commit as no-op success and skips review', async () => {
    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      if (params.role === 'engineer') {
        return engineerSuccess(['src/a.ts', 'src/b.ts'], { skipCommit: true });
      }
      if (params.role === 'review') {
        throw new Error('Reviewer should not run for clean no-op success');
      }
      throw new Error(`Unexpected role: ${params.role}`);
    });

    await startWorkers(ITEM_ID);

    expect(getRepoTaskState('repo-a').tasks[0]).toMatchObject({
      id: 'T1',
      status: 'completed',
      commitHash: 'head-0',
    });
    const reviewerCall = mockExecuteAgent.mock.calls.find((call) => call[0].role === 'review');
    expect(reviewerCall).toBeUndefined();
  });

  it('reuses the same session to resolve dirty no-commit success with a follow-up commit', async () => {
    const resumeSessionIds: Array<string | undefined> = [];
    let engineerCalls = 0;

    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      if (params.role === 'engineer') {
        engineerCalls += 1;
        if (engineerCalls === 1) {
          expect(params.resumeSessionId).toBeUndefined();
          return engineerSuccess(['src/a.ts'], {
            skipCommit: true,
            dirtyStatus: ' M src/a.ts',
            sessionId: 'session-dirty-1',
          });
        }
        if (engineerCalls === 2) {
          resumeSessionIds.push(params.resumeSessionId);
          return engineerSuccess(['src/fixed.ts']);
        }
      }
      if (params.role === 'review') {
        return reviewApprove();
      }
      throw new Error(`Unexpected role/currentTask: ${params.role}/${params.currentTask}`);
    });

    await startWorkers(ITEM_ID);

    expect(resumeSessionIds).toEqual(['session-dirty-1']);
    expect(getRepoTaskState('repo-a').tasks[0]).toMatchObject({
      id: 'T1',
      status: 'completed',
      filesModified: ['src/fixed.ts'],
    });
  });

  it('treats dirty no-commit success as no-op when the same-session follow-up cleans the worktree', async () => {
    let engineerCalls = 0;

    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      if (params.role === 'engineer') {
        engineerCalls += 1;
        if (engineerCalls === 1) {
          return engineerSuccess(['src/a.ts'], {
            skipCommit: true,
            dirtyStatus: ' M src/a.ts',
            sessionId: 'session-dirty-2',
          });
        }
        if (engineerCalls === 2) {
          expect(params.resumeSessionId).toBe('session-dirty-2');
          return engineerSuccess(['src/a.ts'], { skipCommit: true });
        }
      }
      if (params.role === 'review') {
        throw new Error('Reviewer should not run when follow-up resolves to a no-op');
      }
      throw new Error(`Unexpected role/currentTask: ${params.role}/${params.currentTask}`);
    });

    await startWorkers(ITEM_ID);

    expect(engineerCalls).toBe(2);
    expect(gitMockState.currentHead).toBe('head-0');
    expect(gitMockState.statusPorcelain).toBe('');
    expect(getRepoTaskState('repo-a').tasks[0]).toMatchObject({
      id: 'T1',
      status: 'completed',
      commitHash: 'head-0',
    });
  });

  it('falls back to a fresh follow-up and resets to baseline when dirty no-commit success stays unresolved', async () => {
    const resumeSessionIds: Array<string | undefined> = [];
    let engineerCalls = 0;

    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      if (params.role === 'engineer') {
        engineerCalls += 1;
        if (engineerCalls === 1) {
          return engineerSuccess(['src/a.ts'], {
            skipCommit: true,
            dirtyStatus: ' M src/a.ts',
            sessionId: 'session-dirty-3',
          });
        }
        if (engineerCalls === 2) {
          resumeSessionIds.push(params.resumeSessionId);
          throw new Error('same-session follow-up failed');
        }
        if (engineerCalls === 3) {
          resumeSessionIds.push(params.resumeSessionId);
          return engineerFailure();
        }
      }
      if (params.role === 'review') {
        throw new Error('Reviewer should not run when unresolved dirty changes are reset to no-op');
      }
      throw new Error(`Unexpected role/currentTask: ${params.role}/${params.currentTask}`);
    });

    await startWorkers(ITEM_ID);

    expect(resumeSessionIds).toEqual(['session-dirty-3', undefined]);
    expect(gitMockState.currentHead).toBe('head-0');
    expect(gitMockState.statusPorcelain).toBe('');
    expect(getRepoTaskState('repo-a').tasks[0]).toMatchObject({
      id: 'T1',
      status: 'completed',
      commitHash: 'head-0',
    });
  });

  it('fails the attempt when the engineer reports failure', async () => {
    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      if (params.role === 'engineer') {
        return engineerFailure();
      }
      if (params.role === 'review') {
        return reviewApprove();
      }
      throw new Error(`Unexpected role: ${params.role}`);
    });

    await expect(startWorkers(ITEM_ID)).rejects.toThrow('Engineer reported failure');
  });

  it('fails the attempt when the engineer leaves a dirty worktree', async () => {
    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      if (params.role === 'engineer') {
        return engineerSuccess(['src/a.ts'], { dirtyStatus: ' M src/a.ts' });
      }
      if (params.role === 'review') {
        return reviewApprove();
      }
      throw new Error(`Unexpected role: ${params.role}`);
    });

    await expect(startWorkers(ITEM_ID)).rejects.toThrow('Engineer left dirty worktree');
  });

  it('rolls failed attempts back to preAttemptHead before retrying', async () => {
    let attempts = 0;
    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      if (params.role === 'engineer') {
        attempts += 1;
        if (attempts === 1) {
          return engineerSuccess(['broken.ts'], { dirtyStatus: ' M broken.ts' });
        }
        expect(gitMockState.currentHead).toBe('head-0');
        return engineerSuccess(['fixed.ts']);
      }
      if (params.role === 'review') {
        return reviewApprove();
      }
      throw new Error(`Unexpected role: ${params.role}`);
    });

    await startWorkers(ITEM_ID);

    const gitCalls = mockSpawn.mock.calls
      .filter(([cmd]) => cmd === 'git')
      .map(([, args]) => args as string[]);
    const resetCalls = gitCalls.filter((args) => args[0] === 'reset' && args[1] === '--hard');
    const cleanCalls = gitCalls.filter((args) => args[0] === 'clean' && args[1] === '-fd');

    expect(attempts).toBe(2);
    expect(resetCalls.some((args) => args[2] === 'head-0')).toBe(true);
    expect(cleanCalls.length).toBeGreaterThan(0);
    expect(getRepoTaskState('repo-a').tasks[0]).toMatchObject({
      id: 'T1',
      status: 'completed',
      filesModified: ['fixed.ts'],
    });
  });

  it('mode=all skips failed tasks and continues with later runnable tasks', async () => {
    mockGetPlan.mockResolvedValue(
      makePlan([
        { id: 'T1', title: 'Task 1', repository: 'repo-a' },
        { id: 'T2', title: 'Task 2', repository: 'repo-a', dependencies: ['T1'] },
        { id: 'T3', title: 'Task 3', repository: 'repo-a' },
      ]) as any
    );

    let t1Attempts = 0;
    const currentTasks: string[] = [];
    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      if (params.role === 'engineer') {
        currentTasks.push(params.currentTask);
        if (params.currentTask === 'T1: Task 1' && t1Attempts < 3) {
          t1Attempts += 1;
          throw new Error('boom');
        }
        return engineerSuccess();
      }
      if (params.role === 'review') {
        return reviewApprove();
      }
      throw new Error(`Unexpected role: ${params.role}`);
    });

    await expect(startWorkers(ITEM_ID)).rejects.toThrow('Task T1 failed for repo-a: boom');

    expect(getRepoTaskState('repo-a').tasks).toEqual([
      expect.objectContaining({ id: 'T1', status: 'failed', attempts: 1 }),
      expect.objectContaining({ id: 'T2', status: 'pending', attempts: 0 }),
      expect.objectContaining({ id: 'T3', status: 'pending', attempts: 0 }),
    ]);

    currentTasks.length = 0;
    await expect(startWorkers(ITEM_ID, { mode: 'all' })).rejects.toThrow('No runnable tasks remain for item');

    expect(getRepoTaskState('repo-a').tasks).toEqual([
      expect.objectContaining({ id: 'T1', status: 'failed', attempts: 1 }),
      expect.objectContaining({ id: 'T2', status: 'pending', attempts: 0 }),
      expect.objectContaining({ id: 'T3', status: 'completed', attempts: 1 }),
    ]);
    expect(currentTasks).toEqual(['T3: Task 3']);
  });

  it('retry_failed reruns only failed tasks and leaves unrelated pending tasks untouched', async () => {
    mockGetPlan.mockResolvedValue(
      makePlan([
        { id: 'T1', title: 'Task 1', repository: 'repo-a' },
        { id: 'T2', title: 'Task 2', repository: 'repo-a', dependencies: ['T1'] },
        { id: 'T3', title: 'Task 3', repository: 'repo-a' },
      ]) as any
    );

    let t1Attempts = 0;
    const currentTasks: string[] = [];
    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      if (params.role === 'engineer') {
        currentTasks.push(params.currentTask);
        if (params.currentTask === 'T1: Task 1' && t1Attempts < 3) {
          t1Attempts += 1;
          throw new Error('boom');
        }
        return engineerSuccess();
      }
      if (params.role === 'review') {
        return reviewApprove();
      }
      throw new Error(`Unexpected role: ${params.role}`);
    });

    await expect(startWorkers(ITEM_ID)).rejects.toThrow('Task T1 failed for repo-a: boom');

    currentTasks.length = 0;
    await expect(startWorkers(ITEM_ID, { mode: 'retry_failed' })).resolves.toBeUndefined();

    expect(getRepoTaskState('repo-a').tasks).toEqual([
      expect.objectContaining({ id: 'T1', status: 'completed', attempts: 2 }),
      expect.objectContaining({ id: 'T2', status: 'pending', attempts: 0 }),
      expect.objectContaining({ id: 'T3', status: 'pending', attempts: 0 }),
    ]);
    expect(currentTasks).toEqual(['T1: Task 1']);
  });

  it('normalizes stale in-progress tasks to failed and skips them', async () => {
    mockGetPlan.mockResolvedValue(
      makePlan([{ id: 'T1', title: 'Task 1', repository: 'repo-a' }]) as any
    );

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
          title: 'Task 1',
          dependencies: [],
          status: 'in_progress',
          attempts: 1,
          lastStartedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      throw new Error('Should not execute any agents');
    });

    // Should throw because no runnable tasks remain (stale in_progress normalized to failed and skipped)
    await expect(startWorkers(ITEM_ID)).rejects.toThrow('No runnable tasks remain for item');

    expect(getRepoTaskState('repo-a').tasks[0]).toMatchObject({
      id: 'T1',
      status: 'failed',
      attempts: 1,
      lastError: 'Interrupted before completion',
    });
  });

  it('retries feedback engineer once and continues the review loop on success', async () => {
    let reviewAttempts = 0;
    let feedbackAttempts = 0;
    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      if (params.role === 'engineer' && params.currentTask === 'T1: Task 1') {
        return engineerSuccess();
      }
      if (params.role === 'review') {
        reviewAttempts += 1;
        return reviewAttempts === 1 ? reviewRequestChanges() : reviewApprove();
      }
      if (params.role === 'engineer' && params.currentTask === 'T1: review-fix') {
        feedbackAttempts += 1;
        if (feedbackAttempts === 1) {
          throw new Error('feedback fail');
        }
        return engineerSuccess();
      }
      throw new Error(`Unexpected role/currentTask: ${params.role}/${params.currentTask}`);
    });

    await startWorkers(ITEM_ID);

    expect(feedbackAttempts).toBe(2);
    expect(reviewAttempts).toBe(2);
  });

  it('uses self-commit instructions in the review-fix prompt', async () => {
    let reviewCalls = 0;
    let reviewFixPrompt = '';
    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      if (params.role === 'engineer' && params.currentTask === 'T1: Task 1') {
        return engineerSuccess();
      }
      if (params.role === 'review') {
        reviewCalls += 1;
        return reviewCalls === 1 ? reviewRequestChanges() : reviewApprove();
      }
      if (params.role === 'engineer' && params.currentTask === 'T1: review-fix') {
        reviewFixPrompt = params.prompt;
        return engineerSuccess();
      }
      throw new Error(`Unexpected role/currentTask: ${params.role}/${params.currentTask}`);
    });

    await startWorkers(ITEM_ID);

    expect(reviewFixPrompt).toContain('git add -A -- <paths>');
    expect(reviewFixPrompt).toContain('git commit -m');
    expect(reviewFixPrompt).toContain('Return {"status": "success"}');
    expect(reviewFixPrompt).not.toContain('files_modified');
  });

  it('fails the run when feedback engineer exhausts its retries', async () => {
    let feedbackAttempts = 0;
    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      if (params.role === 'engineer' && params.currentTask === 'T1: Task 1') {
        return engineerSuccess();
      }
      if (params.role === 'review') {
        return reviewRequestChanges();
      }
      if (params.role === 'engineer' && params.currentTask === 'T1: review-fix') {
        feedbackAttempts += 1;
        throw new Error(`feedback fail ${feedbackAttempts}`);
      }
      throw new Error(`Unexpected role/currentTask: ${params.role}/${params.currentTask}`);
    });

    await expect(startWorkers(ITEM_ID)).rejects.toThrow(
      'Review feedback handling failed for repo-a during task T1'
    );

    expect(feedbackAttempts).toBe(3);
    expect(mockCreateDraftPrsForAllRepos).not.toHaveBeenCalled();
  });

  it('does not run an extra review-fix after the last feedback round', async () => {
    let reviewCalls = 0;
    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      if (params.role === 'engineer' && params.currentTask === 'T1: Task 1') {
        return engineerSuccess();
      }
      if (params.role === 'review') {
        reviewCalls += 1;
        return reviewRequestChanges(`fix ${reviewCalls}`);
      }
      if (params.role === 'engineer' && params.currentTask === 'T1: review-fix') {
        return engineerSuccess();
      }
      throw new Error(`Unexpected role/currentTask: ${params.role}/${params.currentTask}`);
    });

    await expect(startWorkers(ITEM_ID)).rejects.toThrow(
      'Review feedback rounds exhausted for repo-a during task T1 after 3 rounds'
    );

    expect(reviewCalls).toBe(4);
    expect(getRepoTaskState('repo-a').tasks[0]).toMatchObject({
      id: 'T1',
      status: 'failed',
    });
    const lastCall = mockExecuteAgent.mock.calls[mockExecuteAgent.mock.calls.length - 1];
    expect(lastCall[0].role).toBe('review');
    expect(lastCall[0].currentTask).toBe('T1: review');
    const reviewFixCalls = mockExecuteAgent.mock.calls.filter(
      (call) => call[0].currentTask === 'T1: review-fix'
    );
    expect(reviewFixCalls).toHaveLength(3);
  });

  it('resumes an in-review task from hooks and reviewer without rerunning engineer', async () => {
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
          title: 'Task 1',
          dependencies: [],
          status: 'in_review',
          attempts: 1,
          phaseBase: 'phase-base-123',
          reviewRounds: 0,
          filesModified: ['file.ts'],
        },
      ],
    });

    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      if (params.role === 'review') {
        return reviewApprove();
      }
      throw new Error(`Unexpected role/currentTask: ${params.role}/${params.currentTask}`);
    });

    await startWorkers(ITEM_ID);

    const engineerTaskCalls = mockExecuteAgent.mock.calls.filter((call) => call[0].role === 'engineer');
    expect(engineerTaskCalls).toHaveLength(0);
    expect(mockExecuteAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'review',
        currentTask: 'T1: review',
      })
    );
    expect(getRepoTaskState('repo-a').tasks[0]).toMatchObject({
      id: 'T1',
      status: 'completed',
      attempts: 1,
      phaseBase: 'phase-base-123',
    });
  });

  it('broadcasts task_state_changed across engineer, hooks, review, and completion transitions', async () => {
    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      if (params.role === 'engineer') {
        return engineerSuccess();
      }
      if (params.role === 'review') {
        return reviewApprove();
      }
      throw new Error(`Unexpected role: ${params.role}`);
    });

    await startWorkers(ITEM_ID);

    const taskStateEvents = mockEventBus.publish.mock.calls
      .map(([, event]) => event)
      .filter((event: any) => event.type === 'task_state_changed');

    expect(taskStateEvents).toEqual([
      expect.objectContaining({ repoName: 'repo-a', taskId: 'T1', status: 'in_progress', currentPhase: 'engineer' }),
      expect.objectContaining({ repoName: 'repo-a', taskId: 'T1', status: 'in_review', currentPhase: 'hooks' }),
      expect.objectContaining({ repoName: 'repo-a', taskId: 'T1', status: 'in_review', currentPhase: 'review' }),
      expect.objectContaining({ repoName: 'repo-a', taskId: 'T1', status: 'completed', currentPhase: undefined }),
    ]);
  });

  it('includes plan and changed files sections in reviewer prompts', async () => {
    let reviewerPrompt = '';
    mockExecuteAgent.mockImplementation(async (params: any): Promise<any> => {
      if (params.role === 'engineer') {
        return engineerSuccess();
      }
      if (params.role === 'review') {
        reviewerPrompt = params.prompt;
        return reviewApprove();
      }
      throw new Error(`Unexpected role: ${params.role}`);
    });

    await startWorkers(ITEM_ID);

    expect(reviewerPrompt).toContain('## Plan');
    expect(reviewerPrompt).toContain('## Changed Files');
    expect(reviewerPrompt).toContain('## Implemented Tasks');
  });
});
