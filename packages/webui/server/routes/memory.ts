// Memory REST routes.
//
// This module owns the read-side API for the v2 memory model:
//   - GET /api/memory       (list with filter/pagination, Task 7.1)
//   - GET /api/memory/:id   (full atom + content body, Task 7.3)
//   - mountMemoryRoutes     (DI factory wiring dbPath + atomsDir, Task 7.1)
//
// Future tasks will add:
//   - POST /api/memory      (extraction entry point, Task 7.4+)
//   - PATCH /api/memory/:id (manual edits, Task 7.5+)
//   - DELETE /api/memory/:id (archive, Task 7.6+)
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
import { readAtomFromFile } from "../../../../extensions/personal-assistant/file-store.ts";
import type { PersonalAssistantConfig } from "@earendil-works/pi-personal-assistant";

/**
 * Dependency injection bag for the memory routes. Grew over Tasks 7.1-7.7
 * to carry dbPath, atomsDir, settings, and callLlm as more endpoints land.
 *
 * - `settings` and `callLlm` are unused by the read-only list/get handlers
 *   in this task; they exist on the bag so the upcoming write handlers
 *   (Task 7.4 extraction, 7.6 archive, 7.7 reactivation) can share the same
 *   DI factory without needing a different interface.
 */
export interface MemoryDeps {
	dbPath: string;
	atomsDir: string;
	settings: PersonalAssistantConfig;
	callLlm: (prompt: string) => Promise<string>;
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

				let atoms =
					archived === "active"
						? index.getActiveAtoms()
						: archived === "archived"
							? index.getActiveAtoms().filter((a) => a.archived === 1)
							: index.getActiveAtoms(); // "all" — see JSDoc above

				if (type && (type === "rule" || type === "fact" || type === "process")) {
					atoms = atoms.filter((a) => a.type === type);
				}
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
 * Register all memory routes on the given Express app. New handlers
 * (POST / PATCH / DELETE in Tasks 7.4-7.7) should be appended here so
 * callers only need to know one entry point.
 */
export function mountMemoryRoutes(
	app: express.Express,
	deps: MemoryDeps,
): void {
	registerGetMemoryList(app, deps);
	registerGetMemoryById(app, deps);
}
