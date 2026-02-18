import { useState, useEffect } from 'react';
import type { CreateItemRequest, CreateItemRepositoryInput } from '@agent-orch/shared';
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

interface RepoEntry {
  key: number;
  name: string;
  role: string;
  repoSource: RepoSource;
  selectedRepoId?: string;
  repoType: RepoType;
  repoUrl: string;
  localPath: string;
  linkMode: LinkMode;
  branch: string;
  workBranch: string;
  submodules: boolean;
  saveRepository: boolean;
  repositoryName: string;
}

let nextKey = 0;
function createEmptyRepoEntry(): RepoEntry {
  return {
    key: nextKey++,
    name: '',
    role: '',
    repoSource: 'saved',
    selectedRepoId: undefined,
    repoType: 'remote',
    repoUrl: '',
    localPath: '',
    linkMode: 'symlink',
    branch: '',
    workBranch: '',
    submodules: false,
    saveRepository: false,
    repositoryName: '',
  };
}

export function CreateItemModal({ isOpen, onClose, onCreate }: CreateItemModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repos, setRepos] = useState<RepoEntry[]>([createEmptyRepoEntry()]);
  const [designDoc, setDesignDoc] = useState('');
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
      setRepos((prev) =>
        prev.map((r) => (r.repoSource === 'saved' ? { ...r, repoSource: 'manual' } : r))
      );
    }
  }, [reposLoading, repositories.length]);

  if (!isOpen) return null;

  const updateRepo = (key: number, updates: Partial<RepoEntry>) => {
    setRepos((prev) =>
      prev.map((r) => (r.key === key ? { ...r, ...updates } : r))
    );
  };

  const addRepo = () => {
    setRepos((prev) => [...prev, createEmptyRepoEntry()]);
  };

  const removeRepo = (key: number) => {
    setRepos((prev) => prev.filter((r) => r.key !== key));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const repoInputs: CreateItemRepositoryInput[] = repos.map((repo) => {
        const input: CreateItemRepositoryInput = {
          name: repo.name,
          role: repo.role,
        };

        if (repo.repoSource === 'saved' && repo.selectedRepoId) {
          input.repositoryId = repo.selectedRepoId;
          if (repo.branch) input.branch = repo.branch;
          if (repo.workBranch) input.workBranch = repo.workBranch;
        } else {
          input.repository =
            repo.repoType === 'remote'
              ? {
                  type: 'remote',
                  url: repo.repoUrl,
                  branch: repo.branch || undefined,
                  workBranch: repo.workBranch || undefined,
                  submodules: repo.submodules,
                }
              : {
                  type: 'local',
                  localPath: repo.localPath,
                  linkMode: repo.linkMode,
                };

          if (repo.saveRepository && repo.repositoryName) {
            input.saveRepository = true;
            input.repositoryName = repo.repositoryName;
          }
        }

        return input;
      });

      await onCreate({
        name,
        description,
        repositories: repoInputs,
        designDoc: designDoc || undefined,
      });
      onClose();
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
    setRepos([createEmptyRepoEntry()]);
    setDesignDoc('');
  };

  const isRepoValid = (repo: RepoEntry) => {
    if (!repo.name || !repo.role) return false;
    if (repo.repoSource === 'saved') {
      return !!repo.selectedRepoId;
    } else {
      if (repo.repoType === 'remote') return !!repo.repoUrl;
      return !!repo.localPath;
    }
  };

  const isFormValid = () => {
    if (!name || !description) return false;
    if (repos.length === 0) return false;
    return repos.every(isRepoValid);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
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

          {/* Repositories */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-300">
                Repositories *
              </label>
              <button
                type="button"
                onClick={addRepo}
                className="px-2 py-1 text-xs bg-gray-700 text-gray-300 rounded hover:bg-gray-600"
              >
                + Add Repository
              </button>
            </div>

            <div className="space-y-4">
              {repos.map((repo, index) => (
                <div
                  key={repo.key}
                  className="bg-gray-750 border border-gray-600 rounded-lg p-4 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-300">
                      Repository {index + 1}
                    </span>
                    {repos.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeRepo(repo.key)}
                        className="text-xs text-red-400 hover:text-red-300"
                      >
                        Remove
                      </button>
                    )}
                  </div>

                  {/* Name and Role */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-400 mb-1">
                        Directory Name *
                      </label>
                      <input
                        type="text"
                        value={repo.name}
                        onChange={(e) => updateRepo(repo.key, { name: e.target.value })}
                        className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
                        placeholder="frontend"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-400 mb-1">
                        Role *
                      </label>
                      <input
                        type="text"
                        value={repo.role}
                        onChange={(e) => updateRepo(repo.key, { role: e.target.value })}
                        className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
                        placeholder="front"
                      />
                      <p className="text-xs text-gray-500 mt-0.5">
                        Dev agent role (e.g. front, back, docs)
                      </p>
                    </div>
                  </div>

                  {/* Repository Source Selection */}
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                      <input
                        type="radio"
                        name={`repoSource-${repo.key}`}
                        value="saved"
                        checked={repo.repoSource === 'saved'}
                        onChange={() => updateRepo(repo.key, { repoSource: 'saved' })}
                        className="text-blue-500"
                        disabled={repositories.length === 0 && !reposLoading}
                      />
                      Saved
                    </label>
                    <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                      <input
                        type="radio"
                        name={`repoSource-${repo.key}`}
                        value="manual"
                        checked={repo.repoSource === 'manual'}
                        onChange={() => updateRepo(repo.key, { repoSource: 'manual' })}
                        className="text-blue-500"
                      />
                      Manual
                    </label>
                  </div>

                  {repo.repoSource === 'saved' ? (
                    <>
                      <RepositorySelector
                        repositories={repositories}
                        selectedId={repo.selectedRepoId}
                        onSelect={(id) => {
                          const updates: Partial<RepoEntry> = { selectedRepoId: id };
                          if (id) {
                            const selectedRepo = repositories.find(r => r.id === id);
                            if (selectedRepo) {
                              if (selectedRepo.directoryName) {
                                updates.name = selectedRepo.directoryName;
                              }
                              if (selectedRepo.role) {
                                updates.role = selectedRepo.role;
                              }
                            }
                          }
                          updateRepo(repo.key, updates);
                        }}
                        loading={reposLoading}
                      />
                      {repo.selectedRepoId && (
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-400 mb-1">
                              Clone Branch
                            </label>
                            <input
                              type="text"
                              value={repo.branch}
                              onChange={(e) => updateRepo(repo.key, { branch: e.target.value })}
                              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
                              placeholder={repositories.find(r => r.id === repo.selectedRepoId)?.branch || 'main'}
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-400 mb-1">
                              Work Branch
                            </label>
                            <input
                              type="text"
                              value={repo.workBranch}
                              onChange={(e) => updateRepo(repo.key, { workBranch: e.target.value })}
                              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
                              placeholder="auto-generated"
                            />
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      {/* Repo Type */}
                      <div className="flex gap-4">
                        <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                          <input
                            type="radio"
                            name={`repoType-${repo.key}`}
                            value="remote"
                            checked={repo.repoType === 'remote'}
                            onChange={() => updateRepo(repo.key, { repoType: 'remote' })}
                            className="text-blue-500"
                          />
                          Remote (Clone)
                        </label>
                        <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                          <input
                            type="radio"
                            name={`repoType-${repo.key}`}
                            value="local"
                            checked={repo.repoType === 'local'}
                            onChange={() => updateRepo(repo.key, { repoType: 'local' })}
                            className="text-blue-500"
                          />
                          Local
                        </label>
                      </div>

                      {repo.repoType === 'remote' ? (
                        <>
                          <div>
                            <label className="block text-xs font-medium text-gray-400 mb-1">
                              Repository URL *
                            </label>
                            <input
                              type="text"
                              value={repo.repoUrl}
                              onChange={(e) => updateRepo(repo.key, { repoUrl: e.target.value })}
                              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
                              placeholder="https://github.com/user/repo.git"
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="block text-xs font-medium text-gray-400 mb-1">
                                Clone Branch
                              </label>
                              <input
                                type="text"
                                value={repo.branch}
                                onChange={(e) => updateRepo(repo.key, { branch: e.target.value })}
                                className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
                                placeholder="main"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-gray-400 mb-1">
                                Work Branch
                              </label>
                              <input
                                type="text"
                                value={repo.workBranch}
                                onChange={(e) => updateRepo(repo.key, { workBranch: e.target.value })}
                                className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
                                placeholder="auto-generated"
                              />
                            </div>
                          </div>
                          <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={repo.submodules}
                              onChange={(e) => updateRepo(repo.key, { submodules: e.target.checked })}
                              className="rounded bg-gray-700 border-gray-600"
                            />
                            Include submodules
                          </label>
                        </>
                      ) : (
                        <>
                          <div>
                            <label className="block text-xs font-medium text-gray-400 mb-1">
                              Local Path *
                            </label>
                            <input
                              type="text"
                              value={repo.localPath}
                              onChange={(e) => updateRepo(repo.key, { localPath: e.target.value })}
                              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-blue-500"
                              placeholder="/path/to/existing/repo"
                            />
                          </div>
                          <div className="flex gap-4">
                            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                              <input
                                type="radio"
                                name={`linkMode-${repo.key}`}
                                value="symlink"
                                checked={repo.linkMode === 'symlink'}
                                onChange={() => updateRepo(repo.key, { linkMode: 'symlink' })}
                                className="text-blue-500"
                              />
                              Symlink
                            </label>
                            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                              <input
                                type="radio"
                                name={`linkMode-${repo.key}`}
                                value="copy"
                                checked={repo.linkMode === 'copy'}
                                onChange={() => updateRepo(repo.key, { linkMode: 'copy' })}
                                className="text-blue-500"
                              />
                              Copy
                            </label>
                          </div>
                        </>
                      )}

                      {/* Save Repository Option */}
                      <div className="p-2 bg-gray-700/50 rounded">
                        <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={repo.saveRepository}
                            onChange={(e) => updateRepo(repo.key, { saveRepository: e.target.checked })}
                            className="rounded bg-gray-700 border-gray-600"
                          />
                          Save for reuse
                        </label>
                        {repo.saveRepository && (
                          <input
                            type="text"
                            value={repo.repositoryName}
                            onChange={(e) => updateRepo(repo.key, { repositoryName: e.target.value })}
                            placeholder="Repository display name"
                            className="mt-2 w-full bg-gray-600 border border-gray-500 rounded px-3 py-1.5 text-white text-xs focus:outline-none focus:border-blue-500"
                          />
                        )}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
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
