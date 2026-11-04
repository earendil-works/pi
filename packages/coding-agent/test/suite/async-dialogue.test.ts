import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import asyncMode from "../../examples/extensions/async-mode/index.ts";
import { createHarness, createTestUiContext, getAssistantTexts, getUserTexts, type Harness } from "./harness.ts";

type Responses = Parameters<Harness["setResponses"]>[0];

describe("busy-time side questions", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function blocked(responses: Responses, mode = "Async") {
		let release!: () => void;
		let entered = false;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const notices: string[] = [];
		const contexts: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				asyncMode,
				(pi) => {
					pi.registerTool({
						name: "gate",
						label: "gate",
						description: "Hold foreground work",
						parameters: Type.Object({}),
						execute: async () => {
							entered = true;
							await gate;
							return { content: [{ type: "text", text: "main tool finished" }], details: {} };
						},
					});
					pi.on("context", async (event) => {
						for (const message of event.messages) {
							if (message.role === "custom" && message.customType === "async-dialogue-context")
								contexts.push(JSON.stringify(message.content));
						}
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				notify: (text) => notices.push(text),
				select: async () => mode,
			}),
		});
		await harness.session.prompt("/mode");
		harness.setResponses([fauxAssistantMessage([fauxToolCall("gate", {})], { stopReason: "toolUse" }), ...responses]);
		const running = harness.session.prompt("Run the main task");
		await vi.waitFor(() => expect(entered).toBe(true));
		return { harness, notices, contexts, release, running };
	}

	it("answers busy input with one read-only call and feeds the attributed result back", async () => {
		const { harness, notices, contexts, release, running } = await blocked([
			(context) => {
				expect(JSON.stringify(context)).toContain("Run the main task");
				expect(JSON.stringify(context)).not.toContain("execute_independent_request");
				return fauxAssistantMessage("Side answer");
			},
			fauxAssistantMessage("Main finished"),
		]);
		try {
			await harness.session.prompt("How does this work?", { streamingBehavior: "steer" });
			await vi.waitFor(() => expect(notices.join("\n")).toContain("Side answer"));
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(harness.session.isStreaming).toBe(true);
			expect(harness.session.getSteeringMessages()).toEqual([]);
			expect(getUserTexts(harness)).not.toContain("How does this work?");
			expect(harness.session.getActiveToolNames()).not.toContain("async_main_state");
		} finally {
			release();
		}
		await running;
		expect(contexts.join("\n")).toContain("How does this work?");
		expect(contexts.join("\n")).toContain("Side answer");
		expect(contexts.join("\n")).toContain("startedAt");
		expect(contexts.join("\n")).toContain("finishedAt");
		const tool = harness.session.agent.state.tools.find((item) => item.name === "async_dialogue_read")!;
		expect(JSON.stringify(await tool.execute("read", {}, new AbortController().signal))).toContain("Side answer");
	});

	it("does not serialize a newer question behind a slow side answer", async () => {
		let complete!: (message: ReturnType<typeof fauxAssistantMessage>) => void;
		const delayed = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
			complete = resolve;
		});
		const { harness, notices, release, running } = await blocked([
			async () => delayed,
			fauxAssistantMessage("Fast answer"),
			fauxAssistantMessage("Main finished"),
		]);
		try {
			await harness.session.prompt("Slow question", { streamingBehavior: "steer" });
			await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(2));
			await harness.session.prompt("Fast question", { streamingBehavior: "steer" });
			await vi.waitFor(() => expect(notices.join("\n")).toContain("Fast answer"));
			expect(notices.join("\n")).not.toContain("Slow answer");
			expect(harness.session.isStreaming).toBe(true);
			complete(fauxAssistantMessage("Slow answer"));
			await vi.waitFor(() => expect(notices.join("\n")).toContain("Slow answer"));
		} finally {
			complete(fauxAssistantMessage("Stopped"));
			release();
		}
		await running;
	});

	it("sends idle input to the main agent after earlier side answers", async () => {
		const { harness, notices, release, running } = await blocked([
			fauxAssistantMessage("Side answer"),
			fauxAssistantMessage("Main finished"),
			fauxAssistantMessage("Idle main answer"),
		]);
		try {
			await harness.session.prompt("Side question", { streamingBehavior: "steer" });
			await vi.waitFor(() => expect(notices.join("\n")).toContain("Side answer"));
		} finally {
			release();
		}
		await running;
		await harness.session.prompt("Idle question");
		expect(getUserTexts(harness)).toContain("Idle question");
		expect(getAssistantTexts(harness)).toContain("Idle main answer");
		expect(notices.join("\n")).not.toContain("Processing independently: Idle question");
	});

	it("treats correction-like busy input as a side question without classification", async () => {
		const { harness, notices, release, running } = await blocked([
			fauxAssistantMessage("Explained the constraint without changing the main task"),
			fauxAssistantMessage("Main finished"),
		]);
		try {
			await harness.session.prompt("Only local testing", { streamingBehavior: "steer" });
			await vi.waitFor(() => expect(notices.join("\n")).toContain("Explained the constraint"));
			expect(harness.session.getSteeringMessages()).toEqual([]);
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			release();
		}
		await running;
	});

	it("reports an answer failure and still accepts another busy question", async () => {
		const { harness, notices, release, running } = await blocked([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Offline model failure" }),
			fauxAssistantMessage("Next answer"),
			fauxAssistantMessage("Main finished"),
		]);
		try {
			await harness.session.prompt("First question", { streamingBehavior: "steer" });
			await vi.waitFor(() => expect(notices.join("\n")).toContain("Offline model failure"));
			await harness.session.prompt("Next question", { streamingBehavior: "steer" });
			await vi.waitFor(() => expect(notices.join("\n")).toContain("Next answer"));
			expect(harness.session.isStreaming).toBe(true);
		} finally {
			release();
		}
		await running;
	});

	it("preserves native busy steering in Default mode", async () => {
		const { harness, notices, release, running } = await blocked([fauxAssistantMessage("Main finished")], "Default");
		try {
			await harness.session.prompt("A normal correction", { streamingBehavior: "steer" });
			expect(harness.session.getSteeringMessages()).toEqual(["A normal correction"]);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(notices.join("\n")).not.toContain("Processing independently");
		} finally {
			release();
		}
		await running;
	});
});
