// tool_result hook — strength-feedback via `read` tool interception.
//
// Contract under test:
//   - registerMemory(pi) registers a tool_result hook via pi.on("tool_result", ...)
//   - When a read tool call targets an atom file (path under atomsDir), the hook
//     bumps access_count and stamps last_access.
//   - Non-atom-file reads, failed reads, and non-read tool calls do NOT bump.
//
// HOME mocking strategy:
//   memory.ts captures DEFAULT_DB_PATH = join(homedir(), ".pi/agent/memory/...")
//   at module load. vi.resetModules() + process.env.HOME = tmpDir make the
//   freshly-imported memory.ts capture the per-test temp path.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";

// Mock embed.ts at module level (char-bag mock, same as search.test.ts).
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

// Lazy-loaded module bindings — re-resolved in beforeEach after vi.resetModules().
type MemoryModule = typeof import("../memory.ts");
type StorageModule = typeof import("../storage.ts");
type EmbedModule = typeof import("../embed.ts");
type MemoryAtom = import("../types.ts").MemoryAtom;

let registerMemory: MemoryModule["registerMemory"];
let MemoryIndex: StorageModule["MemoryIndex"];
let embedText: EmbedModule["embedText"];

const ORIGINAL_HOME = process.env.HOME;

function makeFakePi() {
	const handlers = new Map<string, (event: any) => void | Promise<void>>();
	return {
		on: vi.fn((event: string, handler: (event: any) => void | Promise<void>) => {
			handlers.set(event, handler);
		}),
		registerTool: vi.fn(),
		_handlers: handlers,
	};
}

