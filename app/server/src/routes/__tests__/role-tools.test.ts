import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

vi.mock('../../lib/yaml', () => ({
  readYamlSafe: vi.fn(),
  writeYaml: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/paths', () => ({
  getRoleToolsLocalPath: vi.fn().mockReturnValue('/role-tools.local.yaml'),
}));

import { readYamlSafe, writeYaml } from '../../lib/yaml';
import { roleToolsRoutes } from '../role-tools';

const mockReadYamlSafe = vi.mocked(readYamlSafe);
const mockWriteYaml = vi.mocked(writeYaml);

function buildApp() {
  const app = Fastify();
  app.register(roleToolsRoutes, { prefix: '/api' });
  return app;
}

describe('role tools routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the current global role tool overrides', async () => {
    mockReadYamlSafe.mockResolvedValue({
      planner: ['Bash(git status:*)'],
      reviewer: ['Read'],
    });

    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/settings/role-tools',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.roleTools).toEqual({
      planner: ['Bash(git status:*)'],
      reviewer: ['Read'],
    });
  });

  it('sanitizes and persists global role tool overrides', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/role-tools',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        roleTools: {
          planner: ['  Bash(git status:*)  ', 'Bash(git status:*)', '  '],
          engineer: ['Bash(npm test:*)'],
        },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.roleTools).toEqual({
      planner: ['Bash(git status:*)'],
      engineer: ['Bash(npm test:*)'],
    });
    expect(mockWriteYaml).toHaveBeenCalledWith('/role-tools.local.yaml', {
      planner: ['Bash(git status:*)'],
      engineer: ['Bash(npm test:*)'],
    });
  });

  it('returns 400 when roleTools contains an unsupported role', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/role-tools',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        roleTools: {
          unknownRole: ['Read'],
        },
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('not a supported role');
  });

  it('returns 400 when roleTools is missing', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/role-tools',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('roleTools is required');
  });
});
