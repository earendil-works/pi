// before_agent_start + context hooks — TDD v1.
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
	it("context hook returns event unchanged if no pending search", async () => {
		registerMemory(mockPi as unknown as ExtensionAPI);
		const ctxHandler = mockPi.hooks.get("context");
		expect(ctxHandler).toBeDefined();
		const event = { messages: [{ role: "user", content: "hello" }] };
		const result = await ctxHandler!(event, {});
		expect(result).toBe(event);
	});

	// Pending search with results → last user message is mutated, prefix
	// contains [Relevant memory context] and the formatted text, suffix
	// contains the original user content.
	it("context hook injects memory block into last user message after pending search", async () => {
		// Configure mocks to return a non-empty formatted result.
		vi.mocked(recallAtoms).mockResolvedValueOnce([
			{ atom: { id: "a1", type: "preference", content: "user prefers ts" }, distance: 0.1, cosine: 0.95, tier: "L0" },
		] as any);
		vi.mocked(formatMemoryContext).mockReturnValueOnce({
			text: "user prefers ts",
			used: 3,
			included: 1,
		});

		registerMemory(mockPi as unknown as ExtensionAPI);
		const beforeHandler = mockPi.hooks.get("before_agent_start");
		const ctxHandler = mockPi.hooks.get("context");
		expect(beforeHandler).toBeDefined();
		expect(ctxHandler).toBeDefined();

		// Kick off the async recall via before_agent_start.
		await beforeHandler!({ prompt: "test prompt" }, createMockCtx());

		// Context awaits the pending search and injects.
		const event = { messages: [{ role: "user", content: "hello" }] };
		const result = await ctxHandler!(event, {});

		// Result must be a new event (mutated messages array), not the same ref.
		expect(result).not.toBe(event);
		const newMessages = (result as { messages: Array<{ role: string; content: string }> }).messages;
		expect(Array.isArray(newMessages)).toBe(true);
		expect(newMessages.length).toBe(1);
		const newContent = newMessages[0].content;
		expect(typeof newContent).toBe("string");
		expect(newContent).toContain("[Relevant memory context]");
		expect(newContent).toContain("user prefers ts");
		expect(newContent).toContain("hello");
		// Prefix must come before the original content.
		const prefixIdx = newContent.indexOf("[Relevant memory context]");
		const originalIdx = newContent.indexOf("hello");
		expect(prefixIdx).toBeLessThan(originalIdx);
		// recallAtoms was called with the user prompt.
		expect(vi.mocked(recallAtoms)).toHaveBeenCalledTimes(1);
	});

	// Pending search with no usable text (formatMemoryContext returns empty)
	// → event is returned unchanged (nothing to inject).
	it("context hook returns event unchanged when pending search returns no formatted text", async () => {
		// recallAtoms returns nothing meaningful, formatMemoryContext returns
		// empty text. This is the "no relevant memory" case — must be
		// non-destructive.
		vi.mocked(recallAtoms).mockResolvedValueOnce([]);
		vi.mocked(formatMemoryContext).mockReturnValueOnce({ text: "", used: 0, included: 0 });

		registerMemory(mockPi as unknown as ExtensionAPI);
		const beforeHandler = mockPi.hooks.get("before_agent_start");
		const ctxHandler = mockPi.hooks.get("context");

		await beforeHandler!({ prompt: "test prompt" }, createMockCtx());
		const event = { messages: [{ role: "user", content: "hello" }] };
		const result = await ctxHandler!(event, {});

		expect(result).toBe(event);
	});

	// Pending search where messages have no user-role message → event is
	// returned unchanged.
	it("context hook returns event unchanged when no user message exists", async () => {
		vi.mocked(recallAtoms).mockResolvedValueOnce([{ atom: { id: "a1" }, distance: 0.1, cosine: 0.95, tier: "L0" }] as any);
		vi.mocked(formatMemoryContext).mockReturnValueOnce({ text: "memory", used: 1, included: 1 });

		registerMemory(mockPi as unknown as ExtensionAPI);
		const beforeHandler = mockPi.hooks.get("before_agent_start");
		const ctxHandler = mockPi.hooks.get("context");

		await beforeHandler!({ prompt: "test prompt" }, createMockCtx());
		const event = { messages: [{ role: "assistant", content: "hi" }] };
		const result = await ctxHandler!(event, {});

		expect(result).toBe(event);
	});

	// Pending search with no prompt in before_agent_start → no work queued,
	// context returns event unchanged.
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
