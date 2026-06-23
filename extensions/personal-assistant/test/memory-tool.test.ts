// memory_get tool — TDD v1.
//
// Contract under test (from specs/memory-search-decoupled/spec.md and
// memory.ts registerMemory's memory_get tool registration):
//   - registerMemory(pi) registers exactly one tool via pi.registerTool.
//   - The tool's `name` is "memory_get", `label` is "Memory Get", and the
//     `description` matches /Fetch the full content of an atom by id/.
//   - The tool's parameters is a TypeBox schema (a single required `id: string`).
//   - execute("call", { id: <uuid> }, signal, onUpdate, ctx):
//       * Returns content[0].text = "<title>\n<summary>\n<content>" and
//         details = { id, type, title, content, summary, tags, importance }
//         for an existing atom.
//       * Returns content[0].text = "atom not found: <id>" and
//         details = { error: "not_found", id } for a missing id.
//       * On a successful hit, calls index.updateAccess(atom.id) — bumps
//         access_count and stamps last_access. This is the sole
//         programmatic strength-feedback entry; search is bump-free.
//       * On a missing id, NEVER modifies any row.
//
// HOME mocking strategy:
//   memory.ts captures DEFAULT_DB_PATH = join(homedir(), ".pi/agent/memory/...")
//   at module load. The simplest way to make that path point at a per-test
//   temp dir is to vi.resetModules() and re-import memory.ts inside beforeEach,
//   after setting process.env.HOME = tmpDir. os.homedir() reads HOME on each
//   invocation on Linux, so the freshly-imported memory.ts captures the new
//   path. embed.ts is also mocked at module level so any transitive embed
//   calls resolve to a deterministic char-bag vector.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

// Mock embed.ts at module level (char-bag mock, same as search.test.ts).
// Memory.ts itself does not call embedText, but the mock keeps any
// transitive import (e.g. test code that imports embedText directly)
// deterministic and hermetic.
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
			if (norm > 0) for (let i = 0; i < arr.length; i++) arr[i] /= norm;
			return arr;
		}),
	};
});

// Lazy-loaded module bindings — re-resolved in beforeEach after vi.resetModules()
// so DEFAULT_DB_PATH captures the per-test tmpDir.
type MemoryModule = typeof import("../memory.ts");
type StorageModule = typeof import("../storage.ts");
type FileStoreModule = typeof import("../file-store.ts");
type EmbedModule = typeof import("../embed.ts");
type MemoryAtom = import("../types.ts").MemoryAtom;

let registerMemory: MemoryModule["registerMemory"];
let MemoryIndex: StorageModule["MemoryIndex"];
let writeAtomToFile: FileStoreModule["writeAtomToFile"];
let embedText: EmbedModule["embedText"];

// Captured at module load — used by afterEach to restore HOME after each
// test's beforeEach re-points it at the per-test tmpDir.
const ORIGINAL_HOME = process.env.HOME;

function makeFakePi() {
	return {
		on: vi.fn(),
		registerTool: vi.fn(),
	};
}

const sampleAtom = (overrides: Partial<MemoryAtom> = {}): MemoryAtom => ({
	id: crypto.randomUUID(),
	type: "rule",
	title: "Test Rule",
	content: "Test content here",
	summary: "Test summary",
	tags: ["test"],
	importance: 0.7,
	strength: 0.7,
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

describe("memory_get tool", () => {
	let dbPath: string;
	let atomsDir: string;
	let tmpDir: string;

	beforeEach(async () => {
		// Clear the module registry so memory.ts re-evaluates DEFAULT_DB_PATH
		// (captured at module load via homedir()) against the per-test tmpDir.
		vi.resetModules();

		const os = await import("node:os");
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-tool-test-"));

		// On Linux, os.homedir() reads process.env.HOME on each call, so the
		// freshly-imported memory.ts captures the new tmpDir at module load.
		process.env.HOME = tmpDir;

		dbPath = path.join(tmpDir, ".pi", "agent", "memory", "memory.db");
		atomsDir = path.join(tmpDir, ".pi", "agent", "memory", "atoms");
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		await fs.mkdir(atomsDir, { recursive: true });

		// Re-import memory.ts and its transitive deps so DEFAULT_DB_PATH
		// resolves to <tmpDir>/.pi/agent/memory/memory.db.
		const memoryMod = await import("../memory.ts");
		registerMemory = memoryMod.registerMemory;
		const storageMod = await import("../storage.ts");
		MemoryIndex = storageMod.MemoryIndex;
		const fileStoreMod = await import("../file-store.ts");
		writeAtomToFile = fileStoreMod.writeAtomToFile;
		const embedMod = await import("../embed.ts");
		embedText = embedMod.embedText;
	});

	afterEach(async () => {
		process.env.HOME = ORIGINAL_HOME;
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("is registered as 'memory_get' on pi.registerTool", () => {
		const pi = makeFakePi();
		registerMemory(pi as unknown as Parameters<typeof registerMemory>[0]);
		expect(pi.registerTool).toHaveBeenCalledTimes(1);
		const call = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[0].name).toBe("memory_get");
		expect(call[0].label).toBe("Memory Get");
		expect(call[0].description).toMatch(/Fetch the full content of an atom by id/);
	});

	it("execute returns full content for valid id and bumps access_count", async () => {
		const pi = makeFakePi();
		registerMemory(pi as unknown as Parameters<typeof registerMemory>[0]);
		const tool = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0];

		// Insert an atom via MemoryIndex at the same path memory.ts uses.
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		const atom = sampleAtom({ title: "Rule A", importance: 0.7, strength: 0.7 });
		const text = `${atom.title}\n\n${atom.summary}\n\n${atom.content}\n\n${atom.tags.join(" ")}`;
		const emb = await embedText(text);
		if (!emb) throw new Error("mocked embedText returned null");
		await idx.insertAtom(atom, emb);
		await writeAtomToFile(atom, atomsDir);
		idx.close();

		// Execute the tool.
		const result: AgentToolResult<unknown> = await tool.execute(
			"call-1",
			{ id: atom.id },
			new AbortController().signal,
			() => {},
			{},
		);

		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({ type: "text" });
		const text0 = (result.content[0] as { type: "text"; text: string }).text;
		expect(text0).toContain("Rule A");
		expect(text0).toContain("Test summary");
		expect(text0).toContain("Test content here");
		expect(result.details).toMatchObject({
			id: atom.id,
			type: "rule",
			title: "Rule A",
			content: "Test content here",
			summary: "Test summary",
			tags: ["test"],
			importance: 0.7,
		});

		// Verify access_count bumped + last_access set.
		const idx2 = new MemoryIndex(dbPath);
		await idx2.init();
		const got = idx2.getAtom(atom.id);
		expect(got?.access_count).toBe(1);
		expect(got?.last_access).not.toBeNull();
		expect(typeof got?.last_access).toBe("number");
		idx2.close();
	});

	it("execute returns not_found for unknown id without bumping", async () => {
		const pi = makeFakePi();
		registerMemory(pi as unknown as Parameters<typeof registerMemory>[0]);
		const tool = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0];

		const result = await tool.execute(
			"call-2",
			{ id: "nonexistent-uuid" },
			new AbortController().signal,
			() => {},
			{},
		);

		const text0 = (result.content[0] as { type: "text"; text: string }).text;
		expect(text0).toContain("atom not found");
		expect(text0).toContain("nonexistent-uuid");
		expect(result.details).toMatchObject({
			error: "not_found",
			id: "nonexistent-uuid",
		});
	});
});