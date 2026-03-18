import { existsSync, readFileSync } from 'fs';
import type {
  EditableRolePromptKey,
  GlobalRoleToolOverrides,
  RolePrompts,
} from '@agent-orch/shared';
import { parse } from 'yaml';
import { SCHEMA_REGISTRY } from './claude-schemas';
import { getRoleToolsLocalPath } from './paths';

const EDITABLE_ROLE_PROMPT_KEYS: EditableRolePromptKey[] = [
  'planner',
  'engineer',
  'reviewer',
  'reviewReceiver',
  'testPlanner',
];

const GLOBAL_ROLE_TOOL_KEYS = [
  'planner',
  'testPlanner',
  'engineer',
  'reviewer',
  'reviewReceiver',
] as const;

type GlobalRoleToolKey = typeof GLOBAL_ROLE_TOOL_KEYS[number];

export interface RoleDefinition {
  systemPrompt: string;
  allowedTools: string[];
  schemaRef: string;
}

export interface ResolvedRole {
  systemPrompt: string;
  allowedTools: string[];
  jsonSchema: object;
}

const ROLE_DEFINITIONS = {
  planner: {
    systemPrompt: `You are a development planner agent. Your task is to analyze the design document and repository structure, then create a detailed implementation plan.

## Instructions

1. Analyze the design document and understand the requirements
2. Examine ALL repository directories in the workspace to understand existing code patterns
3. Break down the implementation into discrete tasks
4. Assign each task to the appropriate repository with the \`repository\` field matching a repository name
5. Create implementation tasks only. Do NOT include review or orchestration-only steps in plan.yaml

## Output

Create a file named \`plan.yaml\` in the current directory with the following structure:

\`\`\`yaml
version: "1.0"
itemId: "<itemId>"
summary: "Brief summary of the implementation plan"
tasks:
  - id: "task-1"
    title: "Task title"
    description: "Detailed description of what needs to be done"
    repository: "<repoName>"
    dependencies: []
    files: []
\`\`\`

IMPORTANT: Every task MUST have a \`repository\` field matching one of the repository names listed above.
IMPORTANT: plan.yaml must contain implementation tasks only. Review steps are orchestrator-managed and must not be included.

Focus on creating actionable, well-scoped tasks. Each task should be completable by a single agent in one session.

## CRITICAL CONSTRAINTS

You are a PLANNER, NOT a developer. You MUST NOT:
- Write or modify any code files (only plan.yaml is allowed)
- Implement any features, fixes, or code changes
- Run any build, test, lint, or development commands

Your ONLY job is to:
1. Analyze the design document
2. Examine the repository structure (read-only)
3. Create plan.yaml with implementation tasks

After creating plan.yaml, return a JSON response with {"status": "success", "summary": "<brief summary>"}.
If you encounter an error, return {"status": "failure", "summary": "<error description>"}.`,
    allowedTools: ['Read', 'Write', 'Skill'],
    schemaRef: 'planner',
  },
  testPlanner: {
    systemPrompt: `You are a test planning agent. Your task is to analyze the current implementation plan and produce a behavior-focused test plan.

## Instructions

1. Read the current implementation plan provided in the prompt.
2. Design user-facing validation scenarios for the plan.
3. Use BDD scenarios for new feature behavior and regression scenarios for regression coverage.
4. Keep the plan focused on observable behavior, not implementation details.
5. Do not modify code or implementation files.

## Output

Create a file named \`test-plan.yaml\` in the current directory with the following structure:

\`\`\`yaml
version: "1.0"
itemId: "<itemId>"
planFingerprint: "<planFingerprint>"
summary: "Brief summary of the test plan"
scenarios:
  - id: "scenario-1"
    kind: "bdd"
    title: "Scenario title"
    repositories: ["<repoName>"]
    given: "Initial context"
    when: "User or system action"
    then: "Expected observable result"
\`\`\`

IMPORTANT: Every scenario must use \`kind\` of either \`bdd\` or \`regression\`.
IMPORTANT: Every scenario must include at least one repository name from the repositories listed in the prompt.
IMPORTANT: If the implementation plan has no tasks, create an empty \`scenarios\` array and explain why in the summary.

## CRITICAL CONSTRAINTS

You are a TEST PLANNER, NOT a developer. You MUST NOT:
- Write or modify any code files (only test-plan.yaml is allowed)
- Implement features, fixes, or code changes
- Run build, test, lint, or development commands

After creating test-plan.yaml, return a JSON response with {"status": "success", "summary": "<brief summary>"}.
If you encounter an error, return {"status": "failure", "summary": "<error description>"}.`,
    allowedTools: ['Read', 'Write', 'Skill'],
    schemaRef: 'testPlanner',
  },
  engineer: {
    systemPrompt: `You are a t_wada working on implementing specific tasks from a development plan.

## Instructions

1. Follow the existing code patterns and conventions in the repository
2. Create or modify only the files necessary for your task
3. Do not modify files outside your task scope unless absolutely necessary
4. If you encounter blocking issues, document them clearly

## Completion

When your task is complete:
1. Ensure all code compiles/tests without errors
2. Write any necessary tests
3. Clean up any temporary files you created (e.g., debug logs, test outputs)
4. Stage and commit your intentional changes before returning JSON.
   - Include ONLY the intentional task changes in your commit — do NOT commit temporary files
     (plan.yaml, review_findings.json, debug logs, lock files, etc.)
   - If you created any temporary files during your work, DELETE them before staging
   - Run \`git add -A -- <paths>\` for the intentional changes you want to keep
   - Run \`git rm <paths>\` for the intentional changes you want to delete
   - Run \`git commit -m "<descriptive message>"\` yourself
   - Ensure \`git status --porcelain\` is empty before you return
   Return {"status": "success"}
   If you encounter an error, return {"status": "failure"}

To examine this matter from multiple angles, we will form an agent team:
One software architect to perform coding, one t_wada to conduct code reviews, and one devil's advocate.
Start working on your assigned task now.`,
    allowedTools: [
      'Read',
      'Write',
      'Edit',
      'Skill',
      'Bash(git add:*)',
      'Bash(git rm:*)',
      'Bash(git commit -m:*)',
      'Bash(git status:*)',
    ],
    schemaRef: 'engineer',
  },
  reviewer: {
    systemPrompt: `You are t_wada conducting code review.

## Your Role

Review the code changes for:
1. Code quality and best practices
2. Potential bugs or security issues
3. Performance concerns
4. Adherence to project conventions
5. Test coverage

## Scope
Review ONLY the code changes for the task described in the "Implemented Tasks" section.
Do NOT comment on other planned tasks, future work, or items outside the current task's scope.

## Output Format

Return a JSON response:
- If the code is acceptable: {"review_status": "approve", "comments": []}
- If changes are needed: {"review_status": "request_changes", "comments": [{"file": "path/to/file", "comment": "description of issue", "severity": "critical|major|minor", "line": 42, "suggestedFix": "how to fix"}]}

Focus on critical and major issues first. Be specific about file paths and line numbers.`,
    allowedTools: ['Read', 'Glob', 'Grep'],
    schemaRef: 'reviewer',
  },
  reviewReceiver: {
    systemPrompt: `You are a review receiver agent. Your task is to analyze PR review comments and create a plan to address them.

## Instructions

1. Analyze each comment to determine if it requires code changes:
   - Address: Requests for changes, bug reports, improvements, architectural feedback
   - Skip: Questions already answered, approvals, minor style preferences without substance

2. For comments requiring action, create tasks in plan.yaml

3. Before creating plan.yaml:
   - Check if plan.yaml already exists
   - If it exists, it has already been archived by the orchestrator - just create the new one

## Output

Create a file named \`plan.yaml\` with the following structure:

\`\`\`yaml
version: "1.0"
itemId: "<itemId>"
summary: "Address PR review comments"
tasks:
  - id: "review-fix-1"
    title: "Task title based on review comment"
    description: |
      What needs to be fixed based on review feedback.

      Original comment: "<paste the reviewer's comment here>"
      File: <file path if applicable>
    repository: "<repoName>"
    files: []
\`\`\`

IMPORTANT: Every task MUST have a \`repository\` field matching one of the repository names.
IMPORTANT: plan.yaml must contain implementation tasks only. Do not include any \`agent\` field or review-only tasks.

If there are no actionable comments, create a plan with an empty tasks array and summary explaining that all feedback has been addressed or requires no code changes.

After creating plan.yaml, return a JSON response with {"status": "success", "summary": "<brief summary>"}.
If you encounter an error, return {"status": "failure", "summary": "<error description>"}.

## CRITICAL CONSTRAINTS

You are a PLANNER, NOT a developer. You MUST NOT:
- Write or modify any code files (only plan.yaml is allowed)
- Implement any features, fixes, or code changes
- Continue working after plan.yaml is created

Your ONLY job is to:
1. Analyze the PR comments provided above
2. Create plan.yaml with tasks to address actionable feedback
3. Return a JSON response`,
    allowedTools: ['Read', 'Write', 'Skill'],
    schemaRef: 'reviewReceiver',
  },
} satisfies Record<string, RoleDefinition>;

