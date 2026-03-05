import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChildProcess } from 'child_process';
import { EventEmitter, Readable, Writable } from 'stream';

// Mock child_process.spawn
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock fs.existsSync to avoid filesystem access
vi.mock('fs', () => ({
  existsSync: () => false,
}));

import { runClaude, type ClaudeExecutionOptions } from '../claude-executor';

function createMockProc(): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  proc.stdout = new EventEmitter() as Readable;
  proc.stderr = new EventEmitter() as Readable;
  // stdin: accept writes silently
  const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  (proc as { stdin: Writable }).stdin = stdin;
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

function baseOptions(overrides?: Partial<ClaudeExecutionOptions>): ClaudeExecutionOptions {
  return {
    prompt: 'test prompt',
    allowedTools: [],
    jsonSchema: { type: 'object' },
    cwd: '/tmp',
    ...overrides,
  };
}

describe('runClaude JSON parsing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLAUDE_PATH = '/usr/bin/claude';
  });

  it('should extract structured_output when present (--json-schema response)', async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc);

    const promise = runClaude<{ review_status: string; comments: string[] }>(baseOptions());

    // Simulate Claude stdout with structured_output
    const output = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: '',
      structured_output: {
        review_status: 'request_changes',
        comments: ['fix this', 'fix that'],
      },
    });
    proc.stdout!.emit('data', Buffer.from(output));
    proc.emit('close', 0);

    const result = await promise;
    expect(result.output).toEqual({
      review_status: 'request_changes',
      comments: ['fix this', 'fix that'],
    });
  });

  it('should fall back to result field when structured_output is absent', async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc);

    const promise = runClaude<{ status: string }>(baseOptions());

    const output = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: JSON.stringify({ status: 'ok' }),
    });
    proc.stdout!.emit('data', Buffer.from(output));
    proc.emit('close', 0);

    const result = await promise;
    expect(result.output).toEqual({ status: 'ok' });
  });

  it('should fall back to result field when structured_output is null', async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc);

    const promise = runClaude<{ status: string }>(baseOptions());

    const output = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: JSON.stringify({ status: 'ok' }),
      structured_output: null,
    });
    proc.stdout!.emit('data', Buffer.from(output));
    proc.emit('close', 0);

    const result = await promise;
    expect(result.output).toEqual({ status: 'ok' });
  });

  it('should return raw string result when result is non-JSON string and no structured_output', async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc);

    const promise = runClaude<string>(baseOptions());

    const output = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'plain text response',
    });
    proc.stdout!.emit('data', Buffer.from(output));
    proc.emit('close', 0);

    const result = await promise;
    expect(result.output).toBe('plain text response');
  });

  it('should return empty string result when result is empty and no structured_output', async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc);

    const promise = runClaude<string>(baseOptions());

    const output = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: '',
    });
    proc.stdout!.emit('data', Buffer.from(output));
    proc.emit('close', 0);

    const result = await promise;
    expect(result.output).toBe('');
  });
});
