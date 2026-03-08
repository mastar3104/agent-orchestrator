import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/yaml', () => ({
  readYamlSafe: vi.fn(),
  writeYaml: vi.fn(),
}));

vi.mock('../../lib/paths', () => ({
  getRepositoriesPath: vi.fn().mockReturnValue('/repositories.yaml'),
}));

vi.mock('../../lib/role-loader', () => ({
  sanitizeRepoAllowedTools: vi.fn((_repoName: string, allowedTools: string[]) => allowedTools),
}));

import { readYamlSafe } from '../../lib/yaml';
import { getRepository } from '../repository-service';

const mockReadYamlSafe = vi.mocked(readYamlSafe);

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
});
