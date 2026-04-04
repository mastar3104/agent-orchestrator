import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeExecutionError, ClaudeSchemaValidationError } from '../../lib/claude-executor';

const mockWriteFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockMkdir = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRunClaude = vi.hoisted(() => vi.fn());
const mockAppendJsonl = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockEmit = vi.hoisted(() => vi.fn());
const mockReconcileStoppedRepoTaskStateForItem = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('fs/promises', () => ({
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
}));

vi.mock('../../lib/claude-executor', async () => {
  const actual = await vi.importActual<typeof import('../../lib/claude-executor')>('../../lib/claude-executor');
  return {
    ...actual,
    runClaude: mockRunClaude,
  };
});

vi.mock('../../lib/jsonl', () => ({
  appendJsonl: mockAppendJsonl,
  readJsonl: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../lib/paths', () => ({
  getAgentDir: vi.fn((_itemId: string, agentId: string) => `/tmp/${agentId}`),
  getAgentEventsPath: vi.fn((_itemId: string, agentId: string) => `/tmp/${agentId}/events.jsonl`),
  getAgentOutputPath: vi.fn((_itemId: string, agentId: string) => `/tmp/${agentId}/output.json`),
  getItemEventsPath: vi.fn((itemId: string) => `/tmp/${itemId}/events.jsonl`),
}));

vi.mock('../event-bus', () => ({
  eventBus: { emit: mockEmit },
}));

vi.mock('../task-state-service', () => ({
  reconcileStoppedRepoTaskStateForItem: mockReconcileStoppedRepoTaskStateForItem,
}));

import { executeAgent } from '../agent-service';

function baseOptions() {
  return {
    itemId: 'ITEM-1',
    role: 'review',
    repoName: 'repo-a',
    prompt: 'user prompt body',
    appendSystemPrompt: 'system prompt body',
    workingDir: '/workspace/repo-a',
    allowedTools: ['Read'],
    jsonSchema: {},
  } as const;
}

function parseSavedOutput(): Record<string, unknown> {
  const raw = mockWriteFile.mock.calls.at(-1)?.[1];
  expect(typeof raw).toBe('string');
  return JSON.parse(raw as string) as Record<string, unknown>;
}

describe('executeAgent output capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves systemPrompt alongside the user prompt on success', async () => {
    mockRunClaude.mockResolvedValue({
      output: { status: 'ok' },
      rawStdout: 'stdout text',
      stderr: '',
      exitCode: 0,
      durationMs: 123,
      sessionId: 'session-1',
    });

    await executeAgent(baseOptions());

    const saved = parseSavedOutput();
    expect(saved.prompt).toBe('user prompt body');
    expect(saved.systemPrompt).toBe('system prompt body');
    expect(saved.stdout).toBe('stdout text');
  });

  it('saves systemPrompt when Claude execution fails', async () => {
    mockRunClaude.mockRejectedValue(
      new ClaudeExecutionError('boom', 1, 'stderr text', 'stdout text', 456)
    );

    await expect(executeAgent(baseOptions())).rejects.toThrow('boom');

    const saved = parseSavedOutput();
    expect(saved.prompt).toBe('user prompt body');
    expect(saved.systemPrompt).toBe('system prompt body');
    expect(saved.stderr).toBe('stderr text');
    expect(saved.stdout).toBe('stdout text');
  });

  it('saves systemPrompt when schema validation fails', async () => {
    mockRunClaude.mockRejectedValue(
      new ClaudeSchemaValidationError(
        'schema fail',
        '{"bad":true}',
        ['$.status is required'],
        'stderr text',
        1,
        789
      )
    );

    await expect(executeAgent(baseOptions())).rejects.toThrow('schema fail');

    const saved = parseSavedOutput();
    expect(saved.prompt).toBe('user prompt body');
    expect(saved.systemPrompt).toBe('system prompt body');
    expect(saved.stdout).toBe('{"bad":true}');
    expect(saved.schemaValidationErrors).toEqual(['$.status is required']);
  });

  it('omits systemPrompt when the agent had no appendSystemPrompt', async () => {
    mockRunClaude.mockResolvedValue({
      output: { status: 'ok' },
      rawStdout: '',
      stderr: '',
      exitCode: 0,
      durationMs: 123,
    });

    await executeAgent({
      ...baseOptions(),
      appendSystemPrompt: undefined,
    });

    const saved = parseSavedOutput();
    expect(saved.prompt).toBe('user prompt body');
    expect(Object.prototype.hasOwnProperty.call(saved, 'systemPrompt')).toBe(false);
  });
});
