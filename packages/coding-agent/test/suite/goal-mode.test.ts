import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import goalModeExtension from "../../examples/extensions/goal-mode/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("goal-mode extension integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	function latestGoalEntry(harness: Harness) {
		const entries = harness.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "custom" && entry.customType === "goal-mode") {
				return entry.data;
			}
		}
		return undefined;
	}

	it("starts from /goal and stops after a no-tool-call turn", async () => {
		const harness = await createHarness({ extensionFactories: [goalModeExtension] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("I inspected the suite and it is green")]);

		await harness.session.prompt("/goal Fix the flaky suite");
		await harness.session.waitForIdle();

		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(getMessageText(harness.session.messages[0]!)).toContain("Fix the flaky suite");
		expect(getMessageText(harness.session.messages[1]!)).toContain("I inspected the suite");
	});

	it("continues after a tool-call turn and stops when the next turn has no tools", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return {
					content: [{ type: "text", text: `echo:${text}` }],
					details: { text },
				};
			},
		};
		const harness = await createHarness({
			extensionFactories: [goalModeExtension],
			tools: [echoTool],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "probe" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("/goal Verify the echo tool");
		await harness.session.waitForIdle();

		expect(toolRuns).toEqual(["probe"]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
	});

	it("marks the goal complete through complete_goal and stops", async () => {
		const harness = await createHarness({ extensionFactories: [goalModeExtension] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("complete_goal", { evidence: "suite passes with 0 failures" }), {
				stopReason: "toolUse",
			}),
		]);

		await harness.session.prompt("/goal Fix the flaky suite");
		await harness.session.waitForIdle();

		expect(harness.getPendingResponseCount()).toBe(0);
		expect(latestGoalEntry(harness)).toMatchObject({
			status: "complete",
			lastCompletionEvidence: "suite passes with 0 failures",
		});
		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
	});

	it("does not auto-continue while the goal is paused", async () => {
		const harness = await createHarness({ extensionFactories: [goalModeExtension] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first answer")]);

		await harness.session.prompt("/goal Fix the flaky suite");
		await harness.session.waitForIdle();
		await harness.session.prompt("/goal pause");

		const settledBeforePause = harness.eventsOfType("agent_settled").length;
		expect(settledBeforePause).toBeGreaterThan(0);
		expect(latestGoalEntry(harness)).toMatchObject({ status: "paused" });
	});
});
