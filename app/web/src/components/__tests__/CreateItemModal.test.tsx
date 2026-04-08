import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CreateItemModal } from '../CreateItemModal';

vi.mock('../../hooks/useRepositories', () => ({
  useRepositoryList: vi.fn(),
}));

import { useRepositoryList } from '../../hooks/useRepositories';

const mockUseRepositoryList = vi.mocked(useRepositoryList);

describe('CreateItemModal', () => {
  const onCreate = vi.fn();
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    onCreate.mockResolvedValue(undefined);
    mockUseRepositoryList.mockReturnValue({
      repositories: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    });
  });

  function renderModal() {
    return render(
      <CreateItemModal isOpen={true} onClose={onClose} onCreate={onCreate} />
    );
  }

  it('shows setup commands textarea for manual + remote repos', () => {
    const view = renderModal();

    // No saved repos, so auto-selects manual. Default repoType is remote.
    expect(view.getByText('Setup Commands')).toBeInTheDocument();
    expect(view.getByPlaceholderText('npm install\nnpm run build', { collapseWhitespace: false })).toBeInTheDocument();
  });

  it('hides setup commands textarea for manual + local repos', async () => {
    const user = userEvent.setup();
    const view = renderModal();

    // Switch to local repo type
    const localRadio = view.getByLabelText('Local');
    await user.click(localRadio);

    expect(view.queryByText('Setup Commands')).not.toBeInTheDocument();
    expect(view.queryByPlaceholderText('npm install\nnpm run build', { collapseWhitespace: false })).not.toBeInTheDocument();
  });

  it('hides setup commands textarea for saved repos', () => {
    mockUseRepositoryList.mockReturnValue({
      repositories: [
        {
          id: 'REPO-1',
          name: 'saved-repo',
          type: 'remote' as const,
          url: 'https://github.com/test/repo.git',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    });

    const view = render(
      <CreateItemModal isOpen={true} onClose={onClose} onCreate={onCreate} />
    );

    // Default repoSource is 'saved' when saved repos exist
    expect(view.queryByText('Setup Commands')).not.toBeInTheDocument();
  });

  it('parses multiline setup commands into string array on submit', async () => {
    const user = userEvent.setup();
    const view = renderModal();

    // Fill required fields
    await user.type(view.getByPlaceholderText('My Feature'), 'Test Item');
    await user.type(
      view.getByPlaceholderText('Brief description of what you want to build'),
      'Test description'
    );
    await user.type(view.getByPlaceholderText('frontend'), 'my-repo');
    await user.type(
      view.getByPlaceholderText('https://github.com/user/repo.git'),
      'https://github.com/test/repo.git'
    );

    // Enter setup commands with whitespace and empty lines
    const textarea = view.getByPlaceholderText('npm install\nnpm run build', { collapseWhitespace: false });
    await user.type(textarea, 'npm install{enter}  {enter}npm run build{enter}  npm test  ');

    await user.click(view.getByRole('button', { name: 'Create Item' }));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        repositories: [
          expect.objectContaining({
            repository: expect.objectContaining({
              type: 'remote',
              setup: ['npm install', 'npm run build', 'npm test'],
            }),
          }),
        ],
      })
    );
  });

  it('sets setup to undefined when textarea is empty', async () => {
    const user = userEvent.setup();
    const view = renderModal();

    // Fill required fields
    await user.type(view.getByPlaceholderText('My Feature'), 'Test Item');
    await user.type(
      view.getByPlaceholderText('Brief description of what you want to build'),
      'Test description'
    );
    await user.type(view.getByPlaceholderText('frontend'), 'my-repo');
    await user.type(
      view.getByPlaceholderText('https://github.com/user/repo.git'),
      'https://github.com/test/repo.git'
    );

    // Leave setup commands empty (default)

    await user.click(view.getByRole('button', { name: 'Create Item' }));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        repositories: [
          expect.objectContaining({
            repository: expect.objectContaining({
              type: 'remote',
            }),
          }),
        ],
      })
    );

    // Verify setup is not present (undefined)
    const callArgs = onCreate.mock.calls[0][0];
    expect(callArgs.repositories[0].repository.setup).toBeUndefined();
  });

  it('sets setup to undefined when textarea contains only whitespace and empty lines', async () => {
    const user = userEvent.setup();
    const view = renderModal();

    await user.type(view.getByPlaceholderText('My Feature'), 'Test Item');
    await user.type(
      view.getByPlaceholderText('Brief description of what you want to build'),
      'Test description'
    );
    await user.type(view.getByPlaceholderText('frontend'), 'my-repo');
    await user.type(
      view.getByPlaceholderText('https://github.com/user/repo.git'),
      'https://github.com/test/repo.git'
    );

    const textarea = view.getByPlaceholderText('npm install\nnpm run build', { collapseWhitespace: false });
    await user.type(textarea, '   {enter}  {enter}   ');

    await user.click(view.getByRole('button', { name: 'Create Item' }));

    const callArgs = onCreate.mock.calls[0][0];
    expect(callArgs.repositories[0].repository.setup).toBeUndefined();
  });
});
