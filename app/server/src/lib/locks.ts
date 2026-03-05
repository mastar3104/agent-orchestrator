/**
 * Item-level execution lock to prevent duplicate execution.
 * Extracted from review-receive-service for shared use.
 */
const itemLockChains = new Map<string, Promise<void>>();

export function isItemLocked(itemId: string): boolean {
  return itemLockChains.has(itemId);
}

export async function withItemLock<T>(itemId: string, fn: () => Promise<T>): Promise<T> {
  const previousChain = itemLockChains.get(itemId) ?? Promise.resolve();

  let resolve: () => void;
  const newChain = new Promise<void>((r) => {
    resolve = r;
  });

  itemLockChains.set(itemId, newChain);

  try {
    await previousChain;
    return await fn();
  } finally {
    resolve!();

    if (itemLockChains.get(itemId) === newChain) {
      itemLockChains.delete(itemId);
    }
  }
}
