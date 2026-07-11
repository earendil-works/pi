// TUI context hook — format + inject contract (Task 5.2).
//
// Per docs/sdd/changes/agent-driven-memory-save/specs/tui-webui-recall-parity/spec.md
// § "Scenario: TUI context hook delegates to recallPipeline", after task 5.1
// refactored the inline pipeline into a single `recallPipeline(...)` call,
// the hook MUST still:
//   - call `formatMemoryContext(finalResults, 4000)` and destructure `{text, used, included}`
//   - build the memory prefix:
//       `[Relevant memory context — atoms at ${atomsDir}]\n${formatted.text}\n\n[User message]\n`
//   - find the last user message index in event.messages
//   - replace that message's content with `memoryPrefix + originalContent`
//   - return `{messages: newMessages}` (a fresh array — never mutate the caller's)
//
// And separately, BEFORE handing results to formatMemoryContext, the hook MUST
// set `RecallResult.relativePath = ${type}/${id}.md` on each result. The
// format function reads this field to emit `file: <relativePath>` lines in the
// rendered block. Without the assignment, the LLM has no path to follow up on
// via the `read` tool, and the strength-feedback tool_result hook
// (memory.ts:937) cannot match any read against an atom.
//
// Why this is its own file (not an addendum to pipeline.test.ts):
//   pipeline.test.ts is structured around the pipeline stages (gate / recall
//   / rerank / format / inject). This file pins down the POST-pipeline
//   contract that survives the recall-precision refactor: the format +
//   inject step itself, independent of how the results were produced. That
//   separation makes the regression target obvious — if a future refactor
//   breaks the format+inject step but keeps the pipeline stages intact,
//   this suite turns RED while pipeline.test.ts stays green.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryAtom, RecallResult } from "../types.ts";
import type { GateDecision } from "../gate.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks — vitest hoists vi.mock() above imports, so factory values
// must come from vi.hoisted(). We mock every module memory.ts dynamically or
// statically imports for the context-hook body, so the test stays hermetic
// and does not need a real bge-m3 service or sqlite-vec install.
// ---------------------------------------------------------------------------

const mockFsSettings = vi.hoisted(() => ({
	// Default: gate + rerank both enabled. rewriteEnabled is dropped
	// intentionally — the hook defaults to true when the field is absent.
	value: JSON.stringify({
		personalAssistant: {
			memory: {
				gate: { enabled: true },
				rerank: { enabled: true },
			},
		},
	}),
}));

const mockCallGate = vi.hoisted(
	() => vi.fn<(...args: unknown[]) => Promise<GateDecision | "timeout" | "parse" | "unreachable" | null>>(),
);
const mockRerankAndFilter = vi.hoisted(() => vi.fn());
const mockFormatMemoryContext = vi.hoisted(
	() => vi.fn<(...args: unknown[]) => { text: string; used: number; included: number }>(),
);
const mockRecallAtoms = vi.hoisted(
	() => vi.fn<(...args: unknown[]) => Promise<RecallResult[]>>(),
);
const mockRewriteQueries = vi.hoisted(
	() => vi.fn<(...args: unknown[]) => Promise<string[] | { reason: string; subqueries: string[] }>>(),
);

vi.mock("node:fs", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		existsSync: () => true,
		readFileSync: () => mockFsSettings.value,
	};
});

vi.mock("../gate.ts", () => ({ callGate: mockCallGate }));
vi.mock("../rerank.ts", () => ({ rerankAndFilter: mockRerankAndFilter }));
vi.mock("../format.ts", () => ({ formatMemoryContext: mockFormatMemoryContext }));
vi.mock("../search.ts", () => ({ recallAtoms: mockRecallAtoms }));
vi.mock("../rewrite.ts", () => ({ rewriteQueries: mockRewriteQueries }));
vi.mock("../storage.ts", () => ({
	MemoryIndex: class FakeMemoryIndex {
		constructor(_dbPath: string) {
			// no-op
		}
		async init(): Promise<void> {
			// no-op
		}
		close(): void {
			// no-op
		}
	},
}));

import { registerMemory } from "../memory.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type HookHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface MockPi {
	hooks: Map<string, HookHandler>;
	on: (name: string, handler: HookHandler) => void;
	registerTool: () => void;
}

function createAtom(id: string, type: MemoryAtom["type"]): MemoryAtom {
	return {
		id,
		type,
		title: `Test ${type} ${id}`,
		content: `Content of ${id}`,
		summary: `Summary of ${id}`,
		tags: [],
		importance: 0.5,
		strength: 0.5,
		access_count: 0,
		version: 1,
		is_latest: 1 as const,
		parent_id: null,
		superseded_at: null,
		archived: 0 as const,
		created_at: Date.now(),
		updated_at: Date.now(),
		last_access: null,
		content_fingerprint: `fp_${id}`,
		source_session: null,
	};
}

