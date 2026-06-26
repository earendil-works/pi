// Memory REST routes.
//
// This module owns the read-side API for the v2 memory model:
//   - GET /api/memory            (list with filter/pagination, Task 7.1)
//   - GET /api/memory/:id        (full atom + content body, Task 7.3)
//   - PATCH /api/memory/:id      (manual edits, Task 7.5)
//   - GET /api/memory/:id/stream (SSE single-atom push, Task 2.4)
//   - GET /api/memory/stats      (counts, Task 7.2)
//   - POST /api/memory/:id/archive  (toggle archived flag, Task 7.5)
//   - POST /api/memory/search    (recall + token budget, Task 7.6)
//   - POST /api/memory/extract   (manual extraction pipeline, Task 7.7)
//   - mountMemoryRoutes          (DI factory wiring dbPath + atomsDir, Task 7.1)
//
// Cross-package imports: extensions/personal-assistant is not in the root
// workspaces array, and its index.ts only re-exports runMemoryExtraction.
// MemoryIndex and readAtomFromFile are reached via direct relative paths
// here so both vitest and the esbuild server bundle resolve them.
//
// Architecture constraints (from docs/sdd/changes/memory-v2-refactor):
//   - 404 only when the atom id is unknown. A missing or stale .md file
//     is NOT a 500 — it degrades to content="" so the UI can still render
//     metadata (S23 / R19).
//   - The route opens a fresh MemoryIndex per request. better-sqlite3 is
//     fast enough that v2 doesn't need a shared connection; the explicit
//     close in the finally block keeps WAL checkpoints small.

import express from "express";
import path from "node:path";
import { MemoryIndex } from "../../../../extensions/personal-assistant/storage.ts";
import {
	readAtomFromFile,
	writeAtomToFile,
} from "../../../../extensions/personal-assistant/file-store.ts";
import { computeFingerprint } from "../../../../extensions/personal-assistant/extraction.ts";
import { recallAtoms } from "../../../../extensions/personal-assistant/search.ts";
import type { RecallResult } from "../../../../extensions/personal-assistant/types.ts";
import {
	buildEmbeddableText,
	embedText,
} from "../../../../extensions/personal-assistant/embed.ts";
import { supersedeIfSimilar } from "../../../../extensions/personal-assistant/dedup.ts";
import { normalizeTags } from "../../../../extensions/personal-assistant/tag-alias.ts";
import type { PersonalAssistantConfig, MemoryAtom } from "@earendil-works/pi-personal-assistant";

/**
 * SSE 订阅表: atomId → Set<Response>
 * module-level state, vitest watch 模式下每个 test file 独立 createApp 避免污染。
 */
const subscribers = new Map<string, Set<express.Response>>();

/**
 * Test-only handle that exposes the current subscriber count for a given
 * atom id. Lets the SSE integration test verify that `res.on('close')`
 * removed a disconnected response from the Set (Task 2.4 cleanup test).
 * Not part of the public API.
 */
export function __getSubscriberCount(atomId: string): number {
	return subscribers.get(atomId)?.size ?? 0;
}

/** SSE 心跳周期(ms),默认 25s。test 可注入更短值。 */
export const SSE_HEARTBEAT_MS = 25_000;

/**
 * 注册一个 SSE 订阅,自动发送初始 `: connected` 帧和 25s 心跳。
 * 客户端断开(res close)时自动从订阅表移除。
 */
export function subscribeAtom(atomId: string, res: express.Response): void {
	try { res.write(": connected\n\n"); } catch { /* ignore broken pipes */ }
	let set = subscribers.get(atomId);
	if (!set) {
		set = new Set();
		subscribers.set(atomId, set);
	}
	set.add(res);
	const interval = setInterval(() => {
		try { res.write(": ping\n\n"); } catch { /* ignore broken pipes */ }
	}, SSE_HEARTBEAT_MS);
	res.on("close", () => {
		clearInterval(interval);
		const s = subscribers.get(atomId);
		if (s) {
			s.delete(res);
			if (s.size === 0) subscribers.delete(atomId);
		}
	});
}

