import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  rm: vi.fn().mockResolvedValue(undefined),
  symlink: vi.fn().mockResolvedValue(undefined),
  cp: vi.fn().mockResolvedValue(undefined),
  lstat: vi.fn(),
}));

vi.mock('../repository-service', () => ({
  getRepository: vi.fn(),
  createRepository: vi.fn(),
}));

vi.mock('../../lib/role-loader', () => ({
  sanitizeRepoAllowedTools: vi.fn((_repoName: string, allowedTools?: string[]) => allowedTools),
  sanitizeRolePrompts: vi.fn((_repoName: string, rolePrompts?: Record<string, string>) => rolePrompts),
}));

vi.mock('../../lib/yaml', () => ({
  readYaml: vi.fn(),
  writeYaml: vi.fn(),
  readYamlSafe: vi.fn(),
}));

vi.mock('../../lib/jsonl', () => ({
  appendJsonl: vi.fn().mockResolvedValue(undefined),
  readJsonl: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../lib/paths', () => ({
  getItemsDir: vi.fn().mockReturnValue('/items'),
  getItemDir: vi.fn((itemId: string) => `/items/${itemId}`),
  getItemConfigPath: vi.fn((itemId: string) => `/items/${itemId}/item.yaml`),
  getItemPlanPath: vi.fn((itemId: string) => `/items/${itemId}/plan.yaml`),
  getItemEventsPath: vi.fn((itemId: string) => `/items/${itemId}/events.jsonl`),
  getWorkspaceRoot: vi.fn((itemId: string) => `/items/${itemId}/workspace`),
  getRepoWorkspaceDir: vi.fn((itemId: string, repoName: string) => `/items/${itemId}/workspace/${repoName}`),
  getRepoSetupLogDir: vi.fn((itemId: string, repoName: string) => `/items/${itemId}/setup/${repoName}`),
}));

vi.mock('../../lib/events', () => ({
  createItemCreatedEvent: vi.fn(),
  createCloneStartedEvent: vi.fn((_itemId: string, repoName: string, repositoryUrl: string) => ({
    type: 'clone_started',
    repoName,
    repositoryUrl,
  })),
  createCloneCompletedEvent: vi.fn((_itemId: string, repoName: string, success: boolean, error?: string) => ({
    type: 'clone_completed',
    repoName,
    success,
    error,
  })),
  createRepoSetupStartedEvent: vi.fn((_itemId: string, repoName: string, commands: string[]) => ({
    type: 'repo_setup_started',
    repoName,
    commands,
  })),
  createRepoSetupCompletedEvent: vi.fn((_itemId: string, repoName: string, results: any[], allPassed: boolean) => ({
    type: 'repo_setup_completed',
    repoName,
    results,
    allPassed,
  })),
  createWorkspaceSetupStartedEvent: vi.fn((_itemId: string, repoName: string, localPath: string, linkMode: string) => ({
    type: 'workspace_setup_started',
    repoName,
    localPath,
    linkMode,
  })),
  createWorkspaceSetupCompletedEvent: vi.fn((_itemId: string, repoName: string, success: boolean, error?: string) => ({
    type: 'workspace_setup_completed',
    repoName,
    success,
    error,
  })),
  createErrorEvent: vi.fn(),
}));

vi.mock('../../lib/command-runner', () => ({
  COMMAND_TIMEOUT_MS: 15 * 60 * 1000,
  runShellCommands: vi.fn(),
}));

vi.mock('../state-service', () => ({
  deriveItemStatus: vi.fn(),
  deriveRepoStatuses: vi.fn(),
  getPendingApprovals: vi.fn(),
}));

vi.mock('../agent-service', () => ({
  getAgentsByItem: vi.fn(),
  stopAgent: vi.fn(),
}));

vi.mock('../git-snapshot-service', () => ({
  stopAllGitSnapshots: vi.fn(),
}));

vi.mock('../planner-service', () => ({
  startPlanner: vi.fn().mockResolvedValue(undefined),
  getPlan: vi.fn(),
}));

vi.mock('../task-state-service', () => ({
  hasStaleExecutionStop: vi.fn().mockReturnValue(false),
  readRepoTaskState: vi.fn(),
  reconcileStoppedRepoTaskState: vi.fn().mockImplementation((state: any) => ({ state, mutated: false, interruptedInProgressTaskIds: [], interruptedInReviewTaskIds: [] })),
}));

import { existsSync } from 'fs';
import { readYamlSafe, writeYaml } from '../../lib/yaml';
import { appendJsonl } from '../../lib/jsonl';
import { runShellCommands } from '../../lib/command-runner';
import { startPlanner } from '../planner-service';
import {
  setupWorkspace,
  updateRepoSetup,
  rerunRepoSetup,
  repoWorkspaceExists,
  RepoNotFoundError,
  UnsupportedRepoTypeError,
} from '../item-service';

