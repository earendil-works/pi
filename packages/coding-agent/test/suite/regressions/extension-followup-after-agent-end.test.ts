/**
 * Regression test for extension followUp messages queued during agent_end.
 *
 * Bug: Extensions calling sendUserMessage({ deliverAs: "followUp" }) during
 * agent_end had their messages silently dropped. The agent loop had already
 * finished, so the internal followUpQueue was never drained.
 *
 * Fix: After agent.prompt() resolves, drain any followUp messages queued by
 * extensions during agent_end and send them as a new prompt.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.js";

async function createWaitingHarness(extensionFactories?: Array<(pi: ExtensionAPI) => void>): Promise<{
	harness: Harness;
	releaseToolExecution: () => void;
	promptPromise: Promise<void>;
	waitForToolStart: Promise<void>;
}> {
	let releaseToolExecution: (() => void) | undefined;
	const toolRelease = new Promise<void>((resolve) => {
		releaseToolExecution = resolve;
	});
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await toolRelease;
			return {
				content: [{ type: "text", text: "released" }],
				details: {},
			};
		},
	};
	const harness = await createHarness({
		tools: [waitTool],
		extensionFactories,
	});

	const waitForToolStart = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === "wait") {
				unsubscribe();
				resolve();
			}
		});
	});

	return {
		harness,
		releaseToolExecution: () => releaseToolExecution?.(),
		promptPromise: harness.session.prompt("start"),
		waitForToolStart,
	};
}

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
});

describe("extension followUp after agent_end", () => {
	it("delivers followUp queued by extension during agent_end", async () => {
		let extensionApi: ExtensionAPI | undefined;

		const waiting = await createWaitingHarness([
			(pi) => {
				extensionApi = pi;
				pi.on("agent_end", () => {
					extensionApi?.sendUserMessage("reminder from extension", {
						deliverAs: "followUp",
					});
				});
			},
		]);
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("first turn done"),
			fauxAssistantMessage("handled reminder"),
		]);

		await waitForToolStart;
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "reminder from extension"]);
		expect(getAssistantTexts(harness)).toEqual(["", "first turn done", "handled reminder"]);
	});

	it("does not deliver followUp when extension does not queue during agent_end", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await waitForToolStart;
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start"]);
		expect(getAssistantTexts(harness)).toEqual(["", "done"]);
	});
});
