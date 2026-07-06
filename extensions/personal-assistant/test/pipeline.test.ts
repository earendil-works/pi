// Pipeline integration test — context hook gate→recall→rerank→format→inject.
//
// Tests the end-to-end flow through the context hook body (pi.on("context", …))
// in memory.ts, using mocked modules for all external dependencies:
//
//   - node:fs (existsSync / readFileSync) — controlled by mockFsConfig
//   - callGate    (gate.ts)     — dynamic import, mocked per test
//   - recallAtoms (search.ts)   — static import, mocked per test
//   - rerankAndFilter (rerank.ts) — dynamic import, mocked per test
//   - formatMemoryContext (format.ts) — dynamic import, mocked per test
//   - MemoryIndex (storage.ts)  — fake no-op class
//
// Scenarios covered (from spec):
//   P1 — happy path: gate pass → recall → rerank → format → inject
//   P4 — idempotent: 2 calls produce same result
//   P5 — gate.enabled=false → skip gate, pipeline continues
//   P6 — rerank.enabled=false → skip rerank
//   S1 — gate skip: need_memory=false → no inject
//   S6 — gate timeout: callGate returns null → no inject

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryAtom, RecallResult } from "../types.ts";
import type { GateDecision } from "../gate.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks — vitest hoists vi.mock() above imports, so factory values
// must come from vi.hoisted(). We use mutable references updated in each
// test via beforeEach.
// ---------------------------------------------------------------------------

/** Controls what loadConfig() sees when it reads settings.json. */
const mockFsSettings = vi.hoisted(() => ({
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

// Mock node:fs so loadConfig reads our controlled settings JSON.
vi.mock("node:fs", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		existsSync: () => true,
		readFileSync: () => mockFsSettings.value,
	};
});

// Mock extension modules
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
// Test helpers
// ---------------------------------------------------------------------------

type HookHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

function createAtom(id: string, type: MemoryAtom["type"], overrides?: Partial<MemoryAtom>): MemoryAtom {
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
		...overrides,
	};
}

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