const mockExistsSync = vi.mocked(existsSync);
const mockReadYamlSafe = vi.mocked(readYamlSafe);
const mockWriteYaml = vi.mocked(writeYaml);
const mockAppendJsonl = vi.mocked(appendJsonl);
const mockRunShellCommands = vi.mocked(runShellCommands);
const mockStartPlanner = vi.mocked(startPlanner);

function makeGitProcess(exitCode: number = 0, stderr: string = '') {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  queueMicrotask(() => {
    if (stderr) {
      proc.stderr.emit('data', Buffer.from(stderr));
    }
    proc.emit('close', exitCode);
  });
  return proc;
}

describe('setupWorkspace repository setup commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockStartPlanner.mockResolvedValue(undefined);
    mockSpawn.mockImplementation(() => makeGitProcess(0));
  });

  it('runs setup commands after clone and work branch checkout', async () => {
    mockReadYamlSafe.mockResolvedValue({
      id: 'ITEM-1',
      name: 'Item',
      description: 'desc',
      repositories: [
        {
          name: 'repo-a',
          type: 'remote',
          url: 'https://github.com/example/repo.git',
          workBranch: 'work/ITEM-1/repo-a',
          setup: ['yarn install --frozen-lockfile'],
        },
      ],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } as any);
    mockRunShellCommands.mockResolvedValue([
      {
        command: 'yarn install --frozen-lockfile',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        durationMs: 10,
        timedOut: false,
      },
    ]);

    await setupWorkspace('ITEM-1');

    expect(mockSpawn).toHaveBeenNthCalledWith(
      1,
      'git',
      ['clone', 'https://github.com/example/repo.git', 'repo-a'],
      expect.objectContaining({ cwd: '/items/ITEM-1/workspace' })
    );
    expect(mockSpawn).toHaveBeenNthCalledWith(
      2,
      'git',
      ['checkout', '-b', 'work/ITEM-1/repo-a'],
      expect.objectContaining({ cwd: '/items/ITEM-1/workspace/repo-a' })
    );
    expect(mockRunShellCommands).toHaveBeenCalledWith(
      ['yarn install --frozen-lockfile'],
      '/items/ITEM-1/workspace/repo-a',
      expect.objectContaining({
        logDir: '/items/ITEM-1/setup/repo-a',
        attempt: 1,
        stopOnError: true,
      })
    );
    expect(mockSpawn.mock.invocationCallOrder[1]).toBeLessThan(mockRunShellCommands.mock.invocationCallOrder[0]);
    expect(mockAppendJsonl.mock.calls.map((call) => (call[1] as { type: string }).type)).toEqual([
      'clone_started',
      'clone_completed',
      'repo_setup_started',
      'repo_setup_completed',
    ]);
    expect(mockStartPlanner).toHaveBeenCalledWith('ITEM-1');
  });

  it('keeps planner startup non-blocked when setup commands fail', async () => {
    mockReadYamlSafe.mockResolvedValue({
      id: 'ITEM-1',
      name: 'Item',
      description: 'desc',
      repositories: [
        {
          name: 'repo-a',
          type: 'remote',
          url: 'https://github.com/example/repo.git',
          setup: ['yarn install --frozen-lockfile'],
        },
      ],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } as any);
    mockRunShellCommands.mockResolvedValue([
      {
        command: 'yarn install --frozen-lockfile',
        exitCode: 1,
        stdout: '',
        stderr: 'failed',
        durationMs: 10,
        timedOut: false,
      },
    ]);

    await expect(setupWorkspace('ITEM-1')).resolves.toBeUndefined();

    expect(mockAppendJsonl).toHaveBeenCalledWith(
      '/items/ITEM-1/events.jsonl',
      expect.objectContaining({
        type: 'repo_setup_completed',
        repoName: 'repo-a',
        allPassed: false,
      })
    );
    expect(mockStartPlanner).toHaveBeenCalledWith('ITEM-1');
  });

  it('does not run setup commands for local repositories', async () => {
    mockExistsSync.mockImplementation((path: any) => path === '/src/local-repo');
    mockReadYamlSafe.mockResolvedValue({
      id: 'ITEM-1',
      name: 'Item',
      description: 'desc',
      repositories: [
        {
          name: 'repo-a',
          type: 'local',
          localPath: '/src/local-repo',
          linkMode: 'copy',
          setup: ['yarn install --frozen-lockfile'],
        },
      ],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } as any);

    await setupWorkspace('ITEM-1');

    expect(mockRunShellCommands).not.toHaveBeenCalled();
    expect(mockAppendJsonl.mock.calls.map((call) => (call[1] as { type: string }).type)).toEqual([
      'workspace_setup_started',
      'workspace_setup_completed',
    ]);
    expect(mockStartPlanner).toHaveBeenCalledWith('ITEM-1');
  });
});

