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
}));

vi.mock('../../lib/events', () => ({
  createItemCreatedEvent: vi.fn().mockReturnValue({ type: 'item_created' }),
  createCloneStartedEvent: vi.fn(),
  createCloneCompletedEvent: vi.fn(),
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
  readRepoTaskState: vi.fn(),
}));

import { writeYaml } from '../../lib/yaml';
import { getRepository } from '../repository-service';
import { createItem } from '../item-service';

const mockWriteYaml = vi.mocked(writeYaml);
const mockGetRepository = vi.mocked(getRepository);

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
});
