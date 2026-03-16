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
});
