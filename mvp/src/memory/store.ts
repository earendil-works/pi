/**
 * Memory store abstraction over Mem0, following the same pattern as
 * src/history/store.ts. The store is created inside a request, never at module
 * load, so tests can inject a fake store without touching Mem0.
 *
 * Every operation is filtered by `owner`, which always comes from the caller's
 * verified session — never from request data.
 */

import type { Memory, MemoryBucket } from "./client.ts";

export type { Memory, MemoryBucket };

export interface MemoryInput {
  text: string;
  bucket: MemoryBucket;
  sourceMessageId?: string;
}

export interface MemoryStore {
  list(owner: string): Promise<Memory[]>;
  /** Get one memory by id. Returns undefined when not found or not the owner's. */
  get(owner: string, id: string): Promise<Memory | undefined>;
  /** `owned` is false when the memory id belongs to another owner; nothing is changed then. */
  save(owner: string, input: MemoryInput): Promise<{ owned: boolean; id?: string }>;
  remove(owner: string, id: string): Promise<boolean>;
  search(owner: string, query: string, limit: number): Promise<Memory[]>;
}

/** In-memory store keyed by owner, with the same contract as the Mem0 store. Used by tests only. */
export function fakeMemoryStore() {
  const memories = new Map<string, { owner: string; m: Memory }>();
  let tick = 0;
  const store: MemoryStore = {
    async list(owner) {
      return [...memories.values()]
        .filter((e) => e.owner === owner)
        .map((e) => e.m)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },
    async save(owner, input) {
      const id = `mem-${++tick}`;
      const at = new Date().toISOString();
      const m: Memory = { id, text: input.text, bucket: input.bucket, createdAt: at, sourceMessageId: input.sourceMessageId };
      memories.set(id, { owner, m });
      return { owned: true, id };
    },
    async remove(owner, id) {
      const e = memories.get(id);
      if (!e || e.owner !== owner) return false;
      memories.delete(id);
      return true;
    },
    async get(owner, id) {
      const e = memories.get(id);
      if (!e || e.owner !== owner) return undefined;
      return e.m;
    },
    async search(owner, _query, limit) {
      return [...memories.values()]
        .filter((e) => e.owner === owner)
        .map((e) => e.m)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit);
    },
  };
  return { store, memories };
}

