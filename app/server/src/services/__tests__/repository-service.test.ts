import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('nanoid', () => ({
  nanoid: vi.fn().mockReturnValue('testrepo'),
}));

vi.mock('../../lib/yaml', () => ({
  readYamlSafe: vi.fn(),
  writeYaml: vi.fn(),
}));

vi.mock('../../lib/paths', () => ({
  getRepositoriesPath: vi.fn().mockReturnValue('/repositories.yaml'),
}));

vi.mock('../../lib/role-loader', () => ({
  sanitizeRepoAllowedTools: vi.fn((_repoName: string, allowedTools: string[]) => allowedTools),
  sanitizeRolePrompts: vi.fn((_repoName: string, rolePrompts: Record<string, string>) => rolePrompts),
}));

import { readYamlSafe, writeYaml } from '../../lib/yaml';
import { createRepository, getRepository, updateRepository } from '../repository-service';

const mockReadYamlSafe = vi.mocked(readYamlSafe);
const mockWriteYaml = vi.mocked(writeYaml);

describe('repository-service hooksMaxAttempts normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to the default when repositories.yaml contains an invalid hooksMaxAttempts', async () => {
    mockReadYamlSafe.mockResolvedValue([
      {
        id: 'REPO-1',
        name: 'repo-a',
        type: 'local',
        localPath: '/tmp/repo-a',
        hooks: ['npm test'],
        hooksMaxAttempts: 'invalid',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ] as any);

    const repository = await getRepository('REPO-1');

    expect(repository).toMatchObject({
      id: 'REPO-1',
      hooksMaxAttempts: 2,
    });
  });

  it('persists rolePrompts on create and allows clearing on update', async () => {
    mockReadYamlSafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'REPO-testrepo',
          name: 'repo-a',
          type: 'remote',
          url: 'https://example.com/repo.git',
          rolePrompts: {
            planner: 'repo planner prompt',
          },
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ] as any);

    const created = await createRepository({
      name: 'repo-a',
      type: 'remote',
      url: 'https://example.com/repo.git',
      rolePrompts: {
        planner: 'repo planner prompt',
      },
    });

    expect(created.rolePrompts).toEqual({
      planner: 'repo planner prompt',
    });
    expect(mockWriteYaml).toHaveBeenCalledWith(
      '/repositories.yaml',
      [
        expect.objectContaining({
          name: 'repo-a',
          rolePrompts: {
            planner: 'repo planner prompt',
          },
        }),
      ]
    );

    const updated = await updateRepository(created.id, {
      rolePrompts: {},
    });

    expect(updated?.rolePrompts).toBeUndefined();
  });
});
