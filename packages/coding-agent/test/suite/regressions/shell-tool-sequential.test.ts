import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("shell tool call ordering", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("runs a read after a bash call in the same message only once the command has finished", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("bash", { command: "sleep 0.3 && echo build-finished > build.log" }),
					fauxToolCall("read", { path: "build.log" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("build and read the log");

		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results.map((message) => message.toolName)).toEqual(["bash", "read"]);
		const readText = JSON.stringify(results[1]?.content);
		expect(results[1]?.isError).toBe(false);
		expect(readText).toContain("build-finished");
	});
});
