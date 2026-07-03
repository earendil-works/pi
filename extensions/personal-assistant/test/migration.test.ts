import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { MemoryIndex } from "../storage.ts";
import type { MemoryAtom } from "../types.ts";

let tmpDir: string;
let index: MemoryIndex;
const DIM = 1024;

function makeAtom(tags: string[], content: string): MemoryAtom {
	const id = randomUUID();
	const fp = id.replace(/-/g, "").slice(0, 16);
	const now = Date.now();
	return {
		id,
		type: "fact",
		title: "test " + id,
		content,
		summary: "test summary",
		tags,
		importance: 0.5,
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
		content_fingerprint: fp,
		source_session: null,
	};
}

function makeVec(dominant: number): number[] {
	const arr = new Array(DIM).fill(0);
	arr[0] = dominant;
	arr[1] = Math.sqrt(Math.max(0, 1 - dominant * dominant));
	return arr;
}

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "migration-test-"));
	index = new MemoryIndex(path.join(tmpDir, "test.db"));
	await index.init();
});

afterEach(async () => {
	index.close();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("markSupersededNoInsert", () => {
	it("marks loser with is_latest=0, parent_id=winner, superseded_at=now", async () => {
		const winner = makeAtom(["a"], "winner content");
		const loser = makeAtom(["b"], "loser content");
		await index.insertAtom(winner, makeVec(1.0));
		await index.insertAtom(loser, makeVec(0.5));

		const now = Date.now();
		const updated = index.markSupersededNoInsert(loser.id, winner.id, now);

		expect(updated.is_latest).toBe(0);
		expect(updated.parent_id).toBe(winner.id);
		expect(updated.superseded_at).toBe(now);
	});

	it("leaves winner unchanged", async () => {
		const winner = makeAtom(["a"], "winner content");
		const loser = makeAtom(["b"], "loser content");
		await index.insertAtom(winner, makeVec(1.0));
		await index.insertAtom(loser, makeVec(0.5));

		const winnerBefore = index.getAtom(winner.id);
		const now = Date.now();
		index.markSupersededNoInsert(loser.id, winner.id, now);
		const winnerAfter = index.getAtom(winner.id);

		expect(winnerAfter).toEqual(winnerBefore);
	});

	it("does not delete loser's vector (memory_vectors row preserved)", async () => {
		const winner = makeAtom(["a"], "winner content");
		const loser = makeAtom(["b"], "loser content");
		await index.insertAtom(winner, makeVec(1.0));
		await index.insertAtom(loser, makeVec(0.5));

		const now = Date.now();
		index.markSupersededNoInsert(loser.id, winner.id, now);

		const loserEmbedding = index.getEmbedding(loser.id);
		expect(loserEmbedding).not.toBeNull();
		expect(loserEmbedding!.length).toBe(DIM);
	});

	it("both atoms remain readable via getAtom after markSupersededNoInsert", async () => {
		const winner = makeAtom(["a"], "winner content");
		const loser = makeAtom(["b"], "loser content");
		await index.insertAtom(winner, makeVec(1.0));
		await index.insertAtom(loser, makeVec(0.5));

		const now = Date.now();
		index.markSupersededNoInsert(loser.id, winner.id, now);

		expect(index.getAtom(winner.id)).not.toBeNull();
		expect(index.getAtom(loser.id)).not.toBeNull();
		expect(index.getActiveAtoms().map((a) => a.id)).toEqual([winner.id]); // loser filtered
	});
});

// ---------------------------------------------------------------------------
// Integration tests: spawn migrate-legacy-atoms.mts against a real
// MemoryIndex seeded with a controlled corpus (Task 2.5). Verifies the
// full pipeline that the unit tests above cover piecemeal —
// backup → loop → report, plus end-to-end idempotency.
//
// Each test runs in its own tmpdir so the script never touches the user's
// live memory.db. The seed corpus is 6 atoms:
//   - 2 cluster pairs (cosine ≥ 0.85 between pair members; ≤ 0 across
//     pairs so they don't cross-pollinate)
//   - 2 unique atoms (dense random vectors, well below 0.65 to anyone)
// Lower-access pair members are designed to lose to higher-access ones on
// each iteration, which is what the "natural winner" pick relies on.
// ---------------------------------------------------------------------------

// Resolve at module load. `__dirname` is provided by vitest for ESM tests
// in this codebase (see packages/coding-agent/test/stdout-cleanliness.test.ts
// for the established pattern).
const MIGRATION_SCRIPT = path.resolve(__dirname, "..", "scripts", "migrate-legacy-atoms.mts");
const ROOT_TSCONFIG = path.resolve(__dirname, "..", "..", "..", "tsconfig.json");

describe("migrate-legacy-atoms.mts (integration)", () => {
	let workspace: string;
	let dbPath: string;
	let atomsDir: string;

	/** Insert 6 atoms into the freshly-created `dbPath`. The pair axes
	 *  are 30° apart so cos ≈ 0.866 (well above the 0.65 threshold),
	 *  and pairs live in different quadrants so cos across pairs is 0
	 *  or negative (no cross-pollination). */
	async function seedCorpus(): Promise<void> {
		const idx = new MemoryIndex(dbPath);
		await idx.init();

		const DIM = 1024;
		const angled = (angleDeg: number): number[] => {
			const rad = (angleDeg * Math.PI) / 180;
			const arr = new Array(DIM).fill(0);
			arr[0] = Math.cos(rad);
			arr[1] = Math.sin(rad);
			return arr;
		};
		const dense = (seed: number): number[] => {
			const arr = new Array(DIM).fill(0);
			let s = seed;
			for (let i = 0; i < DIM; i++) {
				s = (s * 1103515245 + 12345) & 0x7fffffff;
				arr[i] = (s / 0x7fffffff) * 2 - 1;
			}
			const norm = Math.sqrt(arr.reduce((sum, v) => sum + v * v, 0));
			return arr.map((v) => v / norm);
		};

		const baseTime = Date.now();
		// Access counts ordered so the migration's sort by access_count
		// DESC, last_access DESC, created_at DESC produces a clean
		// [a1, b1, a2, b2, x, y] order — i.e. each pair's higher-ranked
		// winner comes before its pair mate.
		const fixture: Array<{
			id: string;
			vec: number[];
			access_count: number;
			last_access: number | null;
			created_at: number;
		}> = [
			{ id: "a1", vec: angled(0), access_count: 100, last_access: baseTime, created_at: baseTime },
			{ id: "b1", vec: angled(90), access_count: 80, last_access: baseTime - 500, created_at: baseTime + 100 },
			{ id: "a2", vec: angled(30), access_count: 10, last_access: null, created_at: baseTime + 200 },
			{ id: "b2", vec: angled(120), access_count: 5, last_access: null, created_at: baseTime + 300 },
			{ id: "x", vec: dense(50), access_count: 3, last_access: baseTime - 2000, created_at: baseTime + 400 },
			{ id: "y", vec: dense(60), access_count: 1, last_access: null, created_at: baseTime + 500 },
		];

		for (const a of fixture) {
			await idx.insertAtom(
				{
					id: a.id,
					type: "fact",
					title: a.id,
					content: a.id,
					summary: "s",
					tags: ["x"],
					importance: 0.5,
					strength: 1.0,
					access_count: a.access_count,
					version: 1,
					is_latest: 1,
					parent_id: null,
					superseded_at: null,
					archived: 0,
					created_at: a.created_at,
					updated_at: a.created_at,
					last_access: a.last_access,
					content_fingerprint: "fp" + a.id,
					source_session: null,
				},
				a.vec,
			);
		}
		idx.close();
	}

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), "migration-int-"));
		dbPath = path.join(workspace, "memory.db");
		atomsDir = path.join(workspace, "atoms");
		await fs.mkdir(atomsDir, { recursive: true });
		await seedCorpus();
	});

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true });
	});

	/** Run the migration script against the seeded `dbPath`. Uses
	 *  `spawnSync` so we can assert on the exact exit code + stdout /
	 *  stderr text in a single round-trip. The two env vars must
	 *  override whatever `loadConfig()` would otherwise return so the
	 *  script never touches the user's real memory.db. */
	function runScript(): { status: number; stdout: string; stderr: string } {
		const result = spawnSync("npx", ["tsx", MIGRATION_SCRIPT], {
			env: {
				...process.env,
				PERSONAL_ASSISTANT_DB_PATH: dbPath,
				PERSONAL_ASSISTANT_ATOMS_DIR: atomsDir,
				TSX_TSCONFIG_PATH: ROOT_TSCONFIG,
			},
			encoding: "utf-8",
		});
		return {
			status: result.status ?? -1,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
		};
	}

	it("creates backup file with .bak.YYYYMMDD suffix", () => {
		const { status, stdout, stderr } = runScript();
		if (status !== 0) {
			throw new Error(`script failed: ${stderr || stdout}`);
		}
		expect(status).toBe(0);

		const now = new Date();
		const yyyymmdd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
		const backupPath = `${dbPath}.bak.${yyyymmdd}`;
		expect(existsSync(backupPath)).toBe(true);
		// Sanity: the backup is byte-identical (it's the live db snapshot).
		// We don't assert file content equality here (would tie the test
		// to better-sqlite3's exact on-disk format) — file existence is
		// the contract.
	});

	it("archives cluster pair losers (2 cluster pairs → 2 archived)", async () => {
		const { status, stdout, stderr } = runScript();
		if (status !== 0) {
			throw new Error(`script failed: ${stderr || stdout}`);
		}
		expect(status).toBe(0);

		const idx = new MemoryIndex(dbPath);
		await idx.init();
		try {
			const active = idx.getActiveAtoms();
			// 6 atoms → 4 active. The 2 losers are the lower-ranked
			// member of each cluster pair (a2, b2). The other 4
			// (a1, b1, x, y) survive as canonical winners / uniques.
			expect(active.length).toBe(4);
			const activeIds = new Set(active.map((a) => a.id));
			expect(activeIds.has("a1")).toBe(true);
			expect(activeIds.has("b1")).toBe(true);
			expect(activeIds.has("x")).toBe(true);
			expect(activeIds.has("y")).toBe(true);
			expect(activeIds.has("a2")).toBe(false);
			expect(activeIds.has("b2")).toBe(false);
		} finally {
			idx.close();
		}
	});

	it("is idempotent — second run produces 0 changes", () => {
		// First run: archives 2 (per the previous test).
		const first = runScript();
		if (first.status !== 0) {
			throw new Error(`script failed (first run): ${first.stderr || first.stdout}`);
		}

		// Second run: should print "0 changes (idempotent)" or otherwise
		// indicate no new supersedes. We assert on stdout content rather
		// than recursing into the report shape so the test stays decoupled
		// from any reporting wording that isn't part of the spec.
		const second = runScript();
		if (second.status !== 0) {
			throw new Error(`script failed (second run): ${second.stderr || second.stdout}`);
		}
		expect(second.status).toBe(0);
		// The script's report prints `archived 0` on a no-op run —
		// the substring `archived 0` proves the second run was empty.
		expect(second.stdout).toMatch(/archived 0/);
	});
});