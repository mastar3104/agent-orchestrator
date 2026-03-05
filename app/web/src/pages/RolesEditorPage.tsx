import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../api/client';

export function RolesEditorPage() {
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const dirty = content !== original;

  const loadContent = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getRolesYaml();
      setContent(result.content);
      setOriginal(result.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load roles.yaml');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadContent();
  }, [loadContent]);

  // Auto-dismiss success after 3s
  useEffect(() => {
    if (!success) return;
    const timer = setTimeout(() => setSuccess(null), 3000);
    return () => clearTimeout(timer);
  }, [success]);

  const handleSave = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await api.updateRolesYaml(content);
      setContent(result.content);
      setOriginal(result.content);
      setSuccess('Roles saved and reloaded successfully');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [content, dirty, saving]);

  // Cmd/Ctrl+S shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave]);

  // Sync scroll between gutter and textarea
  const handleScroll = useCallback(() => {
    if (textareaRef.current && gutterRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, []);

  const lineCount = content.split('\n').length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-gray-400 hover:text-white">
            &larr; Back to Items
          </Link>
          <h1 className="text-xl font-bold text-white">roles.yaml</h1>
          {dirty && (
            <span className="text-sm text-yellow-400">(unsaved changes)</span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={loadContent}
            disabled={loading}
            className="px-3 py-1.5 bg-gray-700 text-gray-200 rounded hover:bg-gray-600 text-sm disabled:opacity-50"
          >
            Reload
          </button>
          <button
            onClick={() => {
              setContent(original);
              setError(null);
            }}
            disabled={!dirty || saving}
            className="px-3 py-1.5 bg-gray-700 text-gray-200 rounded hover:bg-gray-600 text-sm disabled:opacity-50"
          >
            Revert
          </button>
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className="px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-500 text-sm disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded font-mono text-sm whitespace-pre-wrap">
          {error}
        </div>
      )}

      {/* Success banner */}
      {success && (
        <div className="bg-green-900/50 border border-green-700 text-green-300 px-4 py-3 rounded text-sm">
          {success}
        </div>
      )}

      {/* Editor */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-gray-400">Loading...</div>
        </div>
      ) : (
        <div
          className="flex border border-gray-700 rounded overflow-hidden"
          style={{ height: 'calc(100vh - 200px)' }}
        >
          {/* Line number gutter */}
          <div
            ref={gutterRef}
            className="bg-gray-900 text-gray-500 text-xs font-mono leading-5 py-3 px-2 text-right select-none overflow-hidden shrink-0"
            style={{ minWidth: '3rem' }}
          >
            {Array.from({ length: lineCount }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onScroll={handleScroll}
            className="flex-1 bg-gray-900 text-gray-100 font-mono text-xs leading-5 p-3 resize-none outline-none border-none"
            spellCheck={false}
          />
        </div>
      )}
    </div>
  );
}
