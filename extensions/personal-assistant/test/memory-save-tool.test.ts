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

	// Task 2.4 — overwrite path (id present, atom exists) — scenarios.md:L15.
	// Pre-insert an atom with id "a-123", content "old content"; then call
	// memory_save with the same id but new content/title/summary/tags/importance.
	// Expected outcome (per storage.ts:194 SQL `version = version + 1`):
	//   - details.action === "updated"
	//   - details.id === "a-123"
	//   - details.embedding === "ok" (mock returns a real vector) or "skipped"
	//     (when the embedder is down — accepting either keeps the test aligned
	//     with the create-path test's looser assertion)
	//   - DB row content/title/summary/tags/importance match the new params,
	//     version bumped (1 → 2), is_latest=1, archived preserved
	//   - .md file overwritten (we pre-write a stale .md so overwriting is
	//     observable rather than only creatable)
	//   - segmentMemorySaveCount incremented by 1
	it("overwrite path: returns {action: 'updated', id, embedding} when id is supplied and atom exists", async () => {
		const idx = new MemoryIndex(dbPath);
		await idx.init();

		// 1. Pre-insert atom a-123 with version=1, is_latest=1, archived=0,
		// and a stable fingerprint so we can detect that the overwrite keeps
		// the same row id but writes new content/title/summary/tags/importance.
		const oldContent = "Original content for atom a-123 overwrite test scenario";
		const { computeFingerprint } = await import("../extraction.ts");
		const oldFingerprint = computeFingerprint(oldContent);
		const existingId = "a-123";
		const oldCreatedAt = Date.now() - 10_000; // arbitrary, just need consistency
		await idx.insertAtom(
			{
				id: existingId,
				type: "rule" as const,
				title: "Old title before overwrite",
				summary: "Old summary line before overwrite",
				content: oldContent,
				tags: ["old"],
				importance: 0.4,
				strength: 0.6,
				access_count: 2,
				version: 1,
				is_latest: 1 as const,
				parent_id: null,
				superseded_at: null,
				archived: 0 as const,
				created_at: oldCreatedAt,
				updated_at: oldCreatedAt,
				last_access: null,
				content_fingerprint: oldFingerprint,
				source_session: "session-old",
			},
			new Array(1024).fill(0.05),
		);

		// Pre-write a stale .md so we can observe the overwrite (writeAtomToFile
		// fs.writeFile replaces the body; we put a sentinel string in the old
		// file that the new content will replace).
		const atomsDir = path.join(tmpDir, ".pi", "agent", "memory", "atoms");
		const staleFilePath = path.join(atomsDir, "rule", `${existingId}.md`);
		await fs.mkdir(path.dirname(staleFilePath), { recursive: true });
		await fs.writeFile(
			staleFilePath,
			"---\nid: \"a-123\"\n---\n\nSTALE_BODY_SENTINEL\n",
			"utf8",
		);

		idx.close();

		// 2. Call memory_save with the same id, new content.
		expect(mod.getSegmentMemorySaveCount()).toBe(0);
		const result = await tool.execute(
			"call-4",
			{
				id: existingId,
				type: "rule" as const,
				title: "new title",
				content: "new content for atom a-123 overwrite test scenario",
				summary: "new summary",
				tags: ["new"],
				importance: 0.8,
			},
			undefined,
			undefined,
			{ ui: { notify: () => {} } },
		);

		// 3. Assert the result shape (relaxed to match create-path test, since
		// the mock always returns a real vector, this should be "ok"; we still
		// accept "skipped" so a future embedder-down mock path doesn't break
		// the contract).
		expect(result.details.action).toBe("updated");
		expect(result.details.id).toBe(existingId);
		expect(["ok", "skipped"]).toContain(result.details.embedding);

		// 4. Assert the DB row reflects the new fields, version is bumped
		// (1 → 2 by SQL `version = version + 1` in storage.ts:194), is_latest
		// and archived are preserved (overwrite is in-place, not a recreate).
		const verifyIdx = new MemoryIndex(dbPath);
		await verifyIdx.init();
		try {
			const updated = verifyIdx.getAtom(existingId);
			expect(updated).not.toBeNull();
			expect(updated!.content).toBe(
				"new content for atom a-123 overwrite test scenario",
			);
			expect(updated!.title).toBe("new title");
			expect(updated!.summary).toBe("new summary");
			expect(updated!.tags).toEqual(["new"]);
			expect(updated!.importance).toBeCloseTo(0.8, 5);
			expect(updated!.version).toBe(2); // 1 + 1 by SQL
			expect(updated!.is_latest).toBe(1);
			expect(updated!.archived).toBe(0); // preserved
			// Continuity fields preserved across overwrite:
			expect(updated!.id).toBe(existingId);
			expect(updated!.source_session).toBe("session-old");
			expect(updated!.created_at).toBe(oldCreatedAt);
			expect(updated!.access_count).toBe(2);
			expect(updated!.strength).toBeCloseTo(0.6, 5);
			// updated_at must move forward (overwrite touches this column);
			// we don't pin an absolute value, only that it's >= oldCreatedAt.
			expect(updated!.updated_at).toBeGreaterThanOrEqual(oldCreatedAt);

			// getActiveAtoms should still see exactly 1 row (overwrite does
			// NOT insert; no new row from this call).
			const allActive = verifyIdx.getActiveAtoms();
			expect(allActive).toHaveLength(1);
			expect(allActive[0].id).toBe(existingId);
		} finally {
			verifyIdx.close();
		}

		// 5. Assert the .md file was overwritten (writeAtomToFile is called
		// after updateAtom; the sentinel must be gone, and the new content
		// should be in the body).
		const overwrittenBody = await fs.readFile(staleFilePath, "utf8");
		expect(overwrittenBody).not.toContain("STALE_BODY_SENTINEL");
		expect(overwrittenBody).toContain("new content for atom a-123");
		expect(overwrittenBody).toContain('title: "new title"');

		// 6. Assert the counter incremented by 1.
		expect(mod.getSegmentMemorySaveCount()).toBe(1);
	});

	// Task 2.5 — id_not_found error path (scenarios.md S7, spec.md L39-44).
	// Pre-state: empty DB (no atom with id "a-ghost"). Call memory_save
	// with `id: "a-ghost"` and any valid content. Expected outcome:
	//   - details.action === "error"
	//   - details.error === "id_not_found"
	//   - details.id === "a-ghost"
	//   - DB unchanged (still zero atoms)
	//   - No .md file was created (writeAtomToFile must not have run)
	//   - segmentMemorySaveCount incremented by 1 (the counter tracks
	//     "agent tried to write", not "agent successfully wrote" — per
	//     principle "counter 计入调用而不计入成功")
	it("id_not_found path: returns {action: 'error', error: 'id_not_found', id} when id is supplied but DB has no such atom", async () => {
		// 1. Empty DB — just init + close so the file exists.
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		idx.close();

		const atomsDir = path.join(tmpDir, ".pi", "agent", "memory", "atoms");

		expect(mod.getSegmentMemorySaveCount()).toBe(0);
		const ghostId = "a-ghost";
		const result = await tool.execute(
			"call-5",
			{
				id: ghostId,
				type: "fact" as const,
				title: "ghost title",
				content: "content for ghost atom id_not_found test scenario",
				summary: "ghost summary line",
				tags: ["ghost"],
				importance: 0.4,
			},
			undefined,
			undefined,
			{ ui: { notify: () => {} } },
		);

		// 2. Assert the error envelope shape exactly (spec.md L43,
		// scenarios.md S7 line 40).
		expect(result.details).toEqual({
			action: "error",
			error: "id_not_found",
			id: ghostId,
		});

		// 3. Assert the DB is unchanged (still zero atoms — no insert).
		const verifyIdx = new MemoryIndex(dbPath);
		await verifyIdx.init();
		try {
			const ghost = verifyIdx.getAtom(ghostId);
			expect(ghost).toBeNull();
			expect(verifyIdx.getActiveAtoms()).toHaveLength(0);
		} finally {
			verifyIdx.close();
		}

		// 4. Assert the .md file was NOT created under atomsDir. The
		// type "fact" subdir would be the canonical writeAtomToFile
		// destination; assert the dir/file does not exist.
		const ghostMdPath = path.join(atomsDir, "fact", `${ghostId}.md`);
		await expect(fs.stat(ghostMdPath)).rejects.toThrow();

		// 5. Assert the counter incremented by 1 — the call still
		// counts even though it returned an error envelope (per
		// principle "counter 计入调用").
		expect(mod.getSegmentMemorySaveCount()).toBe(1);
	});
});