/**
 * 当某 atom 被 PATCH/supersede 后,推送给该 atom 的所有订阅者。
 * 帧格式: `event: atom\ndata: <JSON>\n\n`
 */
export function broadcastAtomUpdate(atom: MemoryAtom): void {
	const set = subscribers.get(atom.id);
	if (!set || set.size === 0) return;
	const frame = `event: atom\ndata: ${JSON.stringify(atom)}\n\n`;
	for (const r of set) {
		try { r.write(frame); } catch { /* ignore broken pipes */ }
	}
}

/**
 * Dependency injection bag for the memory routes. Grew over Tasks 7.1-7.7
 * to carry dbPath, atomsDir, settings, and callLlm as more endpoints land.
 *
 * - `settings` and `callLlm` are unused by the read-only list/get handlers
 *   in this task; they exist on the bag so the upcoming write handlers
 *   (Task 7.4 extraction, 7.6 archive, 7.7 reactivation) can share the same
 *   DI factory without needing a different interface.
 * - `embedTimeoutMs` is consumed only by the PATCH handler so it can keep
 *   the embed call short in tests (ollama is unreachable in CI). Optional;
 *   when unset, embedText's 15s default applies.
 */
export interface MemoryDeps {
	dbPath: string;
	atomsDir: string;
	settings: PersonalAssistantConfig;
	callLlm: (prompt: string) => Promise<string>;
	embedTimeoutMs?: number;
}

/**
 * Open a fresh MemoryIndex and apply the schema. Caller must close().
 */
async function createIndex(dbPath: string): Promise<MemoryIndex> {
	const index = new MemoryIndex(dbPath);
	await index.init();
	return index;
}

/**
 * GET /api/memory/:id — return the full atom (DB row) plus the .md body.
 *
 * This endpoint is a UI preview only — reading an atom via the webui does NOT
 * count toward the strength-feedback loop. Strength feedback is recorded
 * exclusively by the agent's `memory_get` tool (see
 * extensions/personal-assistant/memory.ts).
 *
 * Status codes:
 *   - 200: atom found. `content` is the .md body if the file is present and
 *          its hash matches atom.content_fingerprint; otherwise `content=""`
 *          so the UI can still render the metadata.
 *   - 404: atom id is unknown.
 *   - 500: only for genuine server errors (DB driver failure, etc.).
 */
