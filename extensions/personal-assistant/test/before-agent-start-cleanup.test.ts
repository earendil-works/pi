// before_agent_start hook — Task 5.1 cleanup-only contract.
//
// After Task 5.1 (recall-precision branch, design.md D1), the
// `before_agent_start` hook in memory.ts MUST be reduced to a single
// responsibility: clear the module-level `pendingMemorySearches` Map so
// stale state does not leak between sessions. The recall pipeline
// (search.ts / format.ts / gate / rerank) has moved to the context hook
// (Task 5.2) because the gate logic needs `messages[]`, which only the
// context hook exposes.
//
// What this suite pins down:
//
//   R5 / delta-spec: before_agent_start hook SHALL 退化为
//   module-level pendingMemorySearches Map cleanup, 不再触发 recall.
//
// Concretely:
//
//   1. The hook IS still registered (preserved so the extension does not
//      log "unhandled before_agent_start" warnings — the principle
//      "8. 不破坏向后兼容" applies).
//   2. The hook does NOT trigger `recallAtoms` (the dynamic import of
//      search.ts no longer runs from before_agent_start).
//   3. The hook does NOT call `ctx.ui.setStatus("memory", ...)` — that
//      TUI status indicator moves to the new context hook.
//   4. The hook does NOT populate `pendingMemorySearches` (which is the
//      observable side effect of the recall pipeline — once recall is
//      gone, the Map stays empty after the hook fires).
//   5. The hook does NOT throw on empty / undefined prompts (defensive —
//      the prior implementation early-returned on empty prompts and the
//      new cleanup body must keep that property).
//
// Why this test file (instead of extending before-agent-start.test.ts):
//   before-agent-start.test.ts asserts the OLD behaviour where
//   before_agent_start kicks off the recall pipeline. That contract moves
//   to the context hook in Task 5.2. Keeping the two contracts in
//   separate files makes the migration legible: this file pins down the
//   minimal cleanup-only contract; task 5.2 will pin down the new
//   context-hook-driven recall.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Mock the modules that the OLD before_agent_start hook dynamically
// imported. After Task 5.1 these imports are gone from the
// before_agent_start body, so the mocks simply must NOT be touched by
// the new hook. We keep them to assert that observation.
vi.mock("../search.ts", () => ({
	recallAtoms: vi.fn(async () => []),
}));

vi.mock("../format.ts", () => ({
	formatMemoryContext: vi.fn(() => ({ text: "", used: 0, included: 0 })),
}));

// Storage mock — defensive: the OLD hook opened a MemoryIndex; the new
// hook does not. The mock keeps the module load path valid in case any
// unrelated code path still imports it.
vi.mock("../storage.ts", () => ({
	MemoryIndex: class FakeMemoryIndex {
		dbPath: string;
		constructor(dbPath: string) {
			this.dbPath = dbPath;
		}
		async init(): Promise<void> {
			// no-op
		}
		close(): void {
			// no-op
		}
	},
}));

import { recallAtoms } from "../search.ts";
import { formatMemoryContext } from "../format.ts";
import { registerMemory } from "../memory.ts";

type HookHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface SetStatusCall {
	key: string;
	text: string | undefined;
}

interface MockPi {
	hooks: Map<string, HookHandler>;
	on: (hookName: string, handler: HookHandler) => void;
	registerTool: (tool: unknown) => void;
}

interface MockCtx {
	ui: {
		setStatus: (key: string, text: string | undefined) => void;
	};
}

function createMockPi(): MockPi {
	const hooks = new Map<string, HookHandler>();
	return {
		hooks,
		on: (hookName, handler) => {
			hooks.set(hookName, handler);
		},
		registerTool: () => {
			// no-op — tool tests live in this file's sibling suite if added later
		},
	};
}

function createMockCtx(): MockCtx & { setStatusCalls: SetStatusCall[] } {
	const calls: SetStatusCall[] = [];
	return {
		setStatusCalls: calls,
		ui: {
			setStatus: (key, text) => {
				calls.push({ key, text });
			},
		},
	};
}

