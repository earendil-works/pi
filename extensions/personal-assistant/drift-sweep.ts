// drift-sweep.ts — periodic .md ↔ DB drift detection.
//
// The tool_result hook in memory.ts catches write/edit drift when the
// agent uses those tools. But the agent (or any other process) can
// still drift an atom .md file via `bash` (sed, vi, redirect),
// `write` from a different extension, or manual edit. Without a
// detection sweep, the vector stays stale until the next extraction
// run eventually regenerates the atom (which may not happen for
// months).
//
// The sweep walks the configured atomsDir, parses each .md, recomputes
// the content fingerprint from the on-disk body, and compares it to
// the DB's content_fingerprint. Mismatch = body was modified outside
// the extraction pipeline = vector is stale. The fix is to call
// reindexOne on the bge-m3 service, which produces a fresh vector
// from the new body.
//
// Throttle: the sweep is best-effort. A bge-m3 outage means some
// drifted atoms stay stale until the next sweep — but the DB
// content row is untouched (we never modify the DB from here), so
// the worst case is a temporarily stale vector, never a corrupted
// row.
//
// Performance: 56 atoms × ~5ms each = 280ms to walk. bge-m3 reindex
// per drifted atom is ~3s (GPU FP16) so we batch sequential — the
// sweep is intentionally not parallel; bge-m3 is single-worker.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MemoryIndex } from "./storage.ts";
import { computeFingerprint } from "./extraction.ts";

export interface DriftSweepStats {
	checked: number;
	drifted: number;
	reindexed: number;
	failed: number;
	errors: string[];
}

/**
 * Walk atomsDir, find .md files whose body fingerprint doesn't match the
 * DB's content_fingerprint, and call reindexOne for each. Returns stats
 * so the caller can log a summary.
 *
 * @param atomsDir absolute path to the atom file directory
 *                 (e.g. ~/.pi/agent/memory/atoms)
 * @param db       open MemoryIndex (caller is responsible for init+close)
 */
export async function runDriftSweep(
	atomsDir: string,
	db: MemoryIndex,
): Promise<DriftSweepStats> {
	const stats: DriftSweepStats = {
		checked: 0,
		drifted: 0,
		reindexed: 0,
		failed: 0,
		errors: [],
	};

	// Lazy-import reindexOne so this module's cold-start cost is just
	// the file-walk + DB read, not the bge-m3 client. Mirrors the
	// pattern in memory.ts.
	let reindexOne: ((id: string) => Promise<{ ok: boolean; error?: string }>) | undefined;
	try {
		({ reindexOne } = await import("./bge-reindex.ts"));
	} catch (err) {
		// Failure to import is permanent (missing module) — return early.
		stats.errors.push(`reindexOne import: ${(err as Error).message}`);
		return stats;
	}

	const filePaths = collectAtomFiles(atomsDir);
	for (const filePath of filePaths) {
		stats.checked++;
		try {
			const drift = await checkAndReindex(filePath, db, reindexOne);
			if (drift === "drift") stats.drifted++;
			else if (drift === "ok") {
				/* in sync */
			} else if (drift === "reindexed") {
				stats.drifted++;
				stats.reindexed++;
			} else if (drift === "failed") {
				stats.drifted++;
				stats.failed++;
			}
		} catch (err) {
			stats.errors.push(`${filePath}: ${(err as Error).message}`);
		}
	}
	return stats;
}

type FileResult = "ok" | "drift" | "reindexed" | "failed";

/**
 * Per-file: parse, recompute fingerprint, compare with DB, optionally
 * reindex. Returns the result kind so the caller can update stats.
 *
 * Sync: returns "drift" without reindexing if reindexOne was not
 * provided (e.g. import failed at the top-level).
 */
