import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

describe("issue #5886: compaction queue with async input hook", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	// Regression test for #5886.
	it("delivers a prompt submitted from compaction_end after an async input hook", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 8_000 } },
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						await Promise.resolve();
						return { action: "continue" };
					});
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first response"), fauxAssistantMessage("queued response")]);

		let queuedPrompt: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.reason === "threshold") {
				queuedPrompt = harness.session.prompt("queued during compaction", { streamingBehavior: "steer" });
			}
		});

		await harness.session.prompt(`initial prompt ${"x".repeat(9_000)}`);
		if (!queuedPrompt) throw new Error("compaction_end did not submit the queued prompt");
		await queuedPrompt;

		expect(harness.eventsOfType("compaction_end").map((event) => event.reason)).toEqual(["threshold"]);
		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.faux.state.callCount).toBe(2);
		expect(getUserTexts(harness).filter((text) => text === "queued during compaction")).toEqual([
			"queued during compaction",
		]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});
});
