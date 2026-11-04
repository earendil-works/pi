import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { piExecutor } from "../../examples/extensions/async-mode/executor.ts";
import asyncMode from "../../examples/extensions/async-mode/index.ts";
import { createHarness, getAssistantTexts, getToolResult, type Harness } from "./harness.ts";

vi.mock("../../examples/extensions/async-mode/executor.ts", () => ({ piExecutor: vi.fn() }));

describe("optional async mode", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.clearAllMocks();
	});

	it("refreshes mode policy inside an existing run at the next model call", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = false;
		const policies: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				asyncMode,
				(pi) => {
					pi.registerTool({
						name: "gate",
						label: "gate",
						description: "Hold a local test operation",
						parameters: Type.Object({}),
						execute: async () => {
							entered = true;
							await gate;
							return { content: [{ type: "text", text: "done" }], details: {} };
						},
					});
					pi.on("context", async (event) => {
						for (const message of event.messages) {
							if (
								message.role === "custom" &&
								message.customType === "async-current-mode" &&
								typeof message.content === "string"
							)
								policies.push(message.content);
						}
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("gate", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("Finished"),
			fauxAssistantMessage("Hello"),
		]);
		const running = harness.session.prompt("Inspect the current task");
		try {
			await vi.waitFor(() => expect(entered).toBe(true));
			expect(policies).toEqual([]);
			await harness.session.prompt("/mode async");
		} finally {
			release();
		}
		await running;
		expect(policies.at(-1)).toContain("Current execution mode: async");
		await harness.session.prompt("/mode default");
		await harness.session.prompt("Hello");
		expect(policies.at(-1)).toContain("Current execution mode: default");
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom_message" && entry.customType === "async-current-mode"),
		).toBe(false);
	});

	it("leaves default tools unchanged and handles short questions without dispatch in async mode", async () => {
		const harness = await createHarness({ extensionFactories: [asyncMode] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
		await harness.session.prompt("/mode async");
		expect(harness.session.getActiveToolNames()).toContain("async_start");
		harness.setResponses([fauxAssistantMessage("IoU is intersection over union.")]);
		await harness.session.prompt("What is IoU?");
		expect(piExecutor).not.toHaveBeenCalled();
		await harness.session.prompt("/mode default");
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
	});

	it("allows a newer question while work runs and delivers the original request after switching modes", async () => {
		let complete!: (result: { success: boolean; result: string }) => void;
		vi.mocked(piExecutor).mockReturnValue(
			async () =>
				new Promise((resolve) => {
					complete = resolve;
				}),
		);
		const harness = await createHarness({ extensionFactories: [asyncMode] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		await harness.session.prompt("/mode async");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("async_start", {
						description: "Investigate migration compatibility",
						context: "Read migration fixtures",
						reason: "Multi-module analysis with long validation",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Started the investigation."),
			fauxAssistantMessage("The short answer."),
			fauxAssistantMessage("The earlier migration investigation is complete."),
		]);
		await harness.session.prompt("Investigate the migration across all modules and validate it");
		expect(getToolResult(harness, "async_start").isError).toBe(false);
		expect(harness.session.isStreaming).toBe(false);
		await harness.session.prompt("A short unrelated question");
		expect(getAssistantTexts(harness)).toContain("The short answer.");
		await harness.session.prompt("/mode default");
		expect(harness.session.getActiveToolNames()).not.toContain("async_start");
		complete({ success: true, result: "Migration validated" });
		await vi.waitFor(() =>
			expect(getAssistantTexts(harness)).toContain("The earlier migration investigation is complete."),
		);
		const messages = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "async-task-result");
		expect(messages).toHaveLength(1);
		expect(JSON.stringify(messages[0])).toContain("Investigate the migration across all modules and validate it");
		expect(JSON.stringify(messages[0])).toContain("Migration validated");
	});
});
