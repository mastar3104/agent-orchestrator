import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───

vi.mock('../agent-service', () => ({
  executeAgent: vi.fn().mockResolvedValue(undefined),
  getAgentsByItem: vi.fn().mockResolvedValue([]),
}));

vi.mock('../item-service', () => ({
  getItemConfig: vi.fn(),
}));

vi.mock('../../lib/paths', () => ({
  getWorkspaceRoot: vi.fn().mockReturnValue('/workspace'),
  getItemEventsPath: vi.fn().mockReturnValue('/events.jsonl'),
  getItemPlanPath: vi.fn().mockReturnValue('/tmp/plan.yaml'),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../event-bus', () => ({
  eventBus: { emit: vi.fn() },
}));

vi.mock('../../lib/jsonl', () => ({
  appendJsonl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/events', () => ({
  createPlanCreatedEvent: vi.fn().mockReturnValue({ type: 'plan_created', id: 'evt-1' }),
  createErrorEvent: vi.fn().mockReturnValue({ type: 'error' }),
}));

vi.mock('../../lib/role-loader', () => ({
  getRole: vi.fn().mockReturnValue({
    promptTemplate: 'You are a planner.',
    allowedTools: ['Read', 'Write'],
    jsonSchema: {},
  }),
}));

vi.mock('../../lib/yaml', () => ({
  readYamlSafe: vi.fn(),
  parseYaml: vi.fn(),
  stringifyYaml: vi.fn(),
}));

vi.mock('../task-state-service', () => ({
  createArchiveTag: vi.fn().mockReturnValue('20260307_000000_abc123'),
  archiveCurrentTaskStates: vi.fn().mockResolvedValue([]),
  regenerateTaskStatesForPlan: vi.fn().mockResolvedValue([]),
}));

import { validatePlanFeedback, planFeedback, formatFeedbacks } from '../planner-service';
import { executeAgent } from '../agent-service';
import { getItemConfig } from '../item-service';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { eventBus } from '../event-bus';
import { appendJsonl } from '../../lib/jsonl';
import { parseYaml } from '../../lib/yaml';
import type { Plan } from '@agent-orch/shared';

const VALID_PLAN: Plan = {
  version: '1',
  itemId: 'item-1',
  summary: 'Test plan',
  createdAt: '2026-01-01T00:00:00Z',
  tasks: [
    { id: 'task-1', title: 'Task 1', repository: 'repo-a', description: 'desc' },
    { id: 'task-2', title: 'Task 2', repository: 'repo-a', description: 'desc' },
    { id: 'task-3', title: 'Task 3', repository: 'repo-a', description: 'desc' },
  ],
};

const PLAN_YAML = 'version: "1"\nitemId: item-1\ntasks:\n  - id: task-1\n  - id: task-2\n  - id: task-3';

describe('validatePlanFeedback', () => {
  it('returns no errors for valid feedbacks', () => {
    const errors = validatePlanFeedback(
      [{ taskId: 'task-1', feedback: 'Fix this' }],
      VALID_PLAN
    );
    expect(errors).toHaveLength(0);
  });

  it('returns error for empty array', () => {
    const errors = validatePlanFeedback([], VALID_PLAN);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('empty');
  });

  it('returns error for empty taskId', () => {
    const errors = validatePlanFeedback(
      [{ taskId: '', feedback: 'Fix' }],
      VALID_PLAN
    );
    expect(errors.some(e => e.includes('taskId'))).toBe(true);
  });

  it('returns error for whitespace-only taskId', () => {
    const errors = validatePlanFeedback(
      [{ taskId: '   ', feedback: 'Fix' }],
      VALID_PLAN
    );
    expect(errors.some(e => e.includes('taskId'))).toBe(true);
  });

  it('returns error for empty feedback', () => {
    const errors = validatePlanFeedback(
      [{ taskId: 'task-1', feedback: '' }],
      VALID_PLAN
    );
    expect(errors.some(e => e.includes('feedback'))).toBe(true);
  });

  it('returns error for whitespace-only feedback', () => {
    const errors = validatePlanFeedback(
      [{ taskId: 'task-1', feedback: '   ' }],
      VALID_PLAN
    );
    expect(errors.some(e => e.includes('feedback'))).toBe(true);
  });

  it('returns error for non-existent taskId', () => {
    const errors = validatePlanFeedback(
      [{ taskId: 'nonexistent', feedback: 'Fix' }],
      VALID_PLAN
    );
    expect(errors.some(e => e.includes('not found'))).toBe(true);
  });

  it('returns error for duplicate taskId', () => {
    const errors = validatePlanFeedback(
      [
        { taskId: 'task-1', feedback: 'Fix A' },
        { taskId: 'task-1', feedback: 'Fix B' },
      ],
      VALID_PLAN
    );
    expect(errors.some(e => e.includes('Duplicate'))).toBe(true);
  });
});

describe('planFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getItemConfig).mockResolvedValue({
      id: 'item-1',
      name: 'Test',
      description: 'desc',
      repositories: [{ name: 'repo-a', type: 'local' }],
    } as any);
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue(PLAN_YAML as any);
    vi.mocked(parseYaml).mockReturnValue(VALID_PLAN);
    vi.mocked(executeAgent).mockResolvedValue(undefined as any);
  });

  it('archives plan, calls executeAgent with feedback prompt, and emits plan_created', async () => {
    await planFeedback('item-1', [{ taskId: 'task-1', feedback: 'Fix this' }]);

    // executeAgent was called with prompt containing the feedback
    expect(executeAgent).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(executeAgent).mock.calls[0][0];
    expect(callArgs.prompt).toContain('Fix this');
    expect(callArgs.prompt).toContain('task-1');

    // plan_created event was emitted
    expect(appendJsonl).toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith('event', expect.objectContaining({
      itemId: 'item-1',
    }));
  });

  it('throws when plan.yaml does not exist', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    await expect(planFeedback('item-1', [{ taskId: 'task-1', feedback: 'Fix' }]))
      .rejects.toThrow('No plan exists yet');
  });

  it('propagates executeAgent errors', async () => {
    vi.mocked(executeAgent).mockRejectedValue(new Error('Agent crashed'));
    await expect(planFeedback('item-1', [{ taskId: 'task-1', feedback: 'Fix' }]))
      .rejects.toThrow('Agent crashed');
  });
});

describe('formatFeedbacks', () => {
  it('formats feedbacks into markdown', () => {
    const result = formatFeedbacks(
      [
        { taskId: 'task-1', feedback: 'Fix the bug' },
        { taskId: 'task-3', feedback: 'Add tests' },
      ],
      PLAN_YAML
    );
    expect(result).toContain('User Feedback on Current Plan');
    expect(result).toContain('task-1');
    expect(result).toContain('Fix the bug');
    expect(result).toContain('task-3');
    expect(result).toContain('Add tests');
    expect(result).toContain(PLAN_YAML);
  });
});
