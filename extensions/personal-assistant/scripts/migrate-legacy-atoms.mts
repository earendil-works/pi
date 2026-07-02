#!/usr/bin/env tsx
// One-shot legacy atom migration script.
//
// Walks the active atom corpus and applies a cosine-similarity dedup pass
// using the public MemoryIndex API. The first long-form writeup of why
// this script exists lives at docs/sdd/changes/atom-remigrate/design.md
// (R1 — "Legacy Atom Migration Script"). The high-level flow:
//
//   1. Resolve dbPath / atomsDir from config (fall back to defaults).
//   2. Copy the live db to a date-stamped backup. Abort loudly if the
//      copy fails — the dedup pass is destructive and a stale backup
//      is the only rollback path.
//   3. Open the index, run the SQL-sorted active-atom sweep, dedup hits
//      that clear the cosine threshold, write a JSON report, close.
//
// The script is **idempotent by design** (L34-40): once the first run
// marks the losers as `is_latest = 0`, subsequent runs see only
// canonical atoms and the dedup loop is a no-op. Re-running it is the
// recommended way to confirm a previous run finished cleanly.
//
// CLI:
//   --threshold=N  cosine threshold for dedup (default 0.65, range 0-1)
//   --help, -h     print usage and exit
//
// The real-migration path (corpus, real embeddings, idempotency) is
// exercised by tests/test/migration.test.ts (Task 2.5). This file's
// vitest suite under scripts/__tests__/ only covers the pure helpers
// (parseArgs / printUsage) — touching the live db from a unit test
// would race with the user's actual memory.db.

import { copyFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MemoryIndex } from "../storage.ts";
import {
	DEFAULT_ATOMS_DIR,
	DEFAULT_DB_PATH,
	loadConfig,
} from "../memory.ts";
import { rowToAtom, type MemoryAtomRow } from "../types.ts";

/** Cosine-similarity threshold for the dedup pass (L5-14).
 *  0.65 is the empirically-derived value from the design doc; we keep
 *  it as the script default so an invocation with no flags behaves
 *  identically to the original hand-rolled migration run. */
const DEFAULT_THRESHOLD = 0.65;

/** Path of the JSON report (one level up from atomsDir so it sits next
 *  to memory.db rather than inside the per-atom file store). */
const REPORT_FILENAME = "migrate-report.json";

/** Shape of migrate-report.json. Kept narrow on purpose — adding fields
 *  is a breaking change for any consumer parsing the file downstream. */
export interface MigrationReport {
	timestamp: string;
	totalActiveAtoms: number;
	archivedCount: number;
	unchangedCount: number;
	backupPath: string;
	threshold: number;
}

/** Parse the script's CLI. `argv` is `process.argv`; the leading
 *  `node` / `tsx` and the script path are skipped (matches
 *  `process.argv.slice(2)` semantics). Exported so the unit test can
 *  exercise it without spawning a child process. */
export function parseArgs(argv: string[]): { threshold: number; help: boolean } {
	let threshold = DEFAULT_THRESHOLD;
	let help = false;
	// Skip the first two slots (node binary + script path) to match the
	// `process.argv.slice(2)` contract the script uses at the call site.
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg.startsWith("--threshold=")) {
			const raw = arg.slice("--threshold=".length);
			const parsed = Number.parseFloat(raw);
			if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
				throw new Error(`Invalid threshold: ${arg}`);
			}
			threshold = parsed;
		}
		// Unknown flags are silently ignored — keeps the script friendly
		// to a stray `--no-warnings` / shell completion artifact without
		// surfacing a hard error for what is essentially a no-op.
	}
	return { threshold, help };
}

/** Print the usage banner. Pure stdout — no side effects beyond the
 *  console.log. Exported for the same reason as parseArgs. */
export function printUsage(): void {
	console.log(`Usage: npx tsx scripts/migrate-legacy-atoms.mts [options]

Options:
  --threshold=N    Cosine similarity threshold for dedup (default: 0.65, range 0-1)
  --help, -h       Show this help

This script performs one-time 0.65-cosine deduplication of legacy atoms.
Re-running is safe (idempotent): a second run produces 0 changes because
the first run already marked losers as is_latest = 0.
`);
}

/** Build YYYYMMDD from the current local-time date. Local time on
 *  purpose: the user thinks in local time, so the suffix on the
 *  backup file should match their wall clock (S108-112). */
