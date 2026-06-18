// Embedding layer for the memory v2 pipeline.
//
// Two responsibilities:
//   1. embedText — single text → 1024-dim vector via ollama's /v1/embeddings.
//      Returns null on any failure (timeout, non-OK, malformed body, parse
//      error). Per design Decision 7 there is NO fallback to other embedding
//      sources: a null tells the caller "ollama is down, skip vector ops for
//      this item" — recall collapses to [] and extraction skips dedup.
//   2. buildEmbeddableText — concatenate title + summary + content + tags for
//      embedding. Per Decision 6 we embed full text, not just title: title-
//      only embeddings have materially worse recall (agentmemory benchmark
//      verified).
//
// All fetch calls honour a per-call timeout via AbortController — the
// rationale is Decision 6's 15s cap. Promise.race with setTimeout would
// leak the underlying socket; AbortController cancels cleanly.

import type { MemoryAtom } from "./types.ts";

/**
 * Embedding configuration. Defaults match design.md:
 *   - ollama running locally at 127.0.0.1:11434
 *   - bge-m3 (1024 dims)
 *   - 15s timeout (Decision 6)
 */
export interface EmbedConfig {
	/** Base URL of the ollama daemon, e.g. http://127.0.0.1:11434. */
	ollamaUrl: string;
	/** Model name as configured in ollama. bge-m3 produces 1024-dim vectors. */
	model: string;
	/** Per-call timeout in milliseconds. */
	timeoutMs: number;
}

const DEFAULT_CONFIG: EmbedConfig = {
	ollamaUrl: "http://127.0.0.1:11434",
	model: "bge-m3",
	timeoutMs: 15000,
};

/**
 * Embed a single text via ollama's OpenAI-compatible /v1/embeddings endpoint.
 *
 * Returns the embedding as a number[] on success, or null on any failure.
 * The caller must treat null as "embedding unavailable, skip vector logic"
 * — there is no fallback to mock or random vectors (Decision 7).
 *
 * Any of the following collapse to null:
 *   - fetch rejects (network error, DNS failure, connection refused)
 *   - timeoutMs elapses before the response arrives
 *   - response status is not 2xx
 *   - response body is not valid JSON, or has no `data[0].embedding` array
 */
export async function embedText(
	text: string,
	config: Partial<EmbedConfig> = {},
): Promise<number[] | null> {
	const cfg = { ...DEFAULT_CONFIG, ...config };
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
		const res = await fetch(`${cfg.ollamaUrl}/v1/embeddings`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: cfg.model, input: text }),
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (!res.ok) return null;
		const data: unknown = await res.json();
		const embedding = readEmbedding(data);
		if (!embedding) return null;
		return embedding;
	} catch {
		// fetch rejected, AbortError on timeout, JSON parse error, etc.
		// All collapse to null per Decision 7 (no fallback).
		return null;
	}
}

/**
 * Type-safe accessor for the ollama /v1/embeddings response body.
 *
 * Returns the embedding array only if the body matches the expected shape:
 *   { data: [{ embedding: number[] }] }
 *
 * Anything else — missing fields, wrong types — yields null. We do NOT
 * surface partial results: the caller wants a complete 1024-dim vector or
 * nothing at all (sqlite-vec would reject anything else).
 */
function readEmbedding(body: unknown): number[] | null {
	if (!body || typeof body !== "object") return null;
	const data = (body as { data?: unknown }).data;
	if (!Array.isArray(data) || data.length === 0) return null;
	const first = data[0];
	if (!first || typeof first !== "object") return null;
	const embedding = (first as { embedding?: unknown }).embedding;
	if (!Array.isArray(embedding)) return null;
	// Every element must be a finite number. sqlite-vec rejects NaN/Inf and
	// mixed types, so we validate rather than passing through.
	for (const v of embedding) {
		if (typeof v !== "number" || !Number.isFinite(v)) return null;
	}
	return embedding;
}

/**
 * Build the text we send to the embedder for a given atom.
 *
 * Concatenates title, summary, content, and tags (space-joined) with "\n\n"
 * separators. Empty / whitespace-only fields are skipped so a thin atom with
 * no tags still produces a clean single-segment string. This is the full-text
 * path per Decision 6 — title-only embedding was rejected because it hurts
 * recall (especially for "process" atoms whose title is short and whose
 * content is the real signal).
 */
export function buildEmbeddableText(
	atom: Pick<MemoryAtom, "title" | "summary" | "content" | "tags">,
): string {
	const tagText = atom.tags.join(" ");
	return [atom.title, atom.summary, atom.content, tagText]
		.filter((s) => s && s.trim().length > 0)
		.join("\n\n");
}

/**
 * Resolve the effective embed config: defaults merged with caller overrides.
 *
 * This is the single source of truth for "what EmbedConfig do we use?". All
 * other modules that need to embed text should call embedText with explicit
 * overrides from their own config loader rather than calling loadConfig
 * directly — loadConfig exists for tests and the small number of places that
 * want the full defaults object.
 */
export function loadConfig(overrides?: Partial<EmbedConfig>): EmbedConfig {
	return { ...DEFAULT_CONFIG, ...overrides };
}