import { nanoid } from 'nanoid';
import type {
  GitRepository,
  CreateRepositoryRequest,
  UpdateRepositoryRequest,
} from '@agent-orch/shared';
import { readYamlSafe, writeYaml } from '../lib/yaml';
import { getRepositoriesPath } from '../lib/paths';

async function loadRepositories(): Promise<GitRepository[]> {
  const repos = await readYamlSafe<GitRepository[]>(getRepositoriesPath());
  return repos || [];
}

async function saveRepositories(repos: GitRepository[]): Promise<void> {
  await writeYaml(getRepositoriesPath(), repos);
}

export async function listRepositories(): Promise<GitRepository[]> {
  const repos = await loadRepositories();
  // Sort by most recently updated
  return repos.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export async function getRepository(id: string): Promise<GitRepository | null> {
  const repos = await loadRepositories();
  return repos.find((r) => r.id === id) || null;
}

export async function createRepository(
  request: CreateRepositoryRequest
): Promise<GitRepository> {
  const repos = await loadRepositories();
  const now = new Date().toISOString();

  const repository: GitRepository = {
    id: `REPO-${nanoid(8)}`,
    name: request.name,
    type: request.type,
    url: request.url,
    localPath: request.localPath,
    branch: request.branch,
    submodules: request.submodules,
    linkMode: request.linkMode,
    directoryName: request.directoryName,
    role: request.role,
    createdAt: now,
    updatedAt: now,
  };

  repos.push(repository);
  await saveRepositories(repos);

  return repository;
}

export async function updateRepository(
  id: string,
  request: UpdateRepositoryRequest
): Promise<GitRepository | null> {
  const repos = await loadRepositories();
  const index = repos.findIndex((r) => r.id === id);

  if (index === -1) {
    return null;
  }

  const updated: GitRepository = {
    ...repos[index],
    ...request,
    updatedAt: new Date().toISOString(),
  };

  repos[index] = updated;
  await saveRepositories(repos);

  return updated;
}

export async function deleteRepository(id: string): Promise<boolean> {
  const repos = await loadRepositories();
  const index = repos.findIndex((r) => r.id === id);

  if (index === -1) {
    return false;
  }

  repos.splice(index, 1);
  await saveRepositories(repos);

  return true;
}
