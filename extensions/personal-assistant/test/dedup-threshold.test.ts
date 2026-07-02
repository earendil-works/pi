// supersedeIfSimilar — default threshold + boundary cases.
//
// Task 1.2 of docs/sdd/changes/atom-remigrate. The production change in task
// 1.1 lowered the default cosine dedup threshold from 0.92 to 0.65 (R7 of
// specs/migration-atom-remigrate/spec.md — "supersedeIfSimilar Default
// Threshold"). This file locks the new default + the two boundary cases on
// either side of it so a future regression to 0.92 trips CI immediately.
//
// Cases covered:
//   (a) default threshold is 0.65 — verified by spying on the
//       `index.findMostSimilarEmbedding` method and asserting the second
//       positional arg is 0.65 when the caller omits the threshold.
//   (b) cosine 0.64 — strictly below the default 0.65 → returns "create",
//       leaves the existing atom untouched.
//   (c) cosine 0.66 — at/above the default 0.65 → returns "supersede",
//       marks the existing atom superseded.
//   (d) self-match guard — when the new atom's id matches the existing
//       atom's id (PATCH-style update of the same row), the function must
//       return "create" rather than calling markSupersededTx on the row it
//       is about to overwrite (which would violate the PRIMARY KEY).
//
// Vector construction: vecUnit = [1, 0, 0, ...] and
// vecAtCos(θ) = [cos θ, sin θ, 0, ...] are both unit vectors with
// cosine(vecUnit, vecAtCos(θ)) = cos θ. That gives us precise cosine
// control over a 1024-dim Float32 column — same setup as dedup.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { MemoryIndex } from "../storage.ts";
import { supersedeIfSimilar } from "../dedup.ts";
import type { MemoryAtom } from "../types.ts";

const DIM = 1024;

const vecUnit = (): number[] => {
	const arr = new Array(DIM).fill(0);
	arr[0] = 1;
	return arr;
};

const vecAtCos = (cosTheta: number): number[] => {
	const arr = new Array(DIM).fill(0);
	const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
	arr[0] = cosTheta;
	arr[1] = sinTheta;
	return arr;
};

const V_UNIT = vecUnit();
const V_COS_064 = vecAtCos(0.64);
const V_COS_066 = vecAtCos(0.66);

const sampleAtom = (overrides: Partial<MemoryAtom> = {}): MemoryAtom => ({
	id: crypto.randomUUID(),
	type: "rule",
	title: "Sample",
	content: "Sample content for testing",
	summary: "Sample summary",
	tags: ["test"],
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
	last_access: null,
	content_fingerprint: `fp-${Math.random().toString(36).slice(2, 18)}`,
	source_session: null,
	...overrides,
});

