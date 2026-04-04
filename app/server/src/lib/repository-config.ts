import type {
  EditableRolePromptKey,
  GitRepository,
  ItemConfig,
  ItemRepositoryConfig,
  RolePrompts,
} from '@agent-orch/shared';

export const DEFAULT_HOOKS_MAX_ATTEMPTS = 2;

const EDITABLE_ROLE_PROMPT_KEYS: EditableRolePromptKey[] = [
  'planner',
  'engineer',
  'reviewer',
  'architectureReviewer',
  'securityReviewer',
  'testingReviewer',
  'requirementsReviewer',
  'reviewReceiver',
  'testPlanner',
  'completedReviewer',
];

function normalizeRolePrompts(value: unknown): RolePrompts | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const normalized: RolePrompts = {};
  const rolePrompts = value as Record<string, unknown>;

  for (const key of EDITABLE_ROLE_PROMPT_KEYS) {
    const prompt = rolePrompts[key];
    if (typeof prompt !== 'string') {
      continue;
    }

    const trimmed = prompt.trim();
    if (!trimmed) {
      continue;
    }

    normalized[key] = trimmed;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

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
    rolePrompts: normalizeRolePrompts(repository.rolePrompts),
    hooksMaxAttempts: normalizeHooksMaxAttempts(repository.hooksMaxAttempts),
  };
}

export function normalizeItemRepositoryConfig(repository: ItemRepositoryConfig): ItemRepositoryConfig {
  return {
    ...repository,
    rolePrompts: normalizeRolePrompts(repository.rolePrompts),
    hooksMaxAttempts: normalizeHooksMaxAttempts(repository.hooksMaxAttempts),
  };
}

export function normalizeItemConfig(config: ItemConfig): ItemConfig {
  return {
    ...config,
    repositories: config.repositories.map(normalizeItemRepositoryConfig),
  };
}
