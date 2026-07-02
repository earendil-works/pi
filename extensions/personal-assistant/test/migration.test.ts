import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
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