import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import toolResultLimiter from "../../../examples/extensions/tool-result-limiter.ts";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

const noisyTool: AgentTool = {
	name: "noisy",
	label: "Noisy",
	description: "Return noisy output",
	parameters: Type.Object({ text: Type.String() }),
	execute: async (_toolCallId, params) => {
		const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
		return { content: [{ type: "text", text }], details: { source: "test" } };
	},
};

function firstText(content: Array<{ type: string; text?: string }>) {
	return content.find((part) => part.type === "text")?.text ?? "";
}

describe("regression #236: tool result limiter extension", () => {
	const harnesses: Harness[] = [];
	const tempOutputDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempOutputDirs.length > 0) {
			rmSync(tempOutputDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("keeps small tool output unchanged", async () => {
		const harness = await createHarness({ tools: [noisyTool], extensionFactories: [toolResultLimiter] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("noisy", { text: "small output" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult?.role === "toolResult" ? firstText(toolResult.content) : "");
			},
		]);

		await harness.session.prompt("run noisy");

		expect(getAssistantTexts(harness)).toContain("small output");
		expect(harness.session.messages.find((message) => message.role === "toolResult")?.details).toEqual({
			source: "test",
		});
	});

	it("truncates huge tool output and saves the full output to a readable file", async () => {
		const fullOutput = `START\n${"head\n".repeat(5000)}MIDDLE_MARKER_SHOULD_BE_OMITTED\n${"tail\n".repeat(5000)}END`;
		const harness = await createHarness({ tools: [noisyTool], extensionFactories: [toolResultLimiter] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("noisy", { text: fullOutput })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(toolResult?.role === "toolResult" ? firstText(toolResult.content) : "");
			},
		]);

		await harness.session.prompt("run noisy");

		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(toolResult?.role).toBe("toolResult");
		if (toolResult?.role !== "toolResult") {
			return;
		}

		const preview = toolResult.content[0]?.type === "text" ? toolResult.content[0].text : "";
		expect(preview).toContain("START");
		expect(preview).toContain("END");
		expect(preview).toContain("Tool output truncated");
		expect(preview).toContain("Full tool output saved to:");
		expect(preview).not.toContain("MIDDLE_MARKER_SHOULD_BE_OMITTED");

		const details = toolResult.details as {
			piToolResultTruncation?: { fullOutputPath?: string };
		};
		const fullOutputPath = details.piToolResultTruncation?.fullOutputPath;
		expect(fullOutputPath).toBeDefined();
		if (!fullOutputPath) {
			return;
		}
		tempOutputDirs.push(dirname(fullOutputPath));
		expect(readFileSync(fullOutputPath, "utf-8")).toBe(fullOutput);
	});
});
