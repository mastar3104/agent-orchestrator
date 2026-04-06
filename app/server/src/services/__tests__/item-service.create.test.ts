import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('nanoid', () => ({
  nanoid: vi.fn().mockReturnValue('testitem'),
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
  writeYaml: vi.fn().mockResolvedValue(undefined),
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
  createItemCreatedEvent: vi.fn().mockReturnValue({ type: 'item_created' }),
  createCloneStartedEvent: vi.fn(),
  createCloneCompletedEvent: vi.fn(),
  createRepoSetupStartedEvent: vi.fn(),
  createRepoSetupCompletedEvent: vi.fn(),
  createWorkspaceSetupStartedEvent: vi.fn(),
  createWorkspaceSetupCompletedEvent: vi.fn(),
  createErrorEvent: vi.fn(),
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
  startPlanner: vi.fn(),
  getPlan: vi.fn(),
}));

vi.mock('../task-state-service', () => ({
  hasStaleExecutionStop: vi.fn().mockReturnValue(false),
  readRepoTaskState: vi.fn(),
  reconcileStoppedRepoTaskState: vi.fn().mockImplementation((state: any) => ({ state, mutated: false, interruptedInProgressTaskIds: [], interruptedInReviewTaskIds: [] })),
}));

vi.mock('../../lib/command-runner', () => ({
  COMMAND_TIMEOUT_MS: 15 * 60 * 1000,
  runShellCommands: vi.fn(),
}));

import { writeYaml } from '../../lib/yaml';
import { getRepository, createRepository } from '../repository-service';
import { createItem } from '../item-service';

const mockWriteYaml = vi.mocked(writeYaml);
const mockGetRepository = vi.mocked(getRepository);
const mockCreateRepository = vi.mocked(createRepository);

describe('createItem hooksMaxAttempts propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('copies hooksMaxAttempts from the saved repository into item.yaml runtime config', async () => {
    mockGetRepository.mockResolvedValue({
      id: 'REPO-1',
      name: 'saved-repo',
      type: 'local',
      localPath: '/tmp/repo-a',
      hooks: ['npm test'],
      hooksMaxAttempts: 3,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } as any);

    const item = await createItem({
      name: 'Item',
      description: 'desc',
      repositories: [
        {
          name: 'repo-a',
          repositoryId: 'REPO-1',
        },
      ],
    });

    expect(item.repositories[0]).toMatchObject({
      name: 'repo-a',
      hooks: ['npm test'],
      hooksMaxAttempts: 3,
    });
    expect(mockWriteYaml).toHaveBeenCalledWith(
      '/items/ITEM-testitem/item.yaml',
      expect.objectContaining({
        repositories: [
          expect.objectContaining({
            name: 'repo-a',
            hooksMaxAttempts: 3,
          }),
        ],
      })
    );
  });

  it('copies setup commands from the saved repository into item.yaml runtime config', async () => {
    mockGetRepository.mockResolvedValue({
      id: 'REPO-1',
      name: 'saved-repo',
      type: 'remote',
      url: 'https://github.com/example/repo.git',
      setup: ['yarn install --frozen-lockfile'],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } as any);

    const item = await createItem({
      name: 'Item',
      description: 'desc',
      repositories: [
        {
          name: 'repo-a',
          repositoryId: 'REPO-1',
        },
      ],
    });

    expect(item.repositories[0]).toMatchObject({
      name: 'repo-a',
      setup: ['yarn install --frozen-lockfile'],
    });
    expect(mockWriteYaml).toHaveBeenCalledWith(
      '/items/ITEM-testitem/item.yaml',
      expect.objectContaining({
        repositories: [
          expect.objectContaining({
            name: 'repo-a',
            setup: ['yarn install --frozen-lockfile'],
          }),
        ],
      })
    );
  });

  it('copies setup commands from an inline repository config into item.yaml runtime config', async () => {
    const item = await createItem({
      name: 'Item',
      description: 'desc',
      repositories: [
        {
          name: 'repo-a',
          repository: {
            type: 'remote',
            url: 'https://github.com/example/repo.git',
            setup: ['npm ci', 'npm run build'],
          },
        },
      ],
    });

    expect(item.repositories[0]).toMatchObject({
      name: 'repo-a',
      setup: ['npm ci', 'npm run build'],
    });
    expect(mockWriteYaml).toHaveBeenCalledWith(
      '/items/ITEM-testitem/item.yaml',
      expect.objectContaining({
        repositories: [
          expect.objectContaining({
            name: 'repo-a',
            setup: ['npm ci', 'npm run build'],
          }),
        ],
      })
    );
  });

  it('forwards setup commands to createRepository when saveRepository is true', async () => {
    await createItem({
      name: 'Item',
      description: 'desc',
      repositories: [
        {
          name: 'repo-a',
          repository: {
            type: 'remote',
            url: 'https://github.com/example/repo.git',
            setup: ['npm ci'],
          },
          saveRepository: true,
          repositoryName: 'saved',
        },
      ],
    });

    expect(mockCreateRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'saved',
        setup: ['npm ci'],
      })
    );
  });

  it('copies rolePrompts from a saved repository into item.yaml runtime config', async () => {
    mockGetRepository.mockResolvedValue({
      id: 'REPO-1',
      name: 'saved-repo',
      type: 'remote',
      url: 'https://github.com/example/repo.git',
      rolePrompts: {
        planner: 'repo planner prompt',
        reviewer: 'repo reviewer prompt',
      },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } as any);

    const item = await createItem({
      name: 'Item',
      description: 'desc',
      repositories: [
        {
          name: 'repo-a',
          repositoryId: 'REPO-1',
        },
      ],
    });

    expect(item.repositories[0]).toMatchObject({
      rolePrompts: {
        planner: 'repo planner prompt',
        reviewer: 'repo reviewer prompt',
      },
    });
  });

  it('copies rolePrompts from an inline repository config into item.yaml runtime config', async () => {
    const item = await createItem({
      name: 'Item',
      description: 'desc',
      repositories: [
        {
          name: 'repo-a',
          repository: {
            type: 'local',
            localPath: '/tmp/repo-a',
            rolePrompts: {
              engineer: 'repo engineer prompt',
            },
          },
        },
      ],
    });

    expect(item.repositories[0]).toMatchObject({
      rolePrompts: {
        engineer: 'repo engineer prompt',
      },
    });
    expect(mockWriteYaml).toHaveBeenCalledWith(
      '/items/ITEM-testitem/item.yaml',
      expect.objectContaining({
        repositories: [
          expect.objectContaining({
            rolePrompts: {
              engineer: 'repo engineer prompt',
            },
          }),
        ],
      })
    );
  });
});
