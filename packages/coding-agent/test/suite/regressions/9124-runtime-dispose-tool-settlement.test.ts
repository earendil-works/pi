import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
} from "../../../src/core/agent-session-runtime.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("regression #9124: runtime disposal during tool execution", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createRuntime(tool: AgentTool): Promise<{ harness: Harness; runtime: AgentSessionRuntime }> {
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		const services: AgentSessionServices = {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		};
		const unusedFactory: CreateAgentSessionRuntimeFactory = async () => {
			throw new Error("runtime replacement is not used in this test");
		};
		return {
			harness,
			runtime: new AgentSessionRuntime(harness.session, services, unusedFactory),
		};
	}

	it("persists the aborted tool turn before disconnecting the session", async () => {
		let markToolStarted!: () => void;
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const tool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait until aborted",
			parameters: Type.Object({}),
			execute: (_toolCallId, _params, signal) =>
				new Promise<AgentToolResult<unknown>>((_resolve, reject) => {
					markToolStarted();
					signal?.addEventListener("abort", () => setTimeout(() => reject(new Error("Operation aborted")), 10), {
						once: true,
					});
				}),
		};
		const { harness, runtime } = await createRuntime(tool);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);

		const prompt = runtime.session.prompt("run tool");
		await toolStarted;
		await runtime.dispose();
		await prompt;

		const messages = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(messages[2]).toMatchObject({
			role: "toolResult",
			content: [{ type: "text", text: "Operation aborted" }],
			isError: true,
		});
	});
});
