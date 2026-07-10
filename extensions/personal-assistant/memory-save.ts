// memory_save tool — agent-driven memory write path.
//
// Task 2.1 scaffold:
//   - Defines the TypeBox parameter schema (MemorySaveParams) that gates
//     tool input at dispatch time (per spec R2: "memory_save validates
//     input via TypeBox schema").
//   - Owns the module-level segmentMemorySaveCount + its 3 helpers
//     (get / increment / reset). The increment is called from the
//     execute body — wired in 2.2+ once the real create / update /
//     skip / error branches land; the helpers and the counter are
//     stable from 2.1 so downstream hooks (session_before_compact in
//     task 4.1) can import them without a 2.2 dependency.
//   - Exposes registerMemorySave(pi) which registers the tool with a
//     scaffold execute body that throws "not implemented". Tasks 2.2+
//     replace the throw with the real implementation.
//
// Counter semantics (from the spec, "agent save counter increments on
// every memory_save call"):
//   - The counter increments on every tool invocation, regardless of
//     outcome (created / updated / skipped / error).
//   - It is reset on session_start and session_compact (handled in
//     memory.ts in task 4.1, not here). It MUST NOT reset on
//     before_agent_start — the counter is per-segment, not per-turn.
//   - The "skipped" and "id_not_found" outcomes from 2.3 / 2.5 are
//     still counted as calls. A "skipped" call means the agent
//     attempted to save (and we deliberately deduped) — that is a
//     real save attempt, not a no-op.
//
// The real execute body (2.2+) reuses the same helpers from
// extraction.ts (computeFingerprint, normalizeContent) and the
// storage layer (MemoryIndex.insertAtom / updateAtom / getAtom /
// getActiveAtomByFingerprint). The wiring lives in 2.2+ to keep this
// scaffold diff focused on the schema + counter + registration shape.

import { Type, type TSchema } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// TypeBox schema
// ---------------------------------------------------------------------------

/**
 * MemorySaveParams — input schema for the `memory_save` tool.
 *
 * Field-level invariants (from design.md § "memory_save tool 接口"):
 *   - `id` is optional. When present, the tool overwrites the atom
 *     with the given id; when absent, the tool runs the create / skip
 *     branches.
 *   - `type` MUST be one of "rule" / "fact" / "process" (the v2 atom
 *     categories from types.ts:18-19). Anything else is rejected by
 *     TypeBox with no storage I/O.
 *   - `title` 1–200 chars. `content` 10–5000 chars. `summary` 5–500
 *     chars. These bounds match the v2 extraction schema
 *     (extraction.ts:38-48) so agent-driven and auto-extract saves
 *     share the same shape.
 *   - `tags` is optional, 0–10 items, each 1–50 chars. Empty array
 *     and missing field are equivalent (both treated as "no tags"
 *     downstream).
 *   - `importance` is the agent-assigned 0–1 priority. It is honest
 *     weighting, not a confidence score — the spec's "## Memory"
 *     system-prompt section tells the agent to not game it.
 *   - `source_session` is optional. When omitted, the tool falls back
 *     to the active session id in 2.2+; for 2.1 scaffold it is
 *     silently dropped.
 */
export const MemorySaveParams: TSchema = Type.Object({
	id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
	type: Type.Union([
		Type.Literal("rule"),
		Type.Literal("fact"),
		Type.Literal("process"),
	]),
	title: Type.String({ minLength: 1, maxLength: 200 }),
	content: Type.String({ minLength: 10, maxLength: 5000 }),
	summary: Type.String({ minLength: 5, maxLength: 500 }),
	tags: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 50 }), { maxItems: 10 }),
	),
	importance: Type.Number({ minimum: 0, maximum: 1 }),
	source_session: Type.Optional(Type.String()),
});

// ---------------------------------------------------------------------------
// Result type (exported for 2.2+ to reuse)
// ---------------------------------------------------------------------------

/**
 * MemorySaveResult — the `details` payload returned by the tool.
 *
 * Four outcomes, exactly one per call:
 *   - `created`  — new atom written, returns the new uuid and an
 *     embedding status flag ("ok" when embedText succeeded, "skipped"
 *     when the bge-m3 service was unavailable and a zero vector was
 *     used as fallback).
 *   - `updated`  — existing atom overwritten in-place, returns the
 *     same uuid and embedding status flag.
 *   - `skipped`  — content fingerprint matches an existing active
 *     atom, no write. The matched id is returned for the agent's
 *     context.
 *   - `error`    — input validation or id resolution failed. No
 *     storage or file I/O occurred.
 */
export type MemorySaveResult =
	| { action: "created"; id: string; embedding: "ok" | "skipped" }
	| { action: "updated"; id: string; embedding: "ok" | "skipped" }
	| { action: "skipped"; reason: "duplicate_content"; existing_id: string }
	| {
			action: "error";
			error: "id_not_found" | "invalid_type" | "content_too_short";
			details?: unknown;
	  };

// ---------------------------------------------------------------------------
// Module-level segment counter
// ---------------------------------------------------------------------------

/**
 * Count of `memory_save` tool invocations within the current
 * segment. Reset to 0 on session_start and session_compact (task 4.1);
 * NOT reset on before_agent_start (per-turn).
 *
 * Module-level so the `session_before_compact` hook in memory.ts
 * (task 4.1) can read it without going through any tool indirection.
 */
let segmentMemorySaveCount = 0;

/** Read the current segment's memory_save count. */
export function getSegmentMemorySaveCount(): number {
	return segmentMemorySaveCount;
}

/** Increment the counter by 1. Called from the tool's execute body. */
export function incrementSegmentMemorySaveCount(): void {
	segmentMemorySaveCount++;
}

/** Reset the counter to 0. Called from session_start / session_compact. */
export function resetSegmentMemorySaveCount(): void {
	segmentMemorySaveCount = 0;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register the `memory_save` tool on the given extension api.
 *
 * Task 2.1 scaffold: the execute body throws "not implemented". The
 * real create / update / skip / error branches land in 2.2+ as
 * straight-line replacements of the throw.
 *
 * The throw is intentionally a plain `Error` (not a typed result
 * envelope) because the runtime / model harness treats thrown errors
 * as tool failures — exactly the RED state we want for tasks 2.2+ to
 * turn GREEN against. If the scaffold returned a fake success
 * envelope, the 2.2+ tests would have a confusing "everything is
 * green today, but the assertions are wrong" failure mode.
 */
export function registerMemorySave(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "memory_save",
		label: "Memory Save",
		description:
			"Save a fact, rule, or process to durable memory. Use this when the user expresses a preference, " +
			"states a stable fact, or describes a reusable workflow. The tool handles deduplication via " +
			"content fingerprint and in-place updates by id — no separate update endpoint needed.",
		promptSnippet:
			"Save a fact, rule, or process to durable memory.",
		parameters: MemorySaveParams,
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			throw new Error("not implemented");
		},
	});
}
