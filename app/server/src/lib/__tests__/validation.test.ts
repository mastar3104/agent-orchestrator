import { describe, expect, it } from 'vitest';
import { normalizeCommandList } from '../validation';

describe('normalizeCommandList', () => {
  it('returns {} when value is undefined', () => {
    const result = normalizeCommandList('setup', undefined, 'setup command');
    expect(result).toEqual({});
    expect(result).not.toHaveProperty('commands');
    expect(result).not.toHaveProperty('error');
  });

  it('returns error when value is null', () => {
    expect(normalizeCommandList('setup', null, 'setup command')).toEqual({
      error: 'setup must be an array',
    });
  });

  it('returns error when value is not an array', () => {
    expect(normalizeCommandList('setup', 'npm install', 'setup command')).toEqual({
      error: 'setup must be an array',
    });
    expect(normalizeCommandList('hooks', 42, 'hook')).toEqual({
      error: 'hooks must be an array',
    });
    expect(normalizeCommandList('setup', {}, 'setup command')).toEqual({
      error: 'setup must be an array',
    });
  });

  it('returns error when array contains a non-string element', () => {
    expect(normalizeCommandList('setup', ['npm install', 123], 'setup command')).toEqual({
      error: 'Each setup command must be a non-empty string',
    });
    expect(normalizeCommandList('hooks', [null], 'hook')).toEqual({
      error: 'Each hook must be a non-empty string',
    });
  });

  it('returns empty commands array for an empty array', () => {
    expect(normalizeCommandList('setup', [], 'setup command')).toEqual({
      commands: [],
    });
  });

  it('returns empty commands array when all entries are blank', () => {
    expect(normalizeCommandList('setup', ['  ', '', '\t'], 'setup command')).toEqual({
      commands: [],
    });
  });

  it('trims entries and filters out blank ones', () => {
    expect(
      normalizeCommandList('setup', ['  npm install  ', '', '  ', 'npm run build'], 'setup command')
    ).toEqual({
      commands: ['npm install', 'npm run build'],
    });
  });
});
