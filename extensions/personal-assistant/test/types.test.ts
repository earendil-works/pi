import { describe, it, expect } from "vitest";
import type {
	MemoryAtom,
	MemoryAtomType,
	RecallResult,
	ExtractionItem,
	ExtractionResult,
	ExtractionPlan,
	MemoryAtomRow,
} from "../types.ts";
import { rowToAtom, atomToRow } from "../types.ts";
import type { PersonalAssistantConfig } from "../memory.ts";

// Helper factory for a complete MemoryAtom sample used in many tests.
function makeAtom(overrides: Partial<MemoryAtom> = {}): MemoryAtom {
	return {
		id: "atom-1",
		type: "rule",
		title: "Use UTC for timestamps",
		content: "All persisted timestamps use UTC ms epoch.",
		summary: "UTC epoch for storage.",
		tags: ["time", "storage", "convention"],
		importance: 0.7,
		strength: 0.7,
		access_count: 0,
		version: 1,
		is_latest: 1,
		parent_id: null,
		superseded_at: null,
		archived: 0,
		created_at: 1_700_000_000_000,
		updated_at: 1_700_000_000_000,
		last_access: null,
		content_fingerprint: "abcdef0123456789",
		source_session: "session-abc",
		...overrides,
	};
}

describe("types", () => {
	it("exports MemoryAtomType union limited to the 3 categories", () => {
		const types: MemoryAtomType[] = ["rule", "fact", "process"];
		expect(types).toHaveLength(3);
		expect(types).toEqual(["rule", "fact", "process"]);
	});

	it("constructs a MemoryAtom and reads type correctly", () => {
		const atom = makeAtom({ type: "rule" });
		expect(atom.type).toBe("rule");

		const fact: MemoryAtom = makeAtom({ type: "fact" });
		expect(fact.type).toBe("fact");

		const process: MemoryAtom = makeAtom({ type: "process" });
		expect(process.type).toBe("process");
	});

	it("supports supersede-chain fields", () => {
		const oldAtom = makeAtom({
			is_latest: 0,
			parent_id: "atom-0",
			superseded_at: 1_700_000_000_000,
		});
		expect(oldAtom.is_latest).toBe(0);
		expect(oldAtom.parent_id).toBe("atom-0");
		expect(oldAtom.superseded_at).toBe(1_700_000_000_000);

		const newAtom = makeAtom({ is_latest: 1, parent_id: oldAtom.id });
		expect(newAtom.is_latest).toBe(1);
		expect(newAtom.parent_id).toBe(oldAtom.id);
	});

	it("round-trips atom <-> row with tags JSON-encoded", () => {
		const atom = makeAtom({ tags: ["alpha", "beta", "gamma"] });
		const row = atomToRow(atom);

		// Row tags must be a JSON string, not the array.
		expect(typeof row.tags).toBe("string");
		expect(row.tags).toBe(JSON.stringify(["alpha", "beta", "gamma"]));

		const back = rowToAtom(row);
		expect(back.tags).toEqual(atom.tags);
		expect(back.id).toBe(atom.id);
		expect(back.type).toBe(atom.type);
		expect(back.title).toBe(atom.title);
		expect(back.content).toBe(atom.content);
		expect(back.summary).toBe(atom.summary);
		expect(back.importance).toBe(atom.importance);
		expect(back.strength).toBe(atom.strength);
		expect(back.access_count).toBe(atom.access_count);
		expect(back.version).toBe(atom.version);
		expect(back.is_latest).toBe(atom.is_latest);
		expect(back.parent_id).toBe(atom.parent_id);
		expect(back.superseded_at).toBe(atom.superseded_at);
		expect(back.archived).toBe(atom.archived);
		expect(back.created_at).toBe(atom.created_at);
		expect(back.updated_at).toBe(atom.updated_at);
		expect(back.last_access).toBe(atom.last_access);
		expect(back.content_fingerprint).toBe(atom.content_fingerprint);
		expect(back.source_session).toBe(atom.source_session);
	});

	it("round-trips an atom with empty tags", () => {
		const atom = makeAtom({ tags: [] });
		const back = rowToAtom(atomToRow(atom));
		expect(back.tags).toEqual([]);
	});

	it("round-trips an atom with null parent_id / superseded_at / last_access / source_session", () => {
		const atom = makeAtom({
			parent_id: null,
			superseded_at: null,
			last_access: null,
			source_session: null,
		});
		const back = rowToAtom(atomToRow(atom));
		expect(back.parent_id).toBeNull();
		expect(back.superseded_at).toBeNull();
		expect(back.last_access).toBeNull();
		expect(back.source_session).toBeNull();
	});

	it("preserves 0 | 1 integer semantics for is_latest and archived (sqlite integer returns)", () => {
		const archived = makeAtom({ archived: 1, is_latest: 0 });
		const row = atomToRow(archived);
		// sqlite-vec / better-sqlite3 returns integer values as JS numbers.
		expect(row.archived).toBe(1);
		expect(row.is_latest).toBe(0);

		const back = rowToAtom(row);
		expect(back.archived).toBe(1);
		expect(back.is_latest).toBe(0);
	});

	it("shapes RecallResult with distance, cosine, score, rrfScore (no file_path)", () => {
		const result: RecallResult = {
			atom: makeAtom(),
			distance: 0.42,
			cosine: 0.79,
			score: 0.79 * (1 + 0.3 * 0.7 + 0.2 * 0.7), // = 0.79 × 1.35 = 1.0665
			// Non-hybrid callers (rare; mostly tests) populate rrfScore with the
			// rank-weighted score, so rrfScore === score in this case.
			rrfScore: 0.79 * (1 + 0.3 * 0.7 + 0.2 * 0.7),
		};
		expect(result.score).toBeGreaterThan(0);
		expect(result.score).toBeLessThanOrEqual(1.5); // max boost scenario
		expect(result.cosine).toBeGreaterThan(0);
		expect(result.cosine).toBeLessThanOrEqual(1);
		// file_path is gone — confirm via type-level: no such field
		expect((result as { file_path?: unknown }).file_path).toBeUndefined();
	});

	it("score field follows the multiplicative formula", () => {
		// cosine × (1 + 0.3 × strength + 0.2 × importance)
		const atom = makeAtom({ strength: 1.0, importance: 1.0 });
		const result: RecallResult = {
			atom,
			distance: 0.1,
			cosine: 0.99,
			score: 0.99 * 1.5,
			rrfScore: 0.99 * 1.5, // equals score for non-hybrid callers
		};
		expect(result.score).toBeCloseTo(1.485);
	});

	it("RecallResult has rrfScore field of type number", () => {
		// Build a literal with rrfScore and assert the type accepts it.
		// If the field is missing from the interface, this assignment fails
		// to compile — the runtime assertions below confirm the field shape.
		const result: RecallResult = {
			atom: makeAtom(),
			distance: 0.3,
			cosine: 0.85,
			score: 0.85 * (1 + 0.3 * 0.7 + 0.2 * 0.7),
			rrfScore: 0.032,
		};
		expect(typeof result.rrfScore).toBe("number");
		// Runtime check via hasOwnProperty — confirms the field is on the
		// instance, not just on the type.
		expect(Object.prototype.hasOwnProperty.call(result, "rrfScore")).toBe(true);
	});

	it("rrfScore is >= 0 for hybrid recall results", () => {
		// Delta Spec scenario: rrfScore is the sum of 1/(rrfK + rank) over
		// channels that returned the atom, so it is always non-negative.
		const rrfK = 60;
		const denseRank = 0; // top dense hit
		const bm25Rank = 2; // lower BM25 hit
		const expectedRrfScore = 1 / (rrfK + denseRank + 1) + 1 / (rrfK + bm25Rank + 1);
		const result: RecallResult = {
			atom: makeAtom(),
			distance: 0.4,
			cosine: 0.7,
			score: 0.7 * (1 + 0.3 * 0.7 + 0.2 * 0.7),
			rrfScore: expectedRrfScore,
		};
		expect(result.rrfScore).toBeGreaterThanOrEqual(0);
		expect(result.rrfScore).toBeCloseTo(expectedRrfScore, 9);
	});

	it("existing score field is preserved alongside rrfScore", () => {
		// Delta Spec scenario: with strength=0.7, importance=0.8, cosine=0.78,
		// score = 0.78 × (1 + 0.3×0.7 + 0.2×0.8) = 0.78 × 1.37 = 1.0686
		// (the spec text says ≈ 1.222 but that value is arithmetically
		// inconsistent with the documented formula; the contract is the
		// formula, not the typo).
		const result: RecallResult = {
			atom: makeAtom({ strength: 0.7, importance: 0.8 }),
			distance: 0.45,
			cosine: 0.78,
			score: 0.78 * (1 + 0.3 * 0.7 + 0.2 * 0.8),
			rrfScore: 0.0167, // hypothetical RRF contribution
		};
		// score contract unchanged: backwards compat with webui + memory_get.
		expect(result.score).toBeCloseTo(1.0686, 3);
		// rrfScore is independent — typically much smaller than score.
		expect(result.rrfScore).toBeLessThan(result.score);
	});

	it("shapes ExtractionItem with the 6 fields", () => {
		const item: ExtractionItem = {
			type: "fact",
			title: "Project uses bun",
			content: "This project uses bun as runtime.",
			summary: "Runtime is bun.",
			tags: ["runtime"],
			importance: 0.6,
		};
		expect(item.importance).toBeGreaterThanOrEqual(0);
		expect(item.importance).toBeLessThanOrEqual(1);
	});

	it("shapes ExtractionResult as a list wrapper", () => {
		const result: ExtractionResult = {
			items: [
				{
					type: "rule",
					title: "t",
					content: "c",
					summary: "s",
					tags: [],
					importance: 0.5,
				},
			],
		};
		expect(result.items).toHaveLength(1);
	});

	it("shapes ExtractionPlan with item status and computed fields", () => {
		const plan: ExtractionPlan = {
			items: [
				{
					item: {
						type: "fact",
						title: "x",
						content: "x content",
						summary: "x summary",
						tags: ["x"],
						importance: 0.5,
					},
					status: "supersede",
					matchedAtomId: "atom-99",
					similarity: 0.91,
					fingerprint: "deadbeefcafef00d",
				},
				{
					item: {
						type: "process",
						title: "y",
						content: "y content",
						summary: "y summary",
						tags: ["y"],
						importance: 0.4,
					},
					status: "create",
					fingerprint: "0011223344556677",
				},
				{
					item: {
						type: "rule",
						title: "z",
						content: "z content",
						summary: "z summary",
						tags: [],
						importance: 0.3,
					},
					status: "skip",
					matchedAtomId: "atom-7",
				},
			],
			modelUsed: "test-model",
			generatedAt: 1_700_000_000_000,
		};
		expect(plan.items.map((i) => i.status)).toEqual([
			"supersede",
			"create",
			"skip",
		]);
		expect(plan.modelUsed).toBe("test-model");
		expect(plan.generatedAt).toBeGreaterThan(0);
	});

	it("rowToAtom handles a row with empty tag string", () => {
		const row: MemoryAtomRow = {
			id: "r1",
			type: "process",
			title: "t",
			summary: "s",
			content: "c",
			tags: "",
			importance: 0.5,
			strength: 0.5,
			access_count: 0,
			version: 1,
			is_latest: 1,
			parent_id: null,
			superseded_at: null,
			archived: 0,
			created_at: 0,
			updated_at: 0,
			last_access: null,
			content_fingerprint: "fp",
			source_session: null,
		};
		// An empty string is invalid JSON; the helper must still produce a sane atom
		// (empty tags array) rather than throwing.
		const atom = rowToAtom(row);
		expect(atom.tags).toEqual([]);
	});

	it("atomToRow JSON-encodes tags exactly as required by sqlite storage", () => {
		const atom = makeAtom({ tags: ["a", "b"] });
		const row = atomToRow(atom);
		expect(row.tags).toBe('["a","b"]');
	});

	it("PersonalAssistantConfig.memory.recall is optional", () => {
		// recall block is fully optional: missing block, empty memory, and full
		// recall sub-config all type-check and round-trip cleanly.
		const c1: PersonalAssistantConfig = { memory: { recall: { rrfK: 30 } } };
		const c2: PersonalAssistantConfig = {
			memory: { recall: { rrfK: 60, recallThreshold: 1 / 60 } },
		};
		const c3: PersonalAssistantConfig = { memory: {} };
		const c4: PersonalAssistantConfig = {};

		expect(c1.memory?.recall?.rrfK).toBe(30);
		expect(c1.memory?.recall?.recallThreshold).toBeUndefined();
		expect(c2.memory?.recall?.rrfK).toBe(60);
		expect(c2.memory?.recall?.recallThreshold).toBeCloseTo(1 / 60);
		expect(c3.memory?.recall).toBeUndefined();
		expect(c4.memory).toBeUndefined();
	});
});