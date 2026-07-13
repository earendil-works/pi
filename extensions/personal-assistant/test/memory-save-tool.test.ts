// memory_save tool — TypeBox schema, segment counter, scaffold registration.
//
// Task 2.1 scaffold contract:
//   - MemorySaveParams TypeBox schema validates all input fields.
//   - Module-level segmentMemorySaveCount + helpers (get / increment / reset).
//   - registerMemorySave(pi) registers a tool whose execute body throws
//     "not implemented" (the real create / update / skip / error logic
//     lands in tasks 2.2+).
//
// RED state for 2.1: the "memory_save execute (scaffold)" tests exercise
// the final expected contract and FAIL today because execute throws.
// They will turn GREEN in 2.2+ once the real implementation lands. We
// keep them in the same file (with a clear "RED" comment block) so the
// 2.2+ diff is purely a `throw` → real body swap, not a test rewrite.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Value } from "typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// char-bag mock for embed.ts so tests don't need a live embedder.
// Mirrors the pattern used in search.test.ts and extraction.test.ts.
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
			if (norm > 0) {
				for (let i = 0; i < arr.length; i++) arr[i] /= norm;
			}
			return arr;
		}),
	};
});

// Trackable extraction mock — Task 4.2 safety-net tests need to assert
// whether `runCompactExtraction` actually invoked the LLM extraction
// path or short-circuited at the counter guard. Replacing
// `extractMemoriesWithCallLlm` with a vi.fn() lets the test count calls
// without paying the real cost (the real path needs config, model
// registry, auth, plus an LLM round-trip).
const extractMemoriesWithCallLlmMock = vi.fn(
	async (
		_callLlm: (prompt: string) => Promise<string>,
		_messages: Array<{ role: string; content: string }>,
	) => ({
		plan: { items: [], modelUsed: "mock", generatedAt: Date.now() },
		created: [],
		updated: [],
		skipped: [],
	}),
);

vi.mock("../extraction.ts", async () => {
	const actual = await vi.importActual<typeof import("../extraction.ts")>("../extraction.ts");
	return {
		...actual,
		extractMemoriesWithCallLlm: extractMemoriesWithCallLlmMock,
	};
});

// Lazy-loaded module bindings — re-resolved in beforeEach after vi.resetModules()
// so each test gets a fresh module-level segmentMemorySaveCount.
type MemorySaveModule = typeof import("../memory-save.ts");
type StorageModule = typeof import("../storage.ts");

let mod: MemorySaveModule;
let MemoryIndex: StorageModule["MemoryIndex"];

const ORIGINAL_HOME = process.env.HOME;

beforeEach(async () => {
	vi.resetModules();
	mod = await import("../memory-save.ts");
	const storageMod = await import("../storage.ts");
	MemoryIndex = storageMod.MemoryIndex;
});

afterEach(() => {
	process.env.HOME = ORIGINAL_HOME;
});

// ---------------------------------------------------------------------------
// MemorySaveParams TypeBox schema
// ---------------------------------------------------------------------------

