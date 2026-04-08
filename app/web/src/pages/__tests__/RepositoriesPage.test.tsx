import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RepositoriesPage } from '../RepositoriesPage';

vi.mock('../../hooks/useRepositories', () => ({
  useRepositoryList: vi.fn(),
}));

import { useRepositoryList } from '../../hooks/useRepositories';

const mockUseRepositoryList = vi.mocked(useRepositoryList);
const EXISTING_REPOSITORY = {
  id: 'REPO-1',
  name: 'repo-a',
  type: 'local' as const,
  localPath: '/tmp/repo-a',
  allowedTools: ['Bash(git status)', 'Edit'],
  hooks: ['npm run lint', 'npm test'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('RepositoriesPage', () => {
  const refresh = vi.fn();
  const create = vi.fn();
  const update = vi.fn();
  const remove = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRepositoryList.mockReturnValue({
      repositories: [],
      loading: false,
      error: null,
      refresh,
      create,
      update,
      remove,
    });
  });

  it('submits rolePrompts when creating a repository', async () => {
    const user = userEvent.setup();
    create.mockResolvedValue({
      id: 'REPO-1',
      name: 'repo-a',
    });

    const view = render(
      <MemoryRouter>
        <RepositoriesPage />
      </MemoryRouter>
    );

    await user.click(view.getByRole('button', { name: '+ New Repository' }));
    await user.type(view.getByPlaceholderText('my-repo'), 'repo-a');
    await user.type(view.getByPlaceholderText('https://github.com/user/repo.git'), 'https://github.com/example/repo.git');
    await user.type(
      view.getByPlaceholderText('Optional repository-specific prompt for Planner'),
      'Repo-specific planner prompt'
    );
    await user.type(
      view.getByPlaceholderText('Optional repository-specific prompt for Engineer'),
      'Repo-specific engineer prompt'
    );

    await user.click(view.getByRole('button', { name: 'Create' }));

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'repo-a',
      rolePrompts: {
        planner: 'Repo-specific planner prompt',
        engineer: 'Repo-specific engineer prompt',
      },
    }));
  });

  it('sends empty arrays when clearing allowedTools and hooks during edit', async () => {
    const user = userEvent.setup();
    update.mockResolvedValue({
      ...EXISTING_REPOSITORY,
      allowedTools: [],
      hooks: [],
    });
    mockUseRepositoryList.mockReturnValue({
      repositories: [EXISTING_REPOSITORY],
      loading: false,
      error: null,
      refresh,
      create,
      update,
      remove,
    });

    const view = render(
      <MemoryRouter>
        <RepositoriesPage />
      </MemoryRouter>
    );

    await user.click(view.getByRole('button', { name: 'Edit' }));

    const allowedToolsInput = view.getByPlaceholderText('Bash(git status), Bash(npm run test)');
    await user.clear(allowedToolsInput);
    await user.type(allowedToolsInput, ',   ,');

    const hooksInput = view.getByPlaceholderText('npm run lint\nnpm test', { collapseWhitespace: false });
    await user.clear(hooksInput);
    await user.type(hooksInput, '  \n   ');

    await user.click(view.getByRole('button', { name: 'Update' }));

    expect(update).toHaveBeenCalledWith('REPO-1', expect.objectContaining({
      allowedTools: [],
      hooks: [],
    }));
  });
});
