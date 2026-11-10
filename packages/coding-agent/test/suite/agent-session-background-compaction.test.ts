import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	isBackgroundCompactionValid,
	prepareBackgroundCompaction,
} from "../../src/core/compaction/background-compaction.ts";
import { createHarness, type Harness } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function seed(harness: Harness) {
	const userId = harness.sessionManager.appendMessage({
		role: "user",
		content: `Original cobalt requirement.${".".repeat(300000)}`,
		timestamp: 1,
	});
	const response = fauxAssistantMessage("Original completed response.", { timestamp: 2 });
	const responseId = harness.sessionManager.appendMessage({
		...response,
		usage: { ...response.usage, input: 75000, totalTokens: 75000 },
	});
	harness.session.refreshContext();
	return { userId, responseId };
}

function freeze(harness: Harness) {
	const snapshot = prepareBackgroundCompaction(
		harness.sessionManager,
		harness.sessionManager.getBranch(),
		harness.getModel(),
		harness.settingsManager.getCompactionSettings(),
		async (preparation) => ({
			kind: "ready",
			fromExtension: false,
			result: {
				summary: "Keep the cobalt requirement.",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
			},
		}),
	);
	if (!snapshot) throw new Error("Expected completed history to be eligible for preparation");
	return snapshot;
}

