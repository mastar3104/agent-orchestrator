import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'yaml';
import { SCHEMA_REGISTRY } from './claude-schemas';

// ─── Types ───

export interface RoleDefinition {
  promptTemplate: string;
  allowedTools: string[];
  schemaRef: string;
}

export interface ResolvedRole {
  promptTemplate: string;
  allowedTools: string[];
  jsonSchema: object;
}

const ALLOWED_BASH_PATTERNS = [
  'Bash(git add:*)',
  'Bash(git rm:*)',
  'Bash(git commit -m:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
];

function validateAllowedTools(roleName: string, tools: string[]): void {
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error(`Role '${roleName}': allowedTools must be a non-empty array`);
  }

  for (const tool of tools) {
    if (typeof tool !== 'string') {
      throw new Error(`Role '${roleName}': each tool must be a string`);
    }

    // Reject unrestricted Bash
    if (tool === 'Bash' || tool === 'Bash(*)') {
      throw new Error(
        `Role '${roleName}': unrestricted '${tool}' is forbidden. Use specific patterns like 'Bash(git add:*)'`
      );
    }

    if (tool.startsWith('Bash(') && !ALLOWED_BASH_PATTERNS.includes(tool)) {
      throw new Error(
        `Role '${roleName}': Bash pattern '${tool}' is not allowed. ` +
        `Permitted: ${ALLOWED_BASH_PATTERNS.join(', ')}`
      );
    }
  }
}

function validateRole(name: string, role: unknown): RoleDefinition {
  if (!role || typeof role !== 'object') {
    throw new Error(`Role '${name}': must be an object`);
  }

  const r = role as Record<string, unknown>;

  if (typeof r.promptTemplate !== 'string' || r.promptTemplate.trim() === '') {
    throw new Error(`Role '${name}': promptTemplate must be a non-empty string`);
  }

  if (typeof r.schemaRef !== 'string') {
    throw new Error(`Role '${name}': schemaRef must be a string`);
  }

  if (!(r.schemaRef in SCHEMA_REGISTRY)) {
    throw new Error(
      `Role '${name}': schemaRef '${r.schemaRef}' not found in SCHEMA_REGISTRY. ` +
      `Valid: ${Object.keys(SCHEMA_REGISTRY).join(', ')}`
    );
  }

  validateAllowedTools(name, r.allowedTools as string[]);

  return {
    promptTemplate: r.promptTemplate as string,
    allowedTools: r.allowedTools as string[],
    schemaRef: r.schemaRef as string,
  };
}

// ─── State ───

let roleCache: Record<string, RoleDefinition> | null = null;

/** Override for testing — set to a custom path to load a different YAML file */
let configPathOverride: string | null = null;

function getBasePath(): string {
  if (configPathOverride) {
    return configPathOverride;
  }
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return resolve(__dirname, '../../config/roles.yaml');
}

function getLocalPath(): string {
  return resolve(dirname(getBasePath()), 'roles.local.yaml');
}

function getReadPath(): string {
  const localPath = getLocalPath();
  if (existsSync(localPath)) return localPath;
  return getBasePath();
}

// ─── Core parsing ───

/**
 * Parse and validate raw YAML content into role definitions.
 * Does NOT update the cache or touch disk.
 */
export function parseAndValidateRoles(raw: string): Record<string, RoleDefinition> {
  const parsed = parse(raw);
  if (!parsed || typeof parsed !== 'object' || !parsed.roles) {
    throw new Error("Invalid roles.yaml: missing top-level 'roles' key");
  }

  const roles: Record<string, RoleDefinition> = {};
  for (const [name, def] of Object.entries(parsed.roles)) {
    roles[name] = validateRole(name, def);
  }
  return roles;
}

// ─── Public API ───

/**
 * Validate raw YAML without writing to disk or updating cache.
 * Returns the parsed roles on success, throws on error.
 */
export function validateRolesYaml(content: string): Record<string, RoleDefinition> {
  return parseAndValidateRoles(content);
}

/** Get the read path (local if exists, otherwise base) */
export function getRolesReadPath(): string {
  return getReadPath();
}

/** Get the local override path (always roles.local.yaml) */
export function getRolesLocalPath(): string {
  return getLocalPath();
}

/** Get the base config path (always roles.yaml) */
export function getRolesBasePath(): string {
  return getBasePath();
}

/** Check if a local roles override exists */
export function hasLocalRoles(): boolean {
  return existsSync(getLocalPath());
}

/**
 * Load and validate all role definitions from roles.yaml.
 * Called at startup. Throws on any error (fail-fast).
 */
export function loadRoles(): Record<string, RoleDefinition> {
  const configPath = getReadPath();

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`roles.yaml not found at ${configPath}`);
    }
    throw new Error(`Failed to read roles.yaml: ${(err as Error).message}`);
  }

  const roles = parseAndValidateRoles(raw);
  roleCache = roles;
  console.log(`[role-loader] Loaded ${Object.keys(roles).length} role(s): ${Object.keys(roles).join(', ')}`);
  return roles;
}

/**
 * Get a resolved role by config key (e.g. 'planner', 'engineer', 'reviewer', 'reviewReceiver').
 * Resolves schemaRef to the actual JSON schema object.
 */
export function getRole(name: string): ResolvedRole {
  if (!roleCache) {
    throw new Error('Roles not loaded. Call loadRoles() first.');
  }

  const def = roleCache[name];
  if (!def) {
    throw new Error(
      `Role '${name}' not found. Available: ${Object.keys(roleCache).join(', ')}`
    );
  }

  return {
    promptTemplate: def.promptTemplate,
    allowedTools: def.allowedTools,
    jsonSchema: SCHEMA_REGISTRY[def.schemaRef],
  };
}

/**
 * Reload roles from disk. Cache-safe: only swaps cache on success.
 * On failure, the previous cache remains intact.
 */
export function reloadRoles(): void {
  const configPath = getReadPath();
  const raw = readFileSync(configPath, 'utf-8');
  const roles = parseAndValidateRoles(raw);
  roleCache = roles;  // atomic swap — only on success
  console.log(`[role-loader] Reloaded ${Object.keys(roles).length} role(s)`);
}

/**
 * Override the config file path. For testing only.
 */
export function _setConfigPath(path: string | null): void {
  configPathOverride = path;
  roleCache = null;
}

// ─── Per-repo allowedTools ───

export class AllowedToolsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllowedToolsFormatError';
  }
}

/**
 * Normalize and validate per-repository allowedTools.
 *
 * **注意: allowedTools は危険なコマンドも設定可能な自己責任項目です。**
 * この関数は Claude CLI に渡す前の最低限の入力検証と正規化のみを行います。
 * 各要素は Claude CLI の --allowedTools に渡す opaque string として扱い、
 * Bash(...) の独自フォーマット検証は行いません。
 *
 * Returns a normalized (trimmed, deduplicated) array suitable for persistence.
 */
export function sanitizeRepoAllowedTools(repoName: string, tools: unknown): string[] {
  if (!Array.isArray(tools)) {
    throw new AllowedToolsFormatError(
      `Repository '${repoName}': allowedTools must be an array of strings.`
    );
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const [index, tool] of tools.entries()) {
    if (typeof tool !== 'string') {
      throw new AllowedToolsFormatError(
        `Repository '${repoName}': allowedTools[${index}] must be a string.`
      );
    }

    const trimmed = tool.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

/**
 * Merge role-level allowedTools with per-repository allowedTools.
 * Deduplicates using Set.
 *
 * repoTools には危険なコマンドも含まれうる（自己責任）。
 * マージ結果はそのまま Claude CLI の --allowedTools に渡される。
 */
export function mergeAllowedTools(roleTools: string[], repoTools?: string[]): string[] {
  if (!repoTools || repoTools.length === 0) {
    return roleTools;
  }
  return [...new Set([...roleTools, ...repoTools])];
}