export function registerGetMemoryById(
	app: express.Express,
	deps: MemoryDeps,
): void {
	app.get("/api/memory/:id", async (req, res) => {
		try {
			const index = await createIndex(deps.dbPath);
			try {
				const atom = index.getAtom(req.params.id);
				if (!atom) {
					res.status(404).json({ error: "atom not found" });
					return;
				}
				const filePath = path.join(
					deps.atomsDir,
					atom.type,
					`${atom.id}.md`,
				);
				// readAtomFromFile returns null on missing file, malformed
				// frontmatter, OR hash mismatch (when expectedHash is given).
				// All three collapse to "no content" — never a 500.
				const result = await readAtomFromFile(
					filePath,
					atom.content_fingerprint,
				);
				if (!result) {
					res.json({ ...atom, content: "" });
					return;
				}
				res.json({ ...atom, content: result.atom.content });
			} finally {
				index.close();
			}
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});
}

/**
 * GET /api/memory — list atoms with optional filter and pagination.
 *
 * Query params:
 *   - `archived=active` (default) — exclude archived rows
 *   - `archived=archived`          — only archived rows
 *   - `archived=all`               — active + archived (current impl
 *     returns active only — the dedicated archive query is left for a
 *     follow-up; the active-only default is what S25/S26 exercise)
 *   - `type=rule|fact|process`     — narrow to a single atom category
 *   - `tag=foo`                    — exact-match tag filter
 *   - `limit=N` (default 200, max 1000)
 *   - `offset=N`  (default 0)
 *
 * Status codes:
 *   - 200: array of atom records (possibly empty)
 *   - 500: DB or index failure
 */
export function registerGetMemoryList(
	app: express.Express,
	deps: MemoryDeps,
): void {
	app.get("/api/memory", async (req, res) => {
		try {
			const index = await createIndex(deps.dbPath);
			try {
				const archived = (req.query.archived as string) || "active";
				const type = req.query.type as string | undefined;
				const tag = req.query.tag as string | undefined;
				const limit = Math.min(
					parseInt((req.query.limit as string) || "200", 10),
					1000,
				);
				const offset = parseInt(
					(req.query.offset as string) || "0",
					10,
				);

			const archivedFilter: boolean | "all" | undefined =
				archived === "all" ? "all" : archived === "archived" ? true : undefined;
			let atoms = index.listAtoms({ archived: archivedFilter, type: type as any });

			if (tag) {
				atoms = atoms.filter((a) => a.tags.includes(tag));
			}
			atoms = atoms.slice(offset, offset + limit);
			res.json(atoms);
			} finally {
				index.close();
			}
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});
}

/**
 * PATCH /api/memory/:id — manually edit tags, content, or importance.
 *
 * Body fields (all optional):
 *   - `content`:    string — replaces the existing content. Empty strings
 *                   are ignored (preserves the old content). Recomputes
 *                   `content_fingerprint` on change.
 *   - `tags`:       string[] — merged with the existing tags through
 *                   `normalizeTags` (trim → empty filter → alias fold →
 *                   Set dedup → preserve order) using the runtime
 *                   `deps.settings.memory.tagAliases` map. Omitted tags
 *                   leave the existing list untouched.
 *   - `importance`: number — clamped to [0, 1].
 *
 * Other atom fields (id, type, title, summary, strength, access_count,
 * version, parent_id, superseded_at, archived, created_at, last_access,
 * source_session) are preserved from the existing atom.
 *
 * Version is incremented via updateAtom's SQL (`version = version + 1`)
 * and reflected in the response payload.
 *
 * Architecture constraints:
 *   - The ollama embedding call is awaited OUTSIDE the DB transaction
 *     so the better-sqlite3 WAL write lock isn't held for the full
 *     embed round-trip (which can take seconds).
 *   - When embedText returns null (ollama down / timeout / network
 *     error), the route still updates the DB row and rewrites the .md
 *     file — only the vector is skipped (Decision 7: no fallback).
 *   - The dedup gate (`supersedeIfSimilar`) is wired in for future use,
 *     but for PATCH the new atom's id always equals existing.id, so the
 *     self-match guard inside supersedeIfSimilar returns "create" and the
 *     route falls through to updateAtom. A supersede response would carry
 *     `previousId` set to the superseded atom's id.
 *
 * Status codes:
 *   - 200: updated atom JSON. On a supersede hit, body includes
 *          `previousId: <supersededAtomId>`.
 *   - 400: missing If-Match header (Task 2.1, CAS contract).
 *   - 404: atom id is unknown.
 *   - 409: If-Match version does not match the current row. Body is
 *          `{ error: "version_conflict", current: <atom> }` so the
 *          client can merge or reload without a second round-trip.
 *          Bypassed when If-Match is `*` (escape hatch for callers
 *          that explicitly want last-writer-wins).
 *   - 500: DB / file-system failure.
 */
export function registerPatchMemory(
	app: express.Express,
	deps: MemoryDeps,
): void {
	app.patch("/api/memory/:id", async (req, res) => {
		try {
			const index = await createIndex(deps.dbPath);
			try {
				const existing = index.getAtom(req.params.id);
				if (!existing) {
					res.status(404).json({ error: "atom not found" });
					return;
				}

				// CAS check (Task 2.1, design.md Decision 1). The client
				// must send the version it loaded with; missing → 400,
				// stale → 409 with `current` so the client can merge or
				// reload. "*" is an escape hatch for clients that
				// explicitly want last-writer-wins (skips the check).
				// Header name is read lowercase per Node / Express
				// normalization; `String(...) === String(...)` bridges
				// the string header vs numeric DB column.
				const ifMatch = req.headers["if-match"];
				if (ifMatch === undefined) {
					res.status(400).json({ error: "missing_if_match" });
					return;
				}
				if (
					ifMatch !== "*" &&
					String(ifMatch) !== String(existing.version)
				) {
					res
						.status(409)
						.json({ error: "version_conflict", current: existing });
					return;
				}

				// Merge body fields. content is replaced only when a
				// non-empty string is supplied; tags are merged through
				// normalizeTags (trim → empty filter → alias fold → Set
				// dedup → preserve order) using the runtime tagAliases
				// from settings.memory.tagAliases; importance is clamped
				// to [0, 1].
				const mergedContent =
					typeof req.body?.content === "string" &&
					req.body.content.length > 0
						? req.body.content
						: existing.content;
				const tagAliases = deps.settings?.memory?.tagAliases;
				const incomingTags = Array.isArray(req.body?.tags)
					? req.body.tags
					: existing.tags;
				const normalizedIncoming = normalizeTags(incomingTags, tagAliases);
				const filteredIncoming = normalizedIncoming.filter(
					(t) => !existing.tags.includes(t),
				);
				const mergedTags = normalizeTags(
					[...existing.tags, ...filteredIncoming],
					tagAliases,
				);
				const mergedImportance =
					typeof req.body?.importance === "number"
						? Math.max(0, Math.min(1, req.body.importance))
						: existing.importance;

				// Build the merged atom. Type is inferred from `existing`
				// (MemoryAtom), so no explicit import of MemoryAtom is
				// required here — spread + three overrides preserves the
				// full shape.
				const mergedAtom = {
					...existing,
					content: mergedContent,
					tags: mergedTags,
					importance: mergedImportance,
					updated_at: Date.now(),
				};

				// Recompute fingerprint from the (possibly new) content.
				// This is sync (sha256 + slice) — no async overhead.
				mergedAtom.content_fingerprint =
					computeFingerprint(mergedContent);

				// Compute embedding OUTSIDE any DB transaction. The await
				// on ollama could take seconds; we do not want to hold
				// the better-sqlite3 WAL write lock that long.
				const embeddableText = buildEmbeddableText(mergedAtom);
				const embedding = await embedText(embeddableText, {
					timeoutMs: deps.embedTimeoutMs,
				});

				// Dedup gate (Task 2.2, design.md Decision 2). For a PATCH
				// the new atom's id always equals existing.id (we are
				// updating the same row in place), so the self-match guard
				// inside supersedeIfSimilar returns "create" — the route
				// falls through to updateAtom below. The gate is still
				// wired up so future callers (or a future routing of PATCH
				// to a fresh id) can take the supersede path.
				const dedupResult = await supersedeIfSimilar(
					index,
					deps.atomsDir,
					mergedAtom,
					embedding ?? null,
				);
				if (dedupResult.status === "supersede") {
					const finalAtom = dedupResult.atom;
					broadcastAtomUpdate(finalAtom);
					res.json({ ...finalAtom, previousId: finalAtom.parent_id });
					return;
				}

				// Fast atomic DB update. updateAtom() runs in its own
				// transaction and bumps version internally. Passing
				// `undefined` for embedding skips the vector update
				// when ollama was unreachable.
				await index.updateAtom(mergedAtom, embedding ?? undefined);

				// Mirror the version+1 from updateAtom's SQL so the
				// response body matches what the DB row now holds.
				mergedAtom.version = existing.version + 1;

				// Write the .md file. Must happen after the DB update so
				// the file's content_hash matches content_fingerprint.
				await writeAtomToFile(mergedAtom, deps.atomsDir);

				// SSE: push the post-write atom to every subscriber of
				// this id (Task 2.4). No-op when nobody is subscribed —
				// the empty Set short-circuits inside broadcastAtomUpdate.
				broadcastAtomUpdate(mergedAtom);

				res.json(mergedAtom);
			} finally {
				index.close();
			}
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});
}

/**
 * GET /api/memory/:id/stream — SSE endpoint for real-time atom updates
 * (Task 2.4, design.md Decision 3, spec ADDED #5).
 *
 * Subscribes the client to atom-version change events for `:id`. The server
 * pushes `event: atom\ndata: {...}\n\n` whenever the atom is updated via
 * PATCH (or any other path that ends in `broadcastAtomUpdate`). A
 * `: ping\n\n` heartbeat is sent every 25s by `subscribeAtom` to keep the
 * connection alive through NATs / proxies.
 *
 * Status codes:
 *   - 200: text/event-stream response, connection held open
 *   - 404: atom id is unknown (response ends immediately)
 *   - 500: only for genuine DB failures
 */
export function registerStreamMemoryById(
	app: express.Express,
	deps: MemoryDeps,
): void {
	app.get("/api/memory/:id/stream", async (req, res) => {
		try {
			const index = await createIndex(deps.dbPath);
			try {
				const existing = index.getAtom(req.params.id);
				if (!existing) {
					res.status(404).json({ error: "atom_not_found" });
					return;
				}
				res.setHeader("Content-Type", "text/event-stream");
				res.setHeader("Cache-Control", "no-cache");
				res.setHeader("Connection", "keep-alive");
				// Express 5 / Node 18+ may have flushHeaders.
				(res as { flushHeaders?: () => void }).flushHeaders?.();
				subscribeAtom(req.params.id, res);
			} finally {
				index.close();
			}
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});
}

/**
 * GET /api/memory/stats — counts of all atoms (active + archived),
 * grouped by type (S46 / S47 / R43).
 *
 * Returns `{ total, archived, byType: { rule, fact, process } }`:
 *   - `total`     — all `is_latest = 1` rows (active + archived).
 *   - `archived`  — subset of `total` with `archived = 1`.
 *   - `byType`    — count of latest rows for each of the three atom
 *     types. Missing categories default to 0 so the UI can render
 *     a stable shape even when the DB is empty.
 *
 * The handler uses `getRawDb()` directly because `getActiveAtoms()`
 * filters `archived = 0` at SQL level — we need cross-status counts
 * for the stats panel. `getRawDb()` is `@internal` (Task 2.2) and
 * acceptable for this cross-status aggregation; new typed methods
 * should be added to MemoryIndex if/when a second caller needs the
 * same view.
 *
 * Status codes:
 *   - 200: `{ total, archived, byType }`.
 *   - 500: DB or index failure.
 */
export function registerGetMemoryStats(
	app: express.Express,
	deps: MemoryDeps,
): void {
	app.get("/api/memory/stats", async (_req, res) => {
		try {
			const index = await createIndex(deps.dbPath);
			try {
				const rawDb = index.getRawDb();
				const total = (
					rawDb
						.prepare(
							`SELECT COUNT(*) as n FROM memory_index WHERE is_latest = 1`,
						)
						.get() as { n: number }
				).n;
				const archived = (
					rawDb
						.prepare(
							`SELECT COUNT(*) as n FROM memory_index WHERE is_latest = 1 AND archived = 1`,
						)
						.get() as { n: number }
				).n;
				const byTypeRows = rawDb
					.prepare(
						`SELECT type, COUNT(*) as n FROM memory_index
						 WHERE is_latest = 1
						 GROUP BY type`,
					)
					.all() as Array<{ type: string; n: number }>;
				const byType: Record<string, number> = {
					rule: 0,
					fact: 0,
					process: 0,
				};
				for (const { type, n } of byTypeRows) {
					byType[type] = n;
				}
				res.json({ total, archived, byType });
			} finally {
				index.close();
			}
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});
}

/**
 * POST /api/memory/:id/archive — toggle or explicitly set the atom's
 * archived flag (R44).
 *
 * Body:
 *   - `archived` (boolean, optional): explicit target state. If omitted,
 *     the route toggles the current state (active→archived, archived→
 *     active). If provided, the boolean overrides the toggle and the
 *     target state equals the body value (S50).
 *
 * Behavior (mirrors storage.ts design):
 *   - Archiving (target=1): markArchived + deleteVector (R45). The
 *     storage layer writes an audit row inside markArchived's
 *     transaction.
 *   - Unarchiving (target=0): markUnarchived only (R46). No audit row,
 *     no vector re-compute — the original archive audit row is
 *     considered sufficient to reconstruct history, and a vector
 *     absent since archive stays absent.
 *
 * Per-route `express.json()` middleware is used so other handlers
 * remain payload-free unless they explicitly need a body.
 *
 * Status codes:
 *   - 200: `{ id, archived }` (0 or 1).
 *   - 404: atom id is unknown.
 *   - 500: DB or index failure.
 */
export function registerPostArchive(
	app: express.Express,
	deps: MemoryDeps,
): void {
	app.post("/api/memory/:id/archive", express.json(), async (req, res) => {
		try {
			const index = await createIndex(deps.dbPath);
			try {
				const existing = index.getAtom(req.params.id);
				if (!existing) {
					res.status(404).json({ error: "atom not found" });
					return;
				}
				// Explicit body.archived overrides the toggle; otherwise
				// invert the current state (S50).
				const explicitArchived = req.body?.archived;
				const targetArchived: 0 | 1 =
					typeof explicitArchived === "boolean"
						? explicitArchived
							? 1
							: 0
						: existing.archived === 0
							? 1
							: 0;

				if (targetArchived === 1) {
					// markArchived writes the audit row in its own
					// transaction; deleteVector is idempotent so calling
					// it unconditionally is safe (matches R45 + R27).
					index.markArchived(req.params.id);
					index.deleteVector(req.params.id);
				} else {
					// No transaction, no audit, no vector re-compute —
					// mirrors markUnarchived's intentional simplicity.
					index.markUnarchived(req.params.id);
				}

				res.json({ id: req.params.id, archived: targetArchived });
			} finally {
				index.close();
			}
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});
}

/**
 * POST /api/memory/search — recall ranked atoms in discovery-only mode.
 *
 * Body:
 *   - `query`  (required) — non-empty string to embed and search.
 *   - `topK`   (optional, default 10) — max candidates to return.
 *   - `type`   (optional) — restrict recall to a single atom type.
 *
 * Response:
 *   - `results`: ranked list of `{ id, type, title, summary, tags, distance, cosine, score }`. Empty when no atoms match or
 *     ollama is unreachable (embedText → null → []).
 *   - `recallTimeMs`: wall-clock ms spent inside `recallAtoms`.
 *   - `score` is a debug/UI-only metadata field — LLM does not see it (formatMemoryContext re-sorts by distance before prompt injection).
 *
 * Discovery-only contract (R-search-cheap):
 *   - No `formattedText`, no `tier` field, no `tokenBudgetUsed`, no `file_path`.
 *     Search is pure vector retrieval; full content is fetched on demand via
 *     `GET /api/memory/:id` (Task 7.3).
 *
 * Architecture constraints:
 *   - recallAtoms is imported via the relative extensions/personal-assistant
 *     path (same as MemoryIndex) — the package is not in the workspace and
 *     `index.ts` only re-exports runMemoryExtraction.
 *   - Per-route `express.json()` so other handlers stay payload-free.
 *
 * Status codes:
 *   - 200: search ran (results may be empty).
 *   - 400: query missing or empty.
 *   - 500: only for genuine DB / vector errors.
 */
export function registerPostSearch(
	app: express.Express,
	deps: MemoryDeps,
): void {
	app.post("/api/memory/search", express.json(), async (req, res) => {
		try {
			const { query, topK = 10, type } = req.body || {};
			if (typeof query !== "string" || query.length === 0) {
				res
					.status(400)
					.json({ error: "query must be a non-empty string" });
				return;
			}

			const index = await createIndex(deps.dbPath);
			try {
				const t0 = Date.now();
				const results = await recallAtoms(index, query, {
					topK,
					filter: type ? { type } : undefined,
				});
				const recallTimeMs = Date.now() - t0;

				res.json({
					results: results.map((r) => ({
						id: r.atom.id,
						type: r.atom.type,
						title: r.atom.title,
						summary: r.atom.summary,
						tags: r.atom.tags,
						distance: r.distance,
						cosine: r.cosine,
						// Task 1.1 will add `score` to RecallResult; until then
						// the value is undefined and the response field is
						// omitted (TS suppression below keeps HEAD compiling).
						score: (r as RecallResult & { score?: number }).score ?? 0,
					})),
					recallTimeMs,
				});
			} finally {
				index.close();
			}
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});
}

/**
 * POST /api/memory/extract — manually trigger the full extraction
 * pipeline against a conversation transcript (R59, S65-S67).
 *
 * Body:
 *   - `messages` (required): non-empty array of `{role: string,
 *     content: string}` entries. The shape mirrors the LLM chat format
 *     so callers can pass a session transcript directly. Each entry
 *     must have both `role` and `content` as strings (S67).
 *
 * Behavior:
 *   - Validates the body. Missing / empty `messages` → 400. Malformed
 *     entries → 400. No silent fallback.
 *   - Lazy-imports runMemoryExtraction from
 *     extensions/personal-assistant/extraction.ts (the same pattern as
 *     registerPostSearch) so the cold-start cost is minimal when the
 *     route is unused. runMemoryExtraction opens its own MemoryIndex
 *     internally, so the route doesn't need to hold the DB handle.
 *   - Returns counts and IDs from each extraction bucket (created,
 *     superseded, skipped) plus a slimmed-down plan echo. Per R60 the
 *     response shape is `{plan, created, superseded, skipped,
 *     createdIds, supersededPairs, skippedIds}`.
 *
 * Architecture constraints:
 *   - Per-route `express.json()` (matching the rest of the POST handlers
 *     in this file) so other handlers stay payload-free.
 *   - 500 is reserved for genuine runMemoryExtraction failures (DB /
 *     LLM / file-system). Validation errors stay 400 so callers can
 *     distinguish "bad input" from "internal failure".
 *
 * Status codes:
 *   - 200: extraction ran. Counts may be zero if the LLM returned an
 *     empty plan (S66) or invalid JSON.
 *   - 400: messages missing / empty / malformed (S67).
 *   - 500: runMemoryExtraction threw.
 */
export function registerPostExtract(
	app: express.Express,
	deps: MemoryDeps,
): void {
	app.post("/api/memory/extract", express.json(), async (req, res) => {
		try {
			const { messages } = req.body || {};
			if (!Array.isArray(messages) || messages.length === 0) {
				res
					.status(400)
					.json({ error: "messages must be a non-empty array" });
				return;
			}
			// Validate each message has string role + content (S67).
			// `m?.role` / `m?.content` short-circuits when the entry
			// itself is null/undefined so the error fires on the shape,
			// not on a TypeError inside the loop.
			for (const m of messages) {
				if (typeof m?.role !== "string" || typeof m?.content !== "string") {
					res.status(400).json({
						error: "each message must have string role and content",
					});
					return;
				}
			}

			// Lazy-import so this route pays nothing at server boot and
			// so we don't drag the extraction module graph into modules
			// that never call the route.
			const { runMemoryExtraction } = await import(
				"../../../../extensions/personal-assistant/extraction.ts"
			);
			const result = await runMemoryExtraction({
				callLlm: deps.callLlm,
				config: { model: deps.settings.memory?.embedding?.model },
				messages,
				dbPath: deps.dbPath,
				atomsDir: deps.atomsDir,
			});

			res.json({
				plan: {
					items: result.plan.items,
					modelUsed: result.plan.modelUsed,
					generatedAt: result.plan.generatedAt,
				},
				created: result.created.length,
				superseded: result.superseded.length,
				skipped: result.skipped.length,
				createdIds: result.created.map((a) => a.id),
				supersededPairs: result.superseded.map((s) => ({
					oldId: s.oldId,
					newId: s.newAtom.id,
				})),
				skippedIds: result.skipped.map((a) => a.id),
			});
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});
}

/**
 * Register all memory routes on the given Express app. New handlers
 * (POST / PATCH / DELETE in Tasks 7.4-7.7) should be appended here so
 * callers only need to know one entry point.
 */
export function mountMemoryRoutes(
	app: express.Express,
	deps: MemoryDeps,
): void {
	// Static paths MUST register before /:id to avoid Express route shadowing
	registerGetMemoryList(app, deps);
	registerGetMemoryStats(app, deps);
	registerPostSearch(app, deps);
	registerPostExtract(app, deps);
	// Parameterized paths last.
	registerGetMemoryById(app, deps);
	registerPatchMemory(app, deps);
	registerPostArchive(app, deps);
	// Register /:id/stream after /:id for consistent route-list ordering in mountMemoryRoutes.
	registerStreamMemoryById(app, deps);
}