/**
 * Build a recall result WITHOUT `relativePath` set. The hook must populate
 * that field before calling formatMemoryContext — that's the contract under
 * test here.
 */
function recallResult(id: string, type: MemoryAtom["type"], overrides?: Partial<RecallResult>): RecallResult {
	return {
		atom: createAtom(id, type),
		cosine: 0.9,
		sparseScore: 0.7,
		rrf: 0.5,
		rerankScore: 0.85,
		...overrides,
	};
}

function createMockPi(): MockPi {
	const hooks = new Map<string, HookHandler>();
	return {
		hooks,
		on: (name, handler) => {
			hooks.set(name, handler);
		},
		registerTool: () => {
			// no-op
		},
	};
}

function createMockCtx(): {
	ui: { setStatus: (key: string, text: string | undefined) => void };
	setStatusCalls: Array<{ key: string; text: string | undefined }>;
} {
	const setStatusCalls: Array<{ key: string; text: string | undefined }> = [];
	return {
		setStatusCalls,
		ui: {
			setStatus: (key, text) => {
				setStatusCalls.push({ key, text });
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Suite — Task 5.2 format + inject + relativePath contract.
// ---------------------------------------------------------------------------

describe("TUI context hook: format + inject contract (Task 5.2)", () => {
	let mockPi: MockPi;
	let contextHandler: HookHandler;

	beforeEach(() => {
		vi.stubEnv("HOME", "/tmp");
		mockFsSettings.value = JSON.stringify({
			personalAssistant: {
				memory: {
					gate: { enabled: true },
					rerank: { enabled: true },
				},
			},
		});

		mockCallGate.mockReset();
		mockCallGate.mockResolvedValue({ need_memory: true } satisfies GateDecision);
		mockRerankAndFilter.mockReset();
		mockRerankAndFilter.mockResolvedValue([
			recallResult("atom-1", "rule", { rerankScore: 0.92 }),
			recallResult("atom-2", "fact", { rerankScore: 0.85 }),
		]);
		mockFormatMemoryContext.mockReset();
		mockFormatMemoryContext.mockReturnValue({
			text: "formatted memory context",
			used: 80,
			included: 2,
		});
		mockRecallAtoms.mockReset();
		mockRecallAtoms.mockResolvedValue([
			recallResult("atom-1", "rule"),
			recallResult("atom-2", "fact"),
		]);
		mockRewriteQueries.mockReset();
		mockRewriteQueries.mockImplementation((query: unknown) => Promise.resolve([query as string]));

		mockPi = createMockPi();
		registerMemory(mockPi as unknown as ExtensionAPI);
		const handler = mockPi.hooks.get("context");
		if (!handler) throw new Error("context hook not registered");
		contextHandler = handler;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	// -----------------------------------------------------------------------
	// relativePath assignment — the contract under test (Task 5.2 explicitly
	// pins this down: "the TUI uses `${atomsDir}/${type}/${id}.md` path when
	// the agent calls `read` to fetch full content").
	// -----------------------------------------------------------------------
	it("assigns relativePath = `${type}/${id}.md` on each result before formatMemoryContext", async () => {
		const event = {
			messages: [{ role: "user", content: "what is the memory rule?" }],
		};
		const ctx = createMockCtx();
		await contextHandler(event, ctx);

		// formatMemoryContext must have been called.
		expect(mockFormatMemoryContext).toHaveBeenCalledTimes(1);
		const results = mockFormatMemoryContext.mock.calls[0]![0] as RecallResult[];

		// Each result MUST carry relativePath set by the hook (NOT undefined).
		// formatMemoryContext → formatMemoryBlock reads this field to emit
		// the `file: <relativePath>` line — without it the LLM has no path
		// to follow up on via the read tool, and the strength-feedback
		// tool_result hook cannot match any read against an atom.
		expect(results).toHaveLength(2);
		expect(results[0]?.relativePath).toBe("rule/atom-1.md");
		expect(results[1]?.relativePath).toBe("fact/atom-2.md");
	});

	// -----------------------------------------------------------------------
	// formatMemoryContext budget — task 5.2 spec: "formatMemoryContext(results, 4000)".
	// -----------------------------------------------------------------------
	it("calls formatMemoryContext with token budget 4000", async () => {
		const event = {
			messages: [{ role: "user", content: "what is the memory rule?" }],
		};
		const ctx = createMockCtx();
		await contextHandler(event, ctx);

		expect(mockFormatMemoryContext).toHaveBeenCalledTimes(1);
		expect(mockFormatMemoryContext.mock.calls[0]![1]).toBe(4000);
	});

	// -----------------------------------------------------------------------
	// Memory prefix format — task 5.2 spec verbatim:
	//   `[Relevant memory context — atoms at ${atomsDir}]\n${formatted.text}\n\n[User message]\n`
	// The atomsDir disclosure lets the LLM resolve `file: <relativePath>` →
	// `${atomsDir}${relativePath}` for its read tool follow-up.
	// -----------------------------------------------------------------------
	it("builds the memory prefix with atomsDir disclosure + [User message] separator", async () => {
		const event = {
			messages: [{ role: "user", content: "what is the memory rule?" }],
		};
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		const typed = result as { messages?: Array<{ role: string; content: string }> };
		const content = typed.messages![0]!.content;

		// The prefix discloses the atomsDir so the LLM can resolve
		// relativePath → absolute path for its read tool follow-up. We
		// don't pin the exact home-relative path here because
		// DEFAULT_ATOMS_DIR is captured at module load (before
		// vi.stubEnv('HOME', ...)), so the actual value depends on the
		// runner's environment. Instead, assert the structural shape:
		//   1. opening marker + closing bracket
		//   2. formatted text embedded verbatim
		//   3. trailing [User message] separator + original content
		expect(content).toMatch(
			/^\[Relevant memory context — atoms at [^\]]+\.pi\/agent\/memory\/atoms\]\n/,
		);
		expect(content).toContain("\nformatted memory context\n");
		expect(content).toMatch(/\[User message\]\nwhat is the memory rule\?$/);
	});

	// -----------------------------------------------------------------------
	// Last user message only — earlier user messages must NOT be mutated.
	// This guards against the "find wrong index" regression where the
	// injection lands on an earlier user message instead of the most recent.
	// -----------------------------------------------------------------------
	it("replaces only the LAST user message, leaving earlier ones untouched", async () => {
		const event = {
			messages: [
				{ role: "user", content: "first prompt" },
				{ role: "assistant", content: "first reply" },
				{ role: "user", content: "second prompt" },
				{ role: "assistant", content: "second reply" },
				{ role: "user", content: "current prompt" },
			],
		};
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		const typed = result as { messages?: Array<{ role: string; content: string }> };
		const msgs = typed.messages!;
		expect(msgs).toHaveLength(5);

		// First user message — untouched.
		expect(msgs[0]!.role).toBe("user");
		expect(msgs[0]!.content).toBe("first prompt");

		// Second user message — untouched.
		expect(msgs[2]!.role).toBe("user");
		expect(msgs[2]!.content).toBe("second prompt");

		// Last user message — injected.
		expect(msgs[4]!.role).toBe("user");
		expect(msgs[4]!.content).toContain("formatted memory context");
		expect(msgs[4]!.content).toContain("[User message]\ncurrent prompt");
	});

	// -----------------------------------------------------------------------
	// Immutability — non-destructive contract (memory.ts header comment:
	// "Non-destructive: original event is returned if nothing to inject").
	// The hook MUST produce a fresh messages array (or return the event
	// unchanged) so a buggy caller cannot accidentally mutate the
	// session's persisted messages.
	// -----------------------------------------------------------------------
	it("does not mutate the original event.messages array", async () => {
		const event = {
			messages: [{ role: "user", content: "current prompt" }],
		};
		const originalRef = event.messages;
		const originalContent = event.messages[0]!.content;

		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		// Original array reference unchanged.
		expect(event.messages).toBe(originalRef);
		// Original message content unchanged.
		expect(event.messages[0]!.content).toBe(originalContent);

		// Returned result is a different array reference (a fresh copy).
		const typed = result as { messages?: Array<{ role: string; content: string }> };
		expect(typed.messages).not.toBe(event.messages);
		// ...but the array length matches.
		expect(typed.messages).toHaveLength(1);
		// ...and the modified message has the prefix.
		expect(typed.messages![0]!.content).toContain("[Relevant memory context — atoms at");
		expect(typed.messages![0]!.content).toContain("[User message]\ncurrent prompt");
	});

	// -----------------------------------------------------------------------
	// Return shape — `{messages: newMessages}` per task 5.2 step 5.
	// -----------------------------------------------------------------------
	it("returns { messages: newMessages } shape", async () => {
		const event = {
			messages: [{ role: "user", content: "current prompt" }],
		};
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		const typed = result as { messages?: Array<{ role: string; content: string }> };
		expect(typed).toBeDefined();
		expect(Array.isArray(typed.messages)).toBe(true);
		expect(typed.messages).toHaveLength(1);
	});

	// -----------------------------------------------------------------------
	// Empty results — when recallPipeline returns no hits, the hook MUST
	// return the event unchanged (no inject, no format call). This protects
	// the user from a "🔍 no memory match" prompt being followed by a
	// dangling prefix block.
	// -----------------------------------------------------------------------
	it("returns event unchanged when recallPipeline returns no results (no inject)", async () => {
		mockRecallAtoms.mockResolvedValue([]);
		mockRerankAndFilter.mockResolvedValue([]);

		const event = {
			messages: [{ role: "user", content: "current prompt" }],
		};
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		// formatMemoryContext not called.
		expect(mockFormatMemoryContext).not.toHaveBeenCalled();
		// Event returned by reference (unchanged).
		expect(result).toBe(event);
	});
});