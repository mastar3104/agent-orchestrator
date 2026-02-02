import type { AgentInfo, AgentStatus, AgentRole } from '@agent-orch/shared';

interface AgentCardProps {
  agent: AgentInfo;
  onStop?: () => void;
  onSelect?: () => void;
  isSelected?: boolean;
}

const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: 'bg-gray-500',
  starting: 'bg-blue-500',
  running: 'bg-green-500 animate-pulse',
  waiting_approval: 'bg-orange-500 animate-pulse',
  waiting_orchestrator: 'bg-cyan-500',
  stopped: 'bg-gray-600',
  completed: 'bg-green-600',
  error: 'bg-red-500',
};

const STATUS_LABELS: Record<AgentStatus, string> = {
  idle: 'Idle',
  starting: 'Starting',
  running: 'Running',
  waiting_approval: 'Waiting Approval',
  waiting_orchestrator: 'Task Done',
  stopped: 'Stopped',
  completed: 'Completed',
  error: 'Error',
};

const ROLE_LABELS: Record<AgentRole, string> = {
  planner: 'Planner',
  front: 'Frontend',
  back: 'Backend',
  review: 'Review',
};

const ROLE_COLORS: Record<AgentRole, string> = {
  planner: 'text-purple-400',
  front: 'text-blue-400',
  back: 'text-green-400',
  review: 'text-yellow-400',
};

export function AgentCard({ agent, onStop, onSelect, isSelected }: AgentCardProps) {
  const isRunning = agent.status === 'running' || agent.status === 'starting';
  const isWaiting = agent.status === 'waiting_approval';

  return (
    <div
      onClick={onSelect}
      className={`bg-gray-800 rounded-lg p-4 border transition-colors cursor-pointer ${
        isSelected
          ? 'border-blue-500'
          : 'border-gray-700 hover:border-gray-600'
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`font-medium ${ROLE_COLORS[agent.role]}`}>
            {ROLE_LABELS[agent.role]}
          </span>
          <span className="text-xs text-gray-500">{agent.id}</span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${STATUS_COLORS[agent.status]}`}
          />
          <span className="text-sm text-gray-400">
            {STATUS_LABELS[agent.status]}
          </span>
        </div>
      </div>

      {agent.currentTask && (
        <p className="text-sm text-gray-400 mb-2 truncate">
          {agent.currentTask}
        </p>
      )}

      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>
          {agent.pid && `PID: ${agent.pid}`}
          {agent.exitCode !== undefined && ` Exit: ${agent.exitCode}`}
        </span>
        {(isRunning || isWaiting) && onStop && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onStop();
            }}
            className="text-red-400 hover:text-red-300"
          >
            Stop
          </button>
        )}
      </div>
    </div>
  );
}