async function checkAndReindex(
	filePath: string,
	db: MemoryIndex,
	reindexOne: (id: string) => Promise<{ ok: boolean; error?: string }>,
): Promise<FileResult> {
	const raw = readFileSync(filePath, "utf8");
	const parsed = splitFrontmatter(raw);
	if (!parsed) return "ok"; // malformed — skip silently; extraction pipeline owns this

	const { id, body, storedFingerprint } = parsed;
	if (!id) return "ok";

	const currentFingerprint = computeFingerprint(body);

	// 1. Self-consistency: does the frontmatter's content_fingerprint
	//    match the body? If not, the file was hand-edited but the
	//    frontmatter was not updated. Either way, the body's
	//    fingerprint is the source of truth — compare it to the DB.
	if (storedFingerprint && storedFingerprint !== currentFingerprint) {
		// Frontmatter says one thing, body says another. Trust the
		// body (it's what the agent reads and what bge-m3 will encode).
	}

	// 2. DB vs body: this is the canonical drift check.
	const dbAtom = db.getAtom(id);
	if (!dbAtom) {
		// .md file exists but DB doesn't have this atom. The
		// extraction pipeline always writes both; if one is missing,
		// something else created the file. Reindex anyway so the
		// vector is at least consistent with the .md.
		const res = await reindexOne(id);
		return res.ok ? "reindexed" : "failed";
	}
	if (dbAtom.content_fingerprint === currentFingerprint) {
		return "ok";
	}

	// 3. Drifted: DB fingerprint doesn't match body. Reindex.
	const res = await reindexOne(id);
	return res.ok ? "reindexed" : "failed";
}

// ---------------------------------------------------------------------------
// Frontmatter parsing (lightweight, .md-only — no nested structures)
// ---------------------------------------------------------------------------

interface ParsedFrontmatter {
	id: string | null;
	body: string;
	storedFingerprint: string | null;
}

/**
 * Split a .md file into (id, body, storedFingerprint). The .md format
 * is documented in file-store.ts writeAtomToFile:
 *
 *   ---
 *   key: value
 *   key2: value2
 *   ---
 *
 *   <body>
 *
 * The frontmatter is intentionally trivial — no nested structures
 * beyond the tags array. We only need `id` and `content_fingerprint`
 * for the drift check, so we don't bother parsing the rest.
 */
function splitFrontmatter(raw: string): ParsedFrontmatter | null {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return null;
	const [, frontmatterBlock, body] = match;
	if (!frontmatterBlock || body === undefined) return null;

	const id = extractFrontmatterField(frontmatterBlock, "id");
	const storedFingerprint = extractFrontmatterField(
		frontmatterBlock,
		"content_fingerprint",
	);
	return { id, body, storedFingerprint };
}

function extractFrontmatterField(block: string, field: string): string | null {
	// Simple regex: match the field at line start, capture the value
	// (which may be quoted with "..." — strip the quotes).
	const re = new RegExp(`^${field}:\\s*(.*)$`, "m");
	const m = block.match(re);
	if (!m) return null;
	const raw = (m[1] ?? "").trim();
	if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
		return raw.slice(1, -1);
	}
	return raw || null;
}

// ---------------------------------------------------------------------------
// Filesystem walk
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .md files under `dir`. The atomsDir layout
 * is `${atomsDir}/${type}/${id}.md` with type ∈ {rule, fact, process},
 * but we walk generically so future type additions don't need code
 * changes.
 */
function collectAtomFiles(dir: string): string[] {
	const out: string[] = [];
	walk(dir, out);
	return out;
}

function walk(dir: string, out: string[]): void {
	let names: string[];
	try {
		names = readdirSync(dir) as unknown as string[];
	} catch {
		// atomsDir doesn't exist yet — nothing to sweep.
		return;
	}
	for (const name of names) {
		const full = join(dir, name);
		let s: ReturnType<typeof statSync>;
		try {
			s = statSync(full);
		} catch {
			continue;
		}
		if (s.isDirectory()) {
			walk(full, out);
		} else if (s.isFile() && name.endsWith(".md")) {
			out.push(full);
		}
	}
}
