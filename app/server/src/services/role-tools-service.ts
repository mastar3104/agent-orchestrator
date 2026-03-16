import type { GlobalRoleToolOverrides } from '@agent-orch/shared';
import { getRoleToolsLocalPath } from '../lib/paths';
import { readYamlSafe, writeYaml } from '../lib/yaml';
import {
  loadRoles,
  sanitizeGlobalRoleToolOverrides,
} from '../lib/role-loader';

export async function getRoleTools(): Promise<GlobalRoleToolOverrides> {
  const roleTools = await readYamlSafe<unknown>(getRoleToolsLocalPath());
  return sanitizeGlobalRoleToolOverrides(roleTools);
}

export async function updateRoleTools(
  roleTools: GlobalRoleToolOverrides
): Promise<GlobalRoleToolOverrides> {
  const sanitized = sanitizeGlobalRoleToolOverrides(roleTools);
  const filePath = getRoleToolsLocalPath();

  await writeYaml(filePath, sanitized);
  loadRoles(filePath);

  return sanitized;
}
