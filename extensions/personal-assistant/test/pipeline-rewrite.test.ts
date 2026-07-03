// Rewrite stage integration test — context hook gate pass → rewrite → multi-recall → merge → rerank.
//
// Tests the rewrite insertion into the context hook pipeline (memory.ts).
// Uses mocked modules for all external dependencies.
//
// Scenarios:
//   RW1 — rewrite enabled, gate pass, rewrite succeeds: subqueries => multi-recall => merge
//   RW2 — rewrite enabled, gate pass, rewrite fallback: subqueries = [current], single recall
//   RW3 — rewrite disabled: subqueries stays [current], single recall
//   RW4 — gate skip (need_memory=false): rewrite NOT called

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryAtom, RecallResult } from "../types.ts";
import type { GateDecision } from "../gate.ts";
import type { RewriteOutcome } from "../rewrite.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockFsSettings = vi.hoisted(() => ({
	value: JSON.stringify({
		personalAssistant: {
			memory: {
				gate: { enabled: true },
				rerank: { enabled: true },
				rewrite: { enabled: true },
			},
		},
	}),
}));

const mockCallGate = vi.hoisted(
	() => vi.fn<(...args: unknown[]) => Promise<GateDecision | "timeout" | "parse" | "unreachable" | null>>(),
);
const mockRewriteQueries = vi.hoisted(
	() => vi.fn<(...args: unknown[]) => Promise<RewriteOutcome>>(),
);
const mockRerankAndFilter = vi.hoisted(() => vi.fn());
const mockFormatMemoryContext = vi.hoisted(
	() => vi.fn<(...args: unknown[]) => { text: string; used: number; included: number }>(),
);
const mockRecallAtoms = vi.hoisted(
	() => vi.fn<(...args: unknown[]) => Promise<RecallResult[]>>(),
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
vi.mock("../rewrite.ts", () => ({ rewriteQueries: mockRewriteQueries }));
vi.mock("../rerank.ts", () => ({ rerankAndFilter: mockRerankAndFilter }));
vi.mock("../format.ts", () => ({ formatMemoryContext: mockFormatMemoryContext }));
vi.mock("../search.ts", () => ({ recallAtoms: mockRecallAtoms }));
vi.mock("../storage.ts", () => ({
	MemoryIndex: class FakeMemoryIndex {
		constructor(_dbPath: string) {}
		async init(): Promise<void> {}
		close(): void {}
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
		registerTool: () => {},
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

describe("context hook rewrite stage (rewrite → multi-recall → merge)", () => {
	let mockPi: ReturnType<typeof createMockPi>;
	let contextHandler: HookHandler;

	beforeEach(() => {
		vi.stubEnv("HOME", "/tmp");
		// Default: all enabled (gate, rerank, rewrite)
		mockFsSettings.value = JSON.stringify({
			personalAssistant: {
				memory: {
					gate: { enabled: true },
					rerank: { enabled: true },
					rewrite: { enabled: true },
				},
			},
		});

		mockCallGate.mockReset();
		mockCallGate.mockResolvedValue({ need_memory: true } satisfies GateDecision);
		mockRewriteQueries.mockReset();
		mockRewriteQueries.mockResolvedValue(["bwa 有问题", "问题是什么", "如何解决"]);
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
		]);

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
	// RW1 — rewrite enabled, gate pass, rewrite succeeds
	// -----------------------------------------------------------------------
	it("RW1: rewrite enabled + gate pass + rewrite succeeds → multi-recall with subqueries", async () => {
		const event = defaultEvent();
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		// Gate was called
		expect(mockCallGate).toHaveBeenCalledTimes(1);

		// rewriteQueries was called with current + recent + 1500ms timeout
		expect(mockRewriteQueries).toHaveBeenCalledTimes(1);
		const rewriteArgs = mockRewriteQueries.mock.calls[0]!;
		expect(rewriteArgs[0]).toBe("bwa 有问题");
		expect(rewriteArgs[1]).toEqual([]);
		expect(rewriteArgs[2]).toEqual({ timeoutMs: 1500 });

		// recallAtoms was called for EACH subquery (multi-recall)
		expect(mockRecallAtoms).toHaveBeenCalledTimes(3);
		// Each call should pass the respective subquery
		const recallCalls = mockRecallAtoms.mock.calls;
		expect(recallCalls[0]![1]).toBe("bwa 有问题");
		expect(recallCalls[1]![1]).toBe("问题是什么");
		expect(recallCalls[2]![1]).toBe("如何解决");

		// rerankAndFilter was called with joined subqueries
		expect(mockRerankAndFilter).toHaveBeenCalledTimes(1);
		const rerankArgs = mockRerankAndFilter.mock.calls[0]!;
		expect(rerankArgs[0]).toBe("bwa 有问题 问题是什么 如何解决");

		// formatMemoryContext was called
		expect(mockFormatMemoryContext).toHaveBeenCalledTimes(1);

		// Result has modified messages
		const typedResult = result as { messages?: Array<{ role: string; content: string }> };
		expect(typedResult.messages![0]!.content).toContain("formatted memory context");
	});

	// -----------------------------------------------------------------------
	// RW2 — rewrite enabled, gate pass, rewrite fallback
	// -----------------------------------------------------------------------
	it("RW2: rewrite fallback → subqueries=[current], single recall, pipeline continues", async () => {
		mockRewriteQueries.mockResolvedValue({ reason: "timeout", subqueries: ["bwa 有问题"] });

		const event = defaultEvent();
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		// Gate was called
		expect(mockCallGate).toHaveBeenCalledTimes(1);

		// rewriteQueries was called
		expect(mockRewriteQueries).toHaveBeenCalledTimes(1);

		// recallAtoms called only ONCE (single subquery from fallback)
		expect(mockRecallAtoms).toHaveBeenCalledTimes(1);
		const recallArgs = mockRecallAtoms.mock.calls[0]!;
		expect(recallArgs[1]).toBe("bwa 有问题");

		// rerankAndFilter was called with the original query
		expect(mockRerankAndFilter).toHaveBeenCalledTimes(1);
		const rerankArgs = mockRerankAndFilter.mock.calls[0]!;
		expect(rerankArgs[0]).toBe("bwa 有问题");

		// Format ran
		expect(mockFormatMemoryContext).toHaveBeenCalledTimes(1);
		const typedResult = result as { messages?: Array<{ role: string; content: string }> };
		expect(typedResult.messages![0]!.content).toContain("formatted memory context");
	});

	// -----------------------------------------------------------------------
	// RW3 — rewrite disabled
	// -----------------------------------------------------------------------
	it("RW3: rewrite disabled → subqueries=[current], no rewrite call, pipeline continues", async () => {
		mockFsSettings.value = JSON.stringify({
			personalAssistant: {
				memory: {
					gate: { enabled: true },
					rerank: { enabled: true },
					rewrite: { enabled: false },
				},
			},
		});

		const event = defaultEvent();
		const ctx = createMockCtx();
		const result = await contextHandler(event, ctx);

		// Gate was called
		expect(mockCallGate).toHaveBeenCalledTimes(1);

		// rewriteQueries was NOT called
		expect(mockRewriteQueries).not.toHaveBeenCalled();

		// recallAtoms called ONCE with current
		expect(mockRecallAtoms).toHaveBeenCalledTimes(1);
		const recallArgs = mockRecallAtoms.mock.calls[0]!;
		expect(recallArgs[1]).toBe("bwa 有问题");

		// rerankAndFilter called with current
		expect(mockRerankAndFilter).toHaveBeenCalledTimes(1);
		const rerankArgs = mockRerankAndFilter.mock.calls[0]!;
		expect(rerankArgs[0]).toBe("bwa 有问题");

		// Format ran
		expect(mockFormatMemoryContext).toHaveBeenCalledTimes(1);
		const typedResult = result as { messages?: Array<{ role: string; content: string }> };
		expect(typedResult.messages![0]!.content).toContain("formatted memory context");
	});

	// -----------------------------------------------------------------------
	// RW4 — gate skip: rewrite NOT called
	// -----------------------------------------------------------------------
	it("RW4: gate skip (need_memory=false) → rewrite NOT called", async () => {
		mockCallGate.mockResolvedValue({ need_memory: false } satisfies GateDecision);

		const event = defaultEvent();
		const ctx = createMockCtx();
		await contextHandler(event, ctx);

		expect(mockCallGate).toHaveBeenCalledTimes(1);
		expect(mockRewriteQueries).not.toHaveBeenCalled();
		expect(mockRecallAtoms).not.toHaveBeenCalled();
		expect(mockRerankAndFilter).not.toHaveBeenCalled();
		expect(mockFormatMemoryContext).not.toHaveBeenCalled();
	});

	// -----------------------------------------------------------------------
	// RW5 — gate disabled: rewrite NOT called
	// -----------------------------------------------------------------------
	it("RW5: gate disabled → rewrite NOT called, single recall", async () => {
		mockFsSettings.value = JSON.stringify({
			personalAssistant: {
				memory: {
					gate: { enabled: false },
					rerank: { enabled: true },
					rewrite: { enabled: true },
				},
			},
		});

		const event = defaultEvent();
		const ctx = createMockCtx();
		await contextHandler(event, ctx);

		expect(mockCallGate).not.toHaveBeenCalled();
		expect(mockRewriteQueries).not.toHaveBeenCalled();

		// recallAtoms called ONCE with current (no gate, no rewrite)
		expect(mockRecallAtoms).toHaveBeenCalledTimes(1);
		const recallArgs = mockRecallAtoms.mock.calls[0]!;
		expect(recallArgs[1]).toBe("bwa 有问题");
	});
});
