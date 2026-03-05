import { useState, useEffect } from 'react';
import type { AgentExecutionOutput } from '@agent-orch/shared';
import { getAgentOutput } from '../api/client';

interface AgentOutputPanelProps {
  itemId: string;
  agentId: string;
  onClose: () => void;
}

type Tab = 'result' | 'raw' | 'stderr' | 'prompt';

export function AgentOutputPanel({ itemId, agentId, onClose }: AgentOutputPanelProps) {
  const [output, setOutput] = useState<AgentExecutionOutput | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('result');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getAgentOutput(itemId, agentId)
      .then((res) => {
        if (!cancelled) {
          setOutput(res.output);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load output');
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [itemId, agentId]);

  const tabs: { key: Tab; label: string }[] = [
    { key: 'result', label: 'Result' },
    { key: 'raw', label: 'Raw Output' },
    { key: 'stderr', label: 'Stderr' },
    { key: 'prompt', label: 'Prompt' },
  ];

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 mt-4">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-white">Agent Output</span>
          {output && (
            <>
              <span
                className={`px-2 py-0.5 text-xs rounded-full ${
                  output.exitCode === 0
                    ? 'bg-green-600 text-white'
                    : 'bg-red-500 text-white'
                }`}
              >
                exit {output.exitCode}
              </span>
              <span className="text-xs text-gray-400">
                {Math.round(output.durationMs / 1000)}s
              </span>
              <span className="text-xs text-gray-500">
                {new Date(output.timestamp).toLocaleString()}
              </span>
            </>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white text-sm"
        >
          Close
        </button>
      </div>

      {loading && (
        <div className="px-4 py-8 text-center text-gray-400">Loading...</div>
      )}

      {error && (
        <div className="px-4 py-8 text-center text-red-400">{error}</div>
      )}

      {!loading && !error && !output && (
        <div className="px-4 py-8 text-center text-gray-400">No output available</div>
      )}

      {!loading && !error && output && (
        <>
          {/* Tabs */}
          <div className="flex border-b border-gray-700">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-4 py-2 text-sm ${
                  activeTab === tab.key
                    ? 'text-white border-b-2 border-blue-500'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="p-4 max-h-96 overflow-auto">
            {activeTab === 'result' && (
              <pre className="text-sm text-gray-200 whitespace-pre-wrap font-mono">
                {output.parsedOutput != null
                  ? JSON.stringify(output.parsedOutput, null, 2)
                  : '(no parsed output)'}
              </pre>
            )}
            {activeTab === 'raw' && (
              <pre className="text-sm text-gray-200 whitespace-pre-wrap font-mono">
                {output.stdout || '(empty)'}
              </pre>
            )}
            {activeTab === 'stderr' && (
              <pre className="text-sm text-gray-200 whitespace-pre-wrap font-mono">
                {output.stderr || '(empty)'}
              </pre>
            )}
            {activeTab === 'prompt' && (
              <pre className="text-sm text-gray-200 whitespace-pre-wrap font-mono">
                {output.prompt}
              </pre>
            )}
          </div>
        </>
      )}
    </div>
  );
}
