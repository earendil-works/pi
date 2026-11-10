import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "../harness.ts";

describe("issue #8328 zero-usage auto-compaction", () => {
	// Regression test for #8328: absent provider usage must not disable compaction or cause repeated compaction after rebuilding context.
	it("compacts from message size with zero provider usage and uses the rebuilt context thereafter", async () => {
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
					pi.on("message_end", ({ message }) => {
						if (message.role !== "assistant") return;
						return {
							message: {
								...message,
								usage: { ...message.usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
							},
						};
					});
				},
			],
		});
		try {
			const original = `Original unsummarized requirement.${".".repeat(344000)}`;
			const sourceId = harness.sessionManager.appendMessage({ role: "user", content: original, timestamp: 1 });
			harness.sessionManager.appendMessage(fauxAssistantMessage("Earlier zero-usage response", { timestamp: 2 }));
			harness.session.refreshContext();
			harness.setResponses([
				(context) => {
					expect(JSON.stringify(context)).not.toContain("Original unsummarized requirement.");
					expect(JSON.stringify(context)).toContain("Keep the cobalt requirement.");
					return fauxAssistantMessage("First resumed answer");
				},
				fauxAssistantMessage("Second resumed answer"),
			]);
			await harness.session.prompt("Resume the earlier requirement");
			await harness.session.prompt("Continue with a small follow-up");
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
			expect(harness.sessionManager.getEntry(sourceId)).toMatchObject({ message: { content: original } });
			expect(harness.session.getLastAssistantText()).toBe("Second resumed answer");
		} finally {
			await harness.session.abort();
			harness.cleanup();
		}
	});
});
