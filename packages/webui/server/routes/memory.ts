import express from "express";
import { unlinkSync } from "node:fs";
import {
	type PersonalAssistantConfig,
	MemoryIndex,
	type MemoryAtom,
	writeAtomToFile,
	readAtomFromFile,
	getAllAtoms,
	rewriteQueryWithCallLlm,
	searchAtomsWithScores,
	ATOMS_DIR,
	MEMORY_DB_PATH,
} from "@earendil-works/pi-personal-assistant";

export interface MemoryDeps {
	dbPath: string;
	atomsDir: string;
	settings: PersonalAssistantConfig;
	callLlm: (prompt: string) => Promise<string>;
}

export function mountMemoryRoutes(app: express.Express, deps: MemoryDeps): void {
	// (2.2) GET /api/memory — list + filter. Reads only the sqlite index (no .md
	// body); per design Decision 6. Filter order per Decision 7:
	// archived → type → tag → q → sort → limit/offset.
	app.get("/api/memory", async (req, res) => {
		try {
			const idx = new MemoryIndex(deps.dbPath);
			await idx.init();
			try {
				const all = getAllAtoms(idx);
				// 1. archived filter
				const archivedMode = String(req.query.archived ?? "active");
				let filtered: MemoryAtom[] = archivedMode === "all"
					? all
					: all.filter((a) => (archivedMode === "archived" ? a.archived : !a.archived));
				// 2. type 多选 (?type=preference,workflow)
				if (req.query.type) {
					const types = String(req.query.type).split(",").map((s) => s.trim()).filter(Boolean);
					if (types.length > 0) {
						filtered = filtered.filter((a) => types.includes(a.type));
					}
				}
				// 3. tag 单选 (?tag=foo)
				if (req.query.tag) {
					const tag = String(req.query.tag);
					filtered = filtered.filter((a) => a.tags.includes(tag));
				}
				// 4. q 搜 title + summary (?q=foo, case-insensitive)
				if (req.query.q) {
					const q = String(req.query.q).toLowerCase();
					filtered = filtered.filter((a) =>
						a.title.toLowerCase().includes(q) || a.summary.toLowerCase().includes(q),
					);
				}
				// 5. sort (updated_at desc, fallback to created_at)
				filtered.sort((a, b) => {
					const ad = a.updated_at || a.created_at;
					const bd = b.updated_at || b.created_at;
					return bd.localeCompare(ad);
				});
				// 6. limit / offset
				const limit = Math.min(Number(req.query.limit ?? 200), 1000);
				const offset = Number(req.query.offset ?? 0);
				const paged = filtered.slice(offset, offset + limit);
				res.json(paged);
			} finally {
				idx.close();
			}
		} catch (err) {
			console.error("[memory list] error:", err);
			res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
		}
	});
	// /api/memory/stats must register BEFORE /api/memory/:id — Express matches in
	// declaration order, otherwise :id swallows "stats" and returns 404.
	app.get("/api/memory/stats", (_req, res) => res.status(501).json({ error: "not implemented" }));
	app.get("/api/memory/:id", async (req, res) => {
		try {
			const idx = new MemoryIndex(deps.dbPath);
			await idx.init();
			try {
				const id = req.params.id;
				// MemoryIndex has no public getAtom; use getAllAtoms (mirrors getAllAtoms
				// approach: getAllRows + rowToAtom), returns all atoms including archived.
				const all = getAllAtoms(idx);
				const existing = all.find((a) => a.id === id);
				if (!existing) {
					res.status(404).json({ error: `atom not found: ${id}` });
					return;
				}
				// Read .md body. Missing file / hash mismatch → content = "" (no 500).
				if (existing.file_path) {
					try {
						const fromFile = readAtomFromFile(existing.file_path, existing.content_hash || undefined);
						if (fromFile) {
							existing.content = fromFile.content;
						} else {
							existing.content = ""; // file missing
						}
					} catch {
						existing.content = ""; // hash mismatch or other read error
					}
				} else {
					existing.content = "";
				}
				res.json(existing);
			} finally {
				idx.close();
			}
		} catch (err) {
			console.error("[memory get] error:", err);
			res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
		}
	});
	// (2.6) POST /api/memory/search — real search pipeline. Per design Decisions 2
	// & 4: rewriteQueryWithCallLlm + searchAtomsWithScores (no ExtensionContext
	// stub). Forwards deps.settings to searchAtomsWithScores so the server's
	// settings drive embedding config rather than the dev's
	// ~/.pi/agent/settings.json (task 1.5b plumbing). callLlm throws are
	// absorbed inside rewriteQueryWithCallLlm (falls back to
	// simpleKeywordExtraction), so this endpoint never returns 500 because of
	// a transient LLM failure.
	app.post("/api/memory/search", async (req, res) => {
		try {
			const body = (req.body ?? {}) as { query?: string; topK?: number };
			const query = body.query ?? "";
			const topK = body.topK ?? 10;
			if (!query) {
				res.status(400).json({ error: "query required" });
				return;
			}
			const idx = new MemoryIndex(deps.dbPath);
			await idx.init();
			try {
				// 1. rewrite query via LLM (降级到 simpleKeywordExtraction on error)
				const rewritten = await rewriteQueryWithCallLlm(
					deps.callLlm,
					query,
					deps.settings,
				);
				// 2. search with scores
				const { results, embedding_available } = await searchAtomsWithScores(
					idx,
					rewritten,
					topK,
					deps.settings,
				);
				res.json({ rewritten, embedding_available, results });
			} finally {
				idx.close();
			}
		} catch (err) {
			console.error("[memory search] error:", err);
			res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
		}
	});
}