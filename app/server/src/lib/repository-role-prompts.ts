import type { EditableRolePromptKey, RolePrompts } from '@agent-orch/shared';

type RepoScopedRolePromptKey = Extract<
  EditableRolePromptKey,
  'engineer' | 'reviewer' | 'reviewReceiver'
>;

export function composeRepositoryRolePrompt(
  basePrompt: string,
  rolePrompts: RolePrompts | undefined,
  roleKey: RepoScopedRolePromptKey
): string {
  const repositoryPrompt = rolePrompts?.[roleKey]?.trim();
  if (!repositoryPrompt) {
    return basePrompt;
  }

  return `## Repository-Specific Instructions

${repositoryPrompt}

${basePrompt}`;
}

export function composePlannerRepositoryPrompts(
  basePrompt: string,
  repositories: Array<{ name: string; rolePrompts?: RolePrompts }>
): string {
  const sections = repositories
    .map((repository) => {
      const plannerPrompt = repository.rolePrompts?.planner?.trim();
      if (!plannerPrompt) {
        return null;
      }

      return `### ${repository.name}
${plannerPrompt}`;
    })
    .filter((section): section is string => section !== null);

  if (sections.length === 0) {
    return basePrompt;
  }

  return `## Repository-Specific Instructions by Repository

${sections.join('\n\n')}

${basePrompt}`;
}
