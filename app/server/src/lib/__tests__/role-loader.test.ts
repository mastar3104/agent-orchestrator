import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { stringify } from 'yaml';
import {
  loadRoles,
  getRole,
  reloadRoles,
  validateRolesYaml,
  _setConfigPath,
  getRolesReadPath,
  getRolesLocalPath,
  getRolesBasePath,
  hasLocalRoles,
  sanitizeRepoAllowedTools,
  mergeAllowedTools,
  AllowedToolsFormatError,
} from '../role-loader';

function tmpFile(): string {
  const dir = join(tmpdir(), 'role-loader-test-' + randomBytes(4).toString('hex'));
  mkdirSync(dir, { recursive: true });
  return join(dir, 'roles.yaml');
}

function writeYaml(path: string, data: unknown): void {
  writeFileSync(path, stringify(data), 'utf-8');
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
      allowedTools: ['Read', 'Write', 'Edit', 'Bash(git add:*)', 'Bash(git commit -m:*)', 'Bash(git status:*)'],
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

beforeEach(() => {
  _setConfigPath(null);
});

afterAll(() => {
  _setConfigPath(null);
});

describe('role-loader', () => {
  it('loads valid YAML with 4 roles and resolves jsonSchema', () => {
    const path = tmpFile();
    writeYaml(path, VALID_ROLES);
    _setConfigPath(path);

    const roles = loadRoles();
    expect(Object.keys(roles)).toHaveLength(4);
    expect(roles).toHaveProperty('planner');
    expect(roles).toHaveProperty('engineer');
    expect(roles).toHaveProperty('reviewer');
    expect(roles).toHaveProperty('reviewReceiver');

    const resolved = getRole('planner');
    expect(resolved.promptTemplate).toBe('You are a planner.');
    expect(resolved.allowedTools).toEqual(['Read', 'Write']);
    expect(resolved.jsonSchema).toBeDefined();
    expect(resolved.jsonSchema).toHaveProperty('type', 'object');
  });

  it('throws when YAML file is missing', () => {
    _setConfigPath('/nonexistent/path/roles.yaml');
    expect(() => loadRoles()).toThrow('roles.yaml not found');
  });

  it('throws when YAML has no roles key', () => {
    const path = tmpFile();
    writeYaml(path, { notRoles: {} });
    _setConfigPath(path);

    expect(() => loadRoles()).toThrow("missing top-level 'roles' key");
  });

  it('throws on invalid schemaRef', () => {
    const path = tmpFile();
    writeYaml(path, {
      roles: {
        bad: {
          promptTemplate: 'test',
          allowedTools: ['Read'],
          schemaRef: 'nonexistent',
        },
      },
    });
    _setConfigPath(path);

    expect(() => loadRoles()).toThrow("schemaRef 'nonexistent' not found");
  });

  it('throws on empty allowedTools', () => {
    const path = tmpFile();
    writeYaml(path, {
      roles: {
        bad: {
          promptTemplate: 'test',
          allowedTools: [],
          schemaRef: 'planner',
        },
      },
    });
    _setConfigPath(path);

    expect(() => loadRoles()).toThrow('allowedTools must be a non-empty array');
  });

  it('rejects Bash(*) in allowedTools', () => {
    const path = tmpFile();
    writeYaml(path, {
      roles: {
        bad: {
          promptTemplate: 'test',
          allowedTools: ['Read', 'Bash(*)'],
          schemaRef: 'planner',
        },
      },
    });
    _setConfigPath(path);

    expect(() => loadRoles()).toThrow("unrestricted 'Bash(*)' is forbidden");
  });

  it('rejects non-whitelisted Bash patterns like Bash(rm -rf:*)', () => {
    const path = tmpFile();
    writeYaml(path, {
      roles: {
        bad: {
          promptTemplate: 'test',
          allowedTools: ['Read', 'Bash(rm -rf:*)'],
          schemaRef: 'planner',
        },
      },
    });
    _setConfigPath(path);

    expect(() => loadRoles()).toThrow("Bash pattern 'Bash(rm -rf:*)' is not allowed");
  });

  it('accepts valid Bash patterns', () => {
    const path = tmpFile();
    writeYaml(path, {
      roles: {
        good: {
          promptTemplate: 'test',
          allowedTools: ['Read', 'Bash(git add:*)', 'Bash(git commit -m:*)', 'Bash(git status:*)'],
          schemaRef: 'planner',
        },
      },
    });
    _setConfigPath(path);

    const roles = loadRoles();
    expect(roles.good.allowedTools).toContain('Bash(git add:*)');
    expect(roles.good.allowedTools).toContain('Bash(git commit -m:*)');
    expect(roles.good.allowedTools).toContain('Bash(git status:*)');
  });
});

describe('validateRolesYaml', () => {
  it('parses valid YAML and returns 4 roles without affecting cache', () => {
    // Load a known config into cache first
    const path = tmpFile();
    writeYaml(path, VALID_ROLES);
    _setConfigPath(path);
    loadRoles();

    // validateRolesYaml should not touch the cache
    const raw = stringify(VALID_ROLES);
    const roles = validateRolesYaml(raw);
    expect(Object.keys(roles)).toHaveLength(4);
    expect(roles).toHaveProperty('planner');
    expect(roles).toHaveProperty('engineer');
    expect(roles).toHaveProperty('reviewer');
    expect(roles).toHaveProperty('reviewReceiver');

    // Cache should still work (wasn't cleared)
    const resolved = getRole('planner');
    expect(resolved.promptTemplate).toBe('You are a planner.');
  });

  it('throws on invalid YAML without affecting cache', () => {
    const path = tmpFile();
    writeYaml(path, VALID_ROLES);
    _setConfigPath(path);
    loadRoles();

    expect(() => validateRolesYaml('{{{')).toThrow();

    // Cache still intact
    const resolved = getRole('planner');
    expect(resolved.promptTemplate).toBe('You are a planner.');
  });

  it('throws on bad schemaRef', () => {
    const raw = stringify({
      roles: {
        bad: {
          promptTemplate: 'test',
          allowedTools: ['Read'],
          schemaRef: 'nonexistent',
        },
      },
    });
    expect(() => validateRolesYaml(raw)).toThrow("schemaRef 'nonexistent' not found");
  });

  it('throws on empty allowedTools', () => {
    const raw = stringify({
      roles: {
        bad: {
          promptTemplate: 'test',
          allowedTools: [],
          schemaRef: 'planner',
        },
      },
    });
    expect(() => validateRolesYaml(raw)).toThrow('allowedTools must be a non-empty array');
  });
});

describe('reloadRoles (cache-safe)', () => {
  it('preserves previous cache when reload fails due to corrupted file', () => {
    // Load valid config
    const path = tmpFile();
    writeYaml(path, VALID_ROLES);
    _setConfigPath(path);
    loadRoles();

    // Corrupt the file
    writeFileSync(path, 'not: valid: yaml: {{', 'utf-8');

    // reloadRoles should throw
    expect(() => reloadRoles()).toThrow();

    // Previous cache should still be intact
    const resolved = getRole('planner');
    expect(resolved.promptTemplate).toBe('You are a planner.');
  });

  it('updates cache on successful reload', () => {
    const path = tmpFile();
    writeYaml(path, VALID_ROLES);
    _setConfigPath(path);
    loadRoles();

    // Update file with different prompt
    const updated = {
      roles: {
        planner: {
          promptTemplate: 'Updated planner.',
          allowedTools: ['Read', 'Write'],
          schemaRef: 'planner',
        },
      },
    };
    writeYaml(path, updated);

    reloadRoles();

    const resolved = getRole('planner');
    expect(resolved.promptTemplate).toBe('Updated planner.');
  });
});

describe('local file priority', () => {
  it('reads from roles.local.yaml when it exists', () => {
    const dir = join(tmpdir(), 'role-loader-local-' + randomBytes(4).toString('hex'));
    mkdirSync(dir, { recursive: true });

    const basePath = join(dir, 'roles.yaml');
    const localPath = join(dir, 'roles.local.yaml');

    writeYaml(basePath, VALID_ROLES);
    writeYaml(localPath, {
      roles: {
        planner: {
          promptTemplate: 'Local planner.',
          allowedTools: ['Read', 'Write'],
          schemaRef: 'planner',
        },
      },
    });

    _setConfigPath(basePath);
    const roles = loadRoles();
    expect(roles.planner.promptTemplate).toBe('Local planner.');
    expect(Object.keys(roles)).toHaveLength(1);

    // Cleanup
    unlinkSync(localPath);
  });

  it('falls back to roles.yaml when local does not exist', () => {
    const path = tmpFile();
    writeYaml(path, VALID_ROLES);
    _setConfigPath(path);

    const roles = loadRoles();
    expect(roles.planner.promptTemplate).toBe('You are a planner.');
    expect(Object.keys(roles)).toHaveLength(4);
  });

  it('hasLocalRoles returns true when local file exists', () => {
    const dir = join(tmpdir(), 'role-loader-has-' + randomBytes(4).toString('hex'));
    mkdirSync(dir, { recursive: true });

    const basePath = join(dir, 'roles.yaml');
    const localPath = join(dir, 'roles.local.yaml');

    writeYaml(basePath, VALID_ROLES);
    writeYaml(localPath, VALID_ROLES);

    _setConfigPath(basePath);
    expect(hasLocalRoles()).toBe(true);

    unlinkSync(localPath);
    expect(hasLocalRoles()).toBe(false);
  });

  it('getRolesReadPath returns local path when local exists', () => {
    const dir = join(tmpdir(), 'role-loader-rp-' + randomBytes(4).toString('hex'));
    mkdirSync(dir, { recursive: true });

    const basePath = join(dir, 'roles.yaml');
    const localPath = join(dir, 'roles.local.yaml');

    writeYaml(basePath, VALID_ROLES);
    _setConfigPath(basePath);

    expect(getRolesReadPath()).toBe(basePath);
    expect(getRolesBasePath()).toBe(basePath);
    expect(getRolesLocalPath()).toBe(localPath);

    writeYaml(localPath, VALID_ROLES);
    expect(getRolesReadPath()).toBe(localPath);

    unlinkSync(localPath);
  });
});

describe('sanitizeRepoAllowedTools', () => {
  it('trims whitespace and removes empty strings', () => {
    const result = sanitizeRepoAllowedTools('test-repo', [
      '  Bash(git status)  ',
      '',
      '  ',
      'Edit',
    ]);
    expect(result).toEqual(['Bash(git status)', 'Edit']);
  });

  it('removes duplicates', () => {
    const result = sanitizeRepoAllowedTools('test-repo', [
      'Bash(git status)',
      'Bash(git status)',
      'Edit',
    ]);
    expect(result).toEqual(['Bash(git status)', 'Edit']);
  });

  it('allows opaque Bash values without requiring :*', () => {
    const result = sanitizeRepoAllowedTools('test-repo', ['Bash(git status)', 'Bash', 'Bash(*)']);
    expect(result).toEqual(['Bash(git status)', 'Bash', 'Bash(*)']);
  });

  it('allows non-Bash tools', () => {
    const result = sanitizeRepoAllowedTools('test-repo', ['Read', 'Write', 'WebFetch']);
    expect(result).toEqual(['Read', 'Write', 'WebFetch']);
  });

  it('allows empty array', () => {
    const result = sanitizeRepoAllowedTools('test-repo', []);
    expect(result).toEqual([]);
  });

  it('rejects non-array values', () => {
    expect(() => sanitizeRepoAllowedTools('test-repo', 'Bash(git status)')).toThrow(AllowedToolsFormatError);
    expect(() => sanitizeRepoAllowedTools('test-repo', 'Bash(git status)')).toThrow('allowedTools must be an array of strings');
  });

  it('rejects non-string entries', () => {
    expect(() => sanitizeRepoAllowedTools('test-repo', ['Read', 42])).toThrow(AllowedToolsFormatError);
    expect(() => sanitizeRepoAllowedTools('test-repo', ['Read', 42])).toThrow('allowedTools[1] must be a string');
  });

  it('returns normalized array suitable for persistence', () => {
    const result = sanitizeRepoAllowedTools('test-repo', [
      '  Bash(git status)  ',
      'Edit  ',
      '  Bash(git status)  ',
    ]);
    expect(result).toEqual(['Bash(git status)', 'Edit']);
  });
});

describe('mergeAllowedTools', () => {
  it('returns roleTools when repoTools is undefined', () => {
    const result = mergeAllowedTools(['Read', 'Write']);
    expect(result).toEqual(['Read', 'Write']);
  });

  it('returns roleTools when repoTools is empty', () => {
    const result = mergeAllowedTools(['Read', 'Write'], []);
    expect(result).toEqual(['Read', 'Write']);
  });

  it('merges roleTools and repoTools', () => {
    const result = mergeAllowedTools(['Read', 'Write'], ['Bash(make:*)', 'Bash(go:*)']);
    expect(result).toEqual(['Read', 'Write', 'Bash(make:*)', 'Bash(go:*)']);
  });

  it('deduplicates overlapping tools', () => {
    const result = mergeAllowedTools(['Read', 'Write', 'Bash(git add:*)'], ['Read', 'Bash(make:*)']);
    expect(result).toEqual(['Read', 'Write', 'Bash(git add:*)', 'Bash(make:*)']);
  });
});
