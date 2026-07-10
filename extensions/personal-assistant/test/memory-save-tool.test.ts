// memory_save tool — TypeBox schema, segment counter, scaffold registration.
//
// Task 2.1 scaffold contract:
//   - MemorySaveParams TypeBox schema validates all input fields.
//   - Module-level segmentMemorySaveCount + helpers (get / increment / reset).
//   - registerMemorySave(pi) registers a tool whose execute body throws
//     "not implemented" (the real create / update / skip / error logic
//     lands in tasks 2.2+).
//
// RED state for 2.1: the "memory_save execute (scaffold)" tests exercise
// the final expected contract and FAIL today because execute throws.
// They will turn GREEN in 2.2+ once the real implementation lands. We
// keep them in the same file (with a clear "RED" comment block) so the
// 2.2+ diff is purely a `throw` → real body swap, not a test rewrite.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Value } from "typebox/value";

// char-bag mock for embed.ts so tests don't need a live embedder.
// Mirrors the pattern used in search.test.ts and extraction.test.ts.
vi.mock("../embed.ts", async () => {
	const actual = await vi.importActual<typeof import("../embed.ts")>("../embed.ts");
	return {
		...actual,
		embedText: vi.fn(async (text: string) => {
			const arr = new Array(1024).fill(0);
			for (let i = 0; i < text.length; i++) {
				arr[text.charCodeAt(i) % 1024] += 1;
			}
			const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
			if (norm > 0) {
				for (let i = 0; i < arr.length; i++) arr[i] /= norm;
			}
			return arr;
		}),
	};
});

// Lazy-loaded module bindings — re-resolved in beforeEach after vi.resetModules()
// so each test gets a fresh module-level segmentMemorySaveCount.
type MemorySaveModule = typeof import("../memory-save.ts");
type StorageModule = typeof import("../storage.ts");

let mod: MemorySaveModule;
let MemoryIndex: StorageModule["MemoryIndex"];

const ORIGINAL_HOME = process.env.HOME;

beforeEach(async () => {
	vi.resetModules();
	mod = await import("../memory-save.ts");
	const storageMod = await import("../storage.ts");
	MemoryIndex = storageMod.MemoryIndex;
});

afterEach(() => {
	process.env.HOME = ORIGINAL_HOME;
});

// ---------------------------------------------------------------------------
// MemorySaveParams TypeBox schema
// ---------------------------------------------------------------------------

