import { Buffer } from "node:buffer";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { BashOperations } from "../../src/core/tools/bash.js";
import { createHarness, type Harness } from "./harness.js";

function getEntryTypes(harness: Harness): string[] {
	return harness.sessionManager.getEntries().map((entry) => entry.type);
}

describe("AgentSession bash and persistence characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("records bash results immediately while idle", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.session.recordBashResult("echo hi", {
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		expect(harness.session.hasPendingBashMessages).toBe(false);
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("bashExecution");
		expect(getEntryTypes(harness)).toContain("message");
	});

	it("defers bash results while streaming and flushes them before the next prompt", async () => {
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
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("after flush"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const firstPrompt = harness.session.prompt("start");
		await sawToolStart;
		harness.session.recordBashResult("echo hi", {
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		expect(harness.session.hasPendingBashMessages).toBe(true);
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(false);

		releaseToolExecution?.();
		await firstPrompt;

		expect(harness.session.hasPendingBashMessages).toBe(true);
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(false);

		await harness.session.prompt("next turn");

		expect(harness.session.hasPendingBashMessages).toBe(false);
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(true);
		expect(getEntryTypes(harness).filter((type) => type === "message").length).toBeGreaterThan(0);
	});

	it("executes bash commands and records the result", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const result = await harness.session.executeBash("printf 'hello'");

		expect(result.output).toContain("hello");
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("bashExecution");
	});

	it("cancels running bash commands with abortBash", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				return await new Promise<{ exitCode: number | null }>((_resolve, reject) => {
					options.signal?.addEventListener(
						"abort",
						() => {
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				});
			},
		};

		const bashPromise = harness.session.executeBash("sleep", undefined, { operations });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.session.isBashRunning).toBe(true);
		harness.session.abortBash();

		const result = await bashPromise;
		expect(result.cancelled).toBe(true);
		expect(harness.session.isBashRunning).toBe(false);
	});

	it("persists user, assistant, toolResult, and custom messages in order", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.sendCustomMessage({
			customType: "note",
			content: "hello",
			display: true,
			details: { a: 1 },
		});
		await harness.session.prompt("start");

		const entries = harness.sessionManager.getEntries();
		expect(entries.map((entry) => entry.type)).toEqual([
			"custom_message",
			"message",
			"message",
			"message",
			"message",
		]);
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"custom",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
	});

	it("does not emit message_end for bash execution messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const messageEndRoles: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_end") {
				messageEndRoles.push(event.message.role);
			}
		});

		harness.session.recordBashResult("echo hi", {
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		expect(messageEndRoles).toEqual([]);
	});

	it("persists aborted assistant messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);

		const sawMessageUpdate = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("hi");
		await sawMessageUpdate;
		await harness.session.abort();
		await promptPromise;

		const lastEntry = harness.sessionManager.getEntries()[harness.sessionManager.getEntries().length - 1];
		expect(lastEntry?.type).toBe("message");
		if (lastEntry?.type === "message") {
			expect(lastEntry.message.role).toBe("assistant");
			if (lastEntry.message.role === "assistant") {
				expect(lastEntry.message.stopReason).toBe("aborted");
			}
		}
	});

	it("records bash output through custom operations", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				options.onData(Buffer.from("hello from custom ops"));
				return { exitCode: 0 };
			},
		};

		const result = await harness.session.executeBash("custom", undefined, { operations });

		expect(result.output).toContain("hello from custom ops");
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("bashExecution");
	});
});
