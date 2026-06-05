/**
 * 5D Memory Types — Pi-mono Self-Evolution Engine
 *
 * Wire-compatible with the Rust apex-mem JSON-RPC schema.
 * These types are the common interface between all memory engine implementations.
 */

// ─── 5D Dimensions ─────────────────────────────────────────────────────────────

export type MemoryDimension =
  | "working"   // <1h decay — active context
  | "episodic"   // 7d decay — event memory
  | "semantic"   // 180d decay — knowledge
  | "procedural" // 365d decay — skills
  | "declarative"; // 5y decay — hard facts

// ─── Core Record ────────────────────────────────────────────────────────────────

export interface MemoryRecord {
  id: string;
  dimension: MemoryDimension;
  content: string;
  tags: string[];
  importance: number;    // 0..1 — THIS IS THE FITNESS SCORE
  createdAt: number;     // epoch ms
  accessedAt: number;    // epoch ms
  accessCount: number;   // invocation frequency
  decayUntil: number;    // epoch ms
  hash: string;          // sha1(content) for dedup
  meta?: Record<string, unknown>;
}

// ─── Search ───────────────────────────────────────────────────────────────────

export interface MemoryHit {
  record: MemoryRecord;
  score: number;         // RRF fused score (0..1)
  sources: Array<"bm25" | "graph" | "lexical" | "recency">;
}

export interface IngestInput {
  content: string;
  dimension: MemoryDimension;
  tags?: string[];
  importance?: number;   // default 0.5
  meta?: Record<string, unknown>;
  id?: string;           // optional explicit ID
}

export interface SearchInput {
  query: string;
  topK?: number;         // default 6
  dimensions?: MemoryDimension[];
  expandGraph?: boolean; // default true
  expandDepth?: number;  // default 2
}

// ─── Evolution ─────────────────────────────────────────────────────────────────

export interface DreamResult {
  decayed: number;    // records decayed
  merged: number;     // dedup events
  promoted: number;   // working→semantic promotions
}

export interface MemoryStats {
  total: number;
  byDimension: Record<MemoryDimension, number>;
  graphNodes: number;
  graphEdges: number;
  ftsSize: number;
  lastDreamAt: number | null;
}

export interface MemoryHealth {
  total: number;
  duplicates: number;
  missingEmbeddings: number;
  danglingEdges: number;
  workingBloat: number;
  deltaG: number;      // -1..1 — SYSTEM FITNESS
  issues: string[];
}

// ─── Engine Interface ──────────────────────────────────────────────────────────

export interface MemoryEngine {
  ingest(input: IngestInput): Promise<MemoryRecord>;
  search(input: SearchInput): Promise<MemoryHit[]>;
  get(id: string): Promise<MemoryRecord | undefined>;
  delete(id: string): Promise<boolean>;
  dream(): Promise<DreamResult>;
  stats(): Promise<MemoryStats>;
  health(): Promise<MemoryHealth>;
  graphJson(): Promise<unknown>;
  flushFromConversation(text: string, source?: string): Promise<{ extracted: MemoryRecord[] }>;
  relate(src: string, rel: string, dst: string, weight?: number, dim?: string): Promise<void>;
  mode(): "local" | "remote";
}

// ─── Decay Constants ──────────────────────────────────────────────────────────

export const DEFAULT_DECAY_MS: Record<MemoryDimension, number> = {
  working:     1 * 60 * 60 * 1000,
  episodic:    7 * 24 * 60 * 60 * 1000,
  semantic:  180 * 24 * 60 * 60 * 1000,
  procedural:365 * 24 * 60 * 60 * 1000,
  declarative: 5 * 365 * 24 * 60 * 60 * 1000,
};