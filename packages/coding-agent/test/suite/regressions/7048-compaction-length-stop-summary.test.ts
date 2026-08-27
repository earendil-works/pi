import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Regression for #7048: a summarization response that hits the output token limit
 * (`stopReason: "length"`) was persisted as a valid compaction checkpoint, silently
 * dropping whatever context the truncated summary did not cover (sessions resumed
 * mid-word). Verifies that compaction now treats `length` stops as a failure:
 * the partial summary is discarded, nothing is appended, and the error surfaces.
 */
describe("#7048 compaction rejects truncated (length-stop) summaries", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

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

	function seedCompactableSession(harness: Harness): void {
		harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "message to compact" }],
			timestamp: now - 1000,
		});
		const model = harness.getModel();
		const assistant: AssistantMessage = {
			...fauxAssistantMessage("", { stopReason: "stop", timestamp: now - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(100),
		};
		assistant.content = [{ type: "text", text: "assistant response to compact" }];
		harness.sessionManager.appendMessage(assistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	}

	it("refuses to persist a length-truncated summary and surfaces the error", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);

		// The summarization call comes back truncated mid-word, exactly like the #7048 report.
		const truncated: AssistantMessage = {
			...fauxAssistantMessage("## Goal\n...you went fro", { stopReason: "length" }),
			usage: createUsage(10),
		};
		harness.session.agent.streamFunction = (model) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const response = { ...truncated, api: model.api, provider: model.provider, model: model.id };
				stream.push({ type: "done", reason: "length", message: response });
			});
			return stream;
		};

		await expect(harness.session.compact()).rejects.toThrow(/generation hit the token cap/);

		// Nothing was persisted: the branch has no compaction entry.
		const branch = harness.sessionManager.getBranch();
		expect(branch.filter((entry) => entry.type === "compaction")).toHaveLength(0);

		// The failure is surfaced to listeners like any other failed compaction.
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toBeDefined();
		expect(compactionEnd).toMatchObject({ reason: "manual", result: undefined, aborted: false });
		expect(compactionEnd?.errorMessage).toContain("generation hit the token cap");
	});
});
