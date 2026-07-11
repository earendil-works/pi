// memory_save tool — agent-driven memory write path.
//
// Task 2.2 create path + Task 2.3 fingerprint-hit skip:
//   - Defines the TypeBox parameter schema (MemorySaveParams) that gates
//     tool input at dispatch time (per spec R2: "memory_save validates
//     input via TypeBox schema").
//   - Owns the module-level segmentMemorySaveCount + its 3 helpers
//     (get / increment / reset). The increment is hoisted to the very
//     top of `execute` (task 2.6) so it fires exactly once on every
//     invocation regardless of outcome (created / updated / skipped /
//     error) — per the principle "计入调用而不计入成功".
//   - Implements two of the four outcomes:
//       2.2  create   (no id, fingerprint miss) → insertAtom +
//             writeAtomToFile + reindexOne → {action: "created", id, embedding}.
//       2.3  skipped  (no id, fingerprint hit) → return
//             {action: "skipped", reason: "duplicate_content", existing_id}
//             with no storage I/O.
//   - Tasks 2.4 / 2.5 land the overwrite (id present, atom exists) and
//     id_not_found (id present, atom missing) branches as additional
//     return paths in this same execute body.
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
// The execute body reuses the same helpers from extraction.ts
// (computeFingerprint) and the storage layer (MemoryIndex.insertAtom /
// getActiveAtomByFingerprint). The writeAtomToFile + reindexOne calls
// match the extraction.ts persistCreate() pattern so the on-disk
// layout and the bge-m3 service state stay in sync across both write
// paths (extraction pipeline and agent-driven memory_save).
//
// Path resolution: dbPath / atomsDir are computed at execute time via
// `homedir()` (resolving to whatever process.env.HOME is at call time).
// The test fixture relies on this — it sets HOME AFTER importing
// memory-save.ts, then expects execute to open a DB at the new HOME.
// `memory.ts` exports `DEFAULT_DB_PATH` / `DEFAULT_ATOMS_DIR` as the
// canonical path strings (AGENTS.md Principle 9 "One Explicit Home");
// a future task will add `config.memory?.dbPath ?? DEFAULT_DB_PATH`
// plumbing + a matching `loadConfig` mock in the test fixture so user
// overrides are honored. For 2.2 the dynamic `homedir()` is correct
// but the path strings appear in two places (memory.ts and here);
// an integration test should pin them to the same value when
// `loadConfig` is added.

