/**
 * In-memory 5D Memory Engine — Pi-mono Self-Evolution Engine
 *
 * Reference implementation of MemoryEngine for Node.js environments.
 * Works without native dependencies. For production, swap with the
 * bun:sqlite implementation from apex-pi or the Rust apex-mem server.
 *
 * This is intentionally simple — the interface (MemoryEngine) is what matters.
 * The 5D evolution logic does not depend on the specific storage backend.
 */

import {
  DEFAULT_DECAY_MS,
  type DreamResult,
  type IngestInput,
  type MemoryDimension,
  type MemoryHealth,
  type MemoryHit,
  type MemoryRecord,
  type MemoryStats,
  type SearchInput,
} from "./types.ts";

// ─── In-Memory Store ───────────────────────────────────────────────────────────

function sha1(s: string): string {
  // Node.js built-in crypto
  const { createHash } = await import("node:crypto") as unknown as { createHash: (alg: string) => { update: (s: string) => { digest: () => { toString: (radix: number) => string } } } };
  // Synchronous sha1 using Web Crypto API fallback
  const encoder = new TextEncoder();
  const data = encoder.encode(s);
  return Array.from(new Uint8Array(
    typeof crypto !== "undefined" && crypto.subtle
      ? await (async () => {
          const hash = await crypto.subtle.digest("SHA-1", data);
          return new Uint8Array(hash);
        })()
      : data
  ))
    .map(b => b.toString(16).padStart(0, "0"))
    .join("");
}

export class InMemory5D implements MemoryEngine {
  private records: Map<string, MemoryRecord> = new Map();
  private graphNodes: Map<string, string> = new Map();
  private graphEdges: Array<[string, string, string, number]> = [];
  private listeners = new Set<() => void>();
  private lastDreamAt: number | null = null;

  async ingest(input: IngestInput): Promise<MemoryRecord> {
    const now = Date.now();
    const dim = input.dimension;
    const tags = input.tags ?? [];
    const importance = Math.max(0, Math.min(1, input.importance ?? 0.5));
    const decay = DEFAULT_DECAY_MS[dim];

    // Dedup: if same hash exists, bump access count
    const content = input.content;
    const hash = await sha1(content);
    const existing = [...this.records.values()].find(r => r.hash === hash);

    if (existing) {
      existing.accessedAt = now;
      existing.accessCount += 1;
      existing.importance = Math.max(existing.importance, importance);
      this.emit();
      return existing;
    }

    const record: MemoryRecord = {
      id: input.id ?? crypto.randomUUID(),
      dimension: dim,
      content,
      tags,
      importance,
      createdAt: now,
      accessedAt: now,
      accessCount: 0,
      decayUntil: now + decay,
      hash,
      meta: input.meta,
    };

    this.records.set(record.id, record);
    this.emit();
    return record;
  }

  async search(input: SearchInput): Promise<MemoryHit[]> {
    const q = input.query.trim().toLowerCase();
    if (!q) return [];

    const dims = input.dimensions;
    const topK = input.topK ?? 6;

    const candidates = [...this.records.values()].filter(r => {
      if (dims && !dims.includes(r.dimension)) return false;
      return r.content.toLowerCase().includes(q) ||
             r.tags.some(t => t.toLowerCase().includes(q));
    });

    // Score: importance × recency boost
    const scored = candidates
      .map(r => {
        const recencyMs = Date.now() - r.accessedAt;
        const recencyBoost = Math.exp(-recencyMs / (30 * 24 * 60 * 60 * 1000));
        const score = r.importance * 0.7 + recencyBoost * 0.3;
        return { record: r, score, sources: ["lexical"] as const };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    // Touch accessed records
    for (const h of scored) {
      h.record.accessedAt = Date.now();
      h.record.accessCount += 1;
    }

    return scored;
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    return this.records.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const deleted = this.records.delete(id);
    this.emit();
    return deleted;
  }

  async dream(): Promise<DreamResult> {
    const now = Date.now();
    let decayed = 0;
    let promoted = 0;

    // 1. Decay importance based on time since last access
    for (const r of this.records.values()) {
      const ageDays = (now - r.accessedAt) / 86_400_000;
      const newImportance = r.importance * Math.exp(-ageDays / 30);
      if (Math.abs(newImportance - r.importance) > 0.001) {
        r.importance = newImportance;
        decayed++;
      }
    }

    // 2. Promote working memories with high importance
    for (const r of this.records.values()) {
      if (r.dimension === "working" && r.importance > 0.55 && r.accessCount > 2) {
        r.dimension = "semantic";
        promoted++;
      }
    }

    this.lastDreamAt = now;
    this.emit();
    return { decayed, merged: 0, promoted };
  }

  async stats(): Promise<MemoryStats> {
    const byDimension: Record<MemoryDimension, number> = {
      working: 0, episodic: 0, semantic: 0, procedural: 0, declarative: 0,
    };
    for (const r of this.records.values()) {
      byDimension[r.dimension]++;
    }
    return {
      total: this.records.size,
      byDimension,
      graphNodes: this.graphNodes.size,
      graphEdges: this.graphEdges.length,
      ftsSize: this.records.size,
      lastDreamAt: this.lastDreamAt,
    };
  }

  async health(): Promise<MemoryHealth> {
    const stats = await this.stats();
    const dups = 0;
    const dangling = 0;
    const workingBloat = stats.byDimension.working > 20 ? stats.byDimension.working - 20 : 0;
    const decayIssues = [...this.records.values()].filter(r => r.decayUntil < Date.now()).length;
    const denom = Math.max(1, stats.total);
    const penalty = (dups + dangling + workingBloat + decayIssues) / denom;
    return {
      total: stats.total,
      duplicates: dups,
      missingEmbeddings: 0,
      danglingEdges: dangling,
      workingBloat,
      deltaG: Math.max(-1, 1 - 2 * penalty),
      issues: [
        ...(workingBloat ? [`working memory is bloated (${workingBloat})`] : []),
        ...(decayIssues ? [`${decayIssues} decayed record(s)`] : []),
      ],
    };
  }

  async graphJson(): Promise<unknown> {
    return { nodes: [...this.graphNodes.entries()], edges: this.graphEdges };
  }

  async flushFromConversation(text: string, source = "conversation"): Promise<{ extracted: MemoryRecord[] }> {
    // Extract *lines as procedural, !lines as declarative, ?lines as episodic
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    const extracted: MemoryRecord[] = [];
    for (const line of lines) {
      let dim: MemoryDimension = "semantic";
      let importance = 0.5;
      let content = line;
      if (line.startsWith("*")) { dim = "procedural"; content = line.slice(1).trim(); importance = 0.6; }
      else if (line.startsWith("!")) { dim = "declarative"; content = line.slice(1).trim(); importance = 0.8; }
      else if (line.startsWith("?")) { dim = "episodic"; content = line.slice(1).trim(); importance = 0.4; }
      if (content.length < 10) continue;
      const rec = await this.ingest({ content, dimension: dim, tags: [source], importance });
      extracted.push(rec);
    }
    return { extracted };
  }

  async relate(src: string, rel: string, dst: string, weight = 1.0, _dim?: string): Promise<void> {
    if (!this.graphNodes.has(src)) this.graphNodes.set(src, src);
    if (!this.graphNodes.has(dst)) this.graphNodes.set(dst, dst);
    this.graphEdges.push([src, rel, dst, weight]);
  }

  mode(): "local" | "remote" { return "local"; }

  // ── Internal event emitter ──────────────────────────────────────────

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  onUpdate(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createMemoryEngine(): MemoryEngine {
  return new InMemory5D();
}