import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.js";

describe("regression #3982: message_end cost override", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("allows extensions to replace finalized assistant usage cost", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role !== "assistant") return;

						return {
							message: {
								...event.message,
								usage: {
									...event.message.usage,
									cost: {
										...event.message.usage.cost,
										total: 0.123,
									},
								},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		const assistantMessage = harness.session.messages.find((message) => message.role === "assistant");
		expect(assistantMessage?.role).toBe("assistant");
		if (assistantMessage?.role !== "assistant") {
			throw new Error("missing assistant message");
		}
		expect(assistantMessage.usage.cost.total).toBe(0.123);

		const messageEnd = harness.eventsOfType("message_end").find((event) => event.message.role === "assistant");
		expect(messageEnd?.message.role).toBe("assistant");
		if (messageEnd?.message.role !== "assistant") {
			throw new Error("missing assistant message_end event");
		}
		expect(messageEnd.message.usage.cost.total).toBe(0.123);
	});
});
