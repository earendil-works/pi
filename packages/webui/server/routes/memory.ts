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
	app.get("/api/memory/:id", (_req, res) => res.status(501).json({ error: "not implemented" }));
	app.patch("/api/memory/:id", (_req, res) => res.status(501).json({ error: "not implemented" }));
	app.post("/api/memory/:id/archive", (_req, res) => res.status(501).json({ error: "not implemented" }));
	app.post("/api/memory/search", (_req, res) => res.status(501).json({ error: "not implemented" }));
	app.get("/api/memory/stats", (_req, res) => res.status(501).json({ error: "not implemented" }));
}