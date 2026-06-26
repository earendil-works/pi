import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runDecay } from "../decay.ts";
import { MemoryIndex } from "../storage.ts";
import type { MemoryAtom } from "../types.ts";

describe("runDecay", () => {
	let index: MemoryIndex;
	let tmpDir: string;
	let dbPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "decay-test-"));
		dbPath = path.join(tmpDir, "memory.db");
		index = new MemoryIndex(dbPath);
		await index.init();
	});

	afterEach(async () => {
		index.close();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	const sampleAtom = (overrides: Partial<MemoryAtom> = {}): MemoryAtom => ({
		id: crypto.randomUUID(),
		type: "rule",
		title: "T",
		content: "C",
		summary: "S",
		tags: [],
		importance: 0.5,
		strength: 0.5,
		access_count: 0,
		version: 1,
		is_latest: 1,
		parent_id: null,
		superseded_at: null,
		archived: 0,
		created_at: Date.now(),
		updated_at: Date.now(),
		last_access: Date.now(),
		content_fingerprint: "fp-" + Math.random().toString(36).slice(2, 18),
		source_session: null,
		...overrides,
	});

	const insertAtom = async (atom: MemoryAtom) => {
		await index.insertAtom(atom, new Array(1024).fill(0.01));
	};

	it("computes new strength with exp decay formula", async () => {
		const a = sampleAtom({ strength: 1.0, importance: 0.5, last_access: Date.now() - 100 * 24 * 60 * 60 * 1000 });
		await insertAtom(a);
		const result = await runDecay(index, { baseDecay: 0.05 });
		expect(result.decayed).toBe(1);
		const got = index.getAtom(a.id);
		expect(got!.strength).toBeLessThan(1.0); // decayed
	});

	it("never archives rule type even at low strength", async () => {
		const rule = sampleAtom({ type: "rule", strength: 0.01, importance: 0.01, last_access: Date.now() - 1000 * 24 * 60 * 60 * 1000 });
		await insertAtom(rule);
		const result = await runDecay(index, { archiveThreshold: 0.1 });
		expect(result.archived).not.toContain(rule.id);
		expect(index.getAtom(rule.id)?.archived).toBe(0);
	});

	it("archives fact with strength below threshold", async () => {
		const fact = sampleAtom({ type: "fact", strength: 0.05, importance: 0.01, last_access: Date.now() - 1000 * 24 * 60 * 60 * 1000 });
		await insertAtom(fact);
		const result = await runDecay(index, { archiveThreshold: 0.1 });
		expect(result.archived).toContain(fact.id);
		expect(index.getAtom(fact.id)?.archived).toBe(1);
	});

	it("archives process with strength below threshold", async () => {
		const proc = sampleAtom({ type: "process", strength: 0.05, importance: 0.01, last_access: Date.now() - 1000 * 24 * 60 * 60 * 1000 });
		await insertAtom(proc);
		const result = await runDecay(index, { archiveThreshold: 0.1 });
		expect(result.archived).toContain(proc.id);
	});

	it("does NOT archive fact with strength above threshold", async () => {
		const fact = sampleAtom({ type: "fact", strength: 0.5, importance: 0.8, last_access: Date.now() - 5 * 24 * 60 * 60 * 1000 });
		await insertAtom(fact);
		const result = await runDecay(index, { archiveThreshold: 0.1 });
		expect(result.archived).not.toContain(fact.id);
	});

	it("deletes vector when archiving", async () => {
		const fact = sampleAtom({ type: "fact", strength: 0.01, importance: 0.01, last_access: Date.now() - 1000 * 24 * 60 * 60 * 1000 });
		await insertAtom(fact);
		const before = index.getRawDb().prepare(`SELECT 1 FROM memory_vectors WHERE id = ?`).get(fact.id);
		expect(before).toBeDefined();

		await runDecay(index, { archiveThreshold: 0.1 });

		const after = index.getRawDb().prepare(`SELECT 1 FROM memory_vectors WHERE id = ?`).get(fact.id);
		expect(after).toBeUndefined();
	});

	it("skips atoms accessed within last hour", async () => {
		const a = sampleAtom({ last_access: Date.now() - 30 * 60 * 1000 }); // 30 min ago
		await insertAtom(a);
		const result = await runDecay(index);
		expect(result.skipped).toBe(1);
		expect(index.getAtom(a.id)?.strength).toBe(a.strength); // unchanged
	});

	// Regression: multiple decay runs (one per process / session_start)
	// must NOT compound. Without the fix, each run multiplies strength by
	// the same factor (since last_access isn't updated), giving
	// strength = factor^N after N runs — atoms archive in days instead
	// of months. Fix: each decay run stamps last_access = now so the
	// next run uses a fresh delta (the time since the last decay).
	it("does not compound strength across multiple decay runs (regression)", async () => {
		// Atom created 0.989 days ago, importance=0.6, baseDecay=0.025.
		// Single decay run: factor = exp(-0.0253 * 0.989 / 0.6) = 0.959.
		// Without the fix, 30 sequential runs give 0.959^30 = 0.291
		// (the value observed in the user DB for a 1-day-old atom).
		// With the fix, all 30 runs collapse to one effective run:
		// strength should stay near 0.959 (not decay to 0.291).
		const a = sampleAtom({
			importance: 0.6,
			strength: 1.0,
			last_access: null, // never recalled → uses created_at
			created_at: Date.now() - 0.989 * 24 * 60 * 60 * 1000,
		});
		await insertAtom(a);

		// First decay run: should set strength to ~0.959 and stamp last_access.
		const r1 = await runDecay(index, { baseDecay: 0.025 });
		expect(r1.decayed).toBe(1);
		const after1 = index.getAtom(a.id)!;
		const strengthAfter1 = after1.strength;
		expect(strengthAfter1).toBeGreaterThan(0.95);
		expect(strengthAfter1).toBeLessThan(0.97);
		// Fix: last_access must be set after decay so subsequent runs
		// use a fresh delta (instead of reusing created_at).
		expect(after1.last_access).not.toBeNull();
		expect(after1.last_access!).toBeGreaterThan(Date.now() - 1000);

		// Subsequent runs within 1 hour of last decay must be skipped
		// (no compounding), per the existing 1-hour throttle rule.
		// `last_access` is now set to ~now, so delta < 1/24 day → skip.
		const r2 = await runDecay(index, { baseDecay: 0.025 });
		expect(r2.skipped).toBe(1);
		expect(r2.decayed).toBe(0);
		expect(index.getAtom(a.id)!.strength).toBeCloseTo(strengthAfter1, 10);
	});
});