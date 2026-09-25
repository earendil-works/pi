/**
 * Tests for plus/src/compaction/compact.ts — Claude Code-style full-conversation
 * compaction. Uses a fake streamFn (faux provider, no real APIs) injected through
 * pi's existing streamFn seam; upstream completeSummarization calls it directly.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model, TranscriptContext, Usage } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, it } from "vitest";
import type { CompactionPreparation } from "../../../coding-agent/src/core/compaction/compaction.ts";
import { compact, generateSummaryWithUsage } from "../../src/compaction/compact.ts";
import { isAutoCompactBreakerTripped, resetAutoCompactBreaker } from "../../src/context/detection.ts";

const MODEL = {
	id: "faux-1",
	name: "Faux One",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "http://localhost:1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
} as unknown as Model<any>;

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1_700_000_000_000 } as AgentMessage;
}

function assistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: { input: 10, output: 20, total: 30 } as unknown as Usage,
		stopReason,
		timestamp: 1_700_000_000_001,
	};
}

const SUMMARY_TEXT =
	"<analysis>scratchpad</analysis>\n\n<summary>\n1. Primary Request and Intent:\n   Do the work.\n</summary>";

interface RecordedCall {
	context: TranscriptContext;
}

/** Fake streamFn: replays queued outcomes (message or thrown error) and records calls. */
function fakeStreamFn(outcomes: Array<AssistantMessage | Error>, calls: RecordedCall[]) {
	return (async (_model: Model<any>, context: TranscriptContext, _options?: unknown) => {
		calls.push({ context });
		const outcome = outcomes.shift();
		if (!outcome) throw new Error("fake streamFn ran out of queued outcomes");
		if (outcome instanceof Error) throw outcome;
		return { result: async () => outcome } as unknown as ReturnType<StreamFn> extends Promise<infer R> ? R : never;
	}) as unknown as StreamFn;
}

function preparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	return {
		firstKeptEntryId: "entry-keep-me",
		messagesToSummarize: [
			userMessage("first request"),
			assistantMessage("first reply"),
			userMessage("second request"),
			assistantMessage("second reply"),
		],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 42,
		previousSummary: undefined,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
		...overrides,
	};
}

/** Extract the full text of the recorded request for substring assertions. */
function requestText(call: RecordedCall): string {
	return call.context.messages.map((m) => ("content" in m ? contentText(m.content as never, "") : "")).join("\n");
}

beforeEach(() => {
	resetAutoCompactBreaker();
	delete process.env.PI_DISABLE_COMPACT;
});

afterEach(() => {
	delete process.env.PI_DISABLE_COMPACT;
});

