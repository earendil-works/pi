import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	COMPACTION_MIN_SECTIONS,
	COMPACTION_SUMMARY_MIN_CHARS,
	effectiveReserveTokens,
	isSummaryUsable,
	shouldCompact,
	stripSummaryAppendix,
	summaryCharsFloorForTokens,
} from "../../../src/core/compaction/index.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Regression for compaction validity:
 *
 *  A) reserveTokens was not context-proportionate. A fixed 16384-token reserve exceeds the
 *     usable on small-window models, so `contextWindow - reserve` goes negative and compaction
 *     spuriously fires on every turn (and leaves no room for the assistant reply, producing
 *     400 request-exceeds-context errors). The effective reserve is now clamped to a safe
 *     fraction of the real window.
 *
 *  B) short-but-valid-length stubs (a bare file-list summary, or a short prose narration) were
 *     still persisted, because the prior fix (#7048) only rejected `length`-stop summaries.
 *     The produced summary is now validated (non-empty, proportionately long enough for the
 *     history it condenses, and structured once substantial) so degenerate stubs are discarded
 *     instead of persisted, while reasonably-dense summaries still persist.
 */

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function seedLargeContent(harness: Harness, charCount: number): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	// A single large user+assistant pair, so the content being summarized is substantial.
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "u".repeat(charCount) }],
		timestamp: now - 2000,
	});
	const model = harness.getModel();
	const assistant: AssistantMessage = {
		...fauxAssistantMessage("", { stopReason: "stop", timestamp: now - 1000 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(100),
	};
	assistant.content = [{ type: "text", text: "a".repeat(charCount) }];
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function useSummaryStreamFn(harness: Harness, summary: string): () => number {
	let callCount = 0;
	harness.session.agent.streamFunction = (model) => {
		callCount++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					...fauxAssistantMessage(summary),
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: createUsage(10),
				},
			});
		});
		return stream;
	};
	return () => callCount;
}

describe("compaction reserve is context-proportionate", () => {
	it("keeps some largest fraction of a large window", () => {
		expect(effectiveReserveTokens(16384, 65536)).toBe(16384);
		expect(effectiveReserveTokens(10000, 100000)).toBe(10000);
		expect(effectiveReserveTokens(0, 100000)).toBe(0);
	});

	it("clamps the reserve to a safe fraction of a small context window", () => {
		// 25% of 4096 is 1024; never let the reserve exceed that.
		expect(effectiveReserveTokens(16384, 4096)).toBe(1024);
		// A very tight window still keeps a small safety headroom below the window.
		expect(effectiveReserveTokens(16384, 1000)).toBe(250);
	});

	it("does not recompute for non-positive context windows", () => {
		expect(effectiveReserveTokens(5000, 0)).toBe(5000);
		expect(effectiveReserveTokens(5000, -1)).toBe(5000);
	});

	it("does not spuriously trigger shouldCompact on a small window with a huge configured reserve", () => {
		const settings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 100 };
		expect(shouldCompact(100, 8192, settings)).toBe(false);
		expect(shouldCompact(1000, 8192, settings)).toBe(false);
		expect(shouldCompact(7000, 8192, settings)).toBe(true);
	});

	it("respects the enabled flag", () => {
		const settings = { enabled: false, reserveTokens: 16384, keepRecentTokens: 100 };
		expect(shouldCompact(1_000_000, 8192, settings)).toBe(false);
	});
});

describe("compaction summary degeneracy guard", () => {
	it("rejects an empty body", () => {
		expect(isSummaryUsable("", 1000)).toBe(false);
		expect(isSummaryUsable("   \n  ", 1000)).toBe(false);
	});

	it("rejects a bare file-reference summary", () => {
		const fileList =
			"<read-files>src/a.ts, src/b.ts, src/c.ts</read-files>\n" + "<modified-files>src/a.ts</modified-files>";
		expect(stripSummaryAppendix(fileList)).toHaveLength(0);
		expect(isSummaryUsable(fileList, 20_000)).toBe(false);
	});

	it("rejects a stub far too short for the history it condenses", () => {
		expect(summaryCharsFloorForTokens(10_000)).toBeGreaterThanOrEqual(COMPACTION_SUMMARY_MIN_CHARS);
		expect(isSummaryUsable("user asked to fix the build.", 10_000)).toBe(false);
	});

	it("rejects a long-but-unstructured narration once it is substantial enough to need an outline", () => {
		const narration = Array.from(
			{ length: 45 },
			(_, i) => `We then changed ${i === 0 ? "file" : "file"} a${i} and observed the resulting output.`,
		).join(" ");
		expect(narration.length).toBeGreaterThan(COMPACTION_SUMMARY_MIN_CHARS);
		expect(stripSummaryAppendix(narration)).toBe(narration);
		expect(COMPACTION_MIN_SECTIONS).toBeLessThanOrEqual(2);
		expect(isSummaryUsable(narration, 30_000)).toBe(false);
	});

	it("accepts a reasonably-dense structured summary", () => {
		const dense = [
			"## Goal",
			"- Fix the reserve so small models don't overflow.",
			"",
			"## Progress",
			"- Clamped the reserve; wired summary validation.",
			"",
			"## Next Steps",
			"1. Run the regression suite.",
			"",
		].join("\n");
		expect(isSummaryUsable(dense, 400)).toBe(true);
	});

	it("is conservative: a brief summary of a very small history is not degenerate", () => {
		const brief = "## Summary\nA short manual session; will resume next.";
		// ~10 summarized tokens -> floor of ~2-3 chars, so the brief summary is fine.
		expect(isSummaryUsable(brief, 10)).toBe(true);
	});
});

describe("compaction wiring end-to-end", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("discards a degenerate empty summary instead of persisting a useless stub", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedLargeContent(harness, 20_000);

		useSummaryStreamFn(harness, "");

		await expect(harness.session.compact()).rejects.toThrow();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(0);
	});

	it("discards a stub that is too short for the history it condenses", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedLargeContent(harness, 20_000);

		useSummaryStreamFn(harness, "the user asked a question.");

		await expect(harness.session.compact()).rejects.toThrow();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(0);
	});

	it("persists a reasonably-dense structured summary", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedLargeContent(harness, 20_000);

		const dense = [
			"## Goal",
			"- Implement context-proportionate reserve and degenerate-summary rejection.",
			"",
			"## Progress",
			`Wired the reserve clamp and the summary validity guard. ${"Detailed technical notes about the fix and its motivation; "
				.repeat(40)
				.trimEnd()}`,
			"",
			"## Next Steps",
			"1. Run the regression suite and confirm no spurious compaction on small windows.",
		].join("\n");
		expect(dense.length).toBeGreaterThanOrEqual(600);

		useSummaryStreamFn(harness, dense);

		const result = await harness.session.compact();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(1);
		expect(result.summary).toContain("## Goal");
		expect(result.summary).toContain("degenerate-summary");
	});
});
