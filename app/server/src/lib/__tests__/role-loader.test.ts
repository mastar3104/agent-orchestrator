import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadRoles,
  getRole,
  loadGlobalRoleToolOverrides,
  sanitizeRepoAllowedTools,
  sanitizeRolePrompts,
  mergeAllowedTools,
  AllowedToolsFormatError,
  RolePromptsFormatError,
  RoleToolOverridesFormatError,
} from '../role-loader';

describe('role-loader', () => {
  beforeEach(() => {
    loadRoles(join(tmpdir(), `missing-role-tools-${Date.now()}.yaml`));
  });

  it('loads built-in roles and resolves jsonSchema', () => {
    const roles = loadRoles(join(tmpdir(), `missing-role-tools-${Date.now()}.yaml`));

    expect(Object.keys(roles)).toEqual([
      'planner',
      'testPlanner',
      'engineer',
      'reviewer',
      'reviewReceiver',
    ]);

    const resolved = getRole('planner');
    expect(resolved.systemPrompt).toContain('You are a development planner agent.');
    expect(resolved.allowedTools).toEqual(['Read', 'Write', 'Skill']);
    expect(resolved.jsonSchema).toHaveProperty('type', 'object');
  });

  it('merges additive global role tool overrides from a local file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'role-tools-'));
    const configPath = join(dir, 'role-tools.local.yaml');

    try {
      writeFileSync(configPath, [
        'planner:',
        '  - "Bash(git status:*)"',
        'engineer:',
        '  - "Read"',
        '  - "Bash(npm test:*)"',
        'reviewer:',
        '  - "Grep"',
      ].join('\n'));

      loadRoles(configPath);

      expect(getRole('planner').allowedTools).toEqual([
        'Read',
        'Write',
        'Skill',
        'Bash(git status:*)',
      ]);
      expect(getRole('engineer').allowedTools).toEqual([
        'Read',
        'Write',
        'Edit',
        'Skill',
        'Bash(git add:*)',
        'Bash(git rm:*)',
        'Bash(git commit -m:*)',
        'Bash(git status:*)',
        'Bash(npm test:*)',
      ]);
      expect(getRole('reviewer').allowedTools).toEqual([
        'Read',
        'Glob',
        'Grep',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to built-in tools when the local override file is missing', () => {
    expect(
      loadGlobalRoleToolOverrides(join(tmpdir(), `missing-role-tools-${Date.now()}.yaml`))
    ).toEqual({});
  });

  it('throws for unsupported global role tool keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'role-tools-invalid-key-'));
    const configPath = join(dir, 'role-tools.local.yaml');

    try {
      writeFileSync(configPath, 'unknownRole:\n  - "Read"\n');
      expect(() => loadRoles(configPath)).toThrow(RoleToolOverridesFormatError);
      expect(() => loadRoles(configPath)).toThrow('roleTools.unknownRole is not a supported role');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws for non-string global role tool entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'role-tools-invalid-entry-'));
    const configPath = join(dir, 'role-tools.local.yaml');

    try {
      writeFileSync(configPath, 'planner:\n  - "Read"\n  - 42\n');
      expect(() => loadRoles(configPath)).toThrow(RoleToolOverridesFormatError);
      expect(() => loadRoles(configPath)).toThrow('roleTools.planner[1] must be a string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws for an unknown role', () => {
    expect(() => getRole('doesNotExist')).toThrow("Role 'doesNotExist' not found");
  });
});

describe('sanitizeRepoAllowedTools', () => {
  it('trims and deduplicates tool entries', () => {
    expect(
      sanitizeRepoAllowedTools('repo-a', ['  Bash(git status)  ', 'Edit', 'Bash(git status)', '  '])
    ).toEqual(['Bash(git status)', 'Edit']);
  });

  it('throws when tools is not an array', () => {
    expect(() => sanitizeRepoAllowedTools('repo-a', 'Bash(git status)')).toThrow(AllowedToolsFormatError);
  });

  it('throws when an entry is not a string', () => {
    expect(() => sanitizeRepoAllowedTools('repo-a', ['Read', 42])).toThrow(
      "allowedTools[1] must be a string"
    );
  });
});

describe('sanitizeRolePrompts', () => {
  it('trims known prompt keys and drops blank values', () => {
    expect(
      sanitizeRolePrompts('repo-a', {
        planner: '  plan prompt  ',
        engineer: '   ',
        reviewer: 'review prompt',
      })
    ).toEqual({
      planner: 'plan prompt',
      reviewer: 'review prompt',
    });
  });

  it('returns undefined when all values are blank', () => {
    expect(
      sanitizeRolePrompts('repo-a', {
        planner: '   ',
      })
    ).toBeUndefined();
  });

  it('throws for unsupported role keys', () => {
    expect(() =>
      sanitizeRolePrompts('repo-a', { unknownRole: 'prompt' })
    ).toThrow(RolePromptsFormatError);
  });

  it('throws for non-string prompt values', () => {
    expect(() =>
      sanitizeRolePrompts('repo-a', { planner: 42 })
    ).toThrow("rolePrompts.planner must be a string");
  });
});

describe('mergeAllowedTools', () => {
  it('deduplicates role and repo tools', () => {
    expect(mergeAllowedTools(['Read', 'Edit'], ['Edit', 'Bash(git status)'])).toEqual([
      'Read',
      'Edit',
      'Bash(git status)',
    ]);
  });
});
