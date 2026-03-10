import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

vi.mock('nanoid', () => ({
  nanoid: vi.fn().mockReturnValue('testrepo'),
}));

vi.mock('../../lib/yaml', () => ({
  readYamlSafe: vi.fn(),
  writeYaml: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/paths', () => ({
  getRepositoriesPath: vi.fn().mockReturnValue('/repositories.yaml'),
}));

import { readYamlSafe, writeYaml } from '../../lib/yaml';
import { repositoryRoutes } from '../repositories';

const mockReadYamlSafe = vi.mocked(readYamlSafe);
const mockWriteYaml = vi.mocked(writeYaml);

function buildApp() {
  const app = Fastify();
  app.register(repositoryRoutes, { prefix: '/api' });
  return app;
}

describe('repository routes allowedTools validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts opaque allowedTools values without requiring :*', async () => {
    mockReadYamlSafe.mockResolvedValue([]);

    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/repositories',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'repo-a',
        type: 'local',
        localPath: '/tmp/repo-a',
        allowedTools: ['  Bash(git status)  ', 'Edit', 'Bash(git status)', '  ', 'Bash(*)'],
      }),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().data.repository.allowedTools).toEqual(['Bash(git status)', 'Edit', 'Bash(*)']);
    expect(mockWriteYaml).toHaveBeenCalledWith(
      '/repositories.yaml',
      [
        expect.objectContaining({
          name: 'repo-a',
          allowedTools: ['Bash(git status)', 'Edit', 'Bash(*)'],
        }),
      ]
    );
  });

  it('returns 400 when allowedTools is not an array', async () => {
    mockReadYamlSafe.mockResolvedValue([]);

    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/repositories',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'repo-a',
        type: 'local',
        localPath: '/tmp/repo-a',
        allowedTools: 'Bash(git status)',
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('allowedTools must be an array of strings');
  });

  it('returns 400 when allowedTools contains a non-string entry', async () => {
    mockReadYamlSafe.mockResolvedValue([
      {
        id: 'REPO-1',
        name: 'repo-a',
        type: 'local',
        localPath: '/tmp/repo-a',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);

    const app = buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/repositories/REPO-1',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        allowedTools: ['Read', 123],
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('allowedTools[1] must be a string');
  });
});
