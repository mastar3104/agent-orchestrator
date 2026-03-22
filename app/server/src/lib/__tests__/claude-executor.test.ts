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

import { runClaude, ClaudeSchemaValidationError, type ClaudeExecutionOptions } from '../claude-executor';
import { ENGINEER_RESPONSE_SCHEMA, REVIEWER_RESPONSE_SCHEMA } from '../claude-schemas';

function createMockProc(): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  proc.stdout = new EventEmitter() as Readable;
  proc.stderr = new EventEmitter() as Readable;
  // stdin: accept writes silently
  const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  (proc as { stdin: Writable }).stdin = stdin;
  proc.kill = vi.fn();
  Object.defineProperty(proc, 'pid', {
    value: 12345,
    configurable: true,
  });
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
      session_id: 'session-123',
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
    expect(result.sessionId).toBe('session-123');
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

  it('should throw ClaudeSchemaValidationError when result is non-JSON string and schema expects object', async () => {
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

    await expect(promise).rejects.toThrow(ClaudeSchemaValidationError);
    await expect(promise).rejects.toThrow("expected type 'object' but got 'string'");
  });

  it('should throw ClaudeSchemaValidationError when result is empty string and schema expects object', async () => {
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

    await expect(promise).rejects.toThrow(ClaudeSchemaValidationError);
    await expect(promise).rejects.toThrow("expected type 'object' but got 'string'");
  });

  it('should fall back to raw result when schema mismatch and fallback mode is enabled', async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc);

    const promise = runClaude<string>(baseOptions({ schemaFallbackMode: 'result_or_empty' }));

    const output = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'plain text response',
    });
    proc.stdout!.emit('data', Buffer.from(output));
    proc.emit('close', 0);

    const result = await promise;
    expect(result.output).toBe('plain text response');
    expect(result.usedSchemaFallback).toBe(true);
    expect(result.schemaValidationErrors).toEqual(["$: expected type 'object' but got 'string'"]);
  });

  it('should return empty string when fallback mode is enabled and result is absent', async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc);

    const promise = runClaude<string>(baseOptions({
      schemaFallbackMode: 'result_or_empty',
      jsonSchema: ENGINEER_RESPONSE_SCHEMA,
    }));

    const output = JSON.stringify({
      type: 'result',
      subtype: 'success',
    });
    proc.stdout!.emit('data', Buffer.from(output));
    proc.emit('close', 0);

    const result = await promise;
    expect(result.output).toBe('');
    expect(result.usedSchemaFallback).toBe(true);
    expect(result.schemaValidationErrors).toEqual(["$: missing required field 'status'"]);
  });

  it('should pass -r when resumeSessionId is provided', async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc);

    // Use empty schema so validation passes for string result
    const promise = runClaude<string>(baseOptions({ resumeSessionId: 'resume-123', jsonSchema: {} }));

    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/bin/claude',
      expect.arrayContaining(['-p', '-r', 'resume-123']),
      expect.any(Object)
    );

    const output = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'ok',
    });
    proc.stdout!.emit('data', Buffer.from(output));
    proc.emit('close', 0);

    const result = await promise;
    expect(result.output).toBe('ok');
  });

  it('should pass --append-system-prompt when provided', async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc);

    const promise = runClaude<string>(baseOptions({
      appendSystemPrompt: 'System instructions',
      jsonSchema: {},
    }));

    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/bin/claude',
      expect.arrayContaining(['--append-system-prompt', 'System instructions']),
      expect.any(Object)
    );

    const output = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'ok',
    });
    proc.stdout!.emit('data', Buffer.from(output));
    proc.emit('close', 0);

    const result = await promise;
    expect(result.output).toBe('ok');
  });

  it('should pass repeated --add-dir arguments when provided', async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc);

    const promise = runClaude<string>(baseOptions({
      addDirs: ['/workspace/repo-a', '/workspace/repo-b'],
      jsonSchema: {},
    }));

    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/bin/claude',
      expect.arrayContaining([
        '--add-dir',
        '/workspace/repo-a',
        '--add-dir',
        '/workspace/repo-b',
      ]),
      expect.any(Object)
    );

    const output = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'ok',
    });
    proc.stdout!.emit('data', Buffer.from(output));
    proc.emit('close', 0);

    const result = await promise;
    expect(result.output).toBe('ok');
  });

  it('should return raw string when jsonSchema is empty', async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc);

    const promise = runClaude<string>(baseOptions({ jsonSchema: {} }));

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

  it('should throw when required fields are missing from parsed object', async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc);

    const promise = runClaude(baseOptions({ jsonSchema: ENGINEER_RESPONSE_SCHEMA }));

    const output = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: '',
      structured_output: { summary: 'only' },
    });
    proc.stdout!.emit('data', Buffer.from(output));
    proc.emit('close', 0);

    await expect(promise).rejects.toThrow(ClaudeSchemaValidationError);
    await expect(promise).rejects.toThrow("missing required field 'status'");
  });

  it('should throw when enum value does not match', async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc);

    const promise = runClaude(baseOptions({ jsonSchema: ENGINEER_RESPONSE_SCHEMA }));

    const output = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: '',
      structured_output: { status: 'ok' },
    });
    proc.stdout!.emit('data', Buffer.from(output));
    proc.emit('close', 0);

    await expect(promise).rejects.toThrow(ClaudeSchemaValidationError);
    await expect(promise).rejects.toThrow('not in enum');
  });

  it('should throw when property type does not match', async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc);

    const promise = runClaude(baseOptions({ jsonSchema: ENGINEER_RESPONSE_SCHEMA }));

    const output = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: '',
      structured_output: { status: 123 },
    });
    proc.stdout!.emit('data', Buffer.from(output));
    proc.emit('close', 0);

    await expect(promise).rejects.toThrow(ClaudeSchemaValidationError);
    await expect(promise).rejects.toThrow("expected type 'string' but got 'number'");
  });

  it('should throw when structured_output has invalid schema', async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc);

    const promise = runClaude(baseOptions({ jsonSchema: ENGINEER_RESPONSE_SCHEMA }));

    const output = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: '',
      session_id: 'session-456',
      structured_output: { status: 'ok' },
    });
    proc.stdout!.emit('data', Buffer.from(output));
    proc.emit('close', 0);

    await expect(promise).rejects.toThrow(ClaudeSchemaValidationError);
    await expect(promise).rejects.toThrow('not in enum');
  });

  it('should throw when nested array item is missing required fields', async () => {
    const proc = createMockProc();
    mockSpawn.mockReturnValue(proc);

    const promise = runClaude(baseOptions({ jsonSchema: REVIEWER_RESPONSE_SCHEMA }));

    const output = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: '',
      structured_output: {
        review_status: 'approve',
        comments: [{ severity: 'major' }],
      },
    });
    proc.stdout!.emit('data', Buffer.from(output));
    proc.emit('close', 0);

    await expect(promise).rejects.toThrow(ClaudeSchemaValidationError);
    await expect(promise).rejects.toThrow("missing required field 'file'");
  });
});
