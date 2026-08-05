import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { toJsonEvent } from "../../../src/modes/json-event.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("regression #7290: JSON event streams stay linear", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function measureUpdateBytes(text: string): Promise<number> {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(text)]);

		await harness.session.prompt("respond");

		const sessionUpdates = harness.eventsOfType("message_update");
		for (const update of sessionUpdates) {
			expect(update).toHaveProperty("message");
			expect(update.assistantMessageEvent).toHaveProperty("partial");
		}

		const updates = sessionUpdates.map((event) => toJsonEvent(event));
		expect(updates.length).toBeGreaterThan(0);
		for (const update of updates) {
			expect(update).not.toHaveProperty("message");
			expect(update.assistantMessageEvent).not.toHaveProperty("partial");
		}
		return updates.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0);
	}

	it("emits delta-only message updates whose size scales linearly", async () => {
		const smallBytes = await measureUpdateBytes("x".repeat(2_000));
		const largeBytes = await measureUpdateBytes("x".repeat(4_000));

		expect(largeBytes).toBeGreaterThan(smallBytes);
		expect(largeBytes / smallBytes).toBeLessThan(2.2);
	});
});
