import { useEffect, useMemo, useState } from 'react';
import {
  GLOBAL_ROLE_TOOL_KEYS,
  type GlobalRoleToolKey,
} from '@agent-orch/shared';
import { useRoleTools } from '../hooks/useRoleTools';

const ROLE_LABELS: Record<GlobalRoleToolKey, string> = {
  planner: 'Planner',
  testPlanner: 'Test Planner',
  completedReviewer: 'Completed Reviewer',
  engineer: 'Engineer',
  reviewer: 'Reviewer',
  reviewReceiver: 'Review Receiver',
};

function toFormState(roleTools: Partial<Record<GlobalRoleToolKey, string[]>>): Record<GlobalRoleToolKey, string> {
  return Object.fromEntries(
    GLOBAL_ROLE_TOOL_KEYS.map((key) => [key, (roleTools[key] || []).join('\n')])
  ) as Record<GlobalRoleToolKey, string>;
}

export function RoleToolsPage() {
  const { roleTools, loading, error, update } = useRoleTools();
  const [form, setForm] = useState<Record<GlobalRoleToolKey, string>>(() => toFormState({}));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm(toFormState(roleTools));
  }, [roleTools]);

  const isDirty = useMemo(() => {
    const current = toFormState(roleTools);
    return GLOBAL_ROLE_TOOL_KEYS.some((key) => current[key] !== form[key]);
  }, [form, roleTools]);

  const handleChange = (key: GlobalRoleToolKey, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaveError(null);
    setSaveMessage(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);

    try {
      const nextRoleTools = Object.fromEntries(
        GLOBAL_ROLE_TOOL_KEYS.map((key) => [
          key,
          form[key]
            .split('\n')
            .map((tool) => tool.trim())
            .filter((tool) => tool.length > 0),
        ])
      ) as Record<GlobalRoleToolKey, string[]>;

      const cleaned = Object.fromEntries(
        Object.entries(nextRoleTools).filter(([, tools]) => tools.length > 0)
      ) as Partial<Record<GlobalRoleToolKey, string[]>>;

      await update(cleaned);
      setSaveMessage('Saved. New agent runs will use the updated tool set.');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save role tools');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Roles</h1>
          <p className="text-sm text-gray-400 mt-1">
            Edit global extra allowed tools per role. These are additive overrides on top of the built-in role tools.
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving || loading || !isDirty}
          className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-400 text-white px-4 py-2 rounded-lg text-sm font-medium"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>

      {error && (
        <div className="bg-red-900/50 text-red-300 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      {saveError && (
        <div className="bg-red-900/50 text-red-300 px-4 py-3 rounded-lg text-sm">
          {saveError}
        </div>
      )}

      {saveMessage && (
        <div className="bg-green-900/40 text-green-300 px-4 py-3 rounded-lg text-sm">
          {saveMessage}
        </div>
      )}

      <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
        <p className="text-sm text-gray-300">
          Enter one tool per line. Repository-level <code className="font-mono">allowedTools</code> remain engineer-only and are added after the global engineer tools.
        </p>
      </div>

      <div className="grid gap-4">
        {GLOBAL_ROLE_TOOL_KEYS.map((roleKey) => (
          <div
            key={roleKey}
            className="bg-gray-800 rounded-lg border border-gray-700 p-4 space-y-2"
          >
            <div>
              <h2 className="text-sm font-medium text-white">{ROLE_LABELS[roleKey]}</h2>
              <p className="text-xs text-gray-500 mt-1">
                Additional tools appended to the built-in {ROLE_LABELS[roleKey]} role tools.
              </p>
            </div>
            <textarea
              value={form[roleKey]}
              onChange={(e) => handleChange(roleKey, e.target.value)}
              rows={4}
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-blue-500"
              placeholder={'Bash(git status:*)\nBash(npm test:*)'}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
