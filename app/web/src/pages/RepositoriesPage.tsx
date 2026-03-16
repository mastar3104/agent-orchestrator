import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  type EditableRolePromptKey,
  type GitRepository,
  type CreateRepositoryRequest,
  type UpdateRepositoryRequest,
  type RolePrompts,
} from '@agent-orch/shared';
import { useRepositoryList } from '../hooks/useRepositories';

type RepoType = 'remote' | 'local';
type LinkMode = 'symlink' | 'copy';

interface RepoFormData {
  name: string;
  type: RepoType;
  url: string;
  localPath: string;
  branch: string;
  submodules: boolean;
  linkMode: LinkMode;
  directoryName: string;
  allowedTools: string;
  rolePrompts: Record<EditableRolePromptKey, string>;
  setup: string;
  hooks: string;
}

const EDITABLE_ROLE_PROMPT_KEYS: EditableRolePromptKey[] = [
  'planner',
  'engineer',
  'reviewer',
  'reviewReceiver',
  'testPlanner',
];

const ROLE_PROMPT_LABELS: Record<EditableRolePromptKey, string> = {
  planner: 'Planner',
  engineer: 'Engineer',
  reviewer: 'Reviewer',
  reviewReceiver: 'Review Receiver',
  testPlanner: 'Test Planner',
};

function createEmptyRolePrompts(): Record<EditableRolePromptKey, string> {
  return {
    planner: '',
    engineer: '',
    reviewer: '',
    reviewReceiver: '',
    testPlanner: '',
  };
}

const emptyForm: RepoFormData = {
  name: '',
  type: 'remote',
  url: '',
  localPath: '',
  branch: '',
  submodules: false,
  linkMode: 'symlink',
  directoryName: '',
  allowedTools: '',
  rolePrompts: createEmptyRolePrompts(),
  setup: '',
  hooks: '',
};

function repoToForm(repo: GitRepository): RepoFormData {
  return {
    name: repo.name,
    type: repo.type,
    url: repo.url || '',
    localPath: repo.localPath || '',
    branch: repo.branch || '',
    submodules: repo.submodules || false,
    linkMode: repo.linkMode || 'symlink',
    directoryName: repo.directoryName || '',
    allowedTools: (repo.allowedTools || []).join(', '),
    rolePrompts: {
      ...createEmptyRolePrompts(),
      ...(repo.rolePrompts || {}),
    },
    setup: (repo.setup || []).join('\n'),
    hooks: (repo.hooks || []).join('\n'),
  };
}

