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

// PATCH whitelist — keys outside this set are silently dropped so clients cannot override id, created_at, file_path, content_hash, strength, access_count, last_access, version, or archived.
const PATCHABLE_FIELDS = [
	"title",
	"type",
	"summary",
	"tags",
	"importance",
	"content",
] as const;

type PatchableKey = (typeof PATCHABLE_FIELDS)[number];

function pickPatchable(body: unknown): Partial<Pick<MemoryAtom, PatchableKey>> {
	if (typeof body !== "object" || body === null) return {};
	const out: Partial<Pick<MemoryAtom, PatchableKey>> = {};
	for (const k of PATCHABLE_FIELDS) {
		if (k in body) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(out as any)[k] = (body as Record<string, unknown>)[k];
		}
	}
	return out;
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
	// (2.7) GET /api/memory/stats — lightweight sqlite-only aggregate. Reads only
	// the index (no .md bodies). byType is dynamic Record<string, number> (no
	// fixed 7-type key set). archived counter is exposed alongside total so the
	// UI can derive active = total - archived without a second query.
	app.get("/api/memory/stats", async (_req, res) => {
		try {
			const idx = new MemoryIndex(deps.dbPath);
			await idx.init();
			try {
				const all = getAllAtoms(idx);
				const byType: Record<string, number> = {};
				let archivedCount = 0;
				for (const a of all) {
					byType[a.type] = (byType[a.type] ?? 0) + 1;
					if (a.archived) archivedCount++;
				}
				res.json({ total: all.length, archived: archivedCount, byType });
			} finally {
				idx.close();
			}
		} catch (err) {
			console.error("[memory stats] error:", err);
			res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
		}
	});
	app.get("/api/memory/:id", async (req, res) => {
		try {
			const idx = new MemoryIndex(deps.dbPath);
			await idx.init();
			try {
				const id = req.params.id;
				const existing = idx.getAtom(id);
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
	app.patch("/api/memory/:id", async (req, res) => {
		try {
			const idx = new MemoryIndex(deps.dbPath);
			await idx.init();
			try {
				const id = req.params.id;
				const existing = idx.getAtom(id);
				if (!existing) {
					res.status(404).json({ error: `atom not found: ${id}` });
					return;
				}
				// 1. 读 currentBody (file 丢失 / hash 错位 → "")
				let currentBody = "";
				if (existing.file_path) {
					try {
						const fromFile = readAtomFromFile(existing.file_path, existing.content_hash);
						if (fromFile) currentBody = fromFile.content;
					} catch {
						currentBody = "";
					}
				}
				// 2. merge: 仅 PATCHABLE_FIELDS 覆盖; content 默认 currentBody; version + 1; updated_at = now
				const body = pickPatchable(req.body);
				const merged: MemoryAtom = {
					...existing,
					...body,
					content: body.content ?? currentBody,
					version: existing.version + 1,
					updated_at: new Date().toISOString(),
					file_path: "", // 待写后填
					content_hash: "", // 待写后填
				};
				// 3. 写 .md 文件 (原子写: tmp → rename)
				const { filePath: newPath, contentHash: newHash } = writeAtomToFile(merged, deps.atomsDir);
				// 4. 旧路径不同则 unlink (e.g. type 改变 → path 变 → 旧文件 unlink)
				if (existing.file_path && existing.file_path !== newPath) {
					try {
						unlinkSync(existing.file_path);
					} catch {
						// 旧文件已丢失, 不阻断
					}
				}
				// 5. 填 file_path / content_hash
				merged.file_path = newPath;
				merged.content_hash = newHash;
				// 6. upsert 到 db + 清 embedding (v2 lazy recompute)
				idx.upsertAtom(merged);
				idx.invalidateEmbedding(merged.id);
				res.json(merged);
			} finally {
				idx.close();
			}
		} catch (err) {
			console.error("[memory patch] error:", err);
			res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
		}
	});
	app.post("/api/memory/:id/archive", async (req, res) => {
		try {
			const idx = new MemoryIndex(deps.dbPath);
			await idx.init();
			try {
				const id = req.params.id;
				const existing = idx.getAtom(id);
				if (!existing) {
					res.status(404).json({ error: `atom not found: ${id}` });
					return;
				}
				const archived = (req.body as { archived?: boolean })?.archived ?? !existing.archived;
				const updated: MemoryAtom = {
					...existing,
					archived,
					version: existing.version + 1,
					updated_at: new Date().toISOString(),
				};
				idx.upsertAtom(updated);
				idx.invalidateEmbedding(id);
				const after = idx.getAtom(id)!;
				res.json({ ok: true, atom: after });
			} finally {
				idx.close();
			}
		} catch (err) {
			console.error("[memory archive] error:", err);
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