describe("MemorySaveParams TypeBox schema", () => {
	it("accepts a valid input with required fields only", () => {
		const valid = {
			type: "fact" as const,
			title: "Test Fact",
			content: "This is some valid content for testing.",
			summary: "A test summary line",
			importance: 0.5,
		};
		expect(Value.Check(mod.MemorySaveParams, valid)).toBe(true);
	});

	it("accepts a valid input with all optional fields", () => {
		const valid = {
			id: "550e8400-e29b-41d4-a716-446655440000",
			type: "rule" as const,
			title: "Test Rule",
			content: "This is a valid rule content for testing.",
			summary: "A test summary line",
			tags: ["test", "rule"],
			importance: 0.8,
			source_session: "session-1",
		};
		expect(Value.Check(mod.MemorySaveParams, valid)).toBe(true);
	});

	it("accepts every legal type literal (rule / fact / process)", () => {
		for (const t of ["rule", "fact", "process"] as const) {
			const input = {
				type: t,
				title: "t",
				content: "long enough content body",
				summary: "summary line",
				importance: 0.5,
			};
			expect(Value.Check(mod.MemorySaveParams, input)).toBe(true);
		}
	});

	it("rejects invalid type literal (not in rule/fact/process)", () => {
		const invalid = {
			type: "opinion",
			title: "Test",
			content: "Valid content body for invalid type test",
			summary: "summary line",
			importance: 0.5,
		};
		expect(Value.Check(mod.MemorySaveParams, invalid)).toBe(false);
	});

	it("rejects content shorter than 10 characters", () => {
		const invalid = {
			type: "fact" as const,
			title: "Test",
			content: "x",
			summary: "summary line",
			importance: 0.5,
		};
		expect(Value.Check(mod.MemorySaveParams, invalid)).toBe(false);
	});

	it("rejects importance above 1", () => {
		const invalid = {
			type: "fact" as const,
			title: "Test",
			content: "Valid content body for importance test",
			summary: "summary line",
			importance: 1.5,
		};
		expect(Value.Check(mod.MemorySaveParams, invalid)).toBe(false);
	});

	it("rejects importance below 0", () => {
		const invalid = {
			type: "fact" as const,
			title: "Test",
			content: "Valid content body for importance test",
			summary: "summary line",
			importance: -0.1,
		};
		expect(Value.Check(mod.MemorySaveParams, invalid)).toBe(false);
	});

	it("accepts importance at the boundaries (0 and 1)", () => {
		for (const importance of [0, 1]) {
			const input = {
				type: "fact" as const,
				title: "Boundary test",
				content: "Valid content body for boundary test",
				summary: "summary line",
				importance,
			};
			expect(Value.Check(mod.MemorySaveParams, input)).toBe(true);
		}
	});

	it("rejects missing required fields (no title)", () => {
		const invalid = {
			type: "fact" as const,
			content: "Valid content body",
			summary: "summary line",
			importance: 0.5,
		};
		expect(Value.Check(mod.MemorySaveParams, invalid)).toBe(false);
	});

	it("rejects summary shorter than 5 characters", () => {
		const invalid = {
			type: "fact" as const,
			title: "Test",
			content: "Valid content body for summary test",
			summary: "abcd",
			importance: 0.5,
		};
		expect(Value.Check(mod.MemorySaveParams, invalid)).toBe(false);
	});

	it("rejects title longer than 200 characters", () => {
		const invalid = {
			type: "fact" as const,
			title: "x".repeat(201),
			content: "Valid content body for title-length test",
			summary: "summary line",
			importance: 0.5,
		};
		expect(Value.Check(mod.MemorySaveParams, invalid)).toBe(false);
	});

	it("rejects content longer than 5000 characters", () => {
		const invalid = {
			type: "fact" as const,
			title: "Test",
			content: "x".repeat(5001),
			summary: "summary line",
			importance: 0.5,
		};
		expect(Value.Check(mod.MemorySaveParams, invalid)).toBe(false);
	});

	it("rejects tags with item longer than 50 characters", () => {
		const invalid = {
			type: "fact" as const,
			title: "Test",
			content: "Valid content body for tag-length test",
			summary: "summary line",
			importance: 0.5,
			tags: ["x".repeat(51)],
		};
		expect(Value.Check(mod.MemorySaveParams, invalid)).toBe(false);
	});

	it("rejects more than 10 tags", () => {
		const invalid = {
			type: "fact" as const,
			title: "Test",
			content: "Valid content body for tag-count test",
			summary: "summary line",
			importance: 0.5,
			tags: Array.from({ length: 11 }, (_, i) => `tag${i}`),
		};
		expect(Value.Check(mod.MemorySaveParams, invalid)).toBe(false);
	});

	it("accepts empty tags array and missing tags as equivalent (both optional)", () => {
		const emptyTags = {
			type: "fact" as const,
			title: "Test",
			content: "Valid content body for empty-tags test",
			summary: "summary line",
			importance: 0.5,
			tags: [],
		};
		const absentTags = {
			type: "fact" as const,
			title: "Test",
			content: "Valid content body for absent-tags test",
			summary: "summary line",
			importance: 0.5,
		};
		expect(Value.Check(mod.MemorySaveParams, emptyTags)).toBe(true);
		expect(Value.Check(mod.MemorySaveParams, absentTags)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// segmentMemorySaveCount + helpers
// ---------------------------------------------------------------------------

describe("segmentMemorySaveCount", () => {
	it("starts at 0 on a fresh module import", () => {
		// The lazy import in the top-level beforeEach gives us a fresh
		// module-level binding; assert the initial value is zero.
		expect(mod.getSegmentMemorySaveCount()).toBe(0);
	});

	it("increments by 1 on each call to incrementSegmentMemorySaveCount", () => {
		expect(mod.getSegmentMemorySaveCount()).toBe(0);
		mod.incrementSegmentMemorySaveCount();
		expect(mod.getSegmentMemorySaveCount()).toBe(1);
		mod.incrementSegmentMemorySaveCount();
		expect(mod.getSegmentMemorySaveCount()).toBe(2);
		mod.incrementSegmentMemorySaveCount();
		expect(mod.getSegmentMemorySaveCount()).toBe(3);
	});

	it("resets to 0 via resetSegmentMemorySaveCount", () => {
		mod.incrementSegmentMemorySaveCount();
		mod.incrementSegmentMemorySaveCount();
		mod.incrementSegmentMemorySaveCount();
		expect(mod.getSegmentMemorySaveCount()).toBe(3);
		mod.resetSegmentMemorySaveCount();
		expect(mod.getSegmentMemorySaveCount()).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// registerMemorySave — tool registration shape
// ---------------------------------------------------------------------------

describe("registerMemorySave", () => {
	function makeFakePi() {
		const calls: any[] = [];
		const pi = {
			registerTool: (tool: any) => {
				calls.push(tool);
			},
		};
		return { pi, calls };
	}

	it("registers exactly one tool", () => {
		const { pi, calls } = makeFakePi();
		mod.registerMemorySave(pi as any);
		expect(calls).toHaveLength(1);
	});

	it("registers a tool named 'memory_save'", () => {
		const { pi, calls } = makeFakePi();
		mod.registerMemorySave(pi as any);
		expect(calls[0].name).toBe("memory_save");
	});

	it("registered tool exposes a TypeBox parameters schema and an execute function", () => {
		const { pi, calls } = makeFakePi();
		mod.registerMemorySave(pi as any);
		const tool = calls[0];
		expect(tool).toHaveProperty("parameters");
		// The TypeBox schema is a JSON-Schema-ish object — assert it
		// round-trips through Value.Check for a valid input.
		expect(Value.Check(tool.parameters, {
			type: "fact",
			title: "x",
			content: "long enough content body",
			summary: "summary line",
			importance: 0.5,
		})).toBe(true);
		expect(typeof tool.execute).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// memory_save execute (RED — scaffold throws "not implemented")
//
// The tests below exercise the FINAL expected contract of the tool:
//   - call tool.execute with valid params against a real MemoryIndex
//   - assert the returned `details.action` is one of created / updated /
//     skipped / error with the expected shape
//
// In 2.1 the execute body throws "not implemented" so these tests FAIL.
// They will turn GREEN as tasks 2.2–2.7 land the real create / update /
// skip / error branches. Keeping them in this file (with the RED
// comment) means 2.2 is a pure body swap, not a test rewrite.
// ---------------------------------------------------------------------------

describe("memory_save execute (RED — scaffold throws 'not implemented')", () => {
	let tmpDir: string;
	let dbPath: string;
	let tool: any;

	beforeEach(async () => {
		vi.resetModules();
		mod = await import("../memory-save.ts");
		// env.HOME is restored in the top-level afterEach.
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-save-exec-test-"));
		process.env.HOME = tmpDir;
		dbPath = path.join(tmpDir, ".pi", "agent", "memory", "memory.db");

		// Register a fresh tool against a fake pi.
		const calls: any[] = [];
		const pi = {
			registerTool: (t: any) => {
				calls.push(t);
			},
		};
		mod.registerMemorySave(pi as any);
		tool = calls[0];
	});

	afterEach(async () => {
		process.env.HOME = ORIGINAL_HOME;
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	// This test is intentionally RED in 2.1: the scaffold execute throws
	// "not implemented", so the expected "created" branch is unreachable.
	// When 2.2 lands the real create path, this test must turn GREEN.
	it("create path: returns {action: 'created', id, embedding} for a brand new atom", async () => {
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		idx.close();

		const params = {
			type: "fact" as const,
			title: "Brand new fact",
			content: "Brand new content for create-path test",
			summary: "Summary of the new fact",
			tags: ["new"],
			importance: 0.5,
		};
		const result = await tool.execute(
			"call-1",
			params,
			undefined,
			undefined,
			{ ui: { notify: () => {} } },
		);
		expect(result.details.action).toBe("created");
		expect(typeof result.details.id).toBe("string");
		expect(["ok", "skipped"]).toContain(result.details.embedding);
	});

	// Counter increment after execute — the spec says the counter
	// increments on EVERY call regardless of outcome. In 2.1 the throw
	// happens before the counter increments, so this is also RED until
	// 2.2 wires the counter into the real execute body.
	it("increments segmentMemorySaveCount after a successful execute", async () => {
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		idx.close();

		expect(mod.getSegmentMemorySaveCount()).toBe(0);
		await tool.execute(
			"call-2",
			{
				type: "rule" as const,
				title: "Rule for counter test",
				content: "Rule content body for counter increment test",
				summary: "Rule summary line",
				importance: 0.6,
			},
			undefined,
			undefined,
			{ ui: { notify: () => {} } },
		);
		expect(mod.getSegmentMemorySaveCount()).toBe(1);
	});

	// Task 2.3 — fingerprint-hit skip path (scenarios.md:L13).
	// Pre-insert an atom with a known content, then call memory_save
	// with the same content (no id). Expected outcome:
	//   - details.action === "skipped"
	//   - details.reason === "duplicate_content"
	//   - details.existing_id === pre-inserted atom id
	//   - DB unchanged (no new row)
	//   - segmentMemorySaveCount incremented by 1 (counter counts calls,
	//     not successes)
	it("skip path: returns {action: 'skipped', reason: 'duplicate_content', existing_id} when fingerprint matches an existing active atom", async () => {
		// 1. Pre-insert an atom with a known content_fingerprint. Use the
		// real `computeFingerprint` from extraction.ts so any future
		// change to the normalization rule (whitespace, case) stays in
		// sync with the tool — the test would otherwise silently drift.
		const { computeFingerprint } = await import("../extraction.ts");
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		const duplicateContent = "Content that already exists in the database for fingerprint dedup test";
		const fingerprint = computeFingerprint(duplicateContent);

		const existingId = "a-789";
		const existingAtom = {
			id: existingId,
			type: "rule" as const,
			title: "Existing rule",
			summary: "Existing rule summary line",
			content: duplicateContent,
			tags: ["existing"],
			importance: 0.7,
			strength: 1.0,
			access_count: 0,
			version: 1,
			is_latest: 1 as const,
			parent_id: null,
			superseded_at: null,
			archived: 0 as const,
			created_at: Date.now(),
			updated_at: Date.now(),
			last_access: null,
			content_fingerprint: fingerprint,
			source_session: null,
		};
		await idx.insertAtom(existingAtom, new Array(1024).fill(0.01));
		idx.close();

		// 2. Call memory_save with the same content (no id).
		expect(mod.getSegmentMemorySaveCount()).toBe(0);
		const result = await tool.execute(
			"call-3",
			{
				type: "rule" as const,
				title: "Different title (does not matter — fingerprint wins)",
				content: duplicateContent,
				summary: "A different summary line",
				importance: 0.3,
			},
			undefined,
			undefined,
			{ ui: { notify: () => {} } },
		);

		// 3. Assert the result shape.
		expect(result.details).toEqual({
			action: "skipped",
			reason: "duplicate_content",
			existing_id: existingId,
		});

		// 4. Assert the DB is unchanged (still exactly 1 row, the pre-inserted atom).
		const verifyIdx = new MemoryIndex(dbPath);
		await verifyIdx.init();
		try {
			const allAtoms = verifyIdx.getActiveAtoms();
			expect(allAtoms).toHaveLength(1);
			expect(allAtoms[0].id).toBe(existingId);
			expect(allAtoms[0].content).toBe(duplicateContent);
			expect(allAtoms[0].version).toBe(1);
			expect(allAtoms[0].access_count).toBe(0);
		} finally {
			verifyIdx.close();
		}

		// 5. Assert the counter incremented by 1 (skip counts as a call).
		expect(mod.getSegmentMemorySaveCount()).toBe(1);
	});
});