export function RepositoriesPage() {
  const { repositories, loading, error, refresh, create, update, remove } = useRepositoryList();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<RepoFormData>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const updateField = <K extends keyof RepoFormData>(key: K, value: RepoFormData[K]) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const parseAllowedTools = (raw: string): string[] | undefined => {
    const tools = raw.split(',').map(t => t.trim()).filter(t => t.length > 0);
    return tools.length > 0 ? tools : undefined;
  };

  const parseRolePrompts = (raw: Record<EditableRolePromptKey, string>, preserveEmptyObject: boolean = false): RolePrompts | undefined => {
    const entries = EDITABLE_ROLE_PROMPT_KEYS
      .map((key) => [key, raw[key].trim()] as const)
      .filter(([, value]) => value.length > 0);

    if (entries.length === 0) {
      return preserveEmptyObject ? {} : undefined;
    }

    return Object.fromEntries(entries) as RolePrompts;
  };

  const parseHooks = (raw: string): string[] | undefined => {
    const hooks = raw.split('\n').map(h => h.trim()).filter(h => h.length > 0);
    return hooks.length > 0 ? hooks : undefined;
  };

  const parseSetup = (raw: string, preserveEmptyArray: boolean = false): string[] | undefined => {
    const commands = raw.split('\n').map(command => command.trim()).filter(command => command.length > 0);
    if (commands.length > 0) {
      return commands;
    }
    return preserveEmptyArray ? [] : undefined;
  };

  const handleCreate = async () => {
    setSaving(true);
    setFormError(null);
    try {
      const data: CreateRepositoryRequest = {
        name: form.name,
        type: form.type,
        url: form.type === 'remote' ? form.url || undefined : undefined,
        localPath: form.type === 'local' ? form.localPath || undefined : undefined,
        branch: form.branch || undefined,
        submodules: form.submodules || undefined,
        linkMode: form.type === 'local' ? form.linkMode : undefined,
        directoryName: form.directoryName || undefined,
        allowedTools: parseAllowedTools(form.allowedTools),
        rolePrompts: parseRolePrompts(form.rolePrompts),
        setup: form.type === 'remote' ? parseSetup(form.setup) : undefined,
        hooks: parseHooks(form.hooks),
      };
      await create(data);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async () => {
    if (!editingId) return;
    setSaving(true);
    setFormError(null);
    try {
      const data: UpdateRepositoryRequest = {
        name: form.name || undefined,
        branch: form.branch || undefined,
        submodules: form.submodules,
        linkMode: form.linkMode,
        directoryName: form.directoryName || undefined,
        allowedTools: parseAllowedTools(form.allowedTools),
        rolePrompts: parseRolePrompts(form.rolePrompts, true),
        setup: form.type === 'remote' ? parseSetup(form.setup, true) : undefined,
        hooks: parseHooks(form.hooks),
      };
      await update(editingId, data);
      setEditingId(null);
      setForm(emptyForm);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await remove(id);
      setDeleteConfirm(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to delete');
    }
  };

  const startEdit = (repo: GitRepository) => {
    setEditingId(repo.id);
    setForm(repoToForm(repo));
    setShowCreate(false);
    setFormError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setShowCreate(false);
    setForm(emptyForm);
    setFormError(null);
  };

  const renderForm = (mode: 'create' | 'edit') => (
    <div className="bg-gray-750 border border-gray-600 rounded-lg p-4 space-y-3">
      <h3 className="text-sm font-medium text-white">
        {mode === 'create' ? 'New Repository' : 'Edit Repository'}
      </h3>

      {formError && (
        <div className="bg-red-900/50 text-red-300 px-3 py-2 rounded text-sm">
          {formError}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Name *</label>
          <input
            type="text"
            value={form.name}
            onChange={e => updateField('name', e.target.value)}
            className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
            placeholder="my-repo"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Type</label>
          <select
            value={form.type}
            onChange={e => updateField('type', e.target.value as RepoType)}
            disabled={mode === 'edit'}
            className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500 disabled:opacity-50"
          >
            <option value="remote">Remote</option>
            <option value="local">Local</option>
          </select>
        </div>
      </div>

      {form.type === 'remote' ? (
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">URL {mode === 'create' ? '*' : ''}</label>
          <input
            type="text"
            value={form.url}
            onChange={e => updateField('url', e.target.value)}
            disabled={mode === 'edit'}
            className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white text-sm font-mono focus:outline-none focus:border-blue-500 disabled:opacity-50"
            placeholder="https://github.com/user/repo.git"
          />
        </div>
      ) : (
        <>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Local Path {mode === 'create' ? '*' : ''}</label>
            <input
              type="text"
              value={form.localPath}
              onChange={e => updateField('localPath', e.target.value)}
              disabled={mode === 'edit'}
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white text-sm font-mono focus:outline-none focus:border-blue-500 disabled:opacity-50"
              placeholder="/path/to/repo"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Link Mode</label>
            <select
              value={form.linkMode}
              onChange={e => updateField('linkMode', e.target.value as LinkMode)}
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="symlink">Symlink</option>
              <option value="copy">Copy</option>
            </select>
          </div>
        </>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Branch</label>
          <input
            type="text"
            value={form.branch}
            onChange={e => updateField('branch', e.target.value)}
            className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
            placeholder="main"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Directory Name</label>
          <input
            type="text"
            value={form.directoryName}
            onChange={e => updateField('directoryName', e.target.value)}
            className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
            placeholder="frontend"
          />
        </div>
      </div>

      {form.type === 'remote' && (
        <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            checked={form.submodules}
            onChange={e => updateField('submodules', e.target.checked)}
            className="rounded bg-gray-700 border-gray-600"
          />
          Include submodules
        </label>
      )}

      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">Engineer Extra Tools</label>
        <input
          type="text"
          value={form.allowedTools}
          onChange={e => updateField('allowedTools', e.target.value)}
          className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white text-sm font-mono focus:outline-none focus:border-blue-500"
          placeholder="Bash(git status), Bash(npm run test)"
        />
        <p className="text-xs text-yellow-600 mt-0.5">
          Comma-separated. Applied only to the engineer role. Values are passed to Claude CLI as-is. Dangerous commands can also be configured - use at your own risk.
        </p>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-400 mb-2">Role Prompts</label>
        <div className="space-y-2">
          {EDITABLE_ROLE_PROMPT_KEYS.map((roleKey) => (
            <div key={roleKey}>
              <label className="block text-xs font-medium text-gray-500 mb-1">
                {ROLE_PROMPT_LABELS[roleKey]}
              </label>
              <textarea
                value={form.rolePrompts[roleKey]}
                onChange={(e) => setForm((prev) => ({
                  ...prev,
                  rolePrompts: {
                    ...prev.rolePrompts,
                    [roleKey]: e.target.value,
                  },
                }))}
                rows={2}
                className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
                placeholder={`Optional repository-specific prompt for ${ROLE_PROMPT_LABELS[roleKey]}`}
              />
            </div>
          ))}
        </div>
      </div>

      {form.type === 'remote' && (
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Setup Commands</label>
          <textarea
            value={form.setup}
            onChange={e => updateField('setup', e.target.value)}
            rows={3}
            className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white text-sm font-mono focus:outline-none focus:border-blue-500"
            placeholder={"yarn install --frozen-lockfile\nbundle install"}
          />
          <p className="text-xs text-gray-500 mt-0.5">
            1行1コマンド。clone 完了後、planner 起動前に repository 直下で順次実行します。失敗しても planner は継続します。
          </p>
        </div>
      )}

      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">Post-Engineer Hooks</label>
        <textarea
          value={form.hooks}
          onChange={e => updateField('hooks', e.target.value)}
          rows={3}
          className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white text-sm font-mono focus:outline-none focus:border-blue-500"
          placeholder={"npm run lint\nnpm test"}
        />
        <p className="text-xs text-gray-500 mt-0.5">
          1行1コマンド。Engineer完了後に順次実行し、失敗時は自動修正を試みます。全リトライ失敗時はエラーで停止します。
        </p>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={cancelEdit}
          className="px-3 py-1.5 text-gray-300 hover:text-white text-sm"
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={mode === 'create' ? handleCreate : handleUpdate}
          disabled={saving || !form.name || (mode === 'create' && form.type === 'remote' && !form.url) || (mode === 'create' && form.type === 'local' && !form.localPath)}
          className="px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-500 text-sm disabled:opacity-50"
        >
          {saving ? 'Saving...' : mode === 'create' ? 'Create' : 'Update'}
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-gray-400 hover:text-white">
            &larr; Back to Items
          </Link>
          <h1 className="text-xl font-bold text-white">Repositories</h1>
        </div>
        <div className="flex gap-2">
          <button
            onClick={refresh}
            disabled={loading}
            className="px-3 py-1.5 bg-gray-700 text-gray-200 rounded hover:bg-gray-600 text-sm disabled:opacity-50"
          >
            Reload
          </button>
          <button
            onClick={() => {
              setShowCreate(true);
              setEditingId(null);
              setForm(emptyForm);
              setFormError(null);
            }}
            className="px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-500 text-sm"
          >
            + New Repository
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded text-sm">
          {error}
        </div>
      )}

      {showCreate && renderForm('create')}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-gray-400">Loading...</div>
        </div>
      ) : repositories.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          No saved repositories. Click "+ New Repository" to create one.
        </div>
      ) : (
        <div className="space-y-3">
          {repositories.map(repo => (
            <div key={repo.id}>
              {editingId === repo.id ? (
                renderForm('edit')
              ) : (
                <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-white font-medium">{repo.name}</span>
                        <span className={`px-2 py-0.5 rounded text-xs ${
                          repo.type === 'remote'
                            ? 'bg-blue-900/50 text-blue-300'
                            : 'bg-green-900/50 text-green-300'
                        }`}>
                          {repo.type}
                        </span>
                        {repo.hooks && repo.hooks.length > 0 && (
                          <span className="px-2 py-0.5 rounded text-xs bg-purple-900/50 text-purple-300">
                            {repo.hooks.length} hook{repo.hooks.length > 1 ? 's' : ''}
                          </span>
                        )}
                        {repo.setup && repo.setup.length > 0 && (
                          <span className="px-2 py-0.5 rounded text-xs bg-cyan-900/50 text-cyan-300">
                            {repo.setup.length} setup
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-400 space-y-1">
                        {repo.type === 'remote' && repo.url && (
                          <div className="font-mono break-all">{repo.url}</div>
                        )}
                        {repo.type === 'local' && repo.localPath && (
                          <div className="font-mono break-all">{repo.localPath}</div>
                        )}
                        <div className="flex gap-4">
                          {repo.branch && <span>Branch: {repo.branch}</span>}
                          {repo.directoryName && <span>Dir: {repo.directoryName}</span>}
                          {repo.linkMode && <span>Mode: {repo.linkMode}</span>}
                          {repo.submodules && <span>Submodules: Yes</span>}
                        </div>
                        {repo.allowedTools && repo.allowedTools.length > 0 && (
                          <div className="flex items-center gap-1 flex-wrap mt-1">
                            <span className="text-gray-500">Engineer Tools:</span>
                            {repo.allowedTools.map((tool, i) => (
                              <span
                                key={i}
                                className="px-1.5 py-0.5 rounded bg-gray-700 text-gray-300 font-mono text-xs"
                              >
                                {tool}
                              </span>
                            ))}
                          </div>
                        )}
                        {repo.rolePrompts && Object.keys(repo.rolePrompts).length > 0 && (
                          <div className="flex items-center gap-1 flex-wrap mt-1">
                            <span className="text-gray-500">Role prompts:</span>
                            {EDITABLE_ROLE_PROMPT_KEYS
                              .filter((roleKey) => repo.rolePrompts?.[roleKey])
                              .map((roleKey) => (
                                <span
                                  key={roleKey}
                                  className="px-1.5 py-0.5 rounded bg-gray-700 text-gray-300 text-xs"
                                >
                                  {ROLE_PROMPT_LABELS[roleKey]}
                                </span>
                              ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2 ml-4">
                      <button
                        onClick={() => startEdit(repo)}
                        className="px-2 py-1 text-xs bg-gray-700 text-gray-300 rounded hover:bg-gray-600"
                      >
                        Edit
                      </button>
                      {deleteConfirm === repo.id ? (
                        <div className="flex gap-1">
                          <button
                            onClick={() => handleDelete(repo.id)}
                            className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-500"
                          >
                            Confirm
                          </button>
                          <button
                            onClick={() => setDeleteConfirm(null)}
                            className="px-2 py-1 text-xs bg-gray-700 text-gray-300 rounded hover:bg-gray-600"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setDeleteConfirm(repo.id)}
                          className="px-2 py-1 text-xs bg-gray-700 text-red-400 rounded hover:bg-gray-600"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