import { Type, type Static } from "typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { computeFingerprint } from "./extraction.ts";
import { writeAtomToFile } from "./file-store.ts";
import { embedText, buildEmbeddableText } from "./embed.ts";
import { MemoryIndex } from "./storage.ts";
import { normalizeTags } from "./tag-alias.ts";
import { reindexOne } from "./bge-reindex.ts";
import type { MemoryAtom } from "./types.ts";

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
export const MemorySaveParams = Type.Object({
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
			id?: string;
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
 * Tasks 2.2 + 2.3 wire the create / skip paths:
 *   - When `params.id` is absent: computeFingerprint → getActiveAtomByFingerprint.
 *     On fingerprint hit (2.3), return {action: "skipped", reason:
 *     "duplicate_content", existing_id} with no I/O. On fingerprint miss,
 *     build a new MemoryAtom, embed via embedText (with 1024-dim zero-vector
 *     fallback when the embedder is down), then insertAtom + writeAtomToFile +
 *     reindexOne, and return {action: "created", id, embedding}.
 *
 * Tasks 2.4 / 2.5 add the other branches in the same execute body:
 *   - 2.4 — id present, atom exists → in-place updateAtom + return
 *           {action: "updated", id, embedding}
 *   - 2.5 — id present, atom missing → {action: "error", error: "id_not_found"}
 *
 * Task 2.6 hoists `incrementSegmentMemorySaveCount()` to the very
 * top of this execute body so it fires exactly once per call
 * regardless of which branch (created / updated / skipped / error)
 * wins — per the principle "counter 计入调用而不计入成功".
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
		async execute(
			_toolCallId,
			params: Static<typeof MemorySaveParams>,
			_signal,
			_onUpdate,
			ctx,
		) {
			// Increment counter at the top of every execute — counts the
			// call, not the outcome (created / updated / skipped / error
			// all count). Per design.md § Decisions § 5 "counter 在
			// `memory_save` execute 入口 `++`". Task 2.6 hoisted this
			// here from scattered inline calls at the end of each branch.
			incrementSegmentMemorySaveCount();

			// Tasks 2.2 + 2.3 cover the create and skip branches. Task 2.4
			// lands the overwrite branch (id present, atom exists); task 2.5
			// will land the id_not_found envelope (id present, atom missing).
			// For now, anything that isn't create/skip/overwrite surfaces as a
			// thrown error so the test contract is unambiguous — task 2.6
			// will revisit error handling for the `id_not_found` outcome (it
			// should return a typed error envelope, not throw).
			const dbPath = join(homedir(), ".pi", "agent", "memory", "memory.db");
			const atomsDir = join(homedir(), ".pi", "agent", "memory", "atoms");

			const index = new MemoryIndex(dbPath);
			await index.init();
			try {
				if (params.id !== undefined) {
					// Task 2.4 — overwrite-by-id (in-place UPDATE).
					// Mirrors `extraction.ts:executeItem` step 3 (line 227-252)
					// but WITHOUT the `is_latest === 1 && archived === 0` guard:
					// the agent explicitly supplies an id, so the agent can
					// update any atom they have the id for (including archived
					// or superseded ones — the agent intentionally chose it).
					// The output preserves `id`, `is_latest`, `archived`,
					// `parent_id`, `superseded_at`, `source_session`,
					// `created_at`, `access_count`, `strength` from the
					// existing row. `version` is auto-bumped by SQL
					// `version = version + 1` (storage.ts:194) — we do NOT
					// pass a manual version field; the typed `MemoryAtom`
					// requires one but the SQL ignores the passed value.
					const existing = index.getAtom(params.id);
					if (!existing) {
						// Task 2.5 — id_not_found envelope (scenarios.md S7 line 37-40,
						// spec.md L39-44). No insertAtom / updateAtom /
						// writeAtomToFile / reindexOne (per spec L44). The
						// counter increments at the top of execute — the
						// spec says it counts every memory_save invocation,
						// including error outcomes (principle "counter 计入
						// 调用而不计入成功").
						const errorResult: MemorySaveResult = {
							action: "error",
							error: "id_not_found",
							id: params.id,
						};
						return {
							content: [
								{
									type: "text",
									text: `Error: no atom found with id ${params.id}`,
								},
							],
							details: errorResult,
						};
					}

					const fingerprint = computeFingerprint(params.content);
					const normalizedTags = normalizeTags(params.tags ?? []);

					const now = Date.now();
					const mergedAtom: MemoryAtom = {
						...existing,
						type: params.type,
						title: params.title,
						summary: params.summary,
						content: params.content,
						tags: normalizedTags,
						importance: params.importance,
						content_fingerprint: fingerprint,
						updated_at: now,
						// Explicit defaults even though `...existing` covers them —
						// makes the in-place semantics obvious to a future reader
						// and protects against a future change to `existing`
						// (e.g. adding an unset optional field).
						id: existing.id,
						version: existing.version, // SQL ignores this; bump is SQL-side.
						is_latest: existing.is_latest,
						archived: existing.archived,
						parent_id: existing.parent_id,
						superseded_at: existing.superseded_at,
						source_session: existing.source_session,
						created_at: existing.created_at,
						access_count: existing.access_count,
						strength: existing.strength,
						last_access: existing.last_access,
					};

					// Embeddable text version 2 (embed.ts:135) — title + summary
					// + tags only. Recall is discovery, content dilutes signal.
					const embeddableText = buildEmbeddableText({
						title: mergedAtom.title,
						summary: mergedAtom.summary,
						tags: mergedAtom.tags,
					});
					// Explicit 15s timeout per embed.ts DEFAULT_CONFIG and the
					// spec's "Decision 6" — preserves a hard upper bound even
					// if the embed default ever moves.
					const embedding = await embedText(embeddableText, { timeoutMs: 15000 });
					const vectorWasNull = embedding === null;
					const vector = embedding ?? new Array(1024).fill(0);

					// Three-step finalisation, mirrors create-path (line ~313):
					//   1. in-place UPDATE row + vector (SQL bumps `version`),
					//   2. write .md sidecar for L1 hydration in recall,
					//   3. ask bge-m3 to refresh its dense+sparse index.
					await index.updateAtom(mergedAtom, vector);
					await writeAtomToFile(mergedAtom, atomsDir);
					await reindexOne(mergedAtom.id);

					const result: MemorySaveResult = {
						action: "updated",
						id: mergedAtom.id,
						embedding: vectorWasNull ? "skipped" : "ok",
					};
					return {
						content: [
							{
								type: "text",
								text: `Updated atom ${mergedAtom.id} (${mergedAtom.type}: ${mergedAtom.title})`,
							},
						],
						details: result,
					};
				}

				const fingerprint = computeFingerprint(params.content);
				const existing = index.getActiveAtomByFingerprint(fingerprint);
				if (existing) {
					// Task 2.3 — fingerprint hit (no id, duplicate content).
					// No storage / file / reindex I/O per design.md § "数据流
					// (memory_save, create 路径)" branch 1. The matched atom's
					// version / updated_at / access_count stay unchanged.
					// The counter still increments (at the top of execute):
					// the agent called the tool and we deliberately deduped,
					// which is a real save attempt (per principle "counter
					// 计入调用而不计入成功").
					const skipResult: MemorySaveResult = {
						action: "skipped",
						reason: "duplicate_content",
						existing_id: existing.id,
					};
					return {
						content: [
							{
								type: "text",
								text: `Skipped: content already exists as atom ${existing.id}`,
							},
						],
						details: skipResult,
					};
				}

				const normalizedTags = normalizeTags(params.tags ?? []);

				// Resolve source_session: explicit param wins, else fall back to
				// the active session id from ctx.sessionManager (read-only at
				// tool-execution time). Tests pass a stub ctx without
				// sessionManager, so this collapses to null — that's fine,
				// source_session is provenance-only and never gates writes.
				const currentSessionId =
					(ctx as { sessionManager?: { getSessionId(): string | undefined } }).sessionManager?.getSessionId() ??
					null;
				const sourceSession = params.source_session ?? currentSessionId;

				const now = Date.now();
				const newAtom: MemoryAtom = {
					id: randomUUID(),
					type: params.type,
					title: params.title,
					summary: params.summary,
					content: params.content,
					tags: normalizedTags,
					importance: params.importance,
					// Fresh-atom defaults: strength starts at 1.0 (mirrors
					// extraction.ts:278 buildAtomFromItem; the decay loop will
					// modulate from there on the next session_start).
					strength: 1.0,
					access_count: 0,
					version: 1,
					is_latest: 1,
					parent_id: null,
					superseded_at: null,
					archived: 0,
					created_at: now,
					updated_at: now,
					last_access: null,
					content_fingerprint: fingerprint,
					source_session: sourceSession,
				};

				// Embeddable text version 2 (embed.ts:135) drops `content` —
				// title + summary + tags only. Recall is discovery-only, so
				// embedding the verbose content dilutes the curated signal.
				const embeddableText = buildEmbeddableText({
					title: newAtom.title,
					summary: newAtom.summary,
					tags: newAtom.tags,
				});
				// Explicit 15s timeout (matches embed.ts DEFAULT_CONFIG and
				// the spec's "Decision 6" — preserves a hard upper bound even
				// if the embed.ts default ever moves).
				const embedding = await embedText(embeddableText, { timeoutMs: 15000 });
				const vectorWasNull = embedding === null;
				const vector = embedding ?? new Array(1024).fill(0);

				// Three-step finalisation (mirrors extraction.ts:168 persistCreate):
				//   1. atomic DB insert (row + vector in one transaction),
				//   2. write .md sidecar for L1 hydration in recall,
				//   3. ask bge-m3 to refresh its dense+sparse index.
				// reindexOne is non-blocking (never throws — collapses to
				// {ok:false,error}); the worst case on bge-m3 outage is one
				// stale vector until the next reindex trigger.
				await index.insertAtom(newAtom, vector);
				await writeAtomToFile(newAtom, atomsDir);
				await reindexOne(newAtom.id);

				const result: MemorySaveResult = {
					action: "created",
					id: newAtom.id,
					embedding: vectorWasNull ? "skipped" : "ok",
				};
				return {
					content: [
						{
							type: "text",
							text: `Created atom ${newAtom.id} (${newAtom.type}: ${newAtom.title})`,
						},
					],
					details: result,
				};
			} finally {
				index.close();
			}
		},
	});
}
