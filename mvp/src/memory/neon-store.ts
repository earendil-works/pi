/**
 * Neon Postgres-backed MemoryStore with pgvector semantic search.
 *
 * Replaces the Mem0 store (NLTPI-MEM-001, blocked on free-plan training concern).
 * See docs/superpowers/specs/2026-11-06-neon-pgvector-memory-design.md.
 *
 * Schema (created once per process):
 *   memories table with a vector(384) embedding column (NULL until embedded),
 *   hnsw index over embedded rows, gin trigram index over all text.
 *
 * Every statement is parameterised and filtered by owner_sub. The owner always
 * comes from the caller's verified session — never from request data.
 *
 * Search strategy:
 *   - If embed runner returns a vector: pgvector cosine search over embedded rows,
 *     union with trigram search over NULL-embedding rows, deduped, capped at limit.
 *   - If embed runner returns null (sandbox not warm, busy, etc.): trigram-only over all rows.
 */

import type { Memory, MemoryBucket, MemoryInput, MemoryStore } from "./store.ts";
import type { EmbedRunner } from "./sandbox-embed.ts";
import type { SandboxLike } from "../sandbox/operations.ts";

export interface NeonSqlRunner {
  query(text: string, params: unknown[]): Promise<Record<string, unknown>[]>;
}

const SCHEMA: readonly string[] = [
  "CREATE EXTENSION IF NOT EXISTS vector",
  "CREATE EXTENSION IF NOT EXISTS pg_trgm",
  `CREATE TABLE IF NOT EXISTS memories (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_sub     text NOT NULL,
    text          text NOT NULL,
    bucket        text NOT NULL CHECK (bucket IN ('owner', 'project')),
    source_msg_id uuid,
    embedding     vector(384),
    created_at    timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS memories_owner
    ON memories (owner_sub, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS memories_embedding
    ON memories USING hnsw (embedding vector_cosine_ops)
    WHERE embedding IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS memories_trgm
    ON memories USING gin (text gin_trgm_ops)`,
];

const TRGM_THRESHOLD = 0.1;

function rowToMemory(row: Record<string, unknown>): Memory | undefined {
  const id = typeof row.id === "string" ? row.id : undefined;
  const text = typeof row.text === "string" ? row.text : undefined;
  if (!id || !text) return undefined;
  const bucket: MemoryBucket =
    row.bucket === "project" ? "project" : "owner";
  const createdAt =
    typeof row.created_at === "string"
      ? row.created_at
      : row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date().toISOString();
  const sourceMessageId =
    typeof row.source_msg_id === "string" ? row.source_msg_id : undefined;
  return { id, text, bucket, createdAt, sourceMessageId };
}

export interface NeonMemoryStoreOptions {
  embedRunner?: EmbedRunner;
  sandbox?: SandboxLike;
  /** Called after a successful save to trigger background embedding. Fire-and-forget. */
  triggerEmbed?: (id: string, text: string) => void;
}

export function createNeonMemoryStore(
  sql: NeonSqlRunner,
  options: NeonMemoryStoreOptions = {},
): MemoryStore {
  let ready: Promise<void> | undefined;

  const ensureSchema = (): Promise<void> => {
    ready ??= (async () => {
      for (const stmt of SCHEMA) {
        await sql.query(stmt, []);
      }
    })().catch((err: unknown) => {
      ready = undefined;
      throw err;
    });
    return ready;
  };

  return {
    async list(owner) {
      await ensureSchema();
      const rows = await sql.query(
        "SELECT id, text, bucket, source_msg_id, created_at FROM memories WHERE owner_sub = $1 ORDER BY created_at DESC",
        [owner],
      );
      return rows.map(rowToMemory).filter(Boolean) as Memory[];
    },

    async get(owner, id) {
      await ensureSchema();
      const rows = await sql.query(
        "SELECT id, text, bucket, source_msg_id, created_at FROM memories WHERE id = $1 AND owner_sub = $2",
        [id, owner],
      );
      if (rows.length === 0) return undefined;
      return rowToMemory(rows[0]) ?? undefined;
    },

    async save(owner, input: MemoryInput) {
      await ensureSchema();
      const rows = await sql.query(
        `INSERT INTO memories (owner_sub, text, bucket, source_msg_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [owner, input.text, input.bucket, input.sourceMessageId ?? null],
      );
      if (rows.length === 0) return { owned: false };
      const id = String(rows[0].id);
      // Fire-and-forget background embed. The row stays usable (trgm fallback) until embedded.
      options.triggerEmbed?.(id, input.text);
      return { owned: true, id };
    },

    async remove(owner, id) {
      await ensureSchema();
      const rows = await sql.query(
        "DELETE FROM memories WHERE id = $1 AND owner_sub = $2 RETURNING id",
        [id, owner],
      );
      return rows.length > 0;
    },

    async search(owner, query, limit) {
      await ensureSchema();
      if (limit <= 0) return [];

      // Try semantic search first.
      if (options.embedRunner && options.sandbox) {
        const vec = await options.embedRunner.embed(query, options.sandbox);
        if (vec !== null) {
          // pgvector cosine search over embedded rows.
          const vecLiteral = `[${vec.join(",")}]`;
          const vectorRows = await sql.query(
            `SELECT id, text, bucket, source_msg_id, created_at
             FROM memories
             WHERE owner_sub = $1 AND embedding IS NOT NULL
             ORDER BY embedding <=> $2::vector
             LIMIT $3`,
            [owner, vecLiteral, limit],
          );
          // Trigram fallback for NULL-embedding rows.
          const trgmRows = await sql.query(
            `SELECT id, text, bucket, source_msg_id, created_at
             FROM memories
             WHERE owner_sub = $1 AND embedding IS NULL
               AND similarity(text, $2) > $3
             ORDER BY similarity(text, $2) DESC
             LIMIT $4`,
            [owner, query, TRGM_THRESHOLD, limit],
          );
          // Merge: vector rows first (more relevant), then trgm, deduplicate by id.
          const seen = new Set<string>();
          const merged: Memory[] = [];
          for (const row of [...vectorRows, ...trgmRows]) {
            const m = rowToMemory(row);
            if (!m || seen.has(m.id)) continue;
            seen.add(m.id);
            merged.push(m);
            if (merged.length >= limit) break;
          }
          return merged;
        }
      }

      // Fallback: trigram similarity over all rows (embed unavailable).
      const rows = await sql.query(
        `SELECT id, text, bucket, source_msg_id, created_at
         FROM memories
         WHERE owner_sub = $1
           AND similarity(text, $2) > $3
         ORDER BY similarity(text, $2) DESC
         LIMIT $4`,
        [owner, query, TRGM_THRESHOLD, limit],
      );
      return rows.map(rowToMemory).filter(Boolean) as Memory[];
    },
  };
}