describe('updateRepoSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteYaml.mockResolvedValue(undefined);
  });

  const baseConfig = {
    id: 'ITEM-1',
    name: 'Item',
    description: 'desc',
    repositories: [
      {
        name: 'repo-a',
        type: 'remote' as const,
        url: 'https://github.com/example/repo.git',
        setup: ['npm install'],
      },
      {
        name: 'repo-b',
        type: 'local' as const,
        localPath: '/src/local-repo',
        linkMode: 'copy' as const,
      },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  it('returns null when item not found', async () => {
    mockReadYamlSafe.mockResolvedValue(null);
    const result = await updateRepoSetup('ITEM-NONE', 'repo-a', ['npm install']);
    expect(result).toBeNull();
    expect(mockWriteYaml).not.toHaveBeenCalled();
  });

  it('throws RepoNotFoundError when repo not found', async () => {
    mockReadYamlSafe.mockResolvedValue(baseConfig);
    await expect(updateRepoSetup('ITEM-1', 'repo-x', ['npm install']))
      .rejects.toThrow(RepoNotFoundError);
  });

  it('throws UnsupportedRepoTypeError when repo is local', async () => {
    mockReadYamlSafe.mockResolvedValue(baseConfig);
    await expect(updateRepoSetup('ITEM-1', 'repo-b', ['npm install']))
      .rejects.toThrow(UnsupportedRepoTypeError);
  });

  it('writes updated config with new setup array and updated timestamp', async () => {
    mockReadYamlSafe.mockResolvedValue(baseConfig);
    const result = await updateRepoSetup('ITEM-1', 'repo-a', ['yarn install', 'yarn build']);

    expect(result).not.toBeNull();
    expect(result!.repositories[0].setup).toEqual(['yarn install', 'yarn build']);
    // Other repo unchanged
    expect(result!.repositories[1]).toEqual(baseConfig.repositories[1]);
    expect(result!.updatedAt).not.toBe(baseConfig.updatedAt);
    expect(mockWriteYaml).toHaveBeenCalledWith(
      '/items/ITEM-1/item.yaml',
      expect.objectContaining({
        repositories: expect.arrayContaining([
          expect.objectContaining({ name: 'repo-a', setup: ['yarn install', 'yarn build'] }),
        ]),
      })
    );
  });
});

describe('rerunRepoSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when item not found', async () => {
    mockReadYamlSafe.mockResolvedValue(null);
    await expect(rerunRepoSetup('ITEM-NONE', 'repo-a'))
      .rejects.toThrow('Item ITEM-NONE not found');
  });

  it('throws RepoNotFoundError when repo not found', async () => {
    mockReadYamlSafe.mockResolvedValue({
      id: 'ITEM-1',
      name: 'Item',
      description: 'desc',
      repositories: [{ name: 'repo-a', type: 'remote', url: 'https://github.com/example/repo.git' }],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    await expect(rerunRepoSetup('ITEM-1', 'repo-x'))
      .rejects.toThrow(RepoNotFoundError);
  });

  it('throws UnsupportedRepoTypeError when repo is local', async () => {
    mockReadYamlSafe.mockResolvedValue({
      id: 'ITEM-1',
      name: 'Item',
      description: 'desc',
      repositories: [{ name: 'repo-a', type: 'local', localPath: '/src/local-repo', linkMode: 'copy' }],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    await expect(rerunRepoSetup('ITEM-1', 'repo-a'))
      .rejects.toThrow(UnsupportedRepoTypeError);
  });

  it('calls runRepoSetupCommands with correct repoDir and eventsPath', async () => {
    mockReadYamlSafe.mockResolvedValue({
      id: 'ITEM-1',
      name: 'Item',
      description: 'desc',
      repositories: [
        {
          name: 'repo-a',
          type: 'remote',
          url: 'https://github.com/example/repo.git',
          setup: ['npm install'],
        },
      ],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    mockRunShellCommands.mockResolvedValue([
      { command: 'npm install', exitCode: 0, stdout: 'ok', stderr: '', durationMs: 10, timedOut: false },
    ]);

    await rerunRepoSetup('ITEM-1', 'repo-a');

    expect(mockRunShellCommands).toHaveBeenCalledWith(
      ['npm install'],
      '/items/ITEM-1/workspace/repo-a',
      expect.objectContaining({
        logDir: '/items/ITEM-1/setup/repo-a',
      })
    );
    expect(mockAppendJsonl).toHaveBeenCalledWith(
      '/items/ITEM-1/events.jsonl',
      expect.objectContaining({ type: 'repo_setup_started' })
    );
  });
});

describe('repoWorkspaceExists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when workspace directory exists', () => {
    mockExistsSync.mockReturnValue(true);
    expect(repoWorkspaceExists('ITEM-1', 'repo-a')).toBe(true);
    expect(mockExistsSync).toHaveBeenCalledWith('/items/ITEM-1/workspace/repo-a');
  });

  it('returns false when workspace directory does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(repoWorkspaceExists('ITEM-1', 'repo-a')).toBe(false);
    expect(mockExistsSync).toHaveBeenCalledWith('/items/ITEM-1/workspace/repo-a');
  });
});
