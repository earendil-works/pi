import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { toJsonEvent } from "../../../src/modes/json-event.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("regression #7925: tool-call metadata is available when streaming starts", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
	});

	it("includes the tool call id and name without cumulative snapshots", async () => {
		harness = await createHarness();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("write", { path: "output.txt", content: "x".repeat(100) }, { id: "call_7925" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("write a file");

		const update = harness
			.eventsOfType("message_update")
			.find((event) => event.assistantMessageEvent.type === "toolcall_start");
		if (!update || update.message.role !== "assistant") {
			throw new Error("Expected toolcall_start assistant update");
		}

		expect(toJsonEvent(update)).toEqual({
			type: "message_update",
			usage: update.message.usage,
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				id: "call_7925",
				toolName: "write",
			},
		});
	});
});
