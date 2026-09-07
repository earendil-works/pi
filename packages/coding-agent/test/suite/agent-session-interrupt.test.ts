import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.ts";

/**
 * A tool that stays running until the run's abort signal fires, then returns
 * immediately. This lets interrupt() observe an in-flight tool without hanging
 * on an unresolved promise.
 */
function abortableWaitTool(): AgentTool {
	return {
		name: "wait",
		label: "Wait",
		description: "Wait until the run is aborted",
		parameters: Type.Object({}),
		execute: async (_id, _args, signal) => {
			await new Promise<void>((resolve) => {
				if (signal?.aborted) {
					resolve();
					return;
				}
				signal?.addEventListener("abort", () => resolve());
			});
			return {
				content: [{ type: "text", text: "released" }],
				details: {},
			};
		},
	};
}

function waitForToolStart(harness: Harness, toolName: string): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === toolName) {
				unsubscribe();
				resolve();
			}
		});
	});
}

describe("AgentSession submit-interrupt", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("interrupt() aborts the running turn without leaving an empty aborted assistant message", async () => {
		const harness = await createHarness({
			tools: [abortableWaitTool()],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);

		const promptPromise = harness.session.prompt("start");
		await waitForToolStart(harness, "wait");
		await harness.session.interrupt();
		await promptPromise;

		expect(harness.session.isIdle).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(0);

		// A submit-interrupt must not surface an empty "aborted" assistant message.
		const aborted = harness.session.messages.filter(
			(message) => message.role === "assistant" && message.stopReason === "aborted",
		);
		expect(aborted).toEqual([]);
	});

	it("delivers a prompt after interrupt() as a fresh turn", async () => {
		const harness = await createHarness({
			tools: [abortableWaitTool()],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled correction"),
		]);

		const promptPromise = harness.session.prompt("start");
		await waitForToolStart(harness, "wait");
		await harness.session.interrupt();
		await promptPromise;

		await harness.session.prompt("correction");

		expect(getUserTexts(harness)).toContain("correction");
		expect(getAssistantTexts(harness)).toContain("handled correction");
	});
});
