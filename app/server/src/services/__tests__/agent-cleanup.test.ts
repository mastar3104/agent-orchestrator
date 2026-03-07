import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ItemEvent } from '@agent-orch/shared';

vi.mock('../../lib/jsonl', () => ({
  readJsonl: vi.fn(),
  appendJsonl: vi.fn(),
}));

vi.mock('../../lib/paths', () => ({
  getItemEventsPath: vi.fn().mockReturnValue('/events.jsonl'),
  getAgentEventsPath: vi.fn().mockReturnValue('/agent-events.jsonl'),
  getAgentDir: vi.fn().mockReturnValue('/agent-dir'),
}));

vi.mock('../event-bus', () => ({
  eventBus: {
    emit: vi.fn(),
  },
}));

import { cleanupOrphanedAgentsForItem } from '../agent-service';
import { readJsonl, appendJsonl } from '../../lib/jsonl';
import { eventBus } from '../event-bus';

const mockReadJsonl = vi.mocked(readJsonl);
const mockAppendJsonl = vi.mocked(appendJsonl);
const mockEventBusEmit = vi.mocked(eventBus.emit);

function makeEvent(type: string, extra: Record<string, unknown> = {}): ItemEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    type: type as ItemEvent['type'],
    timestamp: new Date().toISOString(),
    itemId: 'item-1',
    ...extra,
  } as ItemEvent;
}

describe('cleanupOrphanedAgentsForItem - stuck review_receiving detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects stuck review_receiving (review_receive_started with no agent_started, completion, or error)', async () => {
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'eng1', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'eng1', exitCode: 0 }),
      makeEvent('pr_created', { repoName: 'repoA', prUrl: 'http://pr', prNumber: 1 }),
      makeEvent('review_receive_started', { agentId: 'rr1', repoName: 'repoA', prNumber: 1, prUrl: 'http://pr' }),
      // Server restarted here, no agent_started, no completion, no error
    ]);

    await cleanupOrphanedAgentsForItem('item-1');

    // Should have written an error event
    expect(mockAppendJsonl).toHaveBeenCalled();
    const errorCall = mockAppendJsonl.mock.calls[0];
    expect(errorCall[1]).toMatchObject({
      type: 'error',
      message: 'Server restarted before review receive agent started',
      repoName: 'repoA',
      phase: 'review_receive',
    });

    // Should have emitted the event
    expect(mockEventBusEmit).toHaveBeenCalled();
    const emitCall = mockEventBusEmit.mock.calls[0];
    expect(emitCall[0]).toBe('event');
    expect(emitCall[1].event).toMatchObject({
      type: 'error',
      repoName: 'repoA',
      phase: 'review_receive',
    });
  });

  it('does not treat completed review_receive as stuck', async () => {
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'eng1', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'eng1', exitCode: 0 }),
      makeEvent('pr_created', { repoName: 'repoA', prUrl: 'http://pr', prNumber: 1 }),
      makeEvent('review_receive_started', { agentId: 'rr1', repoName: 'repoA', prNumber: 1, prUrl: 'http://pr' }),
      makeEvent('review_receive_completed', { agentId: 'rr1', repoName: 'repoA', prNumber: 1, commentsCutoffAt: null, totalComments: 0, newComments: 0, filteredComments: 0 }),
    ]);

    const cleanedCount = await cleanupOrphanedAgentsForItem('item-1');

    // Should not write additional error event for completed review_receive
    // (only orphaned agent cleanup events would be written, but there are no running agents here)
    expect(cleanedCount).toBe(0);
  });

  it('does not treat review_receive with agent_started as stuck', async () => {
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'eng1', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'eng1', exitCode: 0 }),
      makeEvent('pr_created', { repoName: 'repoA', prUrl: 'http://pr', prNumber: 1 }),
      makeEvent('review_receive_started', { agentId: 'rr1', repoName: 'repoA', prNumber: 1, prUrl: 'http://pr' }),
      makeEvent('agent_started', { agentId: 'rr1', role: 'review-receiver', repoName: 'repoA' }),
      // Server restarted here with rr1 still running
    ]);

    await cleanupOrphanedAgentsForItem('item-1');

    // Should clean up the running rr1 agent as orphaned, not as stuck review_receive
    const appendCalls = mockAppendJsonl.mock.calls.filter(
      call => (call[1] as any).type === 'status_changed'
    );
    expect(appendCalls.length).toBeGreaterThan(0);
    const statusChangeEvent = appendCalls[0][1] as any;
    expect(statusChangeEvent.type).toBe('status_changed');
    expect(statusChangeEvent.newStatus).toBe('stopped');
  });

  it('does not treat review_receive with error as stuck', async () => {
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      makeEvent('agent_started', { agentId: 'eng1', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'eng1', exitCode: 0 }),
      makeEvent('pr_created', { repoName: 'repoA', prUrl: 'http://pr', prNumber: 1 }),
      makeEvent('review_receive_started', { agentId: 'rr1', repoName: 'repoA', prNumber: 1, prUrl: 'http://pr' }),
      makeEvent('error', { repoName: 'repoA', phase: 'review_receive', message: 'Failed to fetch comments' }),
    ]);

    const cleanedCount = await cleanupOrphanedAgentsForItem('item-1');

    // Should not write additional error event since error already exists
    expect(cleanedCount).toBe(0);
  });

  it('handles multiple review_receives in same item correctly', async () => {
    mockReadJsonl.mockResolvedValue([
      makeEvent('plan_created', { planPath: '/plan.yaml' }),
      // repoA: completes successfully
      makeEvent('agent_started', { agentId: 'eng1', role: 'engineer', repoName: 'repoA' }),
      makeEvent('agent_exited', { agentId: 'eng1', exitCode: 0 }),
      makeEvent('pr_created', { repoName: 'repoA', prUrl: 'http://pr1', prNumber: 1 }),
      makeEvent('review_receive_started', { agentId: 'rr1', repoName: 'repoA', prNumber: 1, prUrl: 'http://pr1' }),
      makeEvent('review_receive_completed', { agentId: 'rr1', repoName: 'repoA', prNumber: 1, commentsCutoffAt: null, totalComments: 0, newComments: 0, filteredComments: 0 }),
      // repoB: stuck review_receiving
      makeEvent('agent_started', { agentId: 'eng2', role: 'engineer', repoName: 'repoB' }),
      makeEvent('agent_exited', { agentId: 'eng2', exitCode: 0 }),
      makeEvent('pr_created', { repoName: 'repoB', prUrl: 'http://pr2', prNumber: 2 }),
      makeEvent('review_receive_started', { agentId: 'rr2', repoName: 'repoB', prNumber: 2, prUrl: 'http://pr2' }),
      // Server restarted here
    ]);

    await cleanupOrphanedAgentsForItem('item-1');

    // Should only detect repoB as stuck, not repoA
    const errorCalls = mockAppendJsonl.mock.calls.filter(
      call => (call[1] as any).type === 'error'
    );
    expect(errorCalls.length).toBeGreaterThan(0);
    const stuckRepoError = errorCalls.find(
      call => (call[1] as any).repoName === 'repoB'
    );
    expect(stuckRepoError).toBeDefined();
    const completedRepoError = errorCalls.find(
      call => (call[1] as any).repoName === 'repoA'
    );
    expect(completedRepoError).toBeUndefined();
  });
});