const sampleAtom = (overrides: Partial<MemoryAtom> = {}): MemoryAtom => ({
	id: crypto.randomUUID(),
	type: "fact",
	title: "Test Fact",
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

describe("tool_result hook (bump access_count on read)", () => {
	let dbPath: string;
	let tmpDir: string;

	beforeEach(async () => {
		vi.resetModules();

		const os = await import("node:os");
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-tool-hook-test-"));

		process.env.HOME = tmpDir;

		dbPath = path.join(tmpDir, ".pi", "agent", "memory", "memory.db");

		const memoryMod = await import("../memory.ts");
		registerMemory = memoryMod.registerMemory;
		const storageMod = await import("../storage.ts");
		MemoryIndex = storageMod.MemoryIndex;
		const embedMod = await import("../embed.ts");
		embedText = embedMod.embedText;
	});

	afterEach(async () => {
		process.env.HOME = ORIGINAL_HOME;
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("registers a tool_result hook on pi.on", () => {
		const pi = makeFakePi();
		registerMemory(pi as unknown as Parameters<typeof registerMemory>[0]);
		expect(pi.on).toHaveBeenCalledWith("tool_result", expect.any(Function));
	});

	it("bumps access_count when read targets an atom file", async () => {
		const pi = makeFakePi();
		registerMemory(pi as unknown as Parameters<typeof registerMemory>[0]);
		const handler = pi._handlers.get("tool_result")!;

		// Insert an atom.
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		const atom = sampleAtom({ title: "Fact A" });
		const text = `${atom.title}\n\n${atom.summary}\n\n${atom.content}\n\n${atom.tags.join(" ")}`;
		const emb = await embedText(text);
		if (!emb) throw new Error("mocked embedText returned null");
		await idx.insertAtom(atom, emb);
		idx.close();

		// Fire the hook with a read event targeting the atom file.
		const atomsDir = path.join(tmpDir, ".pi", "agent", "memory", "atoms");
		const atomPath = path.join(atomsDir, atom.type, `${atom.id}.md`);
		await handler({
			type: "tool_result",
			toolName: "read",
			toolCallId: "call-1",
			input: { path: atomPath },
			content: [{ type: "text", text: "file content" }],
			isError: false,
			details: undefined,
		});

		// Verify access_count bumped.
		const idx2 = new MemoryIndex(dbPath);
		await idx2.init();
		const got = idx2.getAtom(atom.id);
		expect(got?.access_count).toBe(1);
		expect(got?.last_access).not.toBeNull();
		expect(typeof got?.last_access).toBe("number");
		idx2.close();
	});

	it("handles ~/ path expansion", async () => {
		const pi = makeFakePi();
		registerMemory(pi as unknown as Parameters<typeof registerMemory>[0]);
		const handler = pi._handlers.get("tool_result")!;

		const idx = new MemoryIndex(dbPath);
		await idx.init();
		const atom = sampleAtom();
		const text = `${atom.title}\n\n${atom.summary}\n\n${atom.content}\n\n${atom.tags.join(" ")}`;
		const emb = await embedText(text);
		if (!emb) throw new Error("mocked embedText returned null");
		await idx.insertAtom(atom, emb);
		idx.close();

		// Use ~/ path instead of absolute.
		const relativePath = `~/.pi/agent/memory/atoms/${atom.type}/${atom.id}.md`;
		await handler({
			type: "tool_result",
			toolName: "read",
			toolCallId: "call-2",
			input: { path: relativePath },
			content: [{ type: "text", text: "content" }],
			isError: false,
			details: undefined,
		});

		const idx2 = new MemoryIndex(dbPath);
		await idx2.init();
		const got = idx2.getAtom(atom.id);
		expect(got?.access_count).toBe(1);
		idx2.close();
	});

	it("does NOT bump for non-atom file reads", async () => {
		const pi = makeFakePi();
		registerMemory(pi as unknown as Parameters<typeof registerMemory>[0]);
		const handler = pi._handlers.get("tool_result")!;

		const idx = new MemoryIndex(dbPath);
		await idx.init();
		const atom = sampleAtom();
		const text = `${atom.title}\n\n${atom.summary}\n\n${atom.content}\n\n${atom.tags.join(" ")}`;
		const emb = await embedText(text);
		if (!emb) throw new Error("mocked embedText returned null");
		await idx.insertAtom(atom, emb);
		idx.close();

		await handler({
			type: "tool_result",
			toolName: "read",
			toolCallId: "call-3",
			input: { path: "/tmp/some-other-file.txt" },
			content: [{ type: "text", text: "content" }],
			isError: false,
			details: undefined,
		});

		const idx2 = new MemoryIndex(dbPath);
		await idx2.init();
		const got = idx2.getAtom(atom.id);
		expect(got?.access_count).toBe(0);
		idx2.close();
	});

	it("does NOT bump when read is an error", async () => {
		const pi = makeFakePi();
		registerMemory(pi as unknown as Parameters<typeof registerMemory>[0]);
		const handler = pi._handlers.get("tool_result")!;

		const idx = new MemoryIndex(dbPath);
		await idx.init();
		const atom = sampleAtom();
		const text = `${atom.title}\n\n${atom.summary}\n\n${atom.content}\n\n${atom.tags.join(" ")}`;
		const emb = await embedText(text);
		if (!emb) throw new Error("mocked embedText returned null");
		await idx.insertAtom(atom, emb);
		idx.close();

		const atomsDir = path.join(tmpDir, ".pi", "agent", "memory", "atoms");
		const atomPath = path.join(atomsDir, atom.type, `${atom.id}.md`);
		await handler({
			type: "tool_result",
			toolName: "read",
			toolCallId: "call-4",
			input: { path: atomPath },
			content: [{ type: "text", text: "error" }],
			isError: true,
			details: undefined,
		});

		const idx2 = new MemoryIndex(dbPath);
		await idx2.init();
		const got = idx2.getAtom(atom.id);
		expect(got?.access_count).toBe(0);
		idx2.close();
	});

	it("does NOT bump for non-read tool results", async () => {
		const pi = makeFakePi();
		registerMemory(pi as unknown as Parameters<typeof registerMemory>[0]);
		const handler = pi._handlers.get("tool_result")!;

		const idx = new MemoryIndex(dbPath);
		await idx.init();
		const atom = sampleAtom();
		const text = `${atom.title}\n\n${atom.summary}\n\n${atom.content}\n\n${atom.tags.join(" ")}`;
		const emb = await embedText(text);
		if (!emb) throw new Error("mocked embedText returned null");
		await idx.insertAtom(atom, emb);
		idx.close();

		await handler({
			type: "tool_result",
			toolName: "bash",
			toolCallId: "call-5",
			input: { command: `cat ${tmpDir}/.pi/agent/memory/atoms/${atom.type}/${atom.id}.md` },
			content: [{ type: "text", text: "content" }],
			isError: false,
			details: undefined,
		});

		const idx2 = new MemoryIndex(dbPath);
		await idx2.init();
		const got = idx2.getAtom(atom.id);
		expect(got?.access_count).toBe(0);
		idx2.close();
	});
});
