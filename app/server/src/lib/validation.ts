/**
 * Normalize a user-supplied list of shell commands (hooks, setup, etc.).
 *
 * - Returns `{}` when the field is absent (`undefined`).
 * - Returns `{ error }` when the value is malformed.
 * - Returns `{ commands }` with trimmed, non-empty entries on success.
 */
export function normalizeCommandList(
  fieldName: string,
  value: unknown,
  itemLabel: string
): { commands?: string[]; error?: string } {
  if (value === undefined) {
    return {};
  }
  if (!Array.isArray(value)) {
    return { error: `${fieldName} must be an array` };
  }

  const commands: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return { error: `Each ${itemLabel} must be a non-empty string` };
    }
    const trimmed = entry.trim();
    if (trimmed.length > 0) {
      commands.push(trimmed);
    }
  }

  return { commands };
}