describe("background compaction", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.abort();
			harness.cleanup();
		}
	});

	it("continues at 75%, waits at 85%, and preserves the entire live tail and original history", async () => {
		const started = deferred();
		const release = deferred();
		const applying = deferred();
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100000, maxTokens: 1024 }],
			tools: [],
		});
		harnesses.push(harness);
		const { userId, responseId } = seed(harness);
		let normalResponses = 0;
		const dispatch: FauxResponseFactory = async (_context, options, _state, model) => {
			if (options?.cacheRetention === "none") {
				if (!options.maxTokens || options.maxTokens > model.maxTokens)
					throw new Error("Provider rejected an excessive summary output budget");
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("Keep the cobalt requirement. Continue the unfinished work.");
			}
			return fauxAssistantMessage(`live response ${++normalResponses}`);
		};
		harness.setResponses([dispatch, dispatch, dispatch]);
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start") applying.resolve();
		});
		try {
			await harness.session.prompt(`live input one${"a".repeat(32000)}`);
			await started.promise;
			expect(harness.session.isIdle).toBe(true);
			expect(harness.eventsOfType("compaction_start")).toEqual([]);
			let settled = false;
			const second = harness.session.prompt(`live input two${"b".repeat(16000)}`).then(() => {
				settled = true;
			});
			await applying.promise;
			await new Promise<void>((done) => setImmediate(done));
			expect(settled).toBe(false);
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
			release.resolve();
			await second;
			const compaction = harness.sessionManager.getEntries().findLast((entry) => entry.type === "compaction");
			if (!compaction?.checkpointId) throw new Error("Missing applied checkpoint");
			expect(compaction.tokensBefore).toBeGreaterThanOrEqual(85000);
			expect(harness.sessionManager.getEntry(compaction.checkpointId)?.parentId).toBe(responseId);
			const active = JSON.stringify(harness.session.messages);
			expect(active).not.toContain("Original cobalt requirement.");
			for (const text of ["live input one", "live input two", "live response 1", "live response 2"])
				expect(active).toContain(text);
			expect(harness.sessionManager.getEntry(userId)).toMatchObject({
				type: "message",
				message: { content: expect.stringContaining("Original cobalt requirement.") },
			});
			const usage = harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "usage" && entry.kind === "compaction_prepare");
			expect(usage).toHaveLength(1);
			expect(compaction.usage).toBeUndefined();
		} finally {
			release.resolve();
		}
	});

	it("does not consume an unanswered user input", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		seed(harness);
		const inputId = harness.sessionManager.appendMessage({
			role: "user",
			content: "Unanswered new requirement",
			timestamp: 3,
		});
		const snapshot = freeze(harness);
		expect(snapshot.firstKeptEntryId).toBe(inputId);
		expect(JSON.stringify(snapshot.preparation.messagesToSummarize)).not.toContain("Unanswered new requirement");
	});

	it.each(["toolUse", "length"] as const)("keeps the newest unconsumed tool batch after %s", async (stopReason) => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		seed(harness);
		const inputId = harness.sessionManager.appendMessage({
			role: "user",
			content: "Inspect the new evidence",
			timestamp: 3,
		});
		harness.sessionManager.appendMessage(
			fauxAssistantMessage(fauxToolCall("read", { path: "evidence" }, { id: "read-evidence" }), {
				stopReason: "toolUse",
			}),
		);
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolName: "read",
			toolCallId: "read-evidence",
			content: [{ type: "text", text: "Unconsumed exact evidence" }],
			isError: false,
			timestamp: 4,
		});
		if (stopReason === "length")
			harness.sessionManager.appendMessage(fauxAssistantMessage("Incomplete interpretation", { stopReason }));
		const snapshot = freeze(harness);
		expect(snapshot.firstKeptEntryId).toBe(inputId);
		expect(JSON.stringify(snapshot.preparation.messagesToSummarize)).not.toContain("Unconsumed exact evidence");
	});

	it("allows edits to the retained tail but rejects summaries of an edited prefix or a different branch/model/policy", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		const { userId, responseId } = seed(harness);
		const inputId = harness.sessionManager.appendMessage({ role: "user", content: "live input", timestamp: 3 });
		const snapshot = freeze(harness);
		const valid = () =>
			isBackgroundCompactionValid(
				snapshot,
				harness.sessionManager.getBranch(),
				harness.getModel(),
				harness.settingsManager.getCompactionSettings(),
			);
		harness.sessionManager.appendContextEdit(inputId, { content: "Corrected live input" });
		expect(valid()).toBe(true);
		expect(
			isBackgroundCompactionValid(
				snapshot,
				harness.sessionManager.getBranch(responseId),
				harness.getModel(),
				snapshot.settings,
			),
		).toBe(false);
		expect(
			isBackgroundCompactionValid(
				snapshot,
				harness.sessionManager.getBranch(),
				{ ...harness.getModel(), id: "different" },
				snapshot.settings,
			),
		).toBe(false);
		harness.settingsManager.applyOverrides({ compaction: { maxSummaryTokens: 4000 } });
		expect(valid()).toBe(false);
		harness.settingsManager.applyOverrides({ compaction: { maxSummaryTokens: snapshot.settings.maxSummaryTokens } });
		harness.sessionManager.appendContextEdit(userId, { content: "The original requirement was corrected" });
		expect(valid()).toBe(false);
	});

	it("uses earlier successful usage when the latest persisted response is a zero-usage error", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100000 }],
			tools: [],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", ({ preparation }) => ({
						compaction: {
							summary: "Keep the cobalt requirement.",
							firstKeptEntryId: preparation.firstKeptEntryId,
							tokensBefore: preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seed(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: `Unanswered input${"a".repeat(40000)}`,
			timestamp: 3,
		});
		harness.sessionManager.appendMessage(
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Synthetic provider overload" }),
		);
		harness.session.refreshContext();
		harness.setResponses([fauxAssistantMessage("Recovered answer")]);
		await harness.session.prompt("Resume the unanswered input");
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
		expect(JSON.stringify(harness.session.messages)).not.toContain("Original cobalt requirement.");
		expect(JSON.stringify(harness.session.messages)).toContain("Unanswered input");
		expect(harness.session.getLastAssistantText()).toBe("Recovered answer");
	});

	it("aborts speculative generation without applying its stale result", async () => {
		const started = deferred();
		const release = deferred();
		const harness = await createHarness({ models: [{ id: "faux-1", contextWindow: 100000 }], tools: [] });
		harnesses.push(harness);
		seed(harness);
		let summarySignal: AbortSignal | undefined;
		const dispatch: FauxResponseFactory = async (_context, options) => {
			if (options?.cacheRetention === "none") {
				summarySignal = options.signal;
				options.signal?.addEventListener("abort", release.resolve, { once: true });
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("stale summary");
			}
			return fauxAssistantMessage("live answer");
		};
		harness.setResponses([dispatch, dispatch]);
		try {
			await harness.session.prompt("continue");
			await started.promise;
			await harness.session.abort();
			expect(summarySignal?.aborted).toBe(true);
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
			expect(JSON.stringify(harness.session.messages)).toContain("Original cobalt requirement.");
		} finally {
			release.resolve();
		}
	});
});
