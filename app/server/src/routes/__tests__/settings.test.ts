import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { stringify } from 'yaml';
import Fastify from 'fastify';
import { settingsRoutes } from '../settings';
import { _setConfigPath, loadRoles } from '../../lib/role-loader';

function tmpFile(): string {
  const dir = join(tmpdir(), 'settings-route-test-' + randomBytes(4).toString('hex'));
  mkdirSync(dir, { recursive: true });
  return join(dir, 'roles.yaml');
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

let tmpPath: string;

beforeEach(() => {
  tmpPath = tmpFile();
  writeFileSync(tmpPath, stringify(VALID_ROLES), 'utf-8');
  _setConfigPath(tmpPath);
  loadRoles();
});

afterAll(() => {
  _setConfigPath(null);
});

describe('GET /api/settings/roles', () => {
  it('returns 200 with roles.yaml content', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/settings/roles',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.content).toContain('planner');
    expect(typeof body.data.content).toBe('string');
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
  it('saves valid YAML and reloads roles', async () => {
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

    // Verify file was actually written
    const onDisk = readFileSync(tmpPath, 'utf-8');
    expect(onDisk).toContain('Updated planner prompt');
  });

  it('returns 400 for invalid YAML and leaves original file unchanged', async () => {
    const app = buildApp();
    const originalContent = readFileSync(tmpPath, 'utf-8');

    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/roles',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ content: 'not:\n  valid:\n    roles: yaml\n' }),
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBeDefined();

    // Original file unchanged
    const onDisk = readFileSync(tmpPath, 'utf-8');
    expect(onDisk).toBe(originalContent);
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
