import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process spawn before importing the module
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock('fs/promises', () => ({
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/jsonl', () => ({
  appendJsonl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/paths', () => ({
  getItemEventsPath: vi.fn().mockReturnValue('/events.jsonl'),
  getRepoWorkspaceDir: vi.fn().mockReturnValue('/workspace/repo'),
}));

vi.mock('../../lib/events', () => ({
  createPrCreatedEvent: vi.fn().mockReturnValue({ type: 'pr_created' }),
  createRepoNoChangesEvent: vi.fn().mockReturnValue({ type: 'repo_no_changes' }),
  createErrorEvent: vi.fn().mockImplementation((_id, msg, opts) => ({
    type: 'error',
    message: msg,
    ...opts,
  })),
}));

vi.mock('../event-bus', () => ({
  eventBus: { emit: vi.fn() },
}));

vi.mock('../item-service', () => ({
  getItemConfig: vi.fn(),
}));

import { createDraftPrForRepo, createDraftPrsForAllRepos } from '../git-pr-service';
import { appendJsonl } from '../../lib/jsonl';
import { getItemConfig } from '../item-service';
import type { ItemRepositoryConfig } from '@agent-orch/shared';

const mockAppendJsonl = vi.mocked(appendJsonl);
const mockGetItemConfig = vi.mocked(getItemConfig);

function createMockProcess(exitCode: number, stdout = '', stderr = '') {
  const proc = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
  };
  proc.stdout.on.mockImplementation((event: string, cb: (d: Buffer) => void) => {
    if (event === 'data' && stdout) cb(Buffer.from(stdout));
    return proc.stdout;
  });
  proc.stderr.on.mockImplementation((event: string, cb: (d: Buffer) => void) => {
    if (event === 'data' && stderr) cb(Buffer.from(stderr));
    return proc.stderr;
  });
  proc.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
    if (event === 'close') {
      setImmediate(() => cb(exitCode));
    }
    return proc;
  });
  return proc;
}

const testRepo: ItemRepositoryConfig = {
  name: 'myrepo',
  type: 'remote',
  url: 'https://github.com/test/myrepo',
  branch: 'main',
};

describe('createDraftPrForRepo - error event logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs error event when getCurrentBranch fails (unrecorded throw path)', async () => {
    // getCurrentBranch → execGit(['rev-parse', '--abbrev-ref', 'HEAD']) fails
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return createMockProcess(1, '', 'fatal: not a git repository');
      }
      return createMockProcess(0);
    });

    await expect(
      createDraftPrForRepo('item-1', testRepo, 'Test Item', 'desc')
    ).rejects.toThrow();

    // Error event should be logged exactly once via the outer catch
    const errorCalls = mockAppendJsonl.mock.calls.filter(
      ([, event]) => (event as { type: string }).type === 'error'
    );
    expect(errorCalls).toHaveLength(1);
  });

  it('logs error event exactly once when safeLogErrorEvent path throws (gh username failure)', async () => {
    let revParseCallCount = 0;
    mockSpawn.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git') {
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          return createMockProcess(0, 'feature-branch');
        }
        if (args[0] === 'symbolic-ref') {
          return createMockProcess(0, 'origin/main');
        }
        if (args[0] === 'status') {
          return createMockProcess(0, '');
        }
        if (args[0] === 'rev-list') {
          return createMockProcess(0, '1');
        }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          revParseCallCount++;
          return createMockProcess(0, 'abc123');
        }
        if (args[0] === 'push') {
          return createMockProcess(0);
        }
        return createMockProcess(0);
      }
      if (cmd === 'gh') {
        if (args[0] === 'api' && args[1] === 'user') {
          // gh username fails
          return createMockProcess(1, '', 'auth required');
        }
        if (args[0] === 'repo') {
          return createMockProcess(0, 'main');
        }
        return createMockProcess(0);
      }
      return createMockProcess(0);
    });

    await expect(
      createDraftPrForRepo('item-1', testRepo, 'Test Item', 'desc')
    ).rejects.toThrow();

    // safeLogErrorEvent records once, prErrorLogged=true, outer catch skips
    const errorCalls = mockAppendJsonl.mock.calls.filter(
      ([, event]) => (event as { type: string }).type === 'error'
    );
    expect(errorCalls).toHaveLength(1);
  });

  it('records pr_created event on success', async () => {
    mockSpawn.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git') {
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          return createMockProcess(0, 'feature-branch');
        }
        if (args[0] === 'symbolic-ref') {
          return createMockProcess(0, 'origin/main');
        }
        if (args[0] === 'status') {
          return createMockProcess(0, '');
        }
        if (args[0] === 'rev-list') {
          return createMockProcess(0, '1');
        }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return createMockProcess(0, 'abc123');
        }
        if (args[0] === 'push') {
          return createMockProcess(0);
        }
        return createMockProcess(0);
      }
      if (cmd === 'gh') {
        if (args[0] === 'api' && args[1] === 'user') {
          return createMockProcess(0, 'testuser');
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          return createMockProcess(0, JSON.stringify({ number: 42, url: 'https://github.com/test/myrepo/pull/42' }));
        }
        if (args[0] === 'repo') {
          return createMockProcess(0, 'main');
        }
        return createMockProcess(0);
      }
      return createMockProcess(0);
    });

    const result = await createDraftPrForRepo('item-1', testRepo, 'Test Item', 'desc');

    expect(result).toEqual({ prUrl: 'https://github.com/test/myrepo/pull/42', prNumber: 42 });

    // pr_created event recorded, no error events
    const errorCalls = mockAppendJsonl.mock.calls.filter(
      ([, event]) => (event as { type: string }).type === 'error'
    );
    expect(errorCalls).toHaveLength(0);

    const prCalls = mockAppendJsonl.mock.calls.filter(
      ([, event]) => (event as { type: string }).type === 'pr_created'
    );
    expect(prCalls).toHaveLength(1);
  });
});

describe('createDraftPrsForAllRepos - error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not throw when createDraftPrForRepo throws (best-effort)', async () => {
    mockGetItemConfig.mockResolvedValue({
      id: 'item-1',
      name: 'Test',
      description: 'desc',
      repositories: [testRepo],
      status: 'running',
    } as any);

    // getCurrentBranch fails
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return createMockProcess(1, '', 'fatal: not a git repository');
      }
      return createMockProcess(0);
    });

    const { results } = await createDraftPrsForAllRepos('item-1');
    expect(results).toHaveLength(1);
    expect(results[0].repoName).toBe('myrepo');
    expect(results[0].prUrl).toBeUndefined();

    // Error event was logged exactly once (by inner catch-guard)
    const errorCalls = mockAppendJsonl.mock.calls.filter(
      ([, event]) => (event as { type: string }).type === 'error'
    );
    expect(errorCalls).toHaveLength(1);
  });
});