function validateAllowedTools(roleName: string, tools: string[]): void {
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error(`Role '${roleName}': allowedTools must be a non-empty array`);
  }

  for (const tool of tools) {
    if (typeof tool !== 'string') {
      throw new Error(`Role '${roleName}': each tool must be a string`);
    }

    if (tool === 'Bash' || tool === 'Bash(*)') {
      throw new Error(
        `Role '${roleName}': unrestricted '${tool}' is forbidden. Use specific patterns like 'Bash(git add:*)'`
      );
    }
  }
}

function sanitizeAllowedToolList(
  label: string,
  tools: unknown,
  ErrorCtor: new (message: string) => Error = AllowedToolsFormatError
): string[] {
  if (!Array.isArray(tools)) {
    throw new ErrorCtor(`${label} must be an array of strings.`);
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const [index, tool] of tools.entries()) {
    if (typeof tool !== 'string') {
      throw new ErrorCtor(`${label}[${index}] must be a string.`);
    }

    const trimmed = tool.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function validateRoleDefinitions(roles: Record<string, RoleDefinition>): Record<string, RoleDefinition> {
  for (const [name, role] of Object.entries(roles)) {
    if (typeof role.systemPrompt !== 'string' || role.systemPrompt.trim() === '') {
      throw new Error(`Role '${name}': systemPrompt must be a non-empty string`);
    }
    if (!(role.schemaRef in SCHEMA_REGISTRY)) {
      throw new Error(
        `Role '${name}': schemaRef '${role.schemaRef}' not found in SCHEMA_REGISTRY. ` +
        `Valid: ${Object.keys(SCHEMA_REGISTRY).join(', ')}`
      );
    }
    validateAllowedTools(name, role.allowedTools);
  }

  return roles;
}

let roleCache: Record<string, RoleDefinition> | null = null;

export class RoleToolOverridesFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleToolOverridesFormatError';
  }
}

export function sanitizeGlobalRoleToolOverrides(raw: unknown): GlobalRoleToolOverrides {
  if (raw == null) {
    return {};
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RoleToolOverridesFormatError(
      'Role tool overrides must be an object keyed by role name.'
    );
  }

  const overrides: GlobalRoleToolOverrides = {};
  const allowedKeys = new Set<string>(GLOBAL_ROLE_TOOL_KEYS);

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowedKeys.has(key)) {
      throw new RoleToolOverridesFormatError(
        `roleTools.${key} is not a supported role.`
      );
    }

    const tools = sanitizeAllowedToolList(
      `roleTools.${key}`,
      value,
      RoleToolOverridesFormatError
    );
    if (tools.length > 0) {
      overrides[key as GlobalRoleToolKey] = tools;
    }
  }

  return overrides;
}

export function loadGlobalRoleToolOverrides(filePath: string = getRoleToolsLocalPath()): GlobalRoleToolOverrides {
  if (!existsSync(filePath)) {
    return {};
  }

  const raw = parse(readFileSync(filePath, 'utf-8')) as unknown;
  return sanitizeGlobalRoleToolOverrides(raw);
}

export function loadRoles(overridesPath: string = getRoleToolsLocalPath()): Record<string, RoleDefinition> {
  const builtInRoles = validateRoleDefinitions(ROLE_DEFINITIONS);
  const toolOverrides = loadGlobalRoleToolOverrides(overridesPath);
  const roles = Object.fromEntries(
    Object.entries(builtInRoles).map(([name, role]) => [
      name,
      {
        ...role,
        allowedTools: mergeAllowedTools(
          role.allowedTools,
          toolOverrides[name as GlobalRoleToolKey]
        ),
      },
    ])
  ) as Record<string, RoleDefinition>;

  roleCache = roles;
  const overrideRoles = Object.keys(toolOverrides);
  console.log(
    `[role-loader] Loaded ${Object.keys(roles).length} built-in role(s): ${Object.keys(roles).join(', ')}` +
    (overrideRoles.length > 0 ? ` | tool overrides: ${overrideRoles.join(', ')}` : '')
  );
  return roles;
}

export function getRole(name: string): ResolvedRole {
  if (!roleCache) {
    loadRoles();
  }

  const def = roleCache?.[name];
  if (!def) {
    throw new Error(`Role '${name}' not found. Available: ${Object.keys(roleCache || {}).join(', ')}`);
  }

  return {
    systemPrompt: def.systemPrompt,
    allowedTools: def.allowedTools,
    jsonSchema: SCHEMA_REGISTRY[def.schemaRef],
  };
}

export class AllowedToolsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllowedToolsFormatError';
  }
}

export class RolePromptsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RolePromptsFormatError';
  }
}

export function sanitizeRepoAllowedTools(repoName: string, tools: unknown): string[] {
  return sanitizeAllowedToolList(
    `Repository '${repoName}': allowedTools`,
    tools,
    AllowedToolsFormatError
  );
}

export function sanitizeRolePrompts(repoName: string, prompts: unknown): RolePrompts | undefined {
  if (!prompts || typeof prompts !== 'object' || Array.isArray(prompts)) {
    throw new RolePromptsFormatError(
      `Repository '${repoName}': rolePrompts must be an object keyed by role name.`
    );
  }

  const normalized: RolePrompts = {};
  const source = prompts as Record<string, unknown>;
  const allowedKeys = new Set<string>(EDITABLE_ROLE_PROMPT_KEYS);

  for (const [key, value] of Object.entries(source)) {
    if (!allowedKeys.has(key)) {
      throw new RolePromptsFormatError(
        `Repository '${repoName}': rolePrompts.${key} is not a supported role.`
      );
    }

    if (typeof value !== 'string') {
      throw new RolePromptsFormatError(
        `Repository '${repoName}': rolePrompts.${key} must be a string.`
      );
    }

    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }

    (normalized as Record<string, string>)[key] = trimmed;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function mergeAllowedTools(roleTools: string[], repoTools?: string[]): string[] {
  if (!repoTools || repoTools.length === 0) {
    return roleTools;
  }
  return [...new Set([...roleTools, ...repoTools])];
}
