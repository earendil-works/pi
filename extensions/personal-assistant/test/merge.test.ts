import { describe, it, expect } from "vitest";
import { mergeByAtomId } from "../merge.ts";
import type { RecallResult, MemoryAtom } from "../types.ts";

function makeAtom(id: string, overrides?: Partial<MemoryAtom>): MemoryAtom {
	return {
		id,
		type: "fact",
		title: "test",
		content: "test content",
		summary: "test summary",
		tags: [],
		importance: 0.5,
		strength: 0.5,
		access_count: 0,
		version: 1,
		is_latest: 1,
		parent_id: null,
		superseded_at: null,
		archived: 0,
		created_at: 1000,
		updated_at: 1000,
		last_access: null,
		content_fingerprint: "abc123",
		source_session: null,
		...overrides,
	};
}

function makeResult(
	id: string,
	rrf: number,
	cosine = 0.8,
	sparseScore = 0.2,
): RecallResult {
	return {
		atom: makeAtom(id),
		rrf,
		cosine,
		sparseScore,
	};
}

describe("mergeByAtomId", () => {
	it("B4: dedup by atom.id, keeps entry with highest rrf", () => {
		const a = [makeResult("x", 0.05, 0.8, 0.2)];
		const b = [makeResult("x", 0.03, 0.7, 0.1)];
		const result = mergeByAtomId([a, b]);
		expect(result).toHaveLength(1);
		expect(result[0].rrf).toBe(0.05);
		expect(result[0].atom.id).toBe("x");
	});

	it("B9: all empty groups returns empty array", () => {
		const result = mergeByAtomId([[], [], []]);
		expect(result).toEqual([]);
	});

	it("R1: merges multiple groups with distinct atoms", () => {
		const a = [makeResult("x", 0.05), makeResult("y", 0.04)];
		const b = [makeResult("z", 0.03)];
		const result = mergeByAtomId([a, b]);
		expect(result).toHaveLength(3);
		const ids = result.map((r: RecallResult) => r.atom.id).sort();
		expect(ids).toEqual(["x", "y", "z"]);
	});

	it("keeps highest rrf when same atom appears across 3+ groups", () => {
		const a = [makeResult("x", 0.01)];
		const b = [makeResult("x", 0.09)];
		const c = [makeResult("x", 0.05)];
		const result = mergeByAtomId([a, b, c]);
		expect(result).toHaveLength(1);
		expect(result[0].rrf).toBe(0.09);
	});

	it("handles single group", () => {
		const g = [makeResult("a", 0.1), makeResult("b", 0.2)];
		const result = mergeByAtomId([g]);
		expect(result).toHaveLength(2);
	});

	it("preserves other fields from the higher-rrf entry", () => {
		const a = [makeResult("x", 0.05, 0.9, 0.3)];
		const b = [makeResult("x", 0.03, 0.7, 0.1)];
		const result = mergeByAtomId([a, b]);
		expect(result[0].cosine).toBe(0.9);
		expect(result[0].sparseScore).toBe(0.3);
	});

	it("empty input array returns empty array", () => {
		const result = mergeByAtomId([]);
		expect(result).toEqual([]);
	});

	it("handles groups with optional rerankScore field", () => {
		const a: RecallResult[] = [
			{ ...makeResult("x", 0.05), rerankScore: 0.9 },
		];
		const b: RecallResult[] = [
			{ ...makeResult("x", 0.03), rerankScore: 0.7 },
		];
		const result = mergeByAtomId([a, b]);
		expect(result).toHaveLength(1);
		expect(result[0].rrf).toBe(0.05);
		expect(result[0].rerankScore).toBe(0.9);
	});
});
