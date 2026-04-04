import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentOutputPanel } from '../AgentOutputPanel';

vi.mock('../../api/client', () => ({
  getAgentOutput: vi.fn(),
}));

import { getAgentOutput } from '../../api/client';

const mockGetAgentOutput = vi.mocked(getAgentOutput);

describe('AgentOutputPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows system prompt in a dedicated tab when captured', async () => {
    mockGetAgentOutput.mockResolvedValue({
      output: {
        prompt: 'user prompt body',
        systemPrompt: 'system prompt body',
        stdout: 'raw stdout',
        stderr: '',
        parsedOutput: { status: 'ok' },
        exitCode: 0,
        durationMs: 1000,
        timestamp: '2026-04-04T00:00:00Z',
      },
    });

    render(
      <AgentOutputPanel
        itemId="ITEM-1"
        agentId="agent-1"
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'System Prompt' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Prompt' }));
    expect(screen.getByText('user prompt body')).toBeInTheDocument();
    expect(screen.queryByText('system prompt body')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'System Prompt' }));
    expect(screen.getByText('system prompt body')).toBeInTheDocument();
  });

  it('shows not captured when legacy output has no systemPrompt', async () => {
    mockGetAgentOutput.mockResolvedValue({
      output: {
        prompt: 'legacy user prompt',
        stdout: '',
        stderr: '',
        parsedOutput: null,
        exitCode: 0,
        durationMs: 1000,
        timestamp: '2026-04-04T00:00:00Z',
      },
    });

    render(
      <AgentOutputPanel
        itemId="ITEM-1"
        agentId="agent-legacy"
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'System Prompt' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'System Prompt' }));
    expect(screen.getByText('(not captured)')).toBeInTheDocument();
  });
});
