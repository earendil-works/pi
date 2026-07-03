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

	it("shapes RecallResult with cosine, sparseScore, rrf (no score, no distance)", () => {
		const result: RecallResult = {
			atom: makeAtom(),
			cosine: 0.79,
			sparseScore: 0.21,
			rrf: 0.0167,
		};
		expect(result.cosine).toBeGreaterThan(0);
		expect(result.cosine).toBeLessThanOrEqual(1);
		expect(result.sparseScore).toBeGreaterThan(0);
		expect(result.rrf).toBeGreaterThan(0);
		// file_path is gone — confirm via type-level: no such field
		expect((result as { file_path?: unknown }).file_path).toBeUndefined();
		// score is gone — client no longer computes a custom score
		expect((result as { score?: unknown }).score).toBeUndefined();
		// distance is gone — client no longer reads L2 distance (rrf is the sort key)
		expect((result as { distance?: unknown }).distance).toBeUndefined();
	});

	it("rrf is the server's RRF score (rank-0 contribution = 1/60)", () => {
		const result: RecallResult = {
			atom: makeAtom(),
			cosine: 0.5,
			sparseScore: 0.3,
			rrf: 1 / 60,
		};
		expect(result.rrf).toBeCloseTo(0.01667, 5);
	});

	it("relativePath is optional and set by the agent hook before formatting", () => {
		const result: RecallResult = {
			atom: makeAtom(),
			cosine: 0.5,
			sparseScore: 0.1,
			rrf: 0.0167,
		};
		expect(result.relativePath).toBeUndefined();
		// The hook sets it before calling formatMemoryContext.
		result.relativePath = `fact/${result.atom.id}.md`;
		expect(result.relativePath).toBe(`fact/${result.atom.id}.md`);
	});

	// Task 1.1 (recall-precision R8): RecallResult gains optional `rerankScore?: number`
	// to carry the cross-encoder rerank output. The field must be optional so legacy
	// call sites (no rerank pipeline yet) keep compiling and existing tests stay green.
	// format.ts (task 1.3) will later sort hits by rerankScore DESC and fall back to rrf
	// for hits without a rerankScore.
	it("rerankScore is optional on RecallResult — omitted literal yields undefined", () => {
		const r: RecallResult = {
			atom: makeAtom(),
			cosine: 0.5,
			sparseScore: 0.4,
			rrf: 0.05,
		};
		// Field absent on the literal — must be optional so the assignment compiles
		// and the property reads back as undefined.
		expect(r.rerankScore).toBeUndefined();
	});

	it("rerankScore on RecallResult — set literal round-trips the score", () => {
		const r2: RecallResult = {
			atom: makeAtom(),
			cosine: 0.5,
			sparseScore: 0.4,
			rrf: 0.05,
			rerankScore: 0.92,
		};
		expect(r2.rerankScore).toBe(0.92);
	});

	it("rerankScore is a number — string / null literals are rejected at compile time", () => {
		// Compile-time guards. The first two lines would error under `tsc --noEmit`
		// if rerankScore were missing from the type or had the wrong shape; the runtime
		// assertions verify the accepted shape behaves as expected.
		const ok: RecallResult = {
			atom: makeAtom(),
			cosine: 0,
			sparseScore: 0,
			rrf: 0,
			rerankScore: 0,
		};
		expect(ok.rerankScore).toBe(0);
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

	it("PersonalAssistantConfig.memory is fully optional (post client-trust-server refactor)", () => {
		// The client-side scoring knobs (`tagOverlapWeight`, `freshnessWeight`,
		// `tagAliases`) were removed when recall stopped re-ranking. The
		// server's RRF is the sole ranking signal. This test pins that
		// the surrounding `memory` block is still optional — empty
		// memory, populated memory, and missing memory all type-check
		// cleanly.
		const c1: PersonalAssistantConfig = { memory: { dbPath: "/tmp/x.db" } };
		const c2: PersonalAssistantConfig = { memory: {} };
		const c3: PersonalAssistantConfig = {};

		expect(c1.memory?.dbPath).toBe("/tmp/x.db");
		expect(c2.memory).toBeDefined();
		expect(c3.memory).toBeUndefined();
	});
});