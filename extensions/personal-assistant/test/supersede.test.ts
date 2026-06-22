import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { MemoryIndex } from "../storage.ts";
import { executePlan } from "../extraction.ts";
import { writeAtomToFile } from "../file-store.ts";
import type { MemoryAtom, ExtractionItem, ExtractionPlan } from "../types.ts";

describe("supersede signal transfer (comprehensive)", () => {
	let index: MemoryIndex;
	let tmpDir: string;
	let atomsDir: string;
	let dbPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "supersede-test-"));
		atomsDir = path.join(tmpDir, "atoms");
		dbPath = path.join(tmpDir, "memory.db");
		await fs.mkdir(atomsDir, { recursive: true });
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
		strength: 0.7,
		access_count: 3,
		version: 1,
		is_latest: 1,
		parent_id: null,
		superseded_at: null,
		archived: 0,
		created_at: Date.now() - 5000,
		updated_at: Date.now() - 5000,
		last_access: Date.now() - 1000,
		content_fingerprint: "fp-" + Math.random().toString(36).slice(2, 18),
		source_session: null,
		...overrides,
	});

	it("transfers access_count from old to new atom", async () => {
		const old = sampleAtom({ access_count: 15 });
		await index.insertAtom(old, new Array(1024).fill(0.01));
		const newAtom = sampleAtom({ access_count: 0 });
		const { newAtom: result } = index.markSupersededTx(old.id, newAtom, new Array(1024).fill(0.02));
		expect(result.access_count).toBe(15);
	});

	it("transfers strength from old to new atom", async () => {
		const old = sampleAtom({ strength: 0.85 });
		await index.insertAtom(old, new Array(1024).fill(0.01));
		const newAtom = sampleAtom({ strength: 0.2 });
		const { newAtom: result } = index.markSupersededTx(old.id, newAtom, new Array(1024).fill(0.02));
		expect(result.strength).toBeCloseTo(0.85, 5);
	});

	it("transfers created_at from old to new atom (preserves origin)", async () => {
		const oldTime = Date.now() - 1000000;
		const old = sampleAtom({ created_at: oldTime });
		await index.insertAtom(old, new Array(1024).fill(0.01));
		const newAtom = sampleAtom({ created_at: Date.now() });
		const { newAtom: result } = index.markSupersededTx(old.id, newAtom, new Array(1024).fill(0.02));
		expect(result.created_at).toBe(oldTime);
	});

	it("new atom version=1 even if newAtom arg had higher version", async () => {
		const old = sampleAtom();
		await index.insertAtom(old, new Array(1024).fill(0.01));
		const newAtom = sampleAtom({ version: 5 });
		const { newAtom: result } = index.markSupersededTx(old.id, newAtom, new Array(1024).fill(0.02));
		expect(result.version).toBe(1);
	});

	it("new atom importance = max(old.importance, new.importance)", async () => {
		const old = sampleAtom({ importance: 0.8 });
		await index.insertAtom(old, new Array(1024).fill(0.01));

		// new < old: takes old
		const new1 = sampleAtom({ importance: 0.3 });
		const r1 = index.markSupersededTx(old.id, new1, new Array(1024).fill(0.02));
		expect(r1.newAtom.importance).toBeCloseTo(0.8, 5);

		// new > old: takes new
		const old2 = sampleAtom({ importance: 0.2 });
		await index.insertAtom(old2, new Array(1024).fill(0.01));
		const new2 = sampleAtom({ importance: 0.9 });
		const r2 = index.markSupersededTx(old2.id, new2, new Array(1024).fill(0.02));
		expect(r2.newAtom.importance).toBeCloseTo(0.9, 5);
	});

	it("new atom parent_id = old.id", async () => {
		const old = sampleAtom({ id: "old-123" });
		await index.insertAtom(old, new Array(1024).fill(0.01));
		const newAtom = sampleAtom({ parent_id: null });
		const { newAtom: result } = index.markSupersededTx("old-123", newAtom, new Array(1024).fill(0.02));
		expect(result.parent_id).toBe("old-123");
	});

	it("old atom is_latest=0 and superseded_at set", async () => {
		const old = sampleAtom();
		await index.insertAtom(old, new Array(1024).fill(0.01));
		const newAtom = sampleAtom();
		index.markSupersededTx(old.id, newAtom, new Array(1024).fill(0.02));
		const oldAfter = index.getAtom(old.id);
		expect(oldAfter?.is_latest).toBe(0);
		expect(oldAfter?.superseded_at).not.toBeNull();
	});

	it("new atom is queryable via getActiveAtoms, old is not", async () => {
		const old = sampleAtom();
		await index.insertAtom(old, new Array(1024).fill(0.01));
		const newAtom = sampleAtom();
		index.markSupersededTx(old.id, newAtom, new Array(1024).fill(0.02));
		const active = index.getActiveAtoms();
		expect(active.map(a => a.id)).toContain(newAtom.id);
		expect(active.map(a => a.id)).not.toContain(old.id);
	});
});