function createMockPi(): { hooks: Map<string, HookHandler>; on: (name: string, handler: HookHandler) => void; registerTool: () => void } {
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

function defaultEvent(): { messages: Array<{ role: string; content: string }> } {
	return {
		messages: [{ role: "user", content: "bwa 有问题" }],
	};
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("context hook pipeline (gate → recall → rerank → format → inject)", () => {
	let mockPi: ReturnType<typeof createMockPi>;
	let contextHandler: HookHandler;

	beforeEach(() => {
		vi.stubEnv("HOME", "/tmp");
		// Reset settings to defaults (gate + rerank both enabled)
		mockFsSettings.value = JSON.stringify({
			personalAssistant: {
				memory: {
					gate: { enabled: true },
					rerank: { enabled: true },
				},
			},
		});

		// Reset all mocks
		mockCallGate.mockReset();
		mockCallGate.mockResolvedValue({ need_memory: true } satisfies GateDecision);
		mockRerankAndFilter.mockReset();
		mockRerankAndFilter.mockResolvedValue([
			recallResult("atom-1", "rule", { rerankScore: 0.92 }),
			recallResult("atom-2", "fact", { rerankScore: 0.85 }),
		]);
		mockFormatMemoryContext.mockReset();
		mockFormatMemoryContext.mockReturnValue({ text: "formatted memory context", used: 80, included: 2 });
		mockRecallAtoms.mockReset();
		mockRecallAtoms.mockResolvedValue([
			recallResult("atom-1", "rule"),
			recallResult("atom-2", "fact"),
			recallResult("atom-3", "process"),
			recallResult("atom-4", "rule"),
			recallResult("atom-5", "fact"),
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
	// P1 — happy path
	// -----------------------------------------------------------------------
	it("P1: full happy path — gate pass → recall → rerank → format → inject", async () => {
		const event = defaultEvent();
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		// Gate was called with current + recent messages
		expect(mockCallGate).toHaveBeenCalledTimes(1);
		const gateArgs = mockCallGate.mock.calls[0]!;
		expect(gateArgs[0]).toBe("bwa 有问题");
		expect(gateArgs[1]).toEqual([]); // no recent messages
		expect(gateArgs[2]).toEqual({ timeoutMs: 5000 });

		// recallAtoms was called with the raw current prompt (GateDecision no longer includes search_query)
		expect(mockRecallAtoms).toHaveBeenCalledTimes(1);
		const recallArgs = mockRecallAtoms.mock.calls[0]!;
		expect(recallArgs[1]).toBe("bwa 有问题");

		// rerankAndFilter was called
		expect(mockRerankAndFilter).toHaveBeenCalledTimes(1);

		// formatMemoryContext was called with 2 filtered results + budget 4000
		expect(mockFormatMemoryContext).toHaveBeenCalledTimes(1);
		const formatArgs = mockFormatMemoryContext.mock.calls[0]!;
		expect(formatArgs[0]).toHaveLength(2);
		expect(formatArgs[1]).toBe(4000);

		// Result has modified messages with memory prefix
		expect(result).not.toBe(event);
		const typedResult = result as { messages?: Array<{ role: string; content: string }> };
		expect(typedResult.messages).toBeDefined();
		expect(typedResult.messages).toHaveLength(1);
		const lastMsg = typedResult.messages![0]!;
		expect(lastMsg.role).toBe("user");
		expect(lastMsg.content).toContain("[Relevant memory context — atoms at");
		expect(lastMsg.content).toContain("formatted memory context");
		expect(lastMsg.content).toContain("[User message]");
		expect(lastMsg.content).toContain("bwa 有问题");

		// setStatus was called with happy status
		const memoryStatusCalls = ctx.setStatusCalls.filter((c) => c.key === "memory");
		expect(memoryStatusCalls.length).toBeGreaterThanOrEqual(1);
		const statusText = memoryStatusCalls[memoryStatusCalls.length - 1]!.text;
		expect(statusText).toContain("📦");
		expect(statusText).toContain("rule=1 fact=1 process=0");
	});

	// -----------------------------------------------------------------------
	// P4 — idempotent
	// -----------------------------------------------------------------------
	it("P4: two calls with same input produce same result", async () => {
		const event = defaultEvent();
		const ctx1 = createMockCtx();
		const r1 = await contextHandler(event, ctx1);

		const ctx2 = createMockCtx();
		const r2 = await contextHandler(event, ctx2);

		expect(r1).toEqual(r2);
	});

	// -----------------------------------------------------------------------
	// P5 — gate disabled
	// -----------------------------------------------------------------------
	it("P5: gate.enabled=false skips gate but continues pipeline", async () => {
		mockFsSettings.value = JSON.stringify({
			personalAssistant: {
				memory: {
					gate: { enabled: false },
					rerank: { enabled: true },
				},
			},
		});

		const event = defaultEvent();
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		// Gate was NOT called
		expect(mockCallGate).not.toHaveBeenCalled();

		// But recall still ran (using the current user message as query)
		expect(mockRecallAtoms).toHaveBeenCalledTimes(1);
		const recallArgs = mockRecallAtoms.mock.calls[0]!;
		expect(recallArgs[1]).toBe("bwa 有问题");

		// Rerank still ran
		expect(mockRerankAndFilter).toHaveBeenCalledTimes(1);

		// Format still ran
		expect(mockFormatMemoryContext).toHaveBeenCalledTimes(1);

		// Memory was injected
		const typedResult = result as { messages?: Array<{ role: string; content: string }> };
		expect(typedResult.messages).toBeDefined();
		expect(typedResult.messages![0]!.content).toContain("formatted memory context");
	});

	// -----------------------------------------------------------------------
	// P6 — rerank disabled
	// -----------------------------------------------------------------------
	it("P6: rerank.enabled=false skips rerank but continues pipeline", async () => {
		mockFsSettings.value = JSON.stringify({
			personalAssistant: {
				memory: {
					gate: { enabled: true },
					rerank: { enabled: false },
				},
			},
		});

		const event = defaultEvent();
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		// Gate was called
		expect(mockCallGate).toHaveBeenCalledTimes(1);

		// Recall ran
		expect(mockRecallAtoms).toHaveBeenCalledTimes(1);

		// Rerank was NOT called
		expect(mockRerankAndFilter).not.toHaveBeenCalled();

		// Format ran with all 5 raw results (no rerank filtering)
		expect(mockFormatMemoryContext).toHaveBeenCalledTimes(1);
		const formatArgs = mockFormatMemoryContext.mock.calls[0]!;
		expect(formatArgs[0]).toHaveLength(5);

		// Memory was injected
		const typedResult = result as { messages?: Array<{ role: string; content: string }> };
		expect(typedResult.messages![0]!.content).toContain("formatted memory context");
	});

	// -----------------------------------------------------------------------
	// S1 — gate skip (need_memory=false)
	// -----------------------------------------------------------------------
	it("S1: gate says need_memory=false — skip pipeline, return event unchanged", async () => {
		mockCallGate.mockResolvedValue({ need_memory: false } satisfies GateDecision);

		const event = defaultEvent();
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		// Gate was called
		expect(mockCallGate).toHaveBeenCalledTimes(1);

		// No further pipeline steps
		expect(mockRecallAtoms).not.toHaveBeenCalled();
		expect(mockRerankAndFilter).not.toHaveBeenCalled();
		expect(mockFormatMemoryContext).not.toHaveBeenCalled();

		// Event returned unmodified (reference identity)
		expect(result).toBe(event);

		// Status indicates gate skipped
		const memoryCalls = ctx.setStatusCalls.filter((c) => c.key === "memory");
		expect(memoryCalls.length).toBeGreaterThanOrEqual(1);
		expect(memoryCalls[memoryCalls.length - 1]!.text).toContain("🚫 gate skipped");
	});

	// -----------------------------------------------------------------------
	// S6 — gate timeout (callGate returns "timeout")
	// -----------------------------------------------------------------------
	it("S6: gate timeout returns 'timeout' — skip pipeline, return event unchanged", async () => {
		mockCallGate.mockResolvedValue("timeout");

		const event = defaultEvent();
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		expect(mockCallGate).toHaveBeenCalledTimes(1);
		expect(mockRecallAtoms).not.toHaveBeenCalled();
		expect(mockRerankAndFilter).not.toHaveBeenCalled();
		expect(mockFormatMemoryContext).not.toHaveBeenCalled();
		expect(result).toBe(event);

		const memoryCalls = ctx.setStatusCalls.filter((c) => c.key === "memory");
		expect(memoryCalls.length).toBeGreaterThanOrEqual(1);
		expect(memoryCalls[memoryCalls.length - 1]!.text).toContain("⚠ gate timeout, skipped");
	});

	// -----------------------------------------------------------------------
	// S5 — gate parse fail (callGate returns "parse")
	// -----------------------------------------------------------------------
	it("S5: gate returns 'parse' — skip pipeline, TUI shows parse-fail status", async () => {
		mockCallGate.mockResolvedValue("parse");

		const event = defaultEvent();
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		expect(mockCallGate).toHaveBeenCalledTimes(1);
		expect(mockRecallAtoms).not.toHaveBeenCalled();
		expect(result).toBe(event);

		const memoryCalls = ctx.setStatusCalls.filter((c) => c.key === "memory");
		expect(memoryCalls.length).toBeGreaterThanOrEqual(1);
		expect(memoryCalls[memoryCalls.length - 1]!.text).toContain("🚫 gate skipped (parse failed)");
	});

	// -----------------------------------------------------------------------
	// S7 — gate unreachable (callGate returns "unreachable")
	// -----------------------------------------------------------------------
	it("S7: gate returns 'unreachable' — skip pipeline, TUI shows down status", async () => {
		mockCallGate.mockResolvedValue("unreachable");

		const event = defaultEvent();
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		expect(mockCallGate).toHaveBeenCalledTimes(1);
		expect(mockRecallAtoms).not.toHaveBeenCalled();
		expect(result).toBe(event);

		const memoryCalls = ctx.setStatusCalls.filter((c) => c.key === "memory");
		expect(memoryCalls.length).toBeGreaterThanOrEqual(1);
		expect(memoryCalls[memoryCalls.length - 1]!.text).toContain("⚠ gate down, skipped");
	});

	// -----------------------------------------------------------------------
	// S2 — rerank fallback (rerank returns RerankFallback)
	// -----------------------------------------------------------------------
	it("S2: rerank returns RerankFallback — use topK and set fallback status", async () => {
		mockRerankAndFilter.mockResolvedValue({ reason: "unreachable", topK: [recallResult("atom-1", "rule")] });

		const event = defaultEvent();
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		// Pipeline proceeded
		expect(mockCallGate).toHaveBeenCalledTimes(1);
		expect(mockRecallAtoms).toHaveBeenCalledTimes(1);
		expect(mockRerankAndFilter).toHaveBeenCalledTimes(1);

		// Format called with topK (1 result, not the full 5)
		expect(mockFormatMemoryContext).toHaveBeenCalledTimes(1);
		const formatArgs = mockFormatMemoryContext.mock.calls[0]!;
		expect(formatArgs[0]).toHaveLength(1);

		// Memory was injected
		const typedResult = result as { messages?: Array<{ role: string; content: string }> };
		expect(typedResult.messages![0]!.content).toContain("formatted memory context");

		// Status includes rerank fallback
		const memoryCalls = ctx.setStatusCalls.filter((c) => c.key === "memory");
		const lastStatus = memoryCalls[memoryCalls.length - 1]!.text;
		expect(lastStatus).toContain("⚠ rerank fallback");
	});

	// -----------------------------------------------------------------------
	// Rerank all below threshold — rerank returns empty array
	// -----------------------------------------------------------------------
	it("rerank returns [] (all below threshold) — no memory match, pipeline stops", async () => {
		mockRerankAndFilter.mockResolvedValue([]);

		const event = defaultEvent();
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		expect(mockCallGate).toHaveBeenCalledTimes(1);
		expect(mockRecallAtoms).toHaveBeenCalledTimes(1);
		expect(mockRerankAndFilter).toHaveBeenCalledTimes(1);
		// Format is NOT called because rerank filtered everything out
		expect(mockFormatMemoryContext).not.toHaveBeenCalled();
		expect(result).toBe(event);

		const memoryCalls = ctx.setStatusCalls.filter((c) => c.key === "memory");
		const lastStatus = memoryCalls[memoryCalls.length - 1]!.text;
		expect(lastStatus).toContain("🔍 no memory match");
	});

	// -----------------------------------------------------------------------
	// Empty recall — no memory match
	// -----------------------------------------------------------------------
	it("returns event unchanged when recall returns empty results", async () => {
		mockRecallAtoms.mockResolvedValue([]);

		const event = defaultEvent();
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		expect(mockCallGate).toHaveBeenCalledTimes(1);
		expect(mockRecallAtoms).toHaveBeenCalledTimes(1);
		expect(mockRerankAndFilter).not.toHaveBeenCalled();
		expect(mockFormatMemoryContext).not.toHaveBeenCalled();
		expect(result).toBe(event);

		const memoryCalls = ctx.setStatusCalls.filter((c) => c.key === "memory");
		expect(memoryCalls.length).toBeGreaterThanOrEqual(1);
		expect(memoryCalls[memoryCalls.length - 1]!.text).toContain("🔍 no memory match");
	});

	// -----------------------------------------------------------------------
	// No user message in event
	// -----------------------------------------------------------------------
	it("returns event unchanged when event has no messages", async () => {
		const event = { messages: [] };
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		expect(mockCallGate).not.toHaveBeenCalled();
		expect(mockRecallAtoms).not.toHaveBeenCalled();
		expect(result).toBe(event);
	});

	it("returns event unchanged when event has no user message", async () => {
		const event = { messages: [{ role: "assistant", content: "hello" }] };
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		expect(mockCallGate).not.toHaveBeenCalled();
		expect(result).toBe(event);
	});

	// -----------------------------------------------------------------------
	// Recent user messages extracted correctly
	// -----------------------------------------------------------------------
	it("extracts recent user messages (up to 3) for gate context", async () => {
		const event = {
			messages: [
				{ role: "user", content: "first" },
				{ role: "assistant", content: "response 1" },
				{ role: "user", content: "second" },
				{ role: "assistant", content: "response 2" },
				{ role: "user", content: "third" },
				{ role: "assistant", content: "response 3" },
				{ role: "user", content: "current prompt" },
			],
		};
		const ctx = createMockCtx();
		await contextHandler(event, ctx);

		expect(mockCallGate).toHaveBeenCalledTimes(1);
		const [, recent] = mockCallGate.mock.calls[0]!;
		// Recent should be the 3 previous user messages (not the last one)
		expect(recent).toEqual(["first", "second", "third"]);
	});

	// -----------------------------------------------------------------------
	// Status emitted even when ui.setStatus is missing
	// -----------------------------------------------------------------------
	it("does not throw when ctx has no ui.setStatus", async () => {
		const event = defaultEvent();
		const bareCtx = {};
		await expect(contextHandler(event, bareCtx)).resolves.not.toThrow();
	});

	it("does not throw when ctx.ui exists but setStatus is missing", async () => {
		const event = defaultEvent();
		const ctx = { ui: {} };
		await expect(contextHandler(event, ctx)).resolves.not.toThrow();
	});

	// -----------------------------------------------------------------------
	// Rewrite integration (Task 4.6)
	// -----------------------------------------------------------------------

	it("A: gate pass + rewrite ok(2) — 2 subqueries, recall called 2x, merged, reranked", async () => {
		mockRewriteQueries.mockResolvedValue(["sub query 1", "sub query 2"]);

		const event = defaultEvent();
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		expect(mockCallGate).toHaveBeenCalledTimes(1);
		expect(mockRewriteQueries).toHaveBeenCalledTimes(1);
		expect(mockRewriteQueries.mock.calls[0]![0]).toBe("bwa 有问题");

		// recallAtoms called 2 times (one per subquery)
		expect(mockRecallAtoms).toHaveBeenCalledTimes(2);
		expect(mockRecallAtoms.mock.calls[0]![1]).toBe("sub query 1");
		expect(mockRecallAtoms.mock.calls[1]![1]).toBe("sub query 2");

		// rerankAndFilter called once per subquery
		expect(mockRerankAndFilter).toHaveBeenCalledTimes(2);
		expect(mockRerankAndFilter.mock.calls[0]![0] as string).toBe("sub query 1");
		expect(mockRerankAndFilter.mock.calls[1]![0] as string).toBe("sub query 2");

		// Format called and memory injected
		expect(mockFormatMemoryContext).toHaveBeenCalledTimes(1);
		const typedResult = result as { messages?: Array<{ role: string; content: string }> };
		expect(typedResult.messages![0]!.content).toContain("formatted memory context");
	});

	it("B: rewrite timeout — fallback to single recall with raw query", async () => {
		mockRewriteQueries.mockResolvedValue({ reason: "timeout", subqueries: ["bwa 有问题"] });

		const event = defaultEvent();
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		expect(mockCallGate).toHaveBeenCalledTimes(1);
		expect(mockRewriteQueries).toHaveBeenCalledTimes(1);

		// Single recall with the raw query (from fallback)
		expect(mockRecallAtoms).toHaveBeenCalledTimes(1);
		expect(mockRecallAtoms.mock.calls[0]![1]).toBe("bwa 有问题");

		// Rerank uses the raw query
		expect(mockRerankAndFilter).toHaveBeenCalledTimes(1);
		expect(mockRerankAndFilter.mock.calls[0]![0]).toBe("bwa 有问题");

		// Memory still injected
		const typedResult = result as { messages?: Array<{ role: string; content: string }> };
		expect(typedResult.messages![0]!.content).toContain("formatted memory context");
	});

	it("C: rewrite parse fail — fallback to single recall with raw query", async () => {
		mockRewriteQueries.mockResolvedValue({ reason: "parse", subqueries: ["bwa 有问题"] });

		const event = defaultEvent();
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		expect(mockCallGate).toHaveBeenCalledTimes(1);
		expect(mockRewriteQueries).toHaveBeenCalledTimes(1);
		expect(mockRecallAtoms).toHaveBeenCalledTimes(1);
		expect(mockRecallAtoms.mock.calls[0]![1]).toBe("bwa 有问题");
		expect(mockRerankAndFilter).toHaveBeenCalledTimes(1);
		expect(mockRerankAndFilter.mock.calls[0]![0]).toBe("bwa 有问题");

		const typedResult = result as { messages?: Array<{ role: string; content: string }> };
		expect(typedResult.messages![0]!.content).toContain("formatted memory context");
	});

	it("D: rewrite disabled — single recall with raw query, rewrite not called", async () => {
		mockFsSettings.value = JSON.stringify({
			personalAssistant: {
				memory: {
					gate: { enabled: true },
					rewrite: { enabled: false },
					rerank: { enabled: true },
				},
			},
		});

		const event = defaultEvent();
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		expect(mockCallGate).toHaveBeenCalledTimes(1);
		// Rewrite NOT called when disabled
		expect(mockRewriteQueries).not.toHaveBeenCalled();
		// Single recall with raw query
		expect(mockRecallAtoms).toHaveBeenCalledTimes(1);
		expect(mockRecallAtoms.mock.calls[0]![1]).toBe("bwa 有问题");
		expect(mockRerankAndFilter).toHaveBeenCalledTimes(1);
		expect(mockRerankAndFilter.mock.calls[0]![0]).toBe("bwa 有问题");

		const typedResult = result as { messages?: Array<{ role: string; content: string }> };
		expect(typedResult.messages![0]!.content).toContain("formatted memory context");
	});

	it("E: gate disabled but rewrite enabled — rewrite still executes (B7)", async () => {
		mockFsSettings.value = JSON.stringify({
			personalAssistant: {
				memory: {
					gate: { enabled: false },
					rewrite: { enabled: true },
					rerank: { enabled: true },
				},
			},
		});

		const event = defaultEvent();
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		// Gate NOT called
		expect(mockCallGate).not.toHaveBeenCalled();
		// Rewrite IS called (B7: independent of gate)
		expect(mockRewriteQueries).toHaveBeenCalledTimes(1);
		// Recall called with rewritten query
		expect(mockRecallAtoms).toHaveBeenCalledTimes(1);
		expect(mockRecallAtoms.mock.calls[0]![1]).toBe("bwa 有问题");
		expect(mockRerankAndFilter).toHaveBeenCalledTimes(1);

		const typedResult = result as { messages?: Array<{ role: string; content: string }> };
		expect(typedResult.messages![0]!.content).toContain("formatted memory context");
	});

	// -----------------------------------------------------------------------
	// Task 5.4 — debug log tests (single emission per pipeline run, routed via setStatus)
	// -----------------------------------------------------------------------
	describe("debug log (gate/rerank/latency)", () => {
		const debugMessagesFor = (ctx: ReturnType<typeof createMockCtx>): string[] =>
			ctx.setStatusCalls.filter((c) => c.key === "memory-debug").map((c) => c.text ?? "");

		it("D1: happy path — gate=pass rewrite=ok(1) rerank=ok", async () => {
			const event = defaultEvent();
			const ctx = createMockCtx();
			await contextHandler(event, ctx);

			const msgs = debugMessagesFor(ctx);
			expect(msgs).toHaveLength(1);
			const msg = msgs[0]!;
			expect(msg).toMatch(/\[recall\]/);
			expect(msg).toContain("gate=pass");
			expect(msg).toContain("rewrite=ok(1)");
			expect(msg).toContain("rerank=ok");
			expect(msg).toContain("pre=5");
			expect(msg).toContain("post=2");
			expect(msg).toMatch(/latency \{gate:\d+ms rewrite:\d+ms recall:\d+ms rerank:\d+ms\}/);
		});

		it("D2: gate timeout — gate=timeout rerank=skip", async () => {
			mockCallGate.mockResolvedValue("timeout");

			const event = defaultEvent();
			const ctx = createMockCtx();
			await contextHandler(event, ctx);

			const msgs = debugMessagesFor(ctx);
			expect(msgs).toHaveLength(1);
			const msg = msgs[0]!;
			expect(msg).toContain("gate=timeout");
			expect(msg).toContain("rewrite=skip");
			expect(msg).not.toContain("pre-gate-skip");
			expect(msg).toContain("rerank=skip");
			expect(msg).toContain("pre=0");
			expect(msg).toContain("post=0");
		});

		it("D3: rerank fallback(timeout) — gate=pass rerank=fallback(timeout)", async () => {
			mockRerankAndFilter.mockResolvedValue({
				reason: "timeout",
				topK: [recallResult("atom-1", "rule")],
			});

			const event = defaultEvent();
			const ctx = createMockCtx();
			await contextHandler(event, ctx);

			const msgs = debugMessagesFor(ctx);
			expect(msgs).toHaveLength(1);
			const msg = msgs[0]!;
			expect(msg).toContain("gate=pass");
			expect(msg).toContain("rewrite=ok(1)");
			expect(msg).toContain("rerank=fallback(timeout)");
		});

		it("D4: rerank fallback(http-error) — gate=pass rerank=fallback(http-error)", async () => {
			mockRerankAndFilter.mockResolvedValue({
				reason: "http-error",
				topK: [recallResult("atom-1", "rule")],
			});

			const event = defaultEvent();
			const ctx = createMockCtx();
			await contextHandler(event, ctx);

			const msgs = debugMessagesFor(ctx);
			expect(msgs).toHaveLength(1);
			const msg = msgs[0]!;
			expect(msg).toContain("gate=pass");
			expect(msg).toContain("rewrite=ok(1)");
			expect(msg).toContain("rerank=fallback(http-error)");
		});

		it("D6: gate parse fail — gate=parse-fail rerank=skip", async () => {
			mockCallGate.mockResolvedValue("parse");

			const event = defaultEvent();
			const ctx = createMockCtx();
			await contextHandler(event, ctx);

			const msgs = debugMessagesFor(ctx);
			expect(msgs).toHaveLength(1);
			const msg = msgs[0]!;
			expect(msg).toContain("gate=parse-fail");
			expect(msg).toContain("rewrite=skip");
			expect(msg).not.toContain("pre-gate-skip");
			expect(msg).toContain("rerank=skip");
			expect(msg).toContain("pre=0");
			expect(msg).toContain("post=0");
		});

		it("D7: gate unreachable — gate=down rerank=skip", async () => {
			mockCallGate.mockResolvedValue("unreachable");

			const event = defaultEvent();
			const ctx = createMockCtx();
			await contextHandler(event, ctx);

			const msgs = debugMessagesFor(ctx);
			expect(msgs).toHaveLength(1);
			const msg = msgs[0]!;
			expect(msg).toContain("gate=down");
			expect(msg).toContain("rewrite=skip");
			expect(msg).not.toContain("pre-gate-skip");
			expect(msg).toContain("rerank=skip");
			expect(msg).toContain("pre=0");
			expect(msg).toContain("post=0");
		});

		it("D5: gate disabled — gate=disabled rerank=ok", async () => {
			mockFsSettings.value = JSON.stringify({
				personalAssistant: {
					memory: {
						gate: { enabled: false },
						rewrite: { enabled: false },
						rerank: { enabled: true },
					},
				},
			});

			const event = defaultEvent();
			const ctx = createMockCtx();
			await contextHandler(event, ctx);

			const msgs = debugMessagesFor(ctx);
			expect(msgs).toHaveLength(1);
			const msg = msgs[0]!;
			expect(msg).toContain("gate=disabled");
			expect(msg).toContain("rewrite=skip");
			expect(msg).toContain("rerank=ok");
			expect(msg).toContain("pre=5");
			expect(msg).toContain("post=2");
		});
	});

	// -----------------------------------------------------------------------
	// Regression: agent-loop iterations must NOT trigger recall
	// -----------------------------------------------------------------------
	describe("regression: skip recall on agent-loop continuations", () => {
		it("AG1: last message role is 'tool' → no recall, no gate call", async () => {
			const event = {
				messages: [
					{ role: "user", content: "what is X?" },
					{ role: "assistant", content: "thinking..." },
					{ role: "tool", content: "result of X is Y" },
				],
			};
			const ctx = createMockCtx();
			const result = await contextHandler(event, ctx);

			// No gate call, no recall, no rerank, no format, no status.
			expect(mockCallGate).not.toHaveBeenCalled();
			expect(mockRecallAtoms).not.toHaveBeenCalled();
			expect(mockRerankAndFilter).not.toHaveBeenCalled();
			expect(mockFormatMemoryContext).not.toHaveBeenCalled();
			expect(ctx.setStatusCalls).toEqual([]);
			// Event returned unmodified.
			expect(result).toBe(event);
		});

		it("AG2: last message role is 'assistant' (mid-turn continuation) → no recall", async () => {
			const event = {
				messages: [
					{ role: "user", content: "do thing" },
					{ role: "assistant", content: "calling tool" },
				],
			};
			const ctx = createMockCtx();
			await contextHandler(event, ctx);

			expect(mockCallGate).not.toHaveBeenCalled();
			expect(mockRecallAtoms).not.toHaveBeenCalled();
		});

		it("AG3: regression guard — fresh user turn DOES still trigger gate", async () => {
			const event = defaultEvent();
			const ctx = createMockCtx();
			await contextHandler(event, ctx);

			expect(mockCallGate).toHaveBeenCalledTimes(1);
		});
	});
});
