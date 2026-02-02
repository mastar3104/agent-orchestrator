import type { GitRepository } from '@agent-orch/shared';

interface RepositorySelectorProps {
  repositories: GitRepository[];
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
  loading?: boolean;
}

export function RepositorySelector({
  repositories,
  selectedId,
  onSelect,
  loading,
}: RepositorySelectorProps) {
  if (loading) {
    return (
      <div className="text-gray-400 text-sm py-2">
        Loading repositories...
      </div>
    );
  }

  if (repositories.length === 0) {
    return (
      <div className="text-gray-400 text-sm py-2">
        No saved repositories. Enter repository details manually below.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <select
        value={selectedId || ''}
        onChange={(e) => onSelect(e.target.value || undefined)}
        className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white focus:outline-none focus:border-blue-500"
      >
        <option value="">-- Select a saved repository --</option>
        {repositories.map((repo) => (
          <option key={repo.id} value={repo.id}>
            {repo.name} ({repo.type === 'remote' ? repo.url : repo.localPath})
          </option>
        ))}
      </select>

      {selectedId && (
        <RepositoryDetails
          repository={repositories.find((r) => r.id === selectedId)}
        />
      )}
    </div>
  );
}

interface RepositoryDetailsProps {
  repository: GitRepository | undefined;
}

function RepositoryDetails({ repository }: RepositoryDetailsProps) {
  if (!repository) return null;

  return (
    <div className="bg-gray-700/50 rounded p-3 text-sm">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <span className="text-gray-400">Type:</span>{' '}
          <span className="text-gray-200">{repository.type}</span>
        </div>
        {repository.type === 'remote' ? (
          <>
            <div>
              <span className="text-gray-400">URL:</span>{' '}
              <span className="text-gray-200 font-mono text-xs break-all">
                {repository.url}
              </span>
            </div>
            {repository.branch && (
              <div>
                <span className="text-gray-400">Branch:</span>{' '}
                <span className="text-gray-200">{repository.branch}</span>
              </div>
            )}
            {repository.submodules && (
              <div>
                <span className="text-gray-400">Submodules:</span>{' '}
                <span className="text-gray-200">Yes</span>
              </div>
            )}
          </>
        ) : (
          <>
            <div>
              <span className="text-gray-400">Path:</span>{' '}
              <span className="text-gray-200 font-mono text-xs break-all">
                {repository.localPath}
              </span>
            </div>
            {repository.linkMode && (
              <div>
                <span className="text-gray-400">Mode:</span>{' '}
                <span className="text-gray-200">{repository.linkMode}</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
