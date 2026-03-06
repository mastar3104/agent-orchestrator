import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ItemEvent } from '@agent-orch/shared';

vi.mock('../../lib/jsonl', () => ({
  readJsonl: vi.fn(),
}));

vi.mock('../../lib/paths', () => ({
  getItemEventsPath: vi.fn().mockReturnValue('/events.jsonl'),
  getAgentEventsPath: vi.fn().mockReturnValue('/agent-events.jsonl'),
}));

import { deriveItemStatus } from '../state-service';
import { readJsonl } from '../../lib/jsonl';

const mockReadJsonl = vi.mocked(readJsonl);

function makeEvent(type: string, extra: Record<string, unknown> = {}): ItemEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    type: type as ItemEvent['type'],
    timestamp: new Date().toISOString(),
    ...extra,
  } as ItemEvent;
}

describe('deriveItemStatus - error check after running check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns running when agent errored but retry is running', async () => {
    mockReadJsonl.mockResolvedValue([
      makeEvent('agent_started', { agentId: 'A', role: 'engineer' }),
      makeEvent('error', { agentId: 'A' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 1 }),
      makeEvent('agent_started', { agentId: 'B', role: 'engineer' }),
    ]);

    expect(await deriveItemStatus('item-1')).toBe('running');
  });

  it('returns review_receiving when agent errored, retry succeeded, and review is in progress', async () => {
    mockReadJsonl.mockResolvedValue([
      makeEvent('agent_started', { agentId: 'A', role: 'engineer' }),
      makeEvent('error', { agentId: 'A' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 1 }),
      makeEvent('agent_started', { agentId: 'B', role: 'engineer' }),
      makeEvent('agent_exited', { agentId: 'B', exitCode: 0 }),
      makeEvent('review_receive_started', { agentId: 'C' }),
      makeEvent('agent_started', { agentId: 'C', role: 'review-receiver' }),
    ]);

    expect(await deriveItemStatus('item-1')).toBe('review_receiving');
  });

  it('returns error when all retries failed and all agents stopped', async () => {
    mockReadJsonl.mockResolvedValue([
      makeEvent('agent_started', { agentId: 'A', role: 'engineer' }),
      makeEvent('error', { agentId: 'A' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 1 }),
      makeEvent('agent_started', { agentId: 'B', role: 'engineer' }),
      makeEvent('error', { agentId: 'B' }),
      makeEvent('agent_exited', { agentId: 'B', exitCode: 1 }),
    ]);

    expect(await deriveItemStatus('item-1')).toBe('error');
  });

  it('returns running when item-level error occurred but new agent is running', async () => {
    mockReadJsonl.mockResolvedValue([
      makeEvent('agent_started', { agentId: 'A', role: 'engineer' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 1 }),
      makeEvent('error'), // item-level error, no agentId
      makeEvent('agent_started', { agentId: 'C', role: 'engineer' }),
    ]);

    expect(await deriveItemStatus('item-1')).toBe('running');
  });

  it('returns error when item-level error occurred and all agents stopped', async () => {
    mockReadJsonl.mockResolvedValue([
      makeEvent('agent_started', { agentId: 'A', role: 'engineer' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 1 }),
      makeEvent('error'), // item-level error, no agentId
    ]);

    expect(await deriveItemStatus('item-1')).toBe('error');
  });

  it('returns completed when error exists but PR created and last event is pr_created', async () => {
    mockReadJsonl.mockResolvedValue([
      makeEvent('agent_started', { agentId: 'A', role: 'engineer' }),
      makeEvent('error', { agentId: 'A' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 1 }),
      makeEvent('agent_started', { agentId: 'B', role: 'engineer' }),
      makeEvent('tasks_completed', { agentId: 'B' }),
      makeEvent('agent_exited', { agentId: 'B', exitCode: 0 }),
      makeEvent('pr_created', { agentId: 'B' }),
    ]);

    expect(await deriveItemStatus('item-1')).toBe('completed');
  });

  it('returns error when error exists and PR created but last event is error', async () => {
    mockReadJsonl.mockResolvedValue([
      makeEvent('agent_started', { agentId: 'A', role: 'engineer' }),
      makeEvent('tasks_completed', { agentId: 'A' }),
      makeEvent('agent_exited', { agentId: 'A', exitCode: 0 }),
      makeEvent('pr_created', { agentId: 'A' }),
      makeEvent('error'), // item-level error after PR
    ]);

    expect(await deriveItemStatus('item-1')).toBe('error');
  });
});
