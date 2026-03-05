import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { stringify } from 'yaml';
import Fastify from 'fastify';
import { settingsRoutes } from '../settings';
import { _setConfigPath, loadRoles } from '../../lib/role-loader';

function tmpDir(): string {
  const dir = join(tmpdir(), 'settings-route-test-' + randomBytes(4).toString('hex'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

const VALID_ROLES = {
  roles: {
    planner: {
      promptTemplate: 'You are a planner.',
      allowedTools: ['Read', 'Write'],
      schemaRef: 'planner',
    },
    engineer: {
      promptTemplate: 'You are an engineer.',
      allowedTools: ['Read', 'Write', 'Edit'],
      schemaRef: 'engineer',
    },
    reviewer: {
      promptTemplate: 'You are a reviewer.',
      allowedTools: ['Read', 'Glob', 'Grep'],
      schemaRef: 'reviewer',
    },
    reviewReceiver: {
      promptTemplate: 'You are a review receiver.',
      allowedTools: ['Read', 'Write'],
      schemaRef: 'reviewReceiver',
    },
  },
};

function buildApp() {
  const app = Fastify();
  app.register(settingsRoutes, { prefix: '/api' });
  return app;
}

let testDir: string;
let basePath: string;
let localPath: string;

beforeEach(() => {
  testDir = tmpDir();
  basePath = join(testDir, 'roles.yaml');
  localPath = join(testDir, 'roles.local.yaml');
  writeFileSync(basePath, stringify(VALID_ROLES), 'utf-8');
  _setConfigPath(basePath);
  loadRoles();
});

afterEach(() => {
  // Clean up local file if created
  try { unlinkSync(localPath); } catch { /* ignore */ }
});

afterAll(() => {
  _setConfigPath(null);
});

describe('GET /api/settings/roles', () => {
  it('returns isLocal: false when no local file exists', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/settings/roles',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.content).toContain('planner');
    expect(body.data.isLocal).toBe(false);
  });

  it('returns isLocal: true when local file exists', async () => {
    const localContent = stringify({
      roles: {
        planner: {
          promptTemplate: 'Local planner.',
          allowedTools: ['Read', 'Write'],
          schemaRef: 'planner',
        },
      },
    });
    writeFileSync(localPath, localContent, 'utf-8');

    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/settings/roles',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.content).toContain('Local planner');
    expect(body.data.isLocal).toBe(true);
  });

  it('returns 500 when file is missing', async () => {
    _setConfigPath('/nonexistent/roles.yaml');
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/settings/roles',
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBeDefined();
  });
});

describe('PUT /api/settings/roles', () => {
  it('creates roles.local.yaml on first save', async () => {
    const app = buildApp();
    const updatedYaml = stringify({
      roles: {
        planner: {
          promptTemplate: 'Updated planner prompt.',
          allowedTools: ['Read', 'Write'],
          schemaRef: 'planner',
        },
      },
    });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/roles',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ content: updatedYaml }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.content).toContain('Updated planner prompt');
    expect(body.data.isLocal).toBe(true);

    // Local file was created
    expect(existsSync(localPath)).toBe(true);
    const onDisk = readFileSync(localPath, 'utf-8');
    expect(onDisk).toContain('Updated planner prompt');

    // Base file unchanged
    const baseContent = readFileSync(basePath, 'utf-8');
    expect(baseContent).toContain('You are a planner.');
  });

  it('overwrites existing local file', async () => {
    // Create initial local file
    writeFileSync(localPath, stringify({
      roles: {
        planner: {
          promptTemplate: 'First local.',
          allowedTools: ['Read', 'Write'],
          schemaRef: 'planner',
        },
      },
    }), 'utf-8');

    const app = buildApp();
    const updatedYaml = stringify({
      roles: {
        planner: {
          promptTemplate: 'Second local.',
          allowedTools: ['Read', 'Write'],
          schemaRef: 'planner',
        },
      },
    });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/roles',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ content: updatedYaml }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.isLocal).toBe(true);

    const onDisk = readFileSync(localPath, 'utf-8');
    expect(onDisk).toContain('Second local.');
  });

  it('returns 400 for invalid YAML and does not create local file', async () => {
    const app = buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/roles',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ content: 'not:\n  valid:\n    roles: yaml\n' }),
    });

    expect(res.statusCode).toBe(400);
    expect(existsSync(localPath)).toBe(false);
  });

  it('returns 400 when content field is missing', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/roles',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('content must be a non-empty string');
  });

  it('returns 400 when content is not a string', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/roles',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ content: 42 }),
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('content must be a non-empty string');
  });

  it('returns 400 when content is an empty string', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/roles',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ content: '   ' }),
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('content must not be empty');
  });
});

describe('DELETE /api/settings/roles/local', () => {
  it('deletes local file and falls back to base', async () => {
    // Create local file first
    const localContent = stringify({
      roles: {
        planner: {
          promptTemplate: 'Local planner.',
          allowedTools: ['Read', 'Write'],
          schemaRef: 'planner',
        },
      },
    });
    writeFileSync(localPath, localContent, 'utf-8');
    loadRoles(); // reload to pick up local

    const app = buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/settings/roles/local',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.isLocal).toBe(false);
    expect(body.data.content).toContain('You are a planner.');

    // Local file removed
    expect(existsSync(localPath)).toBe(false);
  });

  it('returns 404 when no local file exists', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/settings/roles/local',
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('No local roles override exists');
  });

  it('rolls back local file when reload fails after delete', async () => {
    // Create a local file with valid content
    const localContent = stringify({
      roles: {
        planner: {
          promptTemplate: 'Local planner.',
          allowedTools: ['Read', 'Write'],
          schemaRef: 'planner',
        },
      },
    });
    writeFileSync(localPath, localContent, 'utf-8');
    loadRoles();

    // Corrupt the base file so reloadRoles() fails after local is removed
    writeFileSync(basePath, 'corrupt: {{{', 'utf-8');

    const app = buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/settings/roles/local',
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('Failed to reset roles');

    // Local file should be restored (rollback)
    expect(existsSync(localPath)).toBe(true);
    const restored = readFileSync(localPath, 'utf-8');
    expect(restored).toContain('Local planner.');
  });
});
