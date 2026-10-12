// memory.md:165
import type { MemoryItem, MemoryProvider } from '@lousho/build-ai-agent';

const items = new Map<string, MemoryItem[]>();
const myProvider: MemoryProvider = {
  async list(scopeKey, { limit, query } = {}) {
    // Newest first; use `query` to rank (e.g. by embedding similarity).
    return (items.get(scopeKey) ?? []).slice(0, limit);
  },
  async add(scopeKey, { text, metadata }) {
    const item: MemoryItem = { id: crypto.randomUUID(), text, createdAt: new Date().toISOString(), metadata };
    items.set(scopeKey, [item, ...(items.get(scopeKey) ?? [])]);
    return item;
  },
  async remove(scopeKey, id) {
    items.set(scopeKey, (items.get(scopeKey) ?? []).filter((item) => item.id !== id));
  },
};
export {};
