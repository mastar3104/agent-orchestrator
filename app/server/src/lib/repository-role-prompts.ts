import type { EditableRolePromptKey, RolePrompts } from '@agent-orch/shared';

type RepoScopedRolePromptKey = Extract<
  EditableRolePromptKey,
  | 'engineer'
  | 'reviewer'
  | 'architectureReviewer'
  | 'securityReviewer'
  | 'testingReviewer'
  | 'requirementsReviewer'
  | 'reviewReceiver'
>;

type WorkspaceScopedRolePromptKey = Extract<
  EditableRolePromptKey,
  'planner' | 'testPlanner' | 'completedReviewer'
>;

export function composeRepositoryRolePrompt(
  basePrompt: string,
  rolePrompts: RolePrompts | undefined,
  roleKey: RepoScopedRolePromptKey,
  fallbackRoleKey?: RepoScopedRolePromptKey
): string {
  const promptSections: string[] = [];
  const fallbackPrompt = fallbackRoleKey ? rolePrompts?.[fallbackRoleKey]?.trim() : '';
  if (fallbackPrompt) {
    promptSections.push(fallbackPrompt);
  }

  const repositoryPrompt = rolePrompts?.[roleKey]?.trim();
  if (repositoryPrompt && (!fallbackRoleKey || roleKey !== fallbackRoleKey)) {
    promptSections.push(repositoryPrompt);
  }

  if (promptSections.length === 0) {
    return basePrompt;
  }

  return `## Repository-Specific Instructions

${promptSections.join('\n\n')}

${basePrompt}`;
}

export function composeWorkspaceRolePrompts(
  basePrompt: string,
  repositories: Array<{ name: string; rolePrompts?: RolePrompts }>,
  roleKey: WorkspaceScopedRolePromptKey
): string {
  const sections = repositories
    .map((repository) => {
      const workspacePrompt = repository.rolePrompts?.[roleKey]?.trim();
      if (!workspacePrompt) {
        return null;
      }

      return `### ${repository.name}
${workspacePrompt}`;
    })
    .filter((section): section is string => section !== null);

  if (sections.length === 0) {
    return basePrompt;
  }

  return `## Repository-Specific Instructions by Repository

${sections.join('\n\n')}

${basePrompt}`;
}

export function composePlannerRepositoryPrompts(
  basePrompt: string,
  repositories: Array<{ name: string; rolePrompts?: RolePrompts }>
): string {
  return composeWorkspaceRolePrompts(basePrompt, repositories, 'planner');
}