describe("MemorySaveParams TypeBox schema", () => {
	it("accepts a valid input with required fields only", () => {
		const valid = {
			type: "fact" as const,
			title: "Test Fact",
			content: "This is some valid content for testing.",
			summary: "A test summary line",
			importance: 0.5,
		};
		expect(Value.Check(mod.MemorySaveParams, valid)).toBe(true);
	});

	it("accepts a valid input with all optional fields", () => {
		const valid = {
			id: "550e8400-e29b-41d4-a716-446655440000",
			type: "rule" as const,
			title: "Test Rule",
			content: "This is a valid rule content for testing.",
			summary: "A test summary line",
			tags: ["test", "rule"],
			importance: 0.8,
			source_session: "session-1",
		};
		expect(Value.Check(mod.MemorySaveParams, valid)).toBe(true);
	});

	it("accepts every legal type literal (rule / fact / process)", () => {
		for (const t of ["rule", "fact", "process"] as const) {
			const input = {
				type: t,
				title: "t",
				content: "long enough content body",
				summary: "summary line",
				importance: 0.5,
			};
			expect(Value.Check(mod.MemorySaveParams, input)).toBe(true);
		}
	});

	it("rejects invalid type literal (not in rule/fact/process)", () => {
		const invalid = {
			type: "opinion",
			title: "Test",
			content: "Valid content body for invalid type test",
			summary: "summary line",
			importance: 0.5,
		};
		expect(Value.Check(mod.MemorySaveParams, invalid)).toBe(false);
	});

	it("rejects content shorter than 10 characters", () => {
		const invalid = {
			type: "fact" as const,
			title: "Test",
			content: "x",
			summary: "summary line",
			importance: 0.5,
		};
		expect(Value.Check(mod.MemorySaveParams, invalid)).toBe(false);
	});

	it("rejects importance above 1", () => {
		const invalid = {
			type: "fact" as const,
			title: "Test",
			content: "Valid content body for importance test",
			summary: "summary line",
			importance: 1.5,
		};
		expect(Value.Check(mod.MemorySaveParams, invalid)).toBe(false);
	});

	it("rejects importance below 0", () => {
		const invalid = {
			type: "fact" as const,
			title: "Test",
			content: "Valid content body for importance test",
			summary: "summary line",
			importance: -0.1,
		};
		expect(Value.Check(mod.MemorySaveParams, invalid)).toBe(false);
	});

	it("accepts importance at the boundaries (0 and 1)", () => {
		for (const importance of [0, 1]) {
			const input = {
				type: "fact" as const,
				title: "Boundary test",
				content: "Valid content body for boundary test",
				summary: "summary line",
				importance,
			};
			expect(Value.Check(mod.MemorySaveParams, input)).toBe(true);
		}
	});

	it("rejects missing required fields (no title)", () => {
		const invalid = {
			type: "fact" as const,
			content: "Valid content body",
			summary: "summary line",
			importance: 0.5,
		};
		expect(Value.Check(mod.MemorySaveParams, invalid)).toBe(false);
	});

	it("rejects summary shorter than 5 characters", () => {
		const invalid = {
			type: "fact" as const,
			title: "Test",
			content: "Valid content body for summary test",
			summary: "abcd",
			importance: 0.5,
		};
		expect(Value.Check(mod.MemorySaveParams, invalid)).toBe(false);
	});

	it("rejects title longer than 200 characters", () => {
		const invalid = {
			type: "fact" as const,
			title: "x".repeat(201),
			content: "Valid content body for title-length test",
			summary: "summary line",
			importance: 0.5,
		};
		expect(Value.Check(mod.MemorySaveParams, invalid)).toBe(false);
	});

	it("rejects content longer than 5000 characters", () => {
		const invalid = {
			type: "fact" as const,
			title: "Test",
			content: "x".repeat(5001),
			summary: "summary line",
			importance: 0.5,
		};
		expect(Value.Check(mod.MemorySaveParams, invalid)).toBe(false);
	});

	it("rejects tags with item longer than 50 characters", () => {
		const invalid = {
			type: "fact" as const,
			title: "Test",
			content: "Valid content body for tag-length test",
			summary: "summary line",
			importance: 0.5,
			tags: ["x".repeat(51)],
		};
		expect(Value.Check(mod.MemorySaveParams, invalid)).toBe(false);
	});

	it("rejects more than 10 tags", () => {
		const invalid = {
			type: "fact" as const,
			title: "Test",
			content: "Valid content body for tag-count test",
			summary: "summary line",
			importance: 0.5,
			tags: Array.from({ length: 11 }, (_, i) => `tag${i}`),
		};
		expect(Value.Check(mod.MemorySaveParams, invalid)).toBe(false);
	});

	it("accepts empty tags array and missing tags as equivalent (both optional)", () => {
		const emptyTags = {
			type: "fact" as const,
			title: "Test",
			content: "Valid content body for empty-tags test",
			summary: "summary line",
			importance: 0.5,
			tags: [],
		};
		const absentTags = {
			type: "fact" as const,
			title: "Test",
			content: "Valid content body for absent-tags test",
			summary: "summary line",
			importance: 0.5,
		};
		expect(Value.Check(mod.MemorySaveParams, emptyTags)).toBe(true);
		expect(Value.Check(mod.MemorySaveParams, absentTags)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// segmentMemorySaveCount + helpers
// ---------------------------------------------------------------------------

describe("segmentMemorySaveCount", () => {
	it("starts at 0 on a fresh module import", () => {
		// The lazy import in the top-level beforeEach gives us a fresh
		// module-level binding; assert the initial value is zero.
		expect(mod.getSegmentMemorySaveCount()).toBe(0);
	});

	it("increments by 1 on each call to incrementSegmentMemorySaveCount", () => {
		expect(mod.getSegmentMemorySaveCount()).toBe(0);
		mod.incrementSegmentMemorySaveCount();
		expect(mod.getSegmentMemorySaveCount()).toBe(1);
		mod.incrementSegmentMemorySaveCount();
		expect(mod.getSegmentMemorySaveCount()).toBe(2);
		mod.incrementSegmentMemorySaveCount();
		expect(mod.getSegmentMemorySaveCount()).toBe(3);
	});

	it("resets to 0 via resetSegmentMemorySaveCount", () => {
		mod.incrementSegmentMemorySaveCount();
		mod.incrementSegmentMemorySaveCount();
		mod.incrementSegmentMemorySaveCount();
		expect(mod.getSegmentMemorySaveCount()).toBe(3);
		mod.resetSegmentMemorySaveCount();
		expect(mod.getSegmentMemorySaveCount()).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// registerMemory hook resets segment counter at session boundaries (Task 4.1)
//
// Delta spec: counter resets at session_start AND session_compact, NOT at
// before_agent_start (per-segment, not per-turn). Scenarios S22: counter
// survives between turns within a segment.
//
// These tests exercise the public registerMemory(pi) entry point, capture
// the hooks it registers on a mock pi, then fire each hook and assert
// whether the module-level segmentMemorySaveCount was reset or preserved.
// All heavy I/O the session_start handler triggers (runDecay, embeddings,
// drift sweep) no-ops against a fresh DB — no mocks needed.
// ---------------------------------------------------------------------------

describe("registerMemory hooks reset segment counter at session boundaries (Task 4.1)", () => {
	let memoryMod: typeof import("../memory.ts");
	let handlers: Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>;
	let tmpHome: string;

	function makeMockPi() {
		const map = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>();
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown) => {
				map.set(event, handler);
			},
			registerTool: () => {
				// no-op — tool registration lives in other test files
			},
		};
		return { pi, hooks: map };
	}

	beforeEach(async () => {
		// Use a tmp HOME so the session_start handler's loadConfig() /
		// MemoryIndex work targets an isolated directory and never sees
		// the user's real ~/.pi/agent/settings.json.
		tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "segment-counter-boundary-"));
		process.env.HOME = tmpHome;

		vi.resetModules();
		// Re-resolve memory-save.ts AND memory.ts so the two modules
		// share the same segmentMemorySaveCount binding (memory.ts
		// imports resetSegmentMemorySaveCount from memory-save.ts).
		mod = await import("../memory-save.ts");
		memoryMod = await import("../memory.ts");

		const { pi, hooks: captured } = makeMockPi();
		memoryMod.registerMemory(pi as unknown as ExtensionAPI);
		handlers = captured;
	});

	afterEach(async () => {
		process.env.HOME = ORIGINAL_HOME;
		await fs.rm(tmpHome, { recursive: true, force: true });
	});

	function getHandler(name: string) {
		const h = handlers.get(name);
		if (!h) throw new Error(`${name} hook not registered by registerMemory`);
		return h;
	}

	// Spec scenario: "counter resets on session_start". The reset must
	// fire EVEN if the counter was bumped up before the session started,
	// and EVEN if the throttle guard would otherwise skip the handler
	// body (so the reset call has to be at the very top of the handler,
	// before the decay throttle). Verified by bumping the counter to 3
	// and asserting it lands on 0 after session_start.
	it("session_start event resets segment counter to 0 (even when counter was >0)", async () => {
		mod.incrementSegmentMemorySaveCount();
		mod.incrementSegmentMemorySaveCount();
		mod.incrementSegmentMemorySaveCount();
		expect(mod.getSegmentMemorySaveCount()).toBe(3);

		const sessionStart = getHandler("session_start");
		await sessionStart(
			{ type: "session_start", reason: "startup" },
			{ ui: {} },
		);

		expect(mod.getSegmentMemorySaveCount()).toBe(0);
	});

	// Spec scenario: "counter resets on session_compact". The compact
	// boundary closes the current segment and opens a new one — same
	// invariant as session_start. The test fires session_compact with a
	// realistic SessionCompactEvent shape so any future shape-checking
	// in the handler would be caught here.
	it("session_compact event resets segment counter to 0 (even when counter was >0)", async () => {
		mod.incrementSegmentMemorySaveCount();
		mod.incrementSegmentMemorySaveCount();
		expect(mod.getSegmentMemorySaveCount()).toBe(2);

		const sessionCompact = getHandler("session_compact");
		await sessionCompact(
			{
				type: "session_compact",
				reason: "manual",
				willRetry: false,
				fromExtension: false,
				compactionEntry: {},
			},
			{ ui: {} },
		);

		expect(mod.getSegmentMemorySaveCount()).toBe(0);
	});

	// Spec scenario S22: "counter survives between turns within a
	// segment". before_agent_start fires on EVERY turn inside a segment;
	// it MUST NOT touch the counter, otherwise the safety-net threshold
	// would never accumulate across turns. Verify the counter persists
	// across two consecutive before_agent_start fires with non-empty
	// prompts.
	it("before_agent_start event does NOT reset segment counter (counter persists across turns)", async () => {
		mod.incrementSegmentMemorySaveCount();
		mod.incrementSegmentMemorySaveCount();
		expect(mod.getSegmentMemorySaveCount()).toBe(2);

		const beforeAgentStart = getHandler("before_agent_start");
		await beforeAgentStart(
			{ type: "before_agent_start", prompt: "what did we decide about X?" },
			{ ui: {} },
		);
		// Counter MUST survive the first turn.
		expect(mod.getSegmentMemorySaveCount()).toBe(2);

		await beforeAgentStart(
			{ type: "before_agent_start", prompt: "another turn within the same segment" },
			{ ui: {} },
		);
		// Counter MUST also survive the second turn (regression guard
		// against an accidental reset being added inside the hook).
		expect(mod.getSegmentMemorySaveCount()).toBe(2);

		// And the counter keeps accumulating with normal tool calls.
		mod.incrementSegmentMemorySaveCount();
		expect(mod.getSegmentMemorySaveCount()).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// session_before_compact safety net (Task 4.2)
//
// Delta spec: "session_before_compact is a graceful safety net" with
// two scenarios:
//   - safety net skipped when agent saved at least once (count >= 1)
//   - safety net runs when agent never saved (count == 0)
//
// These tests exercise the public registerMemory(pi) entry point. They
// call the session_before_compact hook the agent actually fires, then
// assert two things:
//   1. The hook's return value matches the spec (undefined when
//      extraction should proceed OR the safety net is skipped; the hook
//      should NOT return {cancel: true} on these paths).
//   2. extractMemoriesWithCallLlm (the proxy for "did runCompactExtraction
//      run the LLM pipeline?") was called or not called according to the
//      counter state.
//
// The mocks set up at the top of the file (embed.ts char-bag +
// extraction.ts trackable stub) keep the tests free of real LLM / DB
// cost while still letting the hook's real code path run.
// ---------------------------------------------------------------------------

describe("session_before_compact safety net (Task 4.2)", () => {
	let memoryMod: typeof import("../memory.ts");
	let handlers: Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>;
	let tmpHome: string;

	function makeMockPi() {
		const map = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>();
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown) => {
				map.set(event, handler);
			},
			registerTool: () => {
				// no-op — tool registration lives in other test files
			},
		};
		return { pi, map };
	}

	function makeCompactEvent() {
		// Use a realistic-shaped event. Empty messagesToSummarize +
		// turnPrefixMessages is fine — runCompactExtraction takes the
		// "no messages" early-return path, which is enough to prove the
		// safety net DID invoke the extraction function (notifySafely
		// gets called with the "skipping" message). For the
		// counter-equals-zero test, we instead need a non-empty event
		// (otherwise the runCompactExtraction early-return prevents
		// extractMemoriesWithCallLlm from firing, and we can't
		// distinguish "extraction ran and decided nothing to do" from
		// "safety net skipped").
		return {
			type: "session_before_compact" as const,
			preparation: {
				firstKeptEntryId: "abc",
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 100,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: {
					reserveTokens: 0,
					enabled: true,
					keepRecentTokens: 0,
				},
			},
			branchEntries: [],
			reason: "manual" as const,
			willRetry: false,
			signal: new AbortController().signal,
		};
	}

	function makeNonEmptyCompactEvent() {
		return {
			type: "session_before_compact" as const,
			preparation: {
				firstKeptEntryId: "abc",
				messagesToSummarize: [
					{
						role: "user",
						content: "a user message that should drive extraction",
						timestamp: Date.now(),
					},
				],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 100,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: {
					reserveTokens: 0,
					enabled: true,
					keepRecentTokens: 0,
				},
			},
			branchEntries: [],
			reason: "manual" as const,
			willRetry: false,
			signal: new AbortController().signal,
		};
	}

	function makeMockCtx() {
		const notifyCalls: Array<{ msg: string; type: string }> = [];
		const find = vi.fn((provider: string, modelId: string) => ({
			id: modelId,
			name: modelId,
			api: "anthropic-messages",
			provider,
			baseUrl: "https://api.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		}));
		const getApiKeyAndHeaders = vi.fn(async () => ({
			ok: true as const,
			apiKey: "sk-test-key",
			headers: {},
		}));
		return {
			ui: {
				setStatus: () => {
					// no-op
				},
				notify: (msg: string, type: string) => {
					notifyCalls.push({ msg, type });
				},
			},
			modelRegistry: { find, getApiKeyAndHeaders },
			notifyCalls,
		};
	}

	function writeExtractionSettings(home: string) {
		const agentDir = path.join(home, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({
				personalAssistant: {
					memory: {
						enabled: true,
						extraction: {
							provider: "anthropic",
							model: "claude-haiku-4-5",
						},
					},
				},
			}, null, 2),
		);
	}

	beforeEach(async () => {
		// Use a tmp HOME so loadConfig() reads an isolated settings.json
		// instead of the user's real ~/.pi/agent/settings.json.
		tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "safety-net-"));
		process.env.HOME = tmpHome;
		writeExtractionSettings(tmpHome);

		vi.resetModules();
		// Re-resolve memory-save.ts AND memory.ts so the two modules
		// share the same segmentMemorySaveCount binding.
		mod = await import("../memory-save.ts");
		memoryMod = await import("../memory.ts");

		// Reset the extraction mock's call counter. The mock is
		// hoisted so the same fn instance survives vi.resetModules();
		// vi.clearAllMocks() (called in afterEach) wipes both call
		// records AND the implementation, so we explicitly install a
		// fresh implementation here too.
		extractMemoriesWithCallLlmMock.mockClear();
		extractMemoriesWithCallLlmMock.mockImplementation(
			async (
				_callLlm: (prompt: string) => Promise<string>,
				_messages: Array<{ role: string; content: string }>,
			) => ({
				plan: { items: [], modelUsed: "mock", generatedAt: Date.now() },
				created: [],
				updated: [],
				skipped: [],
			}),
		);

		const { pi, map } = makeMockPi();
		memoryMod.registerMemory(pi as unknown as ExtensionAPI);
		handlers = map;
	});

	afterEach(async () => {
		process.env.HOME = ORIGINAL_HOME;
		await fs.rm(tmpHome, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	function getHandler(name: string) {
		const h = handlers.get(name);
		if (!h) throw new Error(`${name} hook not registered by registerMemory`);
		return h;
	}

	// Spec scenario: "safety net skipped when agent saved at least once".
	// GIVEN counter >= 1, the hook MUST return undefined BEFORE calling
	// runCompactExtraction — the LLM extraction is a no-op when the
	// agent already drove a memory_save during the segment.
	//
	// We verify both:
	//   1. Result is undefined (compact proceeds).
	//   2. extractMemoriesWithCallLlm was NOT called (the extraction
	//      pipeline didn't even start, including the "no messages"
	//      early-return path).
	it("session_before_compact returns undefined without invoking runCompactExtraction when segment counter >= 1", async () => {
		mod.incrementSegmentMemorySaveCount();
		mod.incrementSegmentMemorySaveCount();
		mod.incrementSegmentMemorySaveCount();
		expect(mod.getSegmentMemorySaveCount()).toBe(3);

		const handler = getHandler("session_before_compact");
		const ctx = makeMockCtx();
		const event = makeCompactEvent();

		const result = await handler(event, ctx);

		expect(result).toBeUndefined();
		// Counter check is at the very top of the handler — extraction
		// never even started, so no notify was emitted, no LLM call.
		expect(extractMemoriesWithCallLlmMock).not.toHaveBeenCalled();
		expect(ctx.notifyCalls).toHaveLength(0);
		// The counter itself is preserved (not reset by the safety net).
		expect(mod.getSegmentMemorySaveCount()).toBe(3);
	});

	// Spec scenario: "safety net runs when agent never saved". GIVEN
	// counter == 0, the existing extraction pipeline runs — this is the
	// pre-Task-4.2 baseline behaviour the safety net was meant to skip
	// past. We assert runCompactExtraction DID invoke the LLM path by
	// passing a non-empty event (so the early-return on empty messages
	// doesn't shadow the call to extractMemoriesWithCallLlm) and
	// checking the mock was called.
	it("session_before_compact invokes runCompactExtraction (existing behaviour) when segment counter == 0", async () => {
		expect(mod.getSegmentMemorySaveCount()).toBe(0);

		const handler = getHandler("session_before_compact");
		const ctx = makeMockCtx();
		const event = makeNonEmptyCompactEvent();

		const result = await handler(event, ctx);

		expect(result).toBeUndefined();
		// runCompactExtraction reached extractMemoriesWithCallLlm — the
		// safety net did NOT short-circuit.
		expect(extractMemoriesWithCallLlmMock).toHaveBeenCalledTimes(1);
		// Counter check must NOT mutate the counter on the
		// counter-equals-zero path either.
		expect(mod.getSegmentMemorySaveCount()).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// session_before_compact graceful on extraction failure (Task 4.3)
//
// Delta spec scenario "safety net graceful on extraction failure" (spec.md
// L195-202): when the agent has never saved (counter === 0) AND the LLM
// extraction pipeline throws (no extraction config, auth missing, LLM
// 4xx/5xx, etc.), the hook MUST treat the failure as non-fatal:
//   - return `undefined` so compact proceeds (NOT `{cancel: true}`)
//   - surface a warn-level notify carrying "safety net skipped" so the
//     user sees that memory was not extracted for this compaction cycle
//
// This replaces the pre-4.3 hard-gate behaviour (cancel: true on throw),
// which made a transient extraction outage block compact entirely — a
// worse outcome than skipping the safety net, since compact discards
// messages.
//
// Like the Task 4.2 describe above, these tests drive the hook through
// the public registerMemory(pi) entry point, fire a synthesised
// session_before_compact event, and assert the returned value + the
// captured notify calls.
// ---------------------------------------------------------------------------

describe("session_before_compact safety net graceful on extraction failure (Task 4.3)", () => {
	let memoryMod: typeof import("../memory.ts");
	let handlers: Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>;
	let tmpHome: string;

	function makeMockPi() {
		const map = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>();
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown) => {
				map.set(event, handler);
			},
			registerTool: () => {
				// no-op — tool registration lives in other test files
			},
		};
		return { pi, map };
	}

	function makeNonEmptyCompactEvent() {
		return {
			type: "session_before_compact" as const,
			preparation: {
				firstKeptEntryId: "abc",
				messagesToSummarize: [
					{
						role: "user",
						content: "a user message that should drive extraction",
						timestamp: Date.now(),
					},
				],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 100,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: {
					reserveTokens: 0,
					enabled: true,
					keepRecentTokens: 0,
				},
			},
			branchEntries: [],
			reason: "manual" as const,
			willRetry: false,
			signal: new AbortController().signal,
		};
	}

	function makeMockCtx() {
		const notifyCalls: Array<{ msg: string; type: string }> = [];
		const find = vi.fn((provider: string, modelId: string) => ({
			id: modelId,
			name: modelId,
			api: "anthropic-messages",
			provider,
			baseUrl: "https://api.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		}));
		const getApiKeyAndHeaders = vi.fn(async () => ({
			ok: true as const,
			apiKey: "sk-test-key",
			headers: {},
		}));
		return {
			ui: {
				setStatus: () => {
					// no-op
				},
				notify: (msg: string, type: string) => {
					notifyCalls.push({ msg, type });
				},
			},
			modelRegistry: { find, getApiKeyAndHeaders },
			notifyCalls,
		};
	}

	function writeExtractionSettings(home: string) {
		const agentDir = path.join(home, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({
				personalAssistant: {
					memory: {
						enabled: true,
						extraction: {
							provider: "anthropic",
							model: "claude-haiku-4-5",
						},
					},
				},
			}, null, 2),
		);
	}

	beforeEach(async () => {
		tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "safety-net-graceful-"));
		process.env.HOME = tmpHome;
		writeExtractionSettings(tmpHome);

		vi.resetModules();
		mod = await import("../memory-save.ts");
		memoryMod = await import("../memory.ts");

		// Re-install a fresh default implementation so other tests'
		// overrides do not leak into this block. The default succeeds;
		// individual tests override with `.mockImplementationOnce` to
		// inject a throw.
		extractMemoriesWithCallLlmMock.mockClear();
		extractMemoriesWithCallLlmMock.mockImplementation(
			async (
				_callLlm: (prompt: string) => Promise<string>,
				_messages: Array<{ role: string; content: string }>,
			) => ({
				plan: { items: [], modelUsed: "mock", generatedAt: Date.now() },
				created: [],
				updated: [],
				skipped: [],
			}),
		);

		const { pi, map } = makeMockPi();
		memoryMod.registerMemory(pi as unknown as ExtensionAPI);
		handlers = map;
	});

	afterEach(async () => {
		process.env.HOME = ORIGINAL_HOME;
		await fs.rm(tmpHome, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	function getHandler(name: string) {
		const h = handlers.get(name);
		if (!h) throw new Error(`${name} hook not registered by registerMemory`);
		return h;
	}

	// Spec scenario S13 (scenarios.md:L67, spec.md:L195): GIVEN
	// `segmentMemorySaveCount === 0` AND `runCompactExtraction` throws
	// (e.g. extraction model not configured, auth failed, LLM 报错),
	// WHEN `session_before_compact` event fires, THEN hook catches the
	// error AND `ctx.ui.notify("memory: safety net skipped — <reason>",
	// "warn")` is invoked AND hook returns `undefined` (compact
	// proceeds; NOT `{cancel: true}`).
	//
	// We force the throw by overriding the extracted-by-mock
	// `extractMemoriesWithCallLlm` so it rejects once. The non-empty
	// compact event is required so the safety net does NOT short-circuit
	// at the counter guard (counter === 0 → safety net runs → reaches
	// the throwing call). Asserts:
	//   1. result === undefined (compact proceeds)
	//   2. result !== { cancel: true } (explicit non-cancel assertion)
	//   3. ctx.ui.notify was called with a warn-level message whose body
	//      contains "safety net skipped" — this proves the catch block
	//      took the graceful path (not the silent-swallow path)
	it("session_before_compact returns undefined and emits warn-level 'safety net skipped' notify when runCompactExtraction throws (S13)", async () => {
		expect(mod.getSegmentMemorySaveCount()).toBe(0);

		// Force the extraction pipeline to throw. We pick a distinctive
		// error message so the test can assert the message is plumbed
		// through to ctx.ui.notify unmodified.
		const boomMessage = "synthetic extraction failure for S13 test";
		extractMemoriesWithCallLlmMock.mockImplementationOnce(async () => {
			throw new Error(boomMessage);
		});

		const handler = getHandler("session_before_compact");
		const ctx = makeMockCtx();
		const event = makeNonEmptyCompactEvent();

		const result = await handler(event, ctx);

		// (1) Compact proceeds — hook returned undefined.
		expect(result).toBeUndefined();
		// (2) Hard gate is GONE — explicit regression guard against the
		// pre-4.3 `{cancel: true}` shape.
		expect(result).not.toEqual({ cancel: true });

		// (3) ctx.ui.notify was invoked with the warn-level graceful
		// message. notifySafely widens its accepted type union to allow
		// "warn" as a synonym for the underlying "warning" literal the
		// ctx.ui.notify API expects, so the captured type is the API
		// value the UI actually sees.
		expect(ctx.notifyCalls.length).toBeGreaterThan(0);
		const safetyNetSkipCall = ctx.notifyCalls.find(
			(c) => c.msg.includes("safety net skipped") && c.type === "warning",
		);
		expect(safetyNetSkipCall).toBeDefined();
		// The thrown error's message is plumbed through unchanged so the
		// user can see the original cause (auth vs. config vs. LLM).
		expect(safetyNetSkipCall!.msg).toContain(boomMessage);
	});
});

// ---------------------------------------------------------------------------
// registerMemorySave — tool registration shape
// ---------------------------------------------------------------------------

describe("registerMemorySave", () => {
	function makeFakePi() {
		const calls: any[] = [];
		const pi = {
			registerTool: (tool: any) => {
				calls.push(tool);
			},
		};
		return { pi, calls };
	}

	it("registers exactly one tool", () => {
		const { pi, calls } = makeFakePi();
		mod.registerMemorySave(pi as any);
		expect(calls).toHaveLength(1);
	});

	it("registers a tool named 'memory_save'", () => {
		const { pi, calls } = makeFakePi();
		mod.registerMemorySave(pi as any);
		expect(calls[0].name).toBe("memory_save");
	});

	it("registered tool exposes a TypeBox parameters schema and an execute function", () => {
		const { pi, calls } = makeFakePi();
		mod.registerMemorySave(pi as any);
		const tool = calls[0];
		expect(tool).toHaveProperty("parameters");
		// The TypeBox schema is a JSON-Schema-ish object — assert it
		// round-trips through Value.Check for a valid input.
		expect(Value.Check(tool.parameters, {
			type: "fact",
			title: "x",
			content: "long enough content body",
			summary: "summary line",
			importance: 0.5,
		})).toBe(true);
		expect(typeof tool.execute).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// registerTools — wires memory_save into the TUI extension entry point
//
// Task 3.1 contract: `registerTools(pi)` (in extensions/personal-assistant/tools.ts)
// must call `pi.registerTool(...)` with a tool named `memory_save`. This is the
// wire-level manifestation of the spec requirement "memory_save tool exposes
// three write outcomes" — without this registration the agent has no way to
// invoke memory_save at runtime.
//
// The `registerMemorySave` describe block above tests the helper in isolation;
// this block tests the integration through the same entry point the agent uses
// (so it would catch a regression where someone removed the `registerMemorySave`
// call from `registerTools`).
// ---------------------------------------------------------------------------

describe("registerTools wires memory_save", () => {
	// Mock pi object that captures every registerTool call. Also stubs the
	// `on(...)` and `sendUserMessage(...)` calls registerTools makes so the
	// test does not crash on the satellite / todo / context hooks.
	function makeRegisterToolsSpyPi() {
		const tools: any[] = [];
		const handlers: Record<string, unknown> = {};
		const pi = {
			on: (event: string, handler: unknown) => {
				handlers[event] = handler;
			},
			registerTool: (tool: any) => {
				tools.push(tool);
			},
			sendUserMessage: () => Promise.resolve(),
		};
		return { pi: pi as unknown as ExtensionAPI, tools, handlers };
	}

	it("calls pi.registerTool with a tool named 'memory_save' when registerTools runs", async () => {
		const { registerTools } = await import("../tools.ts");
		const { pi, tools } = makeRegisterToolsSpyPi();

		registerTools(pi);

		const memorySave = tools.find((t) => t.name === "memory_save");
		expect(memorySave).toBeDefined();
		expect(memorySave.name).toBe("memory_save");
	});

	it("memory_save tool registered via registerTools uses the TypeBox MemorySaveParams schema (accepts happy-path, rejects invalid input)", async () => {
		const { registerTools } = await import("../tools.ts");
		const { pi, tools } = makeRegisterToolsSpyPi();

		registerTools(pi);

		const memorySave = tools.find((t) => t.name === "memory_save");
		expect(memorySave).toBeDefined();
		expect(memorySave).toHaveProperty("parameters");

		// Happy-path input must validate against the schema the tool
		// actually exposes (the same MemorySaveParams used by the
		// registerMemorySave helper, but verified end-to-end through the
		// registerTools entry point).
		const happyPath = {
			type: "fact" as const,
			title: "Registertools integration fact",
			content: "Happy-path content body for the registerTools integration test",
			summary: "Summary for the registerTools integration test",
			importance: 0.5,
		};
		expect(Value.Check(memorySave.parameters, happyPath)).toBe(true);

		// Invalid input must NOT validate — importance above 1 is
		// rejected by the schema, proving the registered schema enforces
		// the same constraints the helper-level tests verify in isolation.
		const invalidImportance = {
			...happyPath,
			importance: 1.5,
		};
		expect(Value.Check(memorySave.parameters, invalidImportance)).toBe(false);
	});

	it("memory_save tool registered via registerTools exposes a non-empty promptSnippet", async () => {
		const { registerTools } = await import("../tools.ts");
		const { pi, tools } = makeRegisterToolsSpyPi();

		registerTools(pi);

		const memorySave = tools.find((t) => t.name === "memory_save");
		expect(memorySave).toBeDefined();
		expect(typeof memorySave.promptSnippet).toBe("string");
		expect(memorySave.promptSnippet.length).toBeGreaterThan(0);
	});

	// Task 3.2 — system prompt informs the agent about memory_save (delta
	// spec: "before_agent_start system prompt informs agent about
	// memory_save"). The scenario from scenarios.md L62-style:
	//   "system prompt contains the Memory section"
	// Verifies the `before_agent_start` hook registered by `registerTools`
	// appends a `## Memory` section describing the `memory_save` tool to
	// the returned systemPrompt. Without this injection the model has no
	// in-context hint that it can durably record preferences/rules/
	// processes, and the agent-driven write path (Task 2.2+) becomes
	// unreachable from real sessions.
	it("before_agent_start system prompt contains the Memory section (Task 3.2)", async () => {
		const { registerTools } = await import("../tools.ts");
		const { pi, handlers } = makeRegisterToolsSpyPi();

		registerTools(pi);

		const beforeHandler = handlers["before_agent_start"];
		expect(beforeHandler).toBeDefined();
		expect(typeof beforeHandler).toBe("function");

		const result = await (beforeHandler as (event: unknown) => Promise<unknown>)({
			systemPrompt: "BASE_SYSTEM_PROMPT",
		});

		expect(result).toBeDefined();
		expect(typeof result).toBe("object");
		const systemPrompt = (result as { systemPrompt?: string }).systemPrompt;
		expect(typeof systemPrompt).toBe("string");
		// The Memory section header must appear in the returned prompt so
		// the model can recognize this as a documented tool surface (not
		// just a side-effect from tool registration).
		expect(systemPrompt).toContain("## Memory");
		// The tool name itself must be mentioned so the model knows which
		// function to invoke. Memory section starts with "You have a
		// `memory_save` tool to durably record..."
		expect(systemPrompt).toContain("memory_save");
	});
});

// ---------------------------------------------------------------------------
// memory_save execute (RED — scaffold throws "not implemented")
//
// The tests below exercise the FINAL expected contract of the tool:
//   - call tool.execute with valid params against a real MemoryIndex
//   - assert the returned `details.action` is one of created / updated /
//     skipped / error with the expected shape
//
// In 2.1 the execute body throws "not implemented" so these tests FAIL.
// They will turn GREEN as tasks 2.2–2.7 land the real create / update /
// skip / error branches. Keeping them in this file (with the RED
// comment) means 2.2 is a pure body swap, not a test rewrite.
// ---------------------------------------------------------------------------

describe("memory_save execute (RED — scaffold throws 'not implemented')", () => {
	let tmpDir: string;
	let dbPath: string;
	let tool: any;

	beforeEach(async () => {
		vi.resetModules();
		mod = await import("../memory-save.ts");
		// env.HOME is restored in the top-level afterEach.
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-save-exec-test-"));
		process.env.HOME = tmpDir;
		dbPath = path.join(tmpDir, ".pi", "agent", "memory", "memory.db");

		// Register a fresh tool against a fake pi.
		const calls: any[] = [];
		const pi = {
			registerTool: (t: any) => {
				calls.push(t);
			},
		};
		mod.registerMemorySave(pi as any);
		tool = calls[0];
	});

	afterEach(async () => {
		process.env.HOME = ORIGINAL_HOME;
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	// This test is intentionally RED in 2.1: the scaffold execute throws
	// "not implemented", so the expected "created" branch is unreachable.
	// When 2.2 lands the real create path, this test must turn GREEN.
	it("create path: returns {action: 'created', id, embedding} for a brand new atom", async () => {
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		idx.close();

		const params = {
			type: "fact" as const,
			title: "Brand new fact",
			content: "Brand new content for create-path test",
			summary: "Summary of the new fact",
			tags: ["new"],
			importance: 0.5,
		};
		const result = await tool.execute(
			"call-1",
			params,
			undefined,
			undefined,
			{ ui: { notify: () => {} } },
		);
		expect(result.details.action).toBe("created");
		expect(typeof result.details.id).toBe("string");
		expect(["ok", "skipped"]).toContain(result.details.embedding);
	});

	// Counter increment after execute — the spec says the counter
	// increments on EVERY call regardless of outcome. In 2.1 the throw
	// happens before the counter increments, so this is also RED until
	// 2.2 wires the counter into the real execute body.
	it("increments segmentMemorySaveCount after a successful execute", async () => {
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		idx.close();

		expect(mod.getSegmentMemorySaveCount()).toBe(0);
		await tool.execute(
			"call-2",
			{
				type: "rule" as const,
				title: "Rule for counter test",
				content: "Rule content body for counter increment test",
				summary: "Rule summary line",
				importance: 0.6,
			},
			undefined,
			undefined,
			{ ui: { notify: () => {} } },
		);
		expect(mod.getSegmentMemorySaveCount()).toBe(1);
	});

	// Task 2.3 — fingerprint-hit skip path (scenarios.md:L13).
	// Pre-insert an atom with a known content, then call memory_save
	// with the same content (no id). Expected outcome:
	//   - details.action === "skipped"
	//   - details.reason === "duplicate_content"
	//   - details.existing_id === pre-inserted atom id
	//   - DB unchanged (no new row)
	//   - segmentMemorySaveCount incremented by 1 (counter counts calls,
	//     not successes)
	it("skip path: returns {action: 'skipped', reason: 'duplicate_content', existing_id} when fingerprint matches an existing active atom", async () => {
		// 1. Pre-insert an atom with a known content_fingerprint. Use the
		// real `computeFingerprint` from extraction.ts so any future
		// change to the normalization rule (whitespace, case) stays in
		// sync with the tool — the test would otherwise silently drift.
		const { computeFingerprint } = await import("../extraction.ts");
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		const duplicateContent = "Content that already exists in the database for fingerprint dedup test";
		const fingerprint = computeFingerprint(duplicateContent);

		const existingId = "a-789";
		const existingAtom = {
			id: existingId,
			type: "rule" as const,
			title: "Existing rule",
			summary: "Existing rule summary line",
			content: duplicateContent,
			tags: ["existing"],
			importance: 0.7,
			strength: 1.0,
			access_count: 0,
			version: 1,
			is_latest: 1 as const,
			parent_id: null,
			superseded_at: null,
			archived: 0 as const,
			created_at: Date.now(),
			updated_at: Date.now(),
			last_access: null,
			content_fingerprint: fingerprint,
			source_session: null,
		};
		await idx.insertAtom(existingAtom, new Array(1024).fill(0.01));
		idx.close();

		// 2. Call memory_save with the same content (no id).
		expect(mod.getSegmentMemorySaveCount()).toBe(0);
		const result = await tool.execute(
			"call-3",
			{
				type: "rule" as const,
				title: "Different title (does not matter — fingerprint wins)",
				content: duplicateContent,
				summary: "A different summary line",
				importance: 0.3,
			},
			undefined,
			undefined,
			{ ui: { notify: () => {} } },
		);

		// 3. Assert the result shape.
		expect(result.details).toEqual({
			action: "skipped",
			reason: "duplicate_content",
			existing_id: existingId,
		});

		// 4. Assert the DB is unchanged (still exactly 1 row, the pre-inserted atom).
		const verifyIdx = new MemoryIndex(dbPath);
		await verifyIdx.init();
		try {
			const allAtoms = verifyIdx.getActiveAtoms();
			expect(allAtoms).toHaveLength(1);
			expect(allAtoms[0].id).toBe(existingId);
			expect(allAtoms[0].content).toBe(duplicateContent);
			expect(allAtoms[0].version).toBe(1);
			expect(allAtoms[0].access_count).toBe(0);
		} finally {
			verifyIdx.close();
		}

		// 5. Assert the counter incremented by 1 (skip counts as a call).
		expect(mod.getSegmentMemorySaveCount()).toBe(1);
	});

	// Task 2.4 — overwrite path (id present, atom exists) — scenarios.md:L15.
	// Pre-insert an atom with id "a-123", content "old content"; then call
	// memory_save with the same id but new content/title/summary/tags/importance.
	// Expected outcome (per storage.ts:194 SQL `version = version + 1`):
	//   - details.action === "updated"
	//   - details.id === "a-123"
	//   - details.embedding === "ok" (mock returns a real vector) or "skipped"
	//     (when the embedder is down — accepting either keeps the test aligned
	//     with the create-path test's looser assertion)
	//   - DB row content/title/summary/tags/importance match the new params,
	//     version bumped (1 → 2), is_latest=1, archived preserved
	//   - .md file overwritten (we pre-write a stale .md so overwriting is
	//     observable rather than only creatable)
	//   - segmentMemorySaveCount incremented by 1
	it("overwrite path: returns {action: 'updated', id, embedding} when id is supplied and atom exists", async () => {
		const idx = new MemoryIndex(dbPath);
		await idx.init();

		// 1. Pre-insert atom a-123 with version=1, is_latest=1, archived=0,
		// and a stable fingerprint so we can detect that the overwrite keeps
		// the same row id but writes new content/title/summary/tags/importance.
		const oldContent = "Original content for atom a-123 overwrite test scenario";
		const { computeFingerprint } = await import("../extraction.ts");
		const oldFingerprint = computeFingerprint(oldContent);
		const existingId = "a-123";
		const oldCreatedAt = Date.now() - 10_000; // arbitrary, just need consistency
		await idx.insertAtom(
			{
				id: existingId,
				type: "rule" as const,
				title: "Old title before overwrite",
				summary: "Old summary line before overwrite",
				content: oldContent,
				tags: ["old"],
				importance: 0.4,
				strength: 0.6,
				access_count: 2,
				version: 1,
				is_latest: 1 as const,
				parent_id: null,
				superseded_at: null,
				archived: 0 as const,
				created_at: oldCreatedAt,
				updated_at: oldCreatedAt,
				last_access: null,
				content_fingerprint: oldFingerprint,
				source_session: "session-old",
			},
			new Array(1024).fill(0.05),
		);

		// Pre-write a stale .md so we can observe the overwrite (writeAtomToFile
		// fs.writeFile replaces the body; we put a sentinel string in the old
		// file that the new content will replace).
		const atomsDir = path.join(tmpDir, ".pi", "agent", "memory", "atoms");
		const staleFilePath = path.join(atomsDir, "rule", `${existingId}.md`);
		await fs.mkdir(path.dirname(staleFilePath), { recursive: true });
		await fs.writeFile(
			staleFilePath,
			"---\nid: \"a-123\"\n---\n\nSTALE_BODY_SENTINEL\n",
			"utf8",
		);

		idx.close();

		// 2. Call memory_save with the same id, new content.
		expect(mod.getSegmentMemorySaveCount()).toBe(0);
		const result = await tool.execute(
			"call-4",
			{
				id: existingId,
				type: "rule" as const,
				title: "new title",
				content: "new content for atom a-123 overwrite test scenario",
				summary: "new summary",
				tags: ["new"],
				importance: 0.8,
			},
			undefined,
			undefined,
			{ ui: { notify: () => {} } },
		);

		// 3. Assert the result shape (relaxed to match create-path test, since
		// the mock always returns a real vector, this should be "ok"; we still
		// accept "skipped" so a future embedder-down mock path doesn't break
		// the contract).
		expect(result.details.action).toBe("updated");
		expect(result.details.id).toBe(existingId);
		expect(["ok", "skipped"]).toContain(result.details.embedding);

		// 4. Assert the DB row reflects the new fields, version is bumped
		// (1 → 2 by SQL `version = version + 1` in storage.ts:194), is_latest
		// and archived are preserved (overwrite is in-place, not a recreate).
		const verifyIdx = new MemoryIndex(dbPath);
		await verifyIdx.init();
		try {
			const updated = verifyIdx.getAtom(existingId);
			expect(updated).not.toBeNull();
			expect(updated!.content).toBe(
				"new content for atom a-123 overwrite test scenario",
			);
			expect(updated!.title).toBe("new title");
			expect(updated!.summary).toBe("new summary");
			expect(updated!.tags).toEqual(["new"]);
			expect(updated!.importance).toBeCloseTo(0.8, 5);
			expect(updated!.version).toBe(2); // 1 + 1 by SQL
			expect(updated!.is_latest).toBe(1);
			expect(updated!.archived).toBe(0); // preserved
			// Continuity fields preserved across overwrite:
			expect(updated!.id).toBe(existingId);
			expect(updated!.source_session).toBe("session-old");
			expect(updated!.created_at).toBe(oldCreatedAt);
			expect(updated!.access_count).toBe(2);
			expect(updated!.strength).toBeCloseTo(0.6, 5);
			// updated_at must move forward (overwrite touches this column);
			// we don't pin an absolute value, only that it's >= oldCreatedAt.
			expect(updated!.updated_at).toBeGreaterThanOrEqual(oldCreatedAt);

			// getActiveAtoms should still see exactly 1 row (overwrite does
			// NOT insert; no new row from this call).
			const allActive = verifyIdx.getActiveAtoms();
			expect(allActive).toHaveLength(1);
			expect(allActive[0].id).toBe(existingId);
		} finally {
			verifyIdx.close();
		}

		// 5. Assert the .md file was overwritten (writeAtomToFile is called
		// after updateAtom; the sentinel must be gone, and the new content
		// should be in the body).
		const overwrittenBody = await fs.readFile(staleFilePath, "utf8");
		expect(overwrittenBody).not.toContain("STALE_BODY_SENTINEL");
		expect(overwrittenBody).toContain("new content for atom a-123");
		expect(overwrittenBody).toContain('title: "new title"');

		// 6. Assert the counter incremented by 1.
		expect(mod.getSegmentMemorySaveCount()).toBe(1);
	});

	// Task 2.5 — id_not_found error path (scenarios.md S7, spec.md L39-44).
	// Pre-state: empty DB (no atom with id "a-ghost"). Call memory_save
	// with `id: "a-ghost"` and any valid content. Expected outcome:
	//   - details.action === "error"
	//   - details.error === "id_not_found"
	//   - details.id === "a-ghost"
	//   - DB unchanged (still zero atoms)
	//   - No .md file was created (writeAtomToFile must not have run)
	//   - segmentMemorySaveCount incremented by 1 (the counter tracks
	//     "agent tried to write", not "agent successfully wrote" — per
	//     principle "counter 计入调用而不计入成功")
	it("id_not_found path: returns {action: 'error', error: 'id_not_found', id} when id is supplied but DB has no such atom", async () => {
		// 1. Empty DB — just init + close so the file exists.
		const idx = new MemoryIndex(dbPath);
		await idx.init();
		idx.close();

		const atomsDir = path.join(tmpDir, ".pi", "agent", "memory", "atoms");

		expect(mod.getSegmentMemorySaveCount()).toBe(0);
		const ghostId = "a-ghost";
		const result = await tool.execute(
			"call-5",
			{
				id: ghostId,
				type: "fact" as const,
				title: "ghost title",
				content: "content for ghost atom id_not_found test scenario",
				summary: "ghost summary line",
				tags: ["ghost"],
				importance: 0.4,
			},
			undefined,
			undefined,
			{ ui: { notify: () => {} } },
		);

		// 2. Assert the error envelope shape exactly (spec.md L43,
		// scenarios.md S7 line 40).
		expect(result.details).toEqual({
			action: "error",
			error: "id_not_found",
			id: ghostId,
		});

		// 3. Assert the DB is unchanged (still zero atoms — no insert).
		const verifyIdx = new MemoryIndex(dbPath);
		await verifyIdx.init();
		try {
			const ghost = verifyIdx.getAtom(ghostId);
			expect(ghost).toBeNull();
			expect(verifyIdx.getActiveAtoms()).toHaveLength(0);
		} finally {
			verifyIdx.close();
		}

		// 4. Assert the .md file was NOT created under atomsDir. The
		// type "fact" subdir would be the canonical writeAtomToFile
		// destination; assert the dir/file does not exist.
		const ghostMdPath = path.join(atomsDir, "fact", `${ghostId}.md`);
		await expect(fs.stat(ghostMdPath)).rejects.toThrow();

		// 5. Assert the counter incremented by 1 — the call still
		// counts even though it returned an error envelope (per
		// principle "counter 计入调用").
		expect(mod.getSegmentMemorySaveCount()).toBe(1);
	});

	// Task 2.7 — embedding-down graceful fallback (scenarios.md S8,
	// spec.md "memory_save gracefully falls back to zero vector when
	// embed service is unavailable"). Verifies BOTH the create and the
	// overwrite path fall back to a 1024-dim zero vector when
	// `embedText` returns `null` (ollama / bge-m3 unreachable), and
	// that `reindexOne` is STILL called so the bge-m3 service can
	// refresh its internal index from the freshly-written `.md` body.
	//
	// Implementation already exists in memory-save.ts: both branches
	// use the `embedding ?? new Array(1024).fill(0)` pattern
	// (matches `extraction.ts:243, 258`) and set the
	// `embedding: vectorWasNull ? "skipped" : "ok"` flag. This test
	// locks that contract — any future regression that drops the
	// fallback (e.g. propagating the null up and throwing) would break
	// S8 and force a fix.
	it("graceful fallback: returns embedding: 'skipped' and uses a 1024-dim zero vector in both branches when embedText returns null", async () => {
		// 1. Re-import the storage + bge-reindex modules so we operate on
		//    the SAME module instances memory-save.ts is using (the inner
		//    beforeEach called `vi.resetModules()` → storage.ts and
		//    bge-reindex.ts were re-evaluated; re-importing here hits the
		//    cache and returns the same instances). Spies on stale
		//    instances from the top-level beforeEach would not intercept
		//    calls made by the freshly-registered tool.
		const storageMod = await import("../storage.ts");
		const bgeMod = await import("../bge-reindex.ts");

		// 2. Override the module-level `embedText` mock (set up at the
		//    top of this file) so it resolves to `null` — simulating
		//    "embedding service is down". The factory's default
		//    char-bag vector is overridden per-test via the same vi.fn
		//    instance the rest of the suite uses; the next test's
		//    `vi.resetModules()` re-creates the factory and resets the
		//    default behavior, so this override does not leak.
		const embedMod = await import("../embed.ts");
		vi.mocked(embedMod.embedText).mockReset();
		vi.mocked(embedMod.embedText).mockResolvedValue(null);

		// 3. Spy on the bge-m3 reindex entry point so the test does not
		//    hit a real network endpoint. `reindexOne` is the function
		//    memory-save.ts imports from `./bge-reindex.ts` — same
		//    module instance as `bgeMod.reindexOne` after `resetModules`
		//    + re-import above, so the spy intercepts the tool's call.
		const reindexSpy = vi
			.spyOn(bgeMod, "reindexOne")
			.mockResolvedValue({ ok: true });

		// 4. Spy on `MemoryIndex.prototype.insertAtom` and `updateAtom`
		//    with `vi.spyOn` (NO `mockResolvedValue` override) so the
		//    original implementations still run and write to the real
		//    on-disk DB. We capture call args via `spy.mock.calls`
		//    (asserting the 1024-dim zero vector was passed) AND we
		//    can verify the DB side effect afterwards via
		//    `MemoryIndex.getEmbedding`.
		const insertSpy = vi.spyOn(storageMod.MemoryIndex.prototype, "insertAtom");
		const updateSpy = vi.spyOn(storageMod.MemoryIndex.prototype, "updateAtom");

		// 5. Pre-insert an existing atom for the overwrite path. This
		//    uses the FRESH `storageMod.MemoryIndex` (same class as the
		//    tool's internal `new MemoryIndex(dbPath)`), so the row is
		//    visible to the tool's `index.getAtom(id)` call below.
		const preIdx = new storageMod.MemoryIndex(dbPath);
		await preIdx.init();
		const existingId = "a-7890";
		const { computeFingerprint } = await import("../extraction.ts");
		const oldContent = "Original content for embedding-down overwrite path test scenario";
		await preIdx.insertAtom(
			{
				id: existingId,
				type: "fact" as const,
				title: "Pre-existing fact for embed-down test",
				summary: "Pre-existing summary for embed-down test",
				content: oldContent,
				tags: ["embed-down"],
				importance: 0.4,
				strength: 1.0,
				access_count: 0,
				version: 1,
				is_latest: 1 as const,
				parent_id: null,
				superseded_at: null,
				archived: 0 as const,
				created_at: Date.now(),
				updated_at: Date.now(),
				last_access: null,
				content_fingerprint: computeFingerprint(oldContent),
				source_session: null,
			},
			// Pre-existing vector doesn't matter for this test; use a
			// non-zero filler so we can tell the post-call zero vector
			// (from the tool's fallback) apart from any pre-existing
			// row's vector when scanning memory_vectors.
			new Array(1024).fill(0.5),
		);
		preIdx.close();

		// 5b. Clear the spies' recorded calls accumulated during the
		//     pre-insert setup, so the assertions below measure ONLY
		//     the calls made by the tool's execute body (not the
		//     `preIdx.insertAtom` above, which would otherwise count
		//     toward `toHaveBeenCalledTimes(1)`).
		insertSpy.mockClear();
		updateSpy.mockClear();
		reindexSpy.mockClear();

		// 6. CREATE PATH — call memory_save with no id, unique content.
		//    Expected: details.action === "created", embedding === "skipped",
		//    insertAtom called with a 1024-dim zero vector, reindexOne
		//    called with the new atom id, and the DB has a row whose
		//    stored vector is all zeros.
		const createResult = await tool.execute(
			"call-create-down",
			{
				type: "fact" as const,
				title: "Embedding-down create fact",
				content:
					"Unique content for embedding-down fallback test create path scenario",
				summary: "Summary for embed-down create path",
				tags: ["embed-down"],
				importance: 0.5,
			},
			undefined,
			undefined,
			{ ui: { notify: () => {} } },
		);

		// 6a. Result shape.
		expect(createResult.details.action).toBe("created");
		expect(createResult.details.embedding).toBe("skipped");
		expect(typeof createResult.details.id).toBe("string");

		// 6b. insertAtom was called exactly once with a 1024-dim zero
		//     vector as its 2nd arg (atom, vector).
		expect(insertSpy).toHaveBeenCalledTimes(1);
		const createVector = insertSpy.mock.calls[0]?.[1];
		expect(Array.isArray(createVector)).toBe(true);
		expect(createVector).toHaveLength(1024);
		for (let i = 0; i < createVector.length; i++) {
			expect(createVector[i]).toBe(0);
		}

		// 6c. reindexOne was called with the new atom id (so the
		//     bge-m3 service can refresh its index from the .md body
		//     even though our embed call failed — S8 line 45).
		expect(reindexSpy).toHaveBeenCalled();
		const reindexArgsAfterCreate = reindexSpy.mock.calls.map((c) => c[0]);
		expect(reindexArgsAfterCreate).toContain(createResult.details.id);

		// 6d. DB state side-effect — memory_vectors row for the new
		//     atom holds a 1024-dim zero vector (Float32 packed by
		//     sqlite-vec → reconstructed by `getEmbedding`).
		const verifyCreateIdx = new storageMod.MemoryIndex(dbPath);
		await verifyCreateIdx.init();
		try {
			const storedVector = verifyCreateIdx.getEmbedding(createResult.details.id);
			expect(storedVector).not.toBeNull();
			expect(storedVector).toHaveLength(1024);
			for (let i = 0; i < storedVector!.length; i++) {
				expect(storedVector![i]).toBe(0);
			}
		} finally {
			verifyCreateIdx.close();
		}

		// 7. OVERWRITE PATH — call memory_save with the existing id and
		//    new content. Expected: details.action === "updated",
		//    embedding === "skipped", updateAtom called with a
		//    1024-dim zero vector, reindexOne called with the existing
		//    id, and the stored vector is now all zeros (the
		//    pre-existing 0.5 vector was overwritten).
		const updateResult = await tool.execute(
			"call-overwrite-down",
			{
				id: existingId,
				type: "fact" as const,
				title: "Updated title for embed-down overwrite test",
				content:
					"Updated content for embedding-down overwrite test path scenario",
				summary: "Updated summary line for embed-down overwrite test",
				tags: ["embed-down", "updated"],
				importance: 0.7,
			},
			undefined,
			undefined,
			{ ui: { notify: () => {} } },
		);

		// 7a. Result shape.
		expect(updateResult.details.action).toBe("updated");
		expect(updateResult.details.id).toBe(existingId);
		expect(updateResult.details.embedding).toBe("skipped");

		// 7b. updateAtom was called exactly once with a 1024-dim zero
		//     vector as its 2nd arg (atom, vector).
		expect(updateSpy).toHaveBeenCalledTimes(1);
		const updateVector = updateSpy.mock.calls[0]?.[1];
		expect(Array.isArray(updateVector)).toBe(true);
		expect(updateVector).toHaveLength(1024);
		for (let i = 0; i < updateVector!.length; i++) {
			expect(updateVector![i]).toBe(0);
		}

		// 7c. reindexOne was called again, this time with the existing
		//     id (the overwrite path uses the atom's own id, not a new
		//     uuid). Total reindexOne call count across both calls is 2.
		expect(reindexSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
		const reindexArgsAfterUpdate = reindexSpy.mock.calls.map((c) => c[0]);
		expect(reindexArgsAfterUpdate).toContain(existingId);

		// 7d. DB state side-effect — the existing atom's stored
		//     vector is now all zeros (was 0.5 pre-overwrite; the
		//     tool's fallback overwrote it).
		const verifyUpdateIdx = new storageMod.MemoryIndex(dbPath);
		await verifyUpdateIdx.init();
		try {
			const updatedStoredVector = verifyUpdateIdx.getEmbedding(existingId);
			expect(updatedStoredVector).not.toBeNull();
			expect(updatedStoredVector).toHaveLength(1024);
			for (let i = 0; i < updatedStoredVector!.length; i++) {
				expect(updatedStoredVector![i]).toBe(0);
			}
		} finally {
			verifyUpdateIdx.close();
		}

		// 8. Cleanup: restore the spies so the next test's
		//    `vi.resetModules()` doesn't see leaked instrumentation
		//    on the prototype / module namespace (defensive — most
		//    other tests in this describe don't use these spies).
		insertSpy.mockRestore();
		updateSpy.mockRestore();
		reindexSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// tool_call hook — blocks write/edit to memory atoms (Task 3.3)
//
// Delta spec (spec.md §"tool_call hook blocks direct file writes to memory
// atoms") requires the personal-assistant `tool_call` hook to block
// `write` / `edit` tool calls whose resolved path falls under
// `~/.pi/agent/memory/atoms/**`. Read operations must NOT be blocked. Bash
// heredoc / redirect coverage is Task 3.4 and is intentionally not tested
// here.
//
// The hook lives in tools.ts (registered by `registerTools`). We invoke
// the captured handler with a synthesized tool_call event and assert the
// returned `{block, reason}` (or `undefined`) per scenario.
// ---------------------------------------------------------------------------

describe("tool_call hook blocks write/edit to memory atoms (Task 3.3)", () => {
	let tmpDir: string;
	let handlers: Record<string, unknown>;

	// Build a spy pi that captures every hook and tool registration, then
	// runs `registerTools(pi)` against a freshly-imported tools module.
	// `process.env.HOME` must be set BEFORE the import so the hook body's
	// atomsDir resolution (which calls `homedir()`) lands inside tmpDir.
	async function setupPiWithHome(homeDir: string): Promise<void> {
		process.env.HOME = homeDir;
		vi.resetModules();
		const { registerTools } = await import("../tools.ts");
		const tools: unknown[] = [];
		handlers = {};
		const pi = {
			on: (event: string, handler: unknown) => {
				handlers[event] = handler;
			},
			registerTool: (tool: unknown) => {
				tools.push(tool);
			},
			sendUserMessage: () => Promise.resolve(),
		};
		registerTools(pi as unknown as ExtensionAPI);
	}

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tool-call-atom-guard-"));
		await setupPiWithHome(tmpDir);
	});

	afterEach(async () => {
		process.env.HOME = ORIGINAL_HOME;
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	// Task 3.3 — S9: write tool to atoms/process/foo.md is blocked.
	// Helper resolves `~` against the test-controlled HOME so the path
	// under test lands inside the configured atomsDir.
	it("blocks write({path: '~/.pi/agent/memory/atoms/process/foo.md'}) (S9)", async () => {
		const handler = handlers["tool_call"];
		expect(typeof handler).toBe("function");

		const result = await (handler as (event: unknown) => Promise<unknown>)({
			toolName: "write",
			input: {
				path: "~/.pi/agent/memory/atoms/process/foo.md",
				content: "should not be written",
			},
		});

		expect(result).toBeDefined();
		expect(typeof result).toBe("object");
		const block = result as { block: boolean; reason: string };
		expect(block.block).toBe(true);
		// Reason must steer the agent toward the canonical tool name so
		// the rejection doubles as a teaching message — mirrors the
		// pre-emptive teaching pattern in
		// buildTransferFileCanonicalPrompt.
		expect(block.reason).toMatch(/memory_save/);
		expect(block.reason).toContain("write");
	});

	// Task 3.3 — S9 (edit variant): edit tool to atoms/fact/a-123.md is
	// blocked. We use a fixed UUID-shaped id so this also implicitly
	// covers the canonical atom file path; the hook should still reject
	// without caring about the id's exact value.
	it("blocks edit({path: '~/.pi/agent/memory/atoms/fact/a-123.md'}) (S9 edit)", async () => {
		const handler = handlers["tool_call"];
		expect(typeof handler).toBe("function");

		const result = await (handler as (event: unknown) => Promise<unknown>)({
			toolName: "edit",
			input: {
				path: "~/.pi/agent/memory/atoms/fact/a-123.md",
				oldText: "old body",
				newText: "new body",
			},
		});

		expect(result).toBeDefined();
		expect(typeof result).toBe("object");
		const block = result as { block: boolean; reason: string };
		expect(block.block).toBe(true);
		expect(block.reason).toMatch(/memory_save/);
	});

	// Task 3.3 — negative: write to a non-atom path is NOT blocked. The
	// hook must let through arbitrary file paths; only the atoms subtree
	// is guarded. This test would fail if the implementation accidentally
	// blocked all writes (a too-broad regex like /atoms/).
	it("does not block write({path: '/tmp/random.txt'})", async () => {
		const handler = handlers["tool_call"];
		expect(typeof handler).toBe("function");

		const result = await (handler as (event: unknown) => Promise<unknown>)({
			toolName: "write",
			input: { path: "/tmp/random.txt", content: "harmless content" },
		});

		expect(result).toBeUndefined();
	});

	// Task 3.3 — S11: read of an atom file is NOT blocked. The hook only
	// inspects `write` / `edit` tool calls; `read` falls through. The
	// scenario explicitly calls this out so the agent can still inspect
	// existing atom contents before calling memory_save.
	it("does not block read({path: '~/.pi/agent/memory/atoms/fact/a-123.md'}) (S11)", async () => {
		const handler = handlers["tool_call"];
		expect(typeof handler).toBe("function");

		const result = await (handler as (event: unknown) => Promise<unknown>)({
			toolName: "read",
			input: { path: "~/.pi/agent/memory/atoms/fact/a-123.md" },
		});

		expect(result).toBeUndefined();
	});

	// Task 3.3 — bash is intentionally NOT covered here (Task 3.4 owns
	// heredoc / redirect detection). This test pins that the write/edit
	// branch does NOT block plain bash commands, even if a `bash` tool
	// call somehow flows past the current implementation's scope.
	it("does not block bash({command: 'cat file'}) — bash is Task 3.4's scope", async () => {
		const handler = handlers["tool_call"];
		expect(typeof handler).toBe("function");

		const result = await (handler as (event: unknown) => Promise<unknown>)({
			toolName: "bash",
			input: { command: "cat file" },
		});

		expect(result).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// tool_call hook — blocks bash redirect / heredoc / tee to memory atoms
// (Task 3.4)
//
// Delta spec (spec.md §"tool_call hook blocks direct file writes to memory
// atoms" + scenarios.md S10/S11) requires the personal-assistant `tool_call`
// hook to ALSO block `bash` commands whose shell syntax (`>` / `>>` /
// `tee`) targets a path under `~/.pi/agent/memory/atoms/**`. Read-only bash
// commands (no write operator + atoms path) MUST NOT be blocked — that
// mirrors the read-tool exception in Task 3.3.
//
// Like the Task 3.3 block, these tests drive the hook through a spy pi and
// assert the returned `{block, reason}` (or `undefined`). The helper
// `looksLikeWriteToAtomsDir` is internal to tools.ts (not exported), so
// coverage comes through the public hook surface.
// ---------------------------------------------------------------------------

describe("tool_call hook blocks bash redirect/heredoc/tee to memory atoms (Task 3.4)", () => {
	let tmpDir: string;
	let handlers: Record<string, unknown>;

	// Same spy pi setup as the Task 3.3 block — `registerTools(pi)` against
	// a freshly-imported tools module so the hook body's atomsDir resolution
	// (`homedir()`) lands inside the tmp HOME.
	async function setupPiWithHome(homeDir: string): Promise<void> {
		process.env.HOME = homeDir;
		vi.resetModules();
		const { registerTools } = await import("../tools.ts");
		const tools: unknown[] = [];
		handlers = {};
		const pi = {
			on: (event: string, handler: unknown) => {
				handlers[event] = handler;
			},
			registerTool: (tool: unknown) => {
				tools.push(tool);
			},
			sendUserMessage: () => Promise.resolve(),
		};
		registerTools(pi as unknown as ExtensionAPI);
	}

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tool-call-bash-atom-guard-"));
		await setupPiWithHome(tmpDir);
	});

	afterEach(async () => {
		process.env.HOME = ORIGINAL_HOME;
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	// S10 — bash heredoc / `>` redirect to atoms/process/foo.md is
	// blocked. The reason must steer the agent toward the canonical tool
	// name (`memory_save`) so the rejection doubles as teaching.
	it("blocks bash({command: 'cat > ~/.pi/agent/memory/atoms/process/foo.md <<EOF\\n...\\nEOF'}) (S10)", async () => {
		const handler = handlers["tool_call"];
		expect(typeof handler).toBe("function");

		const result = await (handler as (event: unknown) => Promise<unknown>)({
			toolName: "bash",
			input: {
				command: "cat > ~/.pi/agent/memory/atoms/process/foo.md <<EOF\n...\nEOF",
			},
		});

		expect(result).toBeDefined();
		expect(typeof result).toBe("object");
		const block = result as { block: boolean; reason: string };
		expect(block.block).toBe(true);
		expect(block.reason).toMatch(/memory_save/);
		// Reason text mentions redirect / heredoc so the model sees WHY
		// the bash approach is rejected (vs. the write/edit reason text).
		expect(block.reason).toMatch(/redirect|heredoc/);
	});

	// S10 sibling — `tee` to atoms/fact/bar.md is blocked. `tee` is the
	// second write operator the helper recognises (`>`, `>>`, `tee`).
	it("blocks bash({command: \"echo 'x' | tee ~/.pi/agent/memory/atoms/fact/bar.md\"})", async () => {
		const handler = handlers["tool_call"];
		expect(typeof handler).toBe("function");

		const result = await (handler as (event: unknown) => Promise<unknown>)({
			toolName: "bash",
			input: {
				command: "echo 'x' | tee ~/.pi/agent/memory/atoms/fact/bar.md",
			},
		});

		expect(result).toBeDefined();
		const block = result as { block: boolean; reason: string };
		expect(block.block).toBe(true);
		expect(block.reason).toMatch(/memory_save/);
	});

	// S10 sibling — append `>>` to atoms/process/append.md is blocked.
	// `>>?` in the regex matches both `>` and `>>` as write operators.
	it("blocks bash({command: \"echo 'x' >> ~/.pi/agent/memory/atoms/process/append.md\"})", async () => {
		const handler = handlers["tool_call"];
		expect(typeof handler).toBe("function");

		const result = await (handler as (event: unknown) => Promise<unknown>)({
			toolName: "bash",
			input: {
				command: "echo 'x' >> ~/.pi/agent/memory/atoms/process/append.md",
			},
		});

		expect(result).toBeDefined();
		const block = result as { block: boolean; reason: string };
		expect(block.block).toBe(true);
		expect(block.reason).toMatch(/memory_save/);
	});

	// S11 — bash read of atom file is NOT blocked. The command has NO
	// write operator (`>`, `>>`, `tee`); the regex doesn't match even
	// though the path is under atoms/. This mirrors the read-tool
	// exception in Task 3.3 so the agent can still inspect existing
	// atoms via bash (cat / less / grep / etc.) before deciding to
	// update.
	it("does not block bash({command: 'cat ~/.pi/agent/memory/atoms/process/a-123.md'}) (S11)", async () => {
		const handler = handlers["tool_call"];
		expect(typeof handler).toBe("function");

		const result = await (handler as (event: unknown) => Promise<unknown>)({
			toolName: "bash",
			input: {
				command: "cat ~/.pi/agent/memory/atoms/process/a-123.md",
			},
		});

		expect(result).toBeUndefined();
	});

	// Negative — bash with no atoms path and no write operator passes
	// through. This pins that the regex doesn't accidentally match
	// arbitrary commands like `ls` or `echo hello`. (No `>`, no `tee`,
	// no atoms substring.)
	it("does not block bash({command: 'ls /tmp/random.txt'})", async () => {
		const handler = handlers["tool_call"];
		expect(typeof handler).toBe("function");

		const result = await (handler as (event: unknown) => Promise<unknown>)({
			toolName: "bash",
			input: { command: "ls /tmp/random.txt" },
		});

		expect(result).toBeUndefined();
	});
});
