import type { GitRepository, ItemConfig, ItemRepositoryConfig } from '@agent-orch/shared';

export const DEFAULT_HOOKS_MAX_ATTEMPTS = 2;

function isValidHooksMaxAttempts(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

export function normalizeHooksMaxAttempts(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return isValidHooksMaxAttempts(value) ? value : DEFAULT_HOOKS_MAX_ATTEMPTS;
}

export function resolveHooksMaxAttempts(value: unknown): number {
  return normalizeHooksMaxAttempts(value) ?? DEFAULT_HOOKS_MAX_ATTEMPTS;
}

export function normalizeGitRepository(repository: GitRepository): GitRepository {
  return {
    ...repository,
    hooksMaxAttempts: normalizeHooksMaxAttempts(repository.hooksMaxAttempts),
  };
}

export function normalizeItemRepositoryConfig(repository: ItemRepositoryConfig): ItemRepositoryConfig {
  return {
    ...repository,
    hooksMaxAttempts: normalizeHooksMaxAttempts(repository.hooksMaxAttempts),
  };
}

export function normalizeItemConfig(config: ItemConfig): ItemConfig {
  return {
    ...config,
    repositories: config.repositories.map(normalizeItemRepositoryConfig),
  };
}
