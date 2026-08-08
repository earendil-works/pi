import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createTaskTool, extractJson } from "../src/harness/tools/task.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function makeMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** streamFn that returns a single text response. */
function textStreamFn(text: string) {
	return () => {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: makeMessage("") });
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: makeMessage(text) });
			stream.push({ type: "done", reason: "stop", message: makeMessage(text) });
		});
		return stream;
	};
}

describe("extractJson", () => {
	it("extracts from a fenced json block", () => {
		expect(extractJson('Here you go:\n```json\n{"a": 1}\n```\n')).toEqual({ a: 1 });
	});

	it("extracts a bare object", () => {
		expect(extractJson('{"name":"x","nested":{"ok":true}}')).toEqual({ name: "x", nested: { ok: true } });
	});

	it("returns undefined when no JSON object is present", () => {
		expect(extractJson("no json here")).toBeUndefined();
		expect(extractJson("array [1,2,3]")).toBeUndefined();
	});
});

describe("task tool", () => {
	it("runs a subagent and returns a schema-validated structured result", async () => {
		const tool = createTaskTool({
			model: createModel(),
			streamFn: textStreamFn('Found it:\n```json\n{"name": "formatBytes", "fileCount": 3}\n```'),
			systemPrompt: "You are a research subagent.",
		});

		const result = await tool.execute(
			"tc1",
			{
				prompt: "Find the symbol formatBytes and count its files.",
				description: "Symbol search",
				schema: {
					properties: { name: {}, fileCount: {} },
					required: ["name", "fileCount"],
				},
			},
			undefined,
			undefined,
		);

		expect(result.details.hasStructuredResult).toBe(true);
		expect(result.details.summary).toBe("Symbol search");
		expect(result.details.messageCount).toBeGreaterThanOrEqual(2); // user + assistant
		expect(result.details.durationMs).toBeGreaterThanOrEqual(0);

		const content = result.content[0];
		expect(content.type).toBe("text");
		if (content.type === "text") {
			expect(JSON.parse(content.text)).toEqual({ name: "formatBytes", fileCount: 3 });
		}
	});

	it("returns prose when no schema is provided", async () => {
		const tool = createTaskTool({
			model: createModel(),
			streamFn: textStreamFn("The answer is 42."),
		});

		const result = await tool.execute("tc2", { prompt: "What is the answer?" }, undefined, undefined);

		expect(result.details.hasStructuredResult).toBe(false);
		const content = result.content[0];
		expect(content.type).toBe("text");
		if (content.type === "text") {
			expect(content.text).toContain("42");
		}
	});

	it("rejects when the subagent output is missing a required field", async () => {
		const tool = createTaskTool({
			model: createModel(),
			streamFn: textStreamFn('```json\n{"name": "only-name"}\n```'),
		});

		await expect(
			tool.execute(
				"tc3",
				{
					prompt: "Return only a name.",
					schema: { properties: { name: {}, count: {} }, required: ["name", "count"] },
				},
				undefined,
				undefined,
			),
		).rejects.toThrow(/missing required field "count"/);
	});

	it("rejects when no JSON is returned despite a schema", async () => {
		const tool = createTaskTool({
			model: createModel(),
			streamFn: textStreamFn("I could not find structured data."),
		});

		await expect(
			tool.execute("tc4", { prompt: "Return JSON.", schema: { properties: { a: {} } } }, undefined, undefined),
		).rejects.toThrow(/did not return a JSON object/);
	});
});
