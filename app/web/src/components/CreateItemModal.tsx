import { useState, useEffect } from 'react';
import type { CreateItemRequest } from '@agent-orch/shared';
import { useRepositoryList } from '../hooks/useRepositories';
import { RepositorySelector } from './RepositorySelector';

interface CreateItemModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (data: CreateItemRequest) => Promise<void>;
}

type RepoType = 'remote' | 'local';
type LinkMode = 'symlink' | 'copy';
type RepoSource = 'saved' | 'manual';

export function CreateItemModal({ isOpen, onClose, onCreate }: CreateItemModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repoSource, setRepoSource] = useState<RepoSource>('saved');
  const [selectedRepoId, setSelectedRepoId] = useState<string | undefined>();
  const [repoType, setRepoType] = useState<RepoType>('remote');
  const [repoUrl, setRepoUrl] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [linkMode, setLinkMode] = useState<LinkMode>('symlink');
  const [branch, setBranch] = useState('');
  const [workBranch, setWorkBranch] = useState('');
  const [submodules, setSubmodules] = useState(false);
  const [designDoc, setDesignDoc] = useState('');
  const [saveRepository, setSaveRepository] = useState(false);
  const [repositoryName, setRepositoryName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { repositories, loading: reposLoading, refresh: refreshRepos } = useRepositoryList();

  // Refresh repositories when modal opens
  useEffect(() => {
    if (isOpen) {
      refreshRepos();
    }
  }, [isOpen, refreshRepos]);

  // Auto-select manual if no saved repositories
  useEffect(() => {
    if (!reposLoading && repositories.length === 0) {
      setRepoSource('manual');
    }
  }, [reposLoading, repositories.length]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const requestData: CreateItemRequest = {
        name,
        description,
        designDoc: designDoc || undefined,
      };

      if (repoSource === 'saved' && selectedRepoId) {
        requestData.repositoryId = selectedRepoId;
        if (branch) {
          requestData.branch = branch;
        }
        if (workBranch) {
          requestData.workBranch = workBranch;
        }
      } else {
        // Manual entry
        requestData.repository = repoType === 'remote'
          ? {
              type: 'remote',
              url: repoUrl,
              branch: branch || undefined,
              workBranch: workBranch || undefined,
              submodules,
            }
          : {
              type: 'local',
              localPath,
              linkMode,
            };

        if (saveRepository && repositoryName) {
          requestData.saveRepository = true;
          requestData.repositoryName = repositoryName;
        }
      }

      await onCreate(requestData);
      onClose();
      // Reset form
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create item');
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setName('');
    setDescription('');
    setRepoSource('saved');
    setSelectedRepoId(undefined);
    setRepoType('remote');
    setRepoUrl('');
    setLocalPath('');
    setLinkMode('symlink');
    setBranch('');
    setWorkBranch('');
    setSubmodules(false);
    setDesignDoc('');
    setSaveRepository(false);
    setRepositoryName('');
  };

  const isFormValid = () => {
    if (!name || !description) return false;
    if (repoSource === 'saved') {
      return !!selectedRepoId;
    } else {
      if (repoType === 'remote') {
        return !!repoUrl;
      } else {
        return !!localPath;
      }
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl font-bold text-white mb-4">Create New Item</h2>

        {error && (
          <div className="bg-red-900/50 text-red-300 px-4 py-2 rounded mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Name *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
              placeholder="My Feature"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Description *
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              rows={2}
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
              placeholder="Brief description of what you want to build"
            />
          </div>

          {/* Repository Source Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Repository Source *
            </label>
            <div className="flex gap-4 mb-3">
              <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                <input
                  type="radio"
                  name="repoSource"
                  value="saved"
                  checked={repoSource === 'saved'}
                  onChange={() => setRepoSource('saved')}
                  className="text-blue-500"
                  disabled={repositories.length === 0 && !reposLoading}
                />
                Select from saved
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                <input
                  type="radio"
                  name="repoSource"
                  value="manual"
                  checked={repoSource === 'manual'}
                  onChange={() => setRepoSource('manual')}
                  className="text-blue-500"
                />
                Enter manually
              </label>
            </div>

            {repoSource === 'saved' ? (
              <>
                <RepositorySelector
                  repositories={repositories}
                  selectedId={selectedRepoId}
                  onSelect={setSelectedRepoId}
                  loading={reposLoading}
                />
                {selectedRepoId && (
                  <div className="mt-3 grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-300 mb-1">
                        Clone Branch (optional)
                      </label>
                      <input
                        type="text"
                        value={branch}
                        onChange={(e) => setBranch(e.target.value)}
                        className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                        placeholder={repositories.find(r => r.id === selectedRepoId)?.branch || 'main'}
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Override saved branch
                      </p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-300 mb-1">
                        Work Branch (optional)
                      </label>
                      <input
                        type="text"
                        value={workBranch}
                        onChange={(e) => setWorkBranch(e.target.value)}
                        className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                        placeholder="feature/my-feature"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Branch for agent work (auto-created)
                      </p>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                {/* Repository Type */}
                <div className="mb-3">
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Repository Type *
                  </label>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                      <input
                        type="radio"
                        name="repoType"
                        value="remote"
                        checked={repoType === 'remote'}
                        onChange={() => setRepoType('remote')}
                        className="text-blue-500"
                      />
                      Remote (Clone from URL)
                    </label>
                    <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                      <input
                        type="radio"
                        name="repoType"
                        value="local"
                        checked={repoType === 'local'}
                        onChange={() => setRepoType('local')}
                        className="text-blue-500"
                      />
                      Local (Existing repository)
                    </label>
                  </div>
                </div>

                {repoType === 'remote' ? (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-300 mb-1">
                        Repository URL *
                      </label>
                      <input
                        type="text"
                        value={repoUrl}
                        onChange={(e) => setRepoUrl(e.target.value)}
                        required={repoSource === 'manual' && repoType === 'remote'}
                        className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                        placeholder="https://github.com/user/repo.git or git@github.com:user/repo.git"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Supports HTTPS and SSH formats
                      </p>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-1">
                          Clone Branch
                        </label>
                        <input
                          type="text"
                          value={branch}
                          onChange={(e) => setBranch(e.target.value)}
                          className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                          placeholder="main"
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          Branch to clone from
                        </p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-1">
                          Work Branch
                        </label>
                        <input
                          type="text"
                          value={workBranch}
                          onChange={(e) => setWorkBranch(e.target.value)}
                          className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                          placeholder="feature/my-feature"
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          Branch for agent work (auto-created)
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center">
                      <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={submodules}
                          onChange={(e) => setSubmodules(e.target.checked)}
                          className="rounded bg-gray-700 border-gray-600"
                        />
                        Include submodules
                      </label>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-300 mb-1">
                        Local Path *
                      </label>
                      <input
                        type="text"
                        value={localPath}
                        onChange={(e) => setLocalPath(e.target.value)}
                        required={repoSource === 'manual' && repoType === 'local'}
                        className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 font-mono text-sm"
                        placeholder="/path/to/existing/repo"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Absolute path to an existing local repository
                      </p>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-300 mb-2">
                        Link Mode
                      </label>
                      <div className="flex gap-4">
                        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                          <input
                            type="radio"
                            name="linkMode"
                            value="symlink"
                            checked={linkMode === 'symlink'}
                            onChange={() => setLinkMode('symlink')}
                            className="text-blue-500"
                          />
                          Symlink
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                          <input
                            type="radio"
                            name="linkMode"
                            value="copy"
                            checked={linkMode === 'copy'}
                            onChange={() => setLinkMode('copy')}
                            className="text-blue-500"
                          />
                          Copy
                        </label>
                      </div>
                      <p className="text-xs text-gray-500 mt-1">
                        {linkMode === 'symlink'
                          ? 'Changes will be reflected in the original repository'
                          : 'Creates an independent copy of the repository'}
                      </p>
                    </div>
                  </>
                )}

                {/* Save Repository Option */}
                <div className="mt-3 p-3 bg-gray-700/50 rounded">
                  <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={saveRepository}
                      onChange={(e) => setSaveRepository(e.target.checked)}
                      className="rounded bg-gray-700 border-gray-600"
                    />
                    Save this repository for reuse
                  </label>
                  {saveRepository && (
                    <div className="mt-2">
                      <input
                        type="text"
                        value={repositoryName}
                        onChange={(e) => setRepositoryName(e.target.value)}
                        placeholder="Repository display name"
                        className="w-full bg-gray-600 border border-gray-500 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 text-sm"
                      />
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Design Document
            </label>
            <textarea
              value={designDoc}
              onChange={(e) => setDesignDoc(e.target.value)}
              rows={6}
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500 font-mono text-sm"
              placeholder="Paste your design document or requirements here..."
            />
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-300 hover:text-white"
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !isFormValid()}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create Item'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
