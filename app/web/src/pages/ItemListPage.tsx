import { useState } from 'react';
import { ItemList } from '../components/ItemList';
import { CreateItemModal } from '../components/CreateItemModal';
import { useItemList } from '../hooks/useItems';

export function ItemListPage() {
  const { items, loading, error, refresh, create, remove } = useItemList();
  const [showCreateModal, setShowCreateModal] = useState(false);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-900/50 text-red-300 px-4 py-3 rounded">
        {error}
        <button
          onClick={refresh}
          className="ml-4 underline hover:no-underline"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Development Items</h1>
        <button
          onClick={() => setShowCreateModal(true)}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-500"
        >
          Create Item
        </button>
      </div>

      <ItemList items={items} onDelete={remove} />

      <CreateItemModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreate={async (data) => {
          await create(data);
        }}
      />
    </div>
  );
}
