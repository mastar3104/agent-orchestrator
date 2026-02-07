import { Link } from 'react-router-dom';
import type { ItemSummary, ItemStatus } from '@agent-orch/shared';

interface ItemListProps {
  items: ItemSummary[];
  onDelete?: (id: string) => void | Promise<void>;
}

const STATUS_COLORS: Record<ItemStatus, string> = {
  created: 'bg-gray-500',
  cloning: 'bg-blue-500',
  planning: 'bg-purple-500',
  ready: 'bg-green-500',
  running: 'bg-yellow-500',
  waiting_approval: 'bg-orange-500',
  completed: 'bg-green-600',
  review_receiving: 'bg-cyan-500',
  error: 'bg-red-500',
};

const STATUS_LABELS: Record<ItemStatus, string> = {
  created: 'Created',
  cloning: 'Cloning',
  planning: 'Planning',
  ready: 'Ready',
  running: 'Running',
  waiting_approval: 'Waiting Approval',
  completed: 'Completed',
  review_receiving: 'Review Receiving',
  error: 'Error',
};

export function ItemList({ items, onDelete }: ItemListProps) {
  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400">
        <p className="text-lg">No items yet</p>
        <p className="text-sm mt-2">Create your first development item to get started</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <Link
          key={item.id}
          to={`/items/${item.id}`}
          className="block bg-gray-800 rounded-lg p-4 hover:bg-gray-750 transition-colors border border-gray-700 hover:border-gray-600"
        >
          <div className="flex items-center justify-between">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3">
                <h3 className="text-lg font-medium text-white truncate">
                  {item.name}
                </h3>
                <span
                  className={`px-2 py-0.5 text-xs rounded-full text-white ${
                    STATUS_COLORS[item.status]
                  }`}
                >
                  {STATUS_LABELS[item.status]}
                </span>
              </div>
              <p className="text-sm text-gray-400 mt-1">{item.id}</p>
            </div>
            <div className="flex items-center gap-4 text-sm text-gray-400">
              {item.agentCount > 0 && (
                <span>{item.agentCount} agents</span>
              )}
              {item.pendingApprovals > 0 && (
                <span className="text-orange-400">
                  {item.pendingApprovals} pending
                </span>
              )}
              {onDelete && (
                <button
                  onClick={async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (confirm('Delete this item?')) {
                      try {
                        await onDelete(item.id);
                      } catch (err) {
                        alert(err instanceof Error ? err.message : 'Failed to delete item');
                      }
                    }
                  }}
                  className="text-red-400 hover:text-red-300"
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}
