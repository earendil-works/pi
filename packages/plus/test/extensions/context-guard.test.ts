/**
 * Tests for plus/src/extensions/context-guard/index.ts — message-count force
 * trigger, relevance pruning at turn_end, and the resume compact suggestion.
 */
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, it } from "vitest";
import type { ContextUsage, ExtensionAPI, ExtensionContext } from "../../../coding-agent/src/core/extensions/types.ts";
import type { ProjectedSessionEntry, SessionEntry } from "../../../coding-agent/src/core/session-manager.ts";
import { resetAutoCompactBreaker, setCurrentModel } from "../../src/context/detection.ts";
import { registerContextGuard } from "../../src/extensions/context-guard/index.ts";

const NOW = 1_700_000_000_000;

// Large window so the CC floor does not dominate; PI_AUTOCOMPACT_PCT_OVERRIDE=1
// pins the threshold at 1% of the effective window (1918 tokens):
// reserve = min(8192, 20k) = 8192; effective = 191808; threshold = 1918.
const MODEL = { contextWindow: 200_000, maxTokens: 8_192 } as Model<never>;

function userMessage(text: string, timestamp = NOW): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp } as AgentMessage;
}

function entry(id: string, messages: AgentMessage[]): ProjectedSessionEntry {
	const sourceEntry = {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(timestampOf(messages)).toISOString(),
	} as SessionEntry;
	(sourceEntry as { message?: AgentMessage }).message = messages[0];
	return { sourceEntry, messages };
}

function timestampOf(messages: AgentMessage[]): number {
	return messages.reduce((max, m) => Math.max(max, m.timestamp), NOW);
}

interface FakeCtx {
	mode: string;
	hasUI: boolean;
	projection: ProjectedSessionEntry[];
	usage: ContextUsage | undefined;
	compactCalls: number;
	confirmCalls: { title: string; message: string }[];
	confirmAnswer: boolean;
}

function fakeCtx(overrides: Partial<FakeCtx> = {}): { ctx: ExtensionContext; fake: FakeCtx } {
	const fake: FakeCtx = {
		mode: "tui",
		hasUI: true,
		projection: [],
		usage: undefined,
		compactCalls: 0,
		confirmCalls: [],
		confirmAnswer: true,
		...overrides,
	};
	const ctx = {
		mode: fake.mode,
		hasUI: fake.hasUI,
		model: MODEL,
		sessionManager: {
			buildSessionProjection: () => ({
				entries: fake.projection,
				messages: fake.projection.flatMap((e) => e.messages),
			}),
			getBranch: () => fake.projection.map((p) => p.sourceEntry),
		},
		getContextUsage: () => fake.usage,
		compact: () => {
			fake.compactCalls++;
		},
		ui: {
			confirm: async (title: string, message: string) => {
				fake.confirmCalls.push({ title, message });
				return fake.confirmAnswer;
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, fake };
}

type TurnEndResult = { entries?: { type: string; targetId: string; replacement: unknown }[] } | undefined;

function captureGuard() {
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	const pi = { on: (event: string, handler: never) => handlers.set(event, handler) } as unknown as ExtensionAPI;
	registerContextGuard(pi);
	const turnEnd = (event: never, ctx: ExtensionContext): TurnEndResult =>
		handlers.get("turn_end")?.(event, ctx) as TurnEndResult;
	const sessionStart = (event: never, ctx: ExtensionContext): Promise<unknown> =>
		Promise.resolve(handlers.get("session_start")?.(event, ctx));
	return { turnEnd, sessionStart };
}

beforeEach(() => {
	resetAutoCompactBreaker();
	setCurrentModel(MODEL);
	process.env.PI_AUTOCOMPACT_PCT_OVERRIDE = "1"; // threshold = 1% of 191808 = 1918
});

afterEach(() => {
	resetAutoCompactBreaker();
	setCurrentModel(undefined);
	delete process.env.PI_AUTOCOMPACT_PCT_OVERRIDE;
	delete process.env.PI_MAX_ACTIVE_MESSAGES;
	delete process.env.PI_DISABLE_AUTO_COMPACT;
	delete process.env.PI_DISABLE_COMPACT;
	delete process.env.PI_PRUNE_TAIL_TURNS;
});

describe("turn_end: message-count force trigger", () => {
	it("forces compaction when the active message count exceeds the cap", () => {
		process.env.PI_MAX_ACTIVE_MESSAGES = "3";
		const projection = [
			entry("e1", [userMessage("one")]),
			entry("e2", [userMessage("two")]),
			entry("e3", [userMessage("three")]),
			entry("e4", [userMessage("four")]),
		];
		const { ctx, fake } = fakeCtx({ projection });
		const { turnEnd } = captureGuard();
		turnEnd({ type: "turn_end" } as never, ctx);
		assert.equal(fake.compactCalls, 1);
	});

	it("does not force compaction at or under the cap and skips pruning below threshold", () => {
		process.env.PI_MAX_ACTIVE_MESSAGES = "10";
		const projection = [entry("e1", [userMessage("tiny")])];
		const { ctx, fake } = fakeCtx({ projection });
		const { turnEnd } = captureGuard();
		const result = turnEnd({ type: "turn_end" } as never, ctx);
		assert.equal(fake.compactCalls, 0);
		assert.equal(result, undefined);
	});

	it("is disabled by PI_MAX_ACTIVE_MESSAGES=0 and honors PI_DISABLE_COMPACT", () => {
		process.env.PI_MAX_ACTIVE_MESSAGES = "0";
		const projection = [entry("e1", [userMessage("one")]), entry("e2", [userMessage("two")])];
		const { ctx, fake } = fakeCtx({ projection });
		const { turnEnd } = captureGuard();
		turnEnd({ type: "turn_end" } as never, ctx);
		assert.equal(fake.compactCalls, 0);

		process.env.PI_MAX_ACTIVE_MESSAGES = "1";
		process.env.PI_DISABLE_COMPACT = "1";
		turnEnd({ type: "turn_end" } as never, ctx);
		assert.equal(fake.compactCalls, 0);
	});
});

describe("turn_end: relevance pruning", () => {
	function bigProjection(): ProjectedSessionEntry[] {
		const big = "x".repeat(8000); // ~2000 tokens, over the 1918 threshold
		return [
			entry("old", [userMessage(big, NOW - 60_000), userMessage("old follow-up", NOW - 59_000)]),
			entry("recent", [userMessage("latest question"), userMessage("latest follow-up")]),
		];
	}

	it("returns context_edit omission drafts when over the threshold", () => {
		process.env.PI_PRUNE_TAIL_TURNS = "1";
		const { ctx } = fakeCtx({ projection: bigProjection() });
		const { turnEnd } = captureGuard();
		const result = turnEnd({ type: "turn_end" } as never, ctx);
		assert.deepEqual(result?.entries, [{ type: "context_edit", targetId: "old", replacement: null }]);
	});

	it("does not prune when auto-compact is disabled", () => {
		process.env.PI_PRUNE_TAIL_TURNS = "1";
		process.env.PI_DISABLE_AUTO_COMPACT = "1";
		const { ctx } = fakeCtx({ projection: bigProjection() });
		const { turnEnd } = captureGuard();
		assert.equal(turnEnd({ type: "turn_end" } as never, ctx), undefined);
	});

	it("does not prune when the projection is under the threshold", () => {
		const { ctx } = fakeCtx({ projection: [entry("e1", [userMessage("tiny")])] });
		const { turnEnd } = captureGuard();
		assert.equal(turnEnd({ type: "turn_end" } as never, ctx), undefined);
	});
});

describe("session_start: resume compact suggestion", () => {
	function resumedUsage(tokens: number, percent = Math.round((tokens / 200_000) * 100)): ContextUsage {
		return { tokens, contextWindow: 200_000, percent };
	}

	it("prompts and compacts when a resumed session is at/above 70% of the threshold", async () => {
		// threshold=1918, 70% = 1343; 1500 tokens prompts.
		const projection = [entry("e1", [userMessage("prior content")])];
		const { ctx, fake } = fakeCtx({ projection, usage: resumedUsage(1500, 75) });
		const { sessionStart } = captureGuard();
		await sessionStart({ type: "session_start", reason: "resume" } as never, ctx);
		assert.equal(fake.confirmCalls.length, 1);
		assert.match(fake.confirmCalls[0].title, /75% full/);
		assert.equal(fake.compactCalls, 1);
	});

	it("declines to compact when the user answers no", async () => {
		const projection = [entry("e1", [userMessage("prior content")])];
		const { ctx, fake } = fakeCtx({ projection, usage: resumedUsage(1500), confirmAnswer: false });
		const { sessionStart } = captureGuard();
		await sessionStart({ type: "session_start", reason: "fork" } as never, ctx);
		assert.equal(fake.confirmCalls.length, 1);
		assert.equal(fake.compactCalls, 0);
	});

	it("does not prompt below 70% of the threshold, for fresh sessions, or outside the TUI", async () => {
		const projection = [entry("e1", [userMessage("prior content")])];
		const { sessionStart } = captureGuard();

		// 1000 < 1343: under the resume floor.
		const below = fakeCtx({ projection, usage: resumedUsage(1000) });
		await sessionStart({ type: "session_start", reason: "resume" } as never, below.ctx);
		assert.equal(below.fake.confirmCalls.length, 0);

		// Fresh session with the same usage.
		const fresh = fakeCtx({ projection: [], usage: resumedUsage(1500) });
		await sessionStart({ type: "session_start", reason: "new" } as never, fresh.ctx);
		assert.equal(fresh.fake.confirmCalls.length, 0);

		// CLI -r reports "startup"; only an empty branch means fresh.
		const startupEmpty = fakeCtx({ projection: [], usage: resumedUsage(1500) });
		await sessionStart({ type: "session_start", reason: "startup" } as never, startupEmpty.ctx);
		assert.equal(startupEmpty.fake.confirmCalls.length, 0);

		// Startup with prior content (CLI -r) prompts…
		const startupResumed = fakeCtx({ projection, usage: resumedUsage(1500) });
		await sessionStart({ type: "session_start", reason: "startup" } as never, startupResumed.ctx);
		assert.equal(startupResumed.fake.confirmCalls.length, 1);

		// …but not in print mode.
		const printMode = fakeCtx({ projection, usage: resumedUsage(1500) });
		printMode.ctx.mode = "print";
		await sessionStart({ type: "session_start", reason: "resume" } as never, printMode.ctx);
		assert.equal(printMode.fake.confirmCalls.length, 0);
	});

	it("does not prompt when auto-compact is disabled", async () => {
		process.env.PI_DISABLE_AUTO_COMPACT = "1";
		const projection = [entry("e1", [userMessage("prior content")])];
		const { ctx, fake } = fakeCtx({ projection, usage: resumedUsage(1500) });
		const { sessionStart } = captureGuard();
		await sessionStart({ type: "session_start", reason: "resume" } as never, ctx);
		assert.equal(fake.confirmCalls.length, 0);
		assert.equal(fake.compactCalls, 0);
	});
});
