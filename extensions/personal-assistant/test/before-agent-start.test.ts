// before_agent_start + context hooks — TDD v1 (pre-recall-precision).
//
// Verifies the v2 memory.ts hook surface additions for memory-context
// injection (Task 8.2):
//   - registerMemory registers two new hooks: before_agent_start + context.
//   - context returns the event unchanged when no memory search is pending.
//   - context awaits the pending search and injects the formatted memory
//     block into the last user message of the event.
//
// Why this is the test file shape:
//   - The 2 new hooks are part of the public registerMemory(pi) contract.
//     R62 requires they be registered; S69/S70 require they behave correctly.
//   - We do not exercise the real MemoryIndex path (would require ollama +
//     sqlite-vec). Instead we mock the dynamic imports recallAtoms +
//     formatMemoryContext so the hook body is hermetic.
//
// recall-precision Task 5.1 (simplify before_agent_start to cleanup-only):
//   The OLD before_agent_start body that fired the recall pipeline is gone —
//   recall has moved to the context hook (Task 5.2). The tests in this
//   file that exercised the recall-from-before_agent_start contract have
//   been removed; the cleanup-only contract is now pinned down in
//   test/before-agent-start-cleanup.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Mock the modules that memory.ts dynamically imports at hook-fire time.
// Vitest hoists vi.mock to the top of the file, so these apply to the
// dynamic `await import("./search.ts")` and `await import("./format.ts")`
// inside the hook bodies. The factories return plain objects with the
// single function memory.ts pulls out of each module.
vi.mock("../search.ts", () => ({
	recallAtoms: vi.fn(async () => []),
}));

vi.mock("../format.ts", () => ({
	formatMemoryContext: vi.fn(() => ({ text: "", used: 0, included: 0 })),
}));

// Mock the static imports in memory.ts so the hook body does not try to
// open a real sqlite database during a unit test. We keep the public shape
// (init / close are async / sync no-ops) so the existing try/finally in
// the hook body still runs cleanly.
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

// Reach into the mocked modules to control per-test return values.
import { recallAtoms } from "../search.ts";
import { formatMemoryContext } from "../format.ts";

// Re-import registerMemory fresh per describe — pendingMemorySearch is a
// module-level variable in memory.ts, so we reset modules to start each
// test with a clean slate. The static import below is for typing; the
// actual registerMemory used in tests comes from the freshly-imported
// module after resetModules.
import { registerMemory } from "../memory.ts";

type HookHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface MockPi {
	hooks: Map<string, HookHandler>;
	on: (hookName: string, handler: HookHandler) => void;
	// `memory_get` tool registration (Task 5.1) — this suite focuses on
	// the hook surface, not the tool, so we only need a no-op to keep
	// `registerMemory` happy when it calls `pi.registerTool`.
	registerTool: (tool: unknown) => void;
}

function createMockPi(): MockPi {
	const hooks = new Map<string, HookHandler>();
	return {
		hooks,
		on: (hookName, handler) => {
			hooks.set(hookName, handler);
		},
		registerTool: () => {
			// no-op — tool assertions live in test/memory-tool.test.ts
		},
	};
}

// Minimal ExtensionContext mock for hook handlers. The before_agent_start
// hook now calls `ctx.ui.setStatus("memory", ...)` to surface the recall
// status in the TUI footer (see memory-status.test.ts for the indicator
// contract). Older tests in this file pass `{}` for ctx; we keep them
// intact and only provide this minimal ctx where the hook is fired and
// the status path runs.
function createMockCtx(): { ui: { setStatus: (key: string, text: string | undefined) => void } } {
	return {
		ui: {
			setStatus: () => {
				// no-op — status assertions live in memory-status.test.ts
			},
		},
	};
}

describe("before_agent_start + context hooks", () => {
	let mockPi: MockPi;

	beforeEach(() => {
		mockPi = createMockPi();
		// Reset mocks between tests so per-test overrides do not leak.
		vi.mocked(recallAtoms).mockReset();
		vi.mocked(formatMemoryContext).mockReset();
		// Default: no recall results, empty formatted text.
		vi.mocked(recallAtoms).mockResolvedValue([]);
		vi.mocked(formatMemoryContext).mockReturnValue({ text: "", used: 0, included: 0 });
		// Redirect homedir so an accidental DB write targets /tmp.
		vi.stubEnv("HOME", "/tmp");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	// R62 — before_agent_start hook is registered.
	it("registers before_agent_start hook (R62 / S69)", () => {
		registerMemory(mockPi as unknown as ExtensionAPI);
		expect(mockPi.hooks.has("before_agent_start")).toBe(true);
	});

	// R62 — context hook is registered.
	it("registers context hook (R62 / S70)", () => {
		registerMemory(mockPi as unknown as ExtensionAPI);
		expect(mockPi.hooks.has("context")).toBe(true);
	});

	// No pending search → event is returned unchanged (non-destructive).
	//
	// recall-precision Task 5.1: recall no longer fires from
	// before_agent_start, so the context hook always sees an empty
	// pendingMemorySearches map and returns the event unchanged.
	// The "context injects after pending search" scenario is now
	// pinned down by the context-hook integration test in Task 5.2.
	it("context hook returns event unchanged if no pending search", async () => {
		registerMemory(mockPi as unknown as ExtensionAPI);
		const ctxHandler = mockPi.hooks.get("context");
		expect(ctxHandler).toBeDefined();
		const event = { messages: [{ role: "user", content: "hello" }] };
		const result = await ctxHandler!(event, {});
		expect(result).toBe(event);
	});

	// recall-precision Task 5.1: before_agent_start no longer triggers
	// recall, so even an empty prompt must produce zero side effects.
	// The "no pending search queued" half of the contract is also
	// asserted in before-agent-start-cleanup.test.ts.
	it("before_agent_start with empty prompt does not queue a search", async () => {
		registerMemory(mockPi as unknown as ExtensionAPI);
		const beforeHandler = mockPi.hooks.get("before_agent_start");
		const ctxHandler = mockPi.hooks.get("context");

		await beforeHandler!({ prompt: "" }, {});
		const event = { messages: [{ role: "user", content: "hello" }] };
		const result = await ctxHandler!(event, {});

		// No pending search → context is non-destructive.
		expect(result).toBe(event);
		// recallAtoms was never called.
		expect(vi.mocked(recallAtoms)).not.toHaveBeenCalled();
	});
});

// recall-precision Task 5.1 removed the entire second describe block
// ("before_agent_start recall config wiring (Task 4.2)") and the
// "recallAtoms is called with topK: 20..." test from the first block
// because every assertion in them depended on before_agent_start invoking
// recallAtoms. The recall config-wiring contract moves with the recall
// pipeline into the new context hook (Task 5.2).