describe("compact", () => {
	it("returns the formatted summary, keeps the cut point, and reports usage", async () => {
		const calls: RecordedCall[] = [];
		const result = await compact(
			preparation(),
			MODEL,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			fakeStreamFn([assistantMessage(SUMMARY_TEXT)], calls),
		);

		assert.ok(!result.summary.includes("<analysis>"));
		assert.ok(!result.summary.includes("scratchpad"));
		assert.ok(result.summary.startsWith("Summary:"));
		assert.equal(result.firstKeptEntryId, "entry-keep-me");
		assert.equal(result.tokensBefore, 42);
		assert.deepEqual(result.usage, { input: 10, output: 20, total: 30 });
		assert.equal(calls.length, 1);
	});

	it("sends the whole conversation plus the CC compact prompt to the model", async () => {
		const calls: RecordedCall[] = [];
		await compact(
			preparation(),
			MODEL,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			fakeStreamFn([assistantMessage(SUMMARY_TEXT)], calls),
		);

		const prompt = requestText(calls[0]);
		assert.ok(prompt.includes("<conversation>"));
		assert.ok(prompt.includes("first request"));
		assert.ok(prompt.includes("Primary Request and Intent"));
		assert.ok(prompt.includes("Do NOT call any tools"));
	});

	it("appends file-ops trailer and re-injects recently read files", async () => {
		const dir = mkdtempSync(join(tmpdir(), "plus-compact-"));
		const readFile = join(dir, "read.ts");
		writeFileSync(readFile, "export const x = 1;\n");

		const prep = preparation({
			fileOps: { read: new Set([readFile]), written: new Set([join(dir, "out.ts")]), edited: new Set() },
		});
		const calls: RecordedCall[] = [];
		const result = await compact(
			prep,
			MODEL,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			fakeStreamFn([assistantMessage(SUMMARY_TEXT)], calls),
		);

		assert.ok(result.summary.includes("<read-files>"));
		assert.ok(result.summary.includes("<modified-files>"));
		assert.ok(result.summary.includes("Recently Read Files (post-compact context)"));
		assert.ok(result.summary.includes("export const x = 1;"));
		assert.deepEqual(result.details, { readFiles: [readFile], modifiedFiles: [join(dir, "out.ts")] });
	});

	it("retries prompt-too-long by dropping the oldest turn, up to 3 retries", async () => {
		const calls: RecordedCall[] = [];
		const ptl = new Error("prompt is too long for this model");
		const outcomes: Array<AssistantMessage | Error> = [ptl, ptl, assistantMessage(SUMMARY_TEXT)];
		const result = await compact(
			preparation(),
			MODEL,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			fakeStreamFn(outcomes, calls),
		);

		assert.equal(calls.length, 3);
		assert.ok(requestText(calls[0]).includes("first request"));
		assert.ok(requestText(calls[1]).includes("second request"));
		assert.ok(!requestText(calls[1]).includes("first request"), "oldest turn should have been dropped");
		assert.ok(!requestText(calls[2]).includes("second request"), "second retry drops the remaining turn");
		assert.ok(result.summary.startsWith("Summary:"));
		assert.equal(isAutoCompactBreakerTripped(), false);
	});

	it("exhausts the PTL retry budget and records one failure for the cycle", async () => {
		const calls: RecordedCall[] = [];
		const ptl = new Error("prompt is too long for this model");
		// 4 messages -> a turn pair is dropped after each retry; the third failure exhausts the budget.
		const outcomes: Array<AssistantMessage | Error> = [ptl, ptl, ptl];
		await assert.rejects(
			() =>
				compact(
					preparation(),
					MODEL,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					fakeStreamFn(outcomes, calls),
				),
			/prompt is too long/,
		);
		assert.equal(calls.length, 3); // initial + 2 retries (conversation is empty after that)
		assert.equal(isAutoCompactBreakerTripped(), false); // one failed cycle = one failure (CC semantics)
	});

	it("trips the circuit breaker after 3 failed compaction cycles", async () => {
		for (let cycle = 0; cycle < 2; cycle++) {
			await assert.rejects(
				() =>
					compact(
						preparation(),
						MODEL,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						fakeStreamFn([new Error("provider exploded")], []),
					),
				/provider exploded/,
			);
			assert.equal(isAutoCompactBreakerTripped(), false);
		}
		await assert.rejects(
			() =>
				compact(
					preparation(),
					MODEL,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					fakeStreamFn([new Error("provider exploded")], []),
				),
			/provider exploded/,
		);
		assert.equal(isAutoCompactBreakerTripped(), true);
	});

	it("does not retry non-PTL errors; records the failure", async () => {
		const calls: RecordedCall[] = [];
		await assert.rejects(
			() =>
				compact(
					preparation(),
					MODEL,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					fakeStreamFn([new Error("provider exploded")], calls),
				),
			/provider exploded/,
		);
		assert.equal(calls.length, 1);
		// One failed cycle records one failure; the breaker needs three consecutive.
		assert.equal(isAutoCompactBreakerTripped(), false);
	});

	it("throws when PI_DISABLE_COMPACT is set", async () => {
		process.env.PI_DISABLE_COMPACT = "1";
		const calls: RecordedCall[] = [];
		await assert.rejects(
			() =>
				compact(
					preparation(),
					MODEL,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					fakeStreamFn([], calls),
				),
			/PI_DISABLE_COMPACT/,
		);
		assert.equal(calls.length, 0);
	});

	it("throws when there is nothing to compact", async () => {
		const prep = preparation({ messagesToSummarize: [], turnPrefixMessages: [] });
		await assert.rejects(() => compact(prep, MODEL, undefined), /Nothing to compact/);
	});

	it("throws when the model reply is cut off at the token cap", async () => {
		const calls: RecordedCall[] = [];
		await assert.rejects(
			() =>
				compact(
					preparation(),
					MODEL,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					fakeStreamFn([assistantMessage("partial", "length")], calls),
				),
			/incomplete/,
		);
	});
});

describe("generateSummaryWithUsage", () => {
	it("merges a previous summary via the <previous-summary> instruction", async () => {
		const calls: RecordedCall[] = [];
		await generateSummaryWithUsage(
			[userMessage("hi")],
			MODEL,
			16_384,
			undefined,
			undefined,
			undefined,
			undefined,
			"OLD SUMMARY",
			undefined,
			fakeStreamFn([assistantMessage(SUMMARY_TEXT)], calls),
		);
		const prompt = requestText(calls[0]);
		assert.ok(prompt.includes("<previous-summary>\nOLD SUMMARY\n</previous-summary>"));
		assert.ok(prompt.includes("Merge it into your new summary"));
	});
});