describe("before_agent_start hook (Task 5.1 cleanup-only)", () => {
	let mockPi: MockPi;
	let mockCtx: MockCtx & { setStatusCalls: SetStatusCall[] };
	let beforeHandler: HookHandler;

	// The OLD before_agent_start body fired the recall pipeline as an
	// async IIFE (fire-and-forget) — `await beforeHandler(...)` only
	// awaited the outer shell, not the IIFE. To assert "no recall was
	// triggered", we need to give the IIFE a chance to run its microtasks
	// first; otherwise the assertion is racy and trivially green.
	//
	// `flushMicrotasks` drains the event loop enough times for any
	// pending `await import(...)`, `await recallAtoms(...)`, and
	// `ctx.ui.setStatus(...)` calls inside the OLD body to complete.
	// Five `setImmediate` ticks is generous — the mock pipeline
	// (init → dynamic import → recallAtoms → setStatus) resolves in
	// 3-4 ticks in practice.
	async function flushMicrotasks(): Promise<void> {
		for (let i = 0; i < 5; i++) {
			await new Promise((r) => setImmediate(r));
		}
	}

	beforeEach(() => {
		mockPi = createMockPi();
		mockCtx = createMockCtx();
		// Reset mocks between tests so per-test overrides do not leak.
		vi.mocked(recallAtoms).mockReset();
		vi.mocked(recallAtoms).mockResolvedValue([]);
		vi.mocked(formatMemoryContext).mockReset();
		vi.mocked(formatMemoryContext).mockReturnValue({
			text: "",
			used: 0,
			included: 0,
		});
		// Redirect homedir so an accidental DB write targets /tmp.
		vi.stubEnv("HOME", "/tmp");

		registerMemory(mockPi as unknown as ExtensionAPI);
		const handler = mockPi.hooks.get("before_agent_start");
		if (!handler) throw new Error("before_agent_start hook not registered");
		beforeHandler = handler;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	// R5 / principle 8: hook is preserved so the extension does not log
	// "unhandled before_agent_start" warnings.
	it("registers before_agent_start hook (preserved)", () => {
		expect(mockPi.hooks.has("before_agent_start")).toBe(true);
	});

	// R5 / D1: recall pipeline moved to context hook — the new
	// before_agent_start MUST NOT import search.ts.
	it("does NOT call recallAtoms when fired with a non-empty prompt", async () => {
		await beforeHandler({ prompt: "what did we decide about X?" }, mockCtx);
		await flushMicrotasks();

		expect(vi.mocked(recallAtoms)).not.toHaveBeenCalled();
	});

	// R5 / D1: the new context hook will own the memory status indicator.
	// before_agent_start MUST NOT call setStatus("memory", ...) — that
	// key is the context hook's responsibility now.
	it("does NOT call ctx.ui.setStatus('memory', ...) when fired with a non-empty prompt", async () => {
		await beforeHandler({ prompt: "what did we decide about X?" }, mockCtx);
		await flushMicrotasks();

		const memoryCalls = mockCtx.setStatusCalls.filter((c) => c.key === "memory");
		expect(memoryCalls).toHaveLength(0);
	});

	// Empty prompts MUST NOT throw — the prior body early-returned on
	// empty prompts and the new cleanup body must keep that contract
	// (otherwise a malformed before_agent_start event could crash the
	// extension loader).
	it("does NOT throw when fired with an empty prompt", async () => {
		await expect(beforeHandler({ prompt: "" }, mockCtx)).resolves.toBeUndefined();
		await flushMicrotasks();
		expect(vi.mocked(recallAtoms)).not.toHaveBeenCalled();
		expect(mockCtx.setStatusCalls).toHaveLength(0);
	});

	// Defense against future regressions where someone re-adds the recall
	// body: even with a "would normally inject" prompt, the hook body
	// stays silent.
	it("does NOT populate any side-effects across multiple fires", async () => {
		await beforeHandler({ prompt: "first prompt" }, mockCtx);
		await beforeHandler({ prompt: "second prompt" }, mockCtx);
		await beforeHandler({ prompt: "" }, mockCtx);
		await flushMicrotasks();

		expect(vi.mocked(recallAtoms)).not.toHaveBeenCalled();
		expect(vi.mocked(formatMemoryContext)).not.toHaveBeenCalled();
		expect(mockCtx.setStatusCalls).toHaveLength(0);
	});

	// Indirect observation of pendingMemorySearches cleanup. The map is
	// module-level and not exported, so we exercise it through the
	// context hook: after before_agent_start fires (and clears the map),
	// the context hook must still return the event unchanged when no
	// recall has been queued. If cleanup accidentally threw, this would
	// surface as a thrown promise; if cleanup left the map in a bad
	// state, the context hook would behave unexpectedly.
	it("context hook after before_agent_start still returns event unchanged (cleanup did not corrupt state)", async () => {
		const ctxHandler = mockPi.hooks.get("context");
		if (!ctxHandler) throw new Error("context hook not registered");

		await beforeHandler({ prompt: "test prompt" }, mockCtx);
		await flushMicrotasks();

		const event = { messages: [{ role: "user", content: "test prompt" }] };
		const result = await ctxHandler(event, mockCtx);

		// No recall was queued (the new hook does not queue anything),
		// so context returns the event unchanged.
		expect(result).toBe(event);
	});
});