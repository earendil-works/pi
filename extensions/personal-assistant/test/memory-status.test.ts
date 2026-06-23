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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Mock the modules that memory.ts dynamically imports at hook-fire time.
vi.mock("../search.ts", () => ({
	recallAtoms: vi.fn(async () => []),
}));

vi.mock("../format.ts", () => ({
	formatMemoryContext: vi.fn(() => ({ text: "", used: 0, included: 0 })),
}));

// Mock storage.ts so the hook body does not open a real sqlite DB.
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
			// no-op — tool assertions live in test/memory-tool.test.ts
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

// Build a fully-shaped RecallResult so the indicator math (byType, topScore)
// has the real fields it touches. RecallResult = { atom, distance, cosine, score }.
function makeRecallResult(overrides: {
	id: string;
	type: "rule" | "fact" | "process";
	score: number;
}) {
	return {
		atom: {
			id: overrides.id,
			type: overrides.type,
			title: `t-${overrides.id}`,
			content: "c",
			summary: "s",
			tags: [],
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
		},
		distance: 0.5,
		cosine: 0.5,
		score: overrides.score,
	};
}

describe("before_agent_start memory status indicator", () => {
	let mockPi: MockPi;
	let mockCtx: MockCtx & { setStatusCalls: SetStatusCall[] };
	let beforeHandler: HookHandler;
	let contextHandler: HookHandler;

	beforeEach(() => {
		mockPi = createMockPi();
		mockCtx = createMockCtx();
		vi.mocked(recallAtoms).mockReset();
		vi.mocked(recallAtoms).mockResolvedValue([]);
		vi.stubEnv("HOME", "/tmp");

		registerMemory(mockPi as unknown as ExtensionAPI);
		const before = mockPi.hooks.get("before_agent_start");
		const ctx = mockPi.hooks.get("context");
		if (!before) throw new Error("before_agent_start hook not registered");
		if (!ctx) throw new Error("context hook not registered");
		beforeHandler = before;
		contextHandler = ctx;
	});

	// Drain the pending recall before asserting. The before_agent_start hook
	// fires the recall as a fire-and-forget promise and only stashes it in
	// `pendingMemorySearches`; the context hook awaits that promise. Calling
	// the context hook with a matching user message forces the recall to
	// drain before setStatus is observed.
	async function fireAndDrain(prompt: string): Promise<void> {
		await beforeHandler({ prompt }, mockCtx);
		await contextHandler({ messages: [{ role: "user", content: prompt }] }, mockCtx);
	}

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	it("calls setStatus('memory', ...) with hits summary when recall returns atoms", async () => {
		vi.mocked(recallAtoms).mockResolvedValueOnce([
			makeRecallResult({ id: "a1", type: "rule", score: 0.9 }),
			makeRecallResult({ id: "b1", type: "fact", score: 0.7 }),
			makeRecallResult({ id: "c1", type: "process", score: 0.5 }),
		] as never);

		await fireAndDrain("test prompt");

		expect(mockCtx.setStatusCalls).toHaveLength(1);
		const call = mockCtx.setStatusCalls[0];
		expect(call.key).toBe("memory");
		expect(call.text).toMatch(/^📦 3 atoms · rule=1 fact=1 process=1 · top=0\.900$/);
	});

	it("calls setStatus('memory', '🔍 no memory match') when recall returns empty", async () => {
		vi.mocked(recallAtoms).mockResolvedValueOnce([]);

		await fireAndDrain("test prompt");

		expect(mockCtx.setStatusCalls).toHaveLength(1);
		expect(mockCtx.setStatusCalls[0]).toEqual({
			key: "memory",
			text: "🔍 no memory match",
		});
	});

	it("calls setStatus('memory', '⚠ memory recall failed') when recall throws", async () => {
		vi.mocked(recallAtoms).mockRejectedValueOnce(new Error("sqlite boom"));

		// Fire the hook (which queues the IIFE) and let the rejection propagate
		// through the pending promise. We must NOT use fireAndDrain here because
		// the context handler re-throws the pending rejection, which would
		// surface as a failing assertion. setStatus is called inside the catch
		// block before the re-throw, so a microtask flush is enough to observe
		// the call. Attach an unhandled-rejection guard so the test runner
		// doesn't fail on the expected rejection.
		const unhandled: unknown[] = [];
		const onUnhandled = (r: { reason: unknown }) => unhandled.push(r.reason);
		process.on("unhandledRejection", onUnhandled);

		try {
			await beforeHandler({ prompt: "test prompt" }, mockCtx);
			// Two microtask flushes: one for index.init(), one for the dynamic
			// import, one for recallAtoms → catch → setStatus.
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			expect(mockCtx.setStatusCalls).toHaveLength(1);
			expect(mockCtx.setStatusCalls[0]).toEqual({
				key: "memory",
				text: "⚠ memory recall failed",
			});
		} finally {
			process.off("unhandledRejection", onUnhandled);
			// The pending promise rejection will eventually fire unhandled; we
			// recorded it above so it doesn't trip the runner. No additional
			// assertion needed — the contract is that setStatus fired before
			// the re-throw, which we already verified above.
		}
	});

	it("does NOT call setStatus when prompt is empty", async () => {
		await beforeHandler({ prompt: "" }, mockCtx);

		expect(mockCtx.setStatusCalls).toHaveLength(0);
		expect(vi.mocked(recallAtoms)).not.toHaveBeenCalled();
	});

	it("counts rule/fact/process independently in the indicator", async () => {
		vi.mocked(recallAtoms).mockResolvedValueOnce([
			makeRecallResult({ id: "r1", type: "rule", score: 0.6 }),
			makeRecallResult({ id: "r2", type: "rule", score: 0.5 }),
			makeRecallResult({ id: "f1", type: "fact", score: 0.4 }),
		] as never);

		await fireAndDrain("test prompt");

		expect(mockCtx.setStatusCalls).toHaveLength(1);
		expect(mockCtx.setStatusCalls[0].text).toBe(
			"📦 3 atoms · rule=2 fact=1 process=0 · top=0.600",
		);
	});
});