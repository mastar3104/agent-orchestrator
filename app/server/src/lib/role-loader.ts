import { existsSync, readFileSync } from 'fs';
import type {
  EditableRolePromptKey,
  GlobalRoleToolOverrides,
  RolePrompts,
} from '@agent-orch/shared';
import { parse } from 'yaml';
import { SCHEMA_REGISTRY } from './claude-schemas';
import { getRoleToolsLocalPath, getRolesConfigPath } from './paths';

const EDITABLE_ROLE_PROMPT_KEYS: EditableRolePromptKey[] = [
  'planner',
  'engineer',
  'reviewer',
  'reviewReceiver',
  'testPlanner',
  'completedReviewer',
];

const GLOBAL_ROLE_TOOL_KEYS = [
  'planner',
  'testPlanner',
  'completedReviewer',
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

interface RawRoleDefinition {
  promptTemplate?: unknown;
  systemPrompt?: unknown;
  allowedTools?: unknown;
  schemaRef?: unknown;
}

interface RawRolesConfig {
  roles?: Record<string, RawRoleDefinition>;
}

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

function resolvePromptTemplate(roleName: string, rawRole: RawRoleDefinition): string {
  const promptTemplate = typeof rawRole.promptTemplate === 'string'
    ? rawRole.promptTemplate
    : typeof rawRole.systemPrompt === 'string'
      ? rawRole.systemPrompt
      : null;

  if (promptTemplate == null || promptTemplate.trim() === '') {
    throw new Error(`Role '${roleName}': promptTemplate must be a non-empty string`);
  }

  return promptTemplate.trim();
}

function loadRoleDefinitions(filePath: string = getRolesConfigPath()): Record<string, RoleDefinition> {
  if (!existsSync(filePath)) {
    throw new Error(`Role config file not found: ${filePath}`);
  }

  const raw = parse(readFileSync(filePath, 'utf-8')) as RawRolesConfig | Record<string, RawRoleDefinition>;
  const rawRoles = raw && typeof raw === 'object' && !Array.isArray(raw) && 'roles' in raw
    ? raw.roles
    : raw;

  if (!rawRoles || typeof rawRoles !== 'object' || Array.isArray(rawRoles)) {
    throw new Error(`Role config '${filePath}' must define a 'roles' object.`);
  }

  const roles = Object.fromEntries(
    Object.entries(rawRoles).map(([name, definition]) => {
      if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
        throw new Error(`Role '${name}': definition must be an object`);
      }

      const allowedTools = sanitizeAllowedToolList(
        `Role '${name}': allowedTools`,
        definition.allowedTools,
        Error
      );
      if (allowedTools.length === 0) {
        throw new Error(`Role '${name}': allowedTools must be a non-empty array`);
      }
      if (typeof definition.schemaRef !== 'string' || definition.schemaRef.trim() === '') {
        throw new Error(`Role '${name}': schemaRef must be a non-empty string`);
      }

      return [name, {
        systemPrompt: resolvePromptTemplate(name, definition),
        allowedTools,
        schemaRef: definition.schemaRef.trim(),
      }];
    })
  ) as Record<string, RoleDefinition>;

  return validateRoleDefinitions(roles);
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

export function loadRoles(
  overridesPath: string = getRoleToolsLocalPath(),
  rolesPath: string = getRolesConfigPath()
): Record<string, RoleDefinition> {
  const configuredRoles = loadRoleDefinitions(rolesPath);
  const toolOverrides = loadGlobalRoleToolOverrides(overridesPath);
  const roles = Object.fromEntries(
    Object.entries(configuredRoles).map(([name, role]) => [
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
    `[role-loader] Loaded ${Object.keys(roles).length} role(s) from ${rolesPath}: ${Object.keys(roles).join(', ')}` +
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
