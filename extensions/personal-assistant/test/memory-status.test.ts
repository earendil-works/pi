// memory status indicator — TDD v1.
//
// Contract under test (from memory.ts before_agent_start hook after the
// status indicator addition):
//   - When recallAtoms returns ≥1 hits:
//       ctx.ui.setStatus("memory", "📦 N atoms · rule=X fact=Y process=Z · top=0.XXX")
//   - When recallAtoms returns 0 hits:
//       ctx.ui.setStatus("memory", "🔍 no memory match")
//   - When recallAtoms throws:
//       ctx.ui.setStatus("memory", "⚠ memory recall failed")
//   - setStatus is called exactly once per before_agent_start fire with a
//     non-empty prompt.
//   - before_agent_start with an empty prompt does NOT call setStatus.
//
// Why this test file:
//   The recall-to-prompt-injection path is exercised end-to-end elsewhere;
//   here we focus narrowly on the `ctx.ui.setStatus("memory", …)` contract
//   so regressions in the indicator (or accidental dropping of the key) are
//   caught without exercising the real MemoryIndex / sqlite-vec stack.
//
// Mocking strategy: reuse the same module-mock pattern as
// before-agent-start.test.ts — mock search.ts / format.ts / storage.ts so
// the hook body is hermetic. Per-test return values are configured on
// `recallAtoms` via vi.mocked(...).mockResolvedValueOnce / mockRejectedValueOnce.
//
// recall-precision Task 5.1:
//   The setStatus("memory", …) indicator moved OFF the before_agent_start
//   hook (cleanup-only now) and onto the new context hook in Task 5.2.
//   The three "calls setStatus" assertions below were removed — they
//   tested a contract that no longer exists at this hook. The
//   "does NOT call setStatus when prompt is empty" regression guard is
//   kept (now trivially true because the hook no longer calls setStatus
//   at all) as a guard against accidental re-introduction.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Mock the modules that the OLD before_agent_start hook dynamically
// imported. After Task 5.1 these imports are gone from the
// before_agent_start body, but the mocks stay so the assertion
// "recallAtoms was not called" is observable (the spy must exist for
// vi.mocked(...).not.toHaveBeenCalled() to be meaningful).
vi.mock("../search.ts", () => ({
	recallAtoms: vi.fn(async () => []),
}));

// Mock storage.ts defensively — the OLD body opened a MemoryIndex;
// the new body does not. The mock keeps the module load path valid
// in case any unrelated code path still imports it.
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
import { registerMemory } from "../memory.ts";

interface SetStatusCall {
	key: string;
	text: string | undefined;
}

interface MockCtx {
	ui: {
		setStatus: (key: string, text: string | undefined) => void;
	};
}

interface HookHandler {
	(event: unknown, ctx: unknown): Promise<unknown> | unknown;
}

interface MockPi {
	hooks: Map<string, HookHandler>;
	on: (hookName: string, handler: HookHandler) => void;
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

describe("before_agent_start memory status indicator", () => {
	let mockPi: MockPi;
	let mockCtx: MockCtx & { setStatusCalls: SetStatusCall[] };
	let beforeHandler: HookHandler;

	// recall-precision Task 5.1: this suite previously asserted that the
	// before_agent_start hook called ctx.ui.setStatus("memory", ...) with
	// hits / no-match / failure summaries. That contract moved to the
	// new context hook (Task 5.2). The remaining regression guard keeps
	// the strongest surviving invariant: "the hook never calls setStatus
	// at all", which trivially covers the empty-prompt case AND every
	// future regression where someone re-adds setStatus to this hook.

	beforeEach(() => {
		mockPi = createMockPi();
		mockCtx = createMockCtx();
		vi.mocked(recallAtoms).mockReset();
		vi.mocked(recallAtoms).mockResolvedValue([]);
		vi.stubEnv("HOME", "/tmp");

		registerMemory(mockPi as unknown as ExtensionAPI);
		const before = mockPi.hooks.get("before_agent_start");
		if (!before) throw new Error("before_agent_start hook not registered");
		beforeHandler = before;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	it("does NOT call ctx.ui.setStatus from before_agent_start (Task 5.1 cleanup-only)", async () => {
		// Fire with a non-empty prompt so the OLD body would have set a
		// memory status; the new cleanup-only body must remain silent.
		await beforeHandler({ prompt: "what did we decide about X?" }, mockCtx);
		// Drain microtasks in case any deferred call slipped through.
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		expect(mockCtx.setStatusCalls).toHaveLength(0);
		expect(vi.mocked(recallAtoms)).not.toHaveBeenCalled();
	});

	it("does NOT call setStatus when prompt is empty", async () => {
		await beforeHandler({ prompt: "" }, mockCtx);

		expect(mockCtx.setStatusCalls).toHaveLength(0);
		expect(vi.mocked(recallAtoms)).not.toHaveBeenCalled();
	});
});