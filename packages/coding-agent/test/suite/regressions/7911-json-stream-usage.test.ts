import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { toJsonEvent } from "../../../src/modes/json-event.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("regression #7911: JSON message updates retain usage", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
	});

	it("includes cumulative usage without cumulative message snapshots", async () => {
		harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("respond");

		// #7290's delta-only wire projection dropped this fixed-size metadata with the snapshots.
		const update = harness
			.eventsOfType("message_update")
			.find((event) => event.message.role === "assistant" && event.message.usage.totalTokens > 0);
		if (!update || update.message.role !== "assistant") {
			throw new Error("Expected an assistant update with populated usage");
		}

		const wireUpdate = toJsonEvent(update);
		expect(wireUpdate.usage).toEqual(update.message.usage);
		expect(wireUpdate).not.toHaveProperty("message");
		expect(wireUpdate.assistantMessageEvent).not.toHaveProperty("partial");
	});
});
