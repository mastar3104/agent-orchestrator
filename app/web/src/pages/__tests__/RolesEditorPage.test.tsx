import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { RolesEditorPage } from '../RolesEditorPage';

// Mock the API client
vi.mock('../../api/client', () => ({
  getRolesYaml: vi.fn(),
  updateRolesYaml: vi.fn(),
  deleteLocalRolesYaml: vi.fn(),
}));

import * as api from '../../api/client';

const mockGetRolesYaml = vi.mocked(api.getRolesYaml);
const mockUpdateRolesYaml = vi.mocked(api.updateRolesYaml);
const mockDeleteLocalRolesYaml = vi.mocked(api.deleteLocalRolesYaml);

function renderPage() {
  return render(
    <MemoryRouter>
      <RolesEditorPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RolesEditorPage isLocal display', () => {
  it('shows "roles.yaml (default)" and no Reset button when isLocal is false', async () => {
    mockGetRolesYaml.mockResolvedValue({
      content: 'roles:\n  planner:\n',
      isLocal: false,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('roles.yaml (default)')).toBeInTheDocument();
    });

    expect(screen.queryByText('Reset to Default')).not.toBeInTheDocument();
  });

  it('shows "roles.local.yaml" and Reset button when isLocal is true', async () => {
    mockGetRolesYaml.mockResolvedValue({
      content: 'roles:\n  planner:\n',
      isLocal: true,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('roles.local.yaml')).toBeInTheDocument();
    });

    expect(screen.getByText('Reset to Default')).toBeInTheDocument();
  });

  it('updates title to "roles.local.yaml" after save', async () => {
    const user = userEvent.setup();

    mockGetRolesYaml.mockResolvedValue({
      content: 'roles:\n  planner:\n',
      isLocal: false,
    });
    mockUpdateRolesYaml.mockResolvedValue({
      content: 'roles:\n  planner: updated\n',
      isLocal: true,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('roles.yaml (default)')).toBeInTheDocument();
    });

    // Type in the textarea to make dirty
    const textarea = screen.getByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, 'roles:\n  planner: updated\n');

    // Click Save
    const saveButton = screen.getByText('Save');
    await user.click(saveButton);

    await waitFor(() => {
      expect(screen.getByText('roles.local.yaml')).toBeInTheDocument();
    });

    expect(screen.getByText('Reset to Default')).toBeInTheDocument();
  });

  it('updates title to "roles.yaml (default)" and hides Reset after reset', async () => {
    const user = userEvent.setup();

    mockGetRolesYaml.mockResolvedValue({
      content: 'roles:\n  local planner:\n',
      isLocal: true,
    });
    mockDeleteLocalRolesYaml.mockResolvedValue({
      content: 'roles:\n  base planner:\n',
      isLocal: false,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('roles.local.yaml')).toBeInTheDocument();
    });

    const resetButton = screen.getByText('Reset to Default');
    await user.click(resetButton);

    await waitFor(() => {
      expect(screen.getByText('roles.yaml (default)')).toBeInTheDocument();
    });

    expect(screen.queryByText('Reset to Default')).not.toBeInTheDocument();
  });
});