function yyyymmddLocal(now: Date): string {
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}${m}${d}`;
}

async function main(): Promise<void> {
	const { threshold, help } = parseArgs(process.argv);
	if (help) {
		printUsage();
		return;
	}

	// 1. Resolve paths. `loadConfig` returns {} on any failure (missing
	//    file, bad JSON, etc.) so we only need to handle the case where
	//    the user has overridden dbPath / atomsDir via settings.json.
	const config = loadConfig();
	const dbPath = config.memory?.dbPath ?? DEFAULT_DB_PATH;
	const atomsDir = config.memory?.atomsDir ?? DEFAULT_ATOMS_DIR;

	// 2. Backup. Use copyFile (not move) so a failed migration leaves
	//    the live db untouched. A copy failure aborts loudly per L108-112.
	const now = new Date();
	const backupPath = `${dbPath}.bak.${yyyymmddLocal(now)}`;
	try {
		await copyFile(dbPath, backupPath);
	} catch (err) {
		// We deliberately preserve the original error message in the
		// thrown error so the operator can diagnose (permissions, ENOENT
		// when the db has never been created, ENOSPC, etc.) without
		// having to re-run the script with strace.
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`backup failed, refusing to migrate: ${detail}`);
	}
	console.log(`backup: ${dbPath} → ${backupPath}`);

	// 3. Open index. `init()` is a no-op async hook reserved for future
	//    schema migrations; awaiting it keeps the call shape forward-
	//    compatible.
	const index = new MemoryIndex(dbPath);
	await index.init();

	try {
		// 4. Snapshot the active corpus for the report's `totalActiveAtoms`
		//    counter. We do the actual iteration via a separate SQL sort
		//    below (see step 5) so the counter and the iteration order
		//    stay decoupled.
		const active = index.getActiveAtoms();
		console.log(
			`found ${active.length} active atoms (db has N total, N-${active.length} are archived/superseded)`,
		);

		// 5. SQL-sorted iteration. We push the ordering into SQLite
		//    instead of sorting in JS so the script scales to large
		//    corpora (5k+ atoms) without an intermediate in-memory copy.
		//    The NULLS-LAST semantics are expressed via COALESCE since
		//    SQLite's NULLS clause isn't available in the project's
		//    pinned better-sqlite3 / sqlite-vec build.
		const stmt = index.getRawDb().prepare(`
			SELECT * FROM memory_index
			WHERE is_latest = 1 AND archived = 0
			ORDER BY access_count DESC, COALESCE(last_access, 0) DESC, created_at DESC
		`);
		const rows = stmt.all() as MemoryAtomRow[];
		const sorted = rows.map(rowToAtom);

		// 6. Dedup loop. We keep the higher-ranked atom (the one
		//    currently being visited — sorted by access_count DESC first)
		//    and mark the lower-ranked hit as superseded. Idempotent
		//    because the second pass sees only canonical atoms.
		let archivedCount = 0;
		let unchangedCount = 0;
		for (const atom of sorted) {
			const embedding = index.getEmbedding(atom.id);
			if (!embedding) {
				// Atoms without a vector row are skipped silently. This
				// shouldn't happen for active atoms (insertAtom always
				// writes the vector), but we don't want a missing blob
				// to abort the whole migration.
				unchangedCount++;
				continue;
			}
			const hit = index.findMostSimilarEmbedding(embedding, threshold);
			if (hit && hit.atom.id !== atom.id) {
				index.markSupersededNoInsert(hit.atom.id, atom.id, Date.now());
				archivedCount++;
			} else {
				unchangedCount++;
			}
		}

		// 7. Persist the report. Sibling of memory.db (parent of atomsDir)
		//    so it lives next to the data it describes rather than inside
		//    the per-atom file store.
		const report: MigrationReport = {
			timestamp: now.toISOString(),
			totalActiveAtoms: active.length,
			archivedCount,
			unchangedCount,
			backupPath,
			threshold,
		};
		const reportPath = join(atomsDir, "..", REPORT_FILENAME);
		writeFileSync(reportPath, JSON.stringify(report, null, 2));
		console.log(
			`migration done: ${active.length} → ${active.length - archivedCount} active (archived ${archivedCount}). Re-run idempotent.`,
		);
		console.log(`report: ${reportPath}`);
	} finally {
		// 8. Always close — even on error, the index holds a WAL file
		//    open and leaking it would block the next migration attempt.
		index.close();
	}
}

// Only auto-run main() when this file is the program entry point
// (tsx / node). When vitest imports the file to exercise parseArgs /
// printUsage, `process.argv[1]` is the vitest binary, not this file,
// and the comparison fails — so the test suite never accidentally
// triggers the destructive migration against the user's live db.
const isDirectInvocation =
	process.argv[1] !== undefined &&
	pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectInvocation) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