describe("supersedeIfSimilar default threshold (0.65) + boundaries", () => {
	let index: MemoryIndex;
	let tmpDir: string;
	let atomsDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dedup-threshold-test-"));
		atomsDir = path.join(tmpDir, "atoms");
		await fs.mkdir(atomsDir, { recursive: true });
		index = new MemoryIndex(":memory:");
		await index.init();
	});

	afterEach(async () => {
		index.close();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	// (a) Default threshold. When the caller omits the threshold arg,
	// supersedeIfSimilar must invoke index.findMostSimilarEmbedding with
	// 0.65 as the threshold. We assert via mock.calls rather than
	// toHaveBeenCalledWith so the assertion does not depend on whether
	// vitest treats the trailing optional `filter` argument as undefined
	// vs absent.
	it("uses 0.65 as the default threshold when caller omits it", async () => {
		const a = sampleAtom({ content: "alpha content unique" });
		await index.insertAtom(a, V_UNIT);

		const newAtom = sampleAtom({ content: "new content unique" });
		const spy = vi.spyOn(index, "findMostSimilarEmbedding");

		const result = await supersedeIfSimilar(index, atomsDir, newAtom, V_UNIT);

		// Threshold check is the primary assertion.
		expect(spy).toHaveBeenCalledTimes(1);
		const calls = spy.mock.calls;
		expect(calls[0]?.[0]).toBe(V_UNIT);
		expect(calls[0]?.[1]).toBe(0.65);

		// The actual call still ran the underlying method (vi.spyOn
		// wraps rather than replaces) — with cosine 1.0 vs the inserted
		// atom and different ids, the merge path fires.
		expect(result.status).toBe("supersede");
		expect(result.atom.is_latest).toBe(1);

		spy.mockRestore();
	});

	// (b) Boundary below threshold. cosine 0.64 < 0.65 → returns "create",
	// leaves the existing atom active. We use vecAtCos(0.64) for the new
	// atom's embedding, so cosine with V_UNIT (stored against A) is
	// exactly 0.64.
	it("returns create when cosine is 0.64 (below 0.65 default)", async () => {
		const a = sampleAtom({ content: "alpha content unique" });
		await index.insertAtom(a, V_UNIT);

		const newAtom = sampleAtom({ content: "new content unique" });
		const result = await supersedeIfSimilar(index, atomsDir, newAtom, V_COS_064);

		expect(result.status).toBe("create");
		expect(result.atom.id).toBe(newAtom.id);
		expect(result.atom.is_latest).toBe(1);
		// A is unchanged — caller takes the insert path.
		const aAfter = index.getAtom(a.id);
		expect(aAfter?.is_latest).toBe(1);
		expect(aAfter?.superseded_at).toBeNull();
	});

	// (c) Boundary at/above threshold. cosine 0.66 >= 0.65 → returns
	// "supersede", marks A superseded, returns the new atom as latest.
	it("supersedes when cosine is 0.66 (at/above 0.65 default)", async () => {
		const a = sampleAtom({ content: "alpha content unique" });
		await index.insertAtom(a, V_UNIT);

		const newAtom = sampleAtom({ content: "new content unique" });
		const result = await supersedeIfSimilar(index, atomsDir, newAtom, V_COS_066);

		expect(result.status).toBe("supersede");
		expect(result.atom.is_latest).toBe(1);
		// A is marked superseded — old row points at the new one.
		const aAfter = index.getAtom(a.id);
		expect(aAfter?.is_latest).toBe(0);
		expect(aAfter?.superseded_at).not.toBeNull();
	});

	// (d) Self-match guard. When the caller is PATCHing an existing atom
	// and the most-similar match is that same atom (cosine 1.0 because
	// the new atom's embedding is the stored vector), supersedeIfSimilar
	// must short-circuit to "create". Otherwise it would call
	// markSupersededTx(A.id, A, …) which would UPDATE A.is_latest=0 and
	// then INSERT a row with the SAME id — hitting the PRIMARY KEY
	// constraint.
	it("returns create on self-match (cosine 1.0, newAtom.id === stored id)", async () => {
		const a = sampleAtom({
			id: "fixed-self-id",
			content: "alpha content unique",
		});
		await index.insertAtom(a, V_UNIT);

		// Same id, same stored embedding — the only candidate cleared by
		// the threshold is A itself.
		const updatedA: MemoryAtom = { ...a, content: "alpha content unique v2" };
		const result = await supersedeIfSimilar(index, atomsDir, updatedA, V_UNIT);

		expect(result.status).toBe("create");
		expect(result.atom.id).toBe(updatedA.id);
		// A is untouched: still active, still original content, no
		// superseded_at. The caller (PATCH path) does its own in-place
		// updateAtom for the same atom id.
		const aAfter = index.getAtom(a.id);
		expect(aAfter?.is_latest).toBe(1);
		expect(aAfter?.superseded_at).toBeNull();
		expect(aAfter?.content).toBe(a.content);
		// No new atom file written on the "create" path.
		const files = await fs.readdir(atomsDir);
		expect(files).toHaveLength(0);
	});
});