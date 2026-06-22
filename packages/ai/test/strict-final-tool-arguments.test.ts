import { afterEach, describe, expect, it } from "vitest";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	ToolCall,
} from "../src/index.ts";
import { registerApiProvider, stream, unregisterApiProviders } from "../src/index.ts";
import { createAssistantMessageEventStream } from "../src/utils/event-stream.ts";

const TEST_API = "strict-tool-arguments-test";
const TEST_SOURCE_ID = "strict-tool-arguments-test-source";

function createModel(): Model<typeof TEST_API> {
	return {
		id: "strict-test-model",
		name: "Strict Test Model",
		api: TEST_API,
		provider: "strict-test-provider",
		baseUrl: "http://localhost:0",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function createMessage(model: Model<typeof TEST_API>, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function toolCall(arguments_: Record<string, unknown>): ToolCall {
	return {
		type: "toolCall",
		id: "call-1",
		name: "write",
		arguments: arguments_,
	};
}

function registerProvider(
	pushEvents: (stream: AssistantMessageEventStream, model: Model<typeof TEST_API>) => void,
): void {
	const providerStream: StreamFunction<typeof TEST_API, StreamOptions> = (model) => {
		const eventStream = createAssistantMessageEventStream();
		queueMicrotask(() => pushEvents(eventStream, model));
		return eventStream;
	};
	const providerStreamSimple: StreamFunction<typeof TEST_API, SimpleStreamOptions> = providerStream;
	registerApiProvider({ api: TEST_API, stream: providerStream, streamSimple: providerStreamSimple }, TEST_SOURCE_ID);
}

async function collectEvents(streamResult: ReturnType<typeof stream>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of streamResult) {
		events.push(event);
	}
	return events;
}

const context: Context = {
	messages: [{ role: "user", content: "write the file", timestamp: 1 }],
};

afterEach(() => {
	unregisterApiProviders(TEST_SOURCE_ID);
});

describe("strict final tool arguments", () => {
	it("turns incomplete streamed tool arguments into a terminal error", async () => {
		registerProvider((eventStream, model) => {
			const start = createMessage(model, []);
			const started = createMessage(model, [toolCall({})]);
			const partial = createMessage(model, [toolCall({ path: "README.md" })]);
			const done = { ...partial, stopReason: "toolUse" as const };
			eventStream.push({ type: "start", partial: start });
			eventStream.push({ type: "toolcall_start", contentIndex: 0, partial: started });
			eventStream.push({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"README.md"', partial });
			eventStream.push({ type: "toolcall_end", contentIndex: 0, toolCall: partial.content[0] as ToolCall, partial });
			eventStream.push({ type: "done", reason: "toolUse", message: done });
		});

		const responseStream = stream(createModel(), context);
		const events = await collectEvents(responseStream);
		const result = await responseStream.result();

		expect(events.map((event) => event.type)).toEqual(["start", "toolcall_start", "toolcall_delta", "error"]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Invalid final tool call arguments for write (call-1)");
	});

	it("keeps tool calls when streamed arguments are valid JSON objects", async () => {
		registerProvider((eventStream, model) => {
			const start = createMessage(model, []);
			const started = createMessage(model, [toolCall({})]);
			const partial = createMessage(model, [toolCall({ path: "README.md" })]);
			const finalToolCall = toolCall({ path: "README.md", content: "updated" });
			const done = { ...createMessage(model, [finalToolCall]), stopReason: "toolUse" as const };
			eventStream.push({ type: "start", partial: start });
			eventStream.push({ type: "toolcall_start", contentIndex: 0, partial: started });
			eventStream.push({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"README.md"', partial });
			eventStream.push({
				type: "toolcall_delta",
				contentIndex: 0,
				delta: ',"content":"updated"}',
				partial: done,
			});
			eventStream.push({ type: "toolcall_end", contentIndex: 0, toolCall: finalToolCall, partial: done });
			eventStream.push({ type: "done", reason: "toolUse", message: done });
		});

		const responseStream = stream(createModel(), context);
		const events = await collectEvents(responseStream);
		const result = await responseStream.result();

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		expect(result.stopReason).toBe("toolUse");
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			arguments: { path: "README.md", content: "updated" },
		});
	});

	it("turns tool calls with non-toolUse stop reasons into a terminal error", async () => {
		registerProvider((eventStream, model) => {
			const start = createMessage(model, []);
			const finalToolCall = toolCall({ path: "README.md" });
			const finalMessage = createMessage(model, [finalToolCall]);
			eventStream.push({ type: "start", partial: start });
			eventStream.push({ type: "toolcall_start", contentIndex: 0, partial: createMessage(model, [toolCall({})]) });
			eventStream.push({
				type: "toolcall_delta",
				contentIndex: 0,
				delta: '{"path":"README.md"}',
				partial: finalMessage,
			});
			eventStream.push({ type: "toolcall_end", contentIndex: 0, toolCall: finalToolCall, partial: finalMessage });
			eventStream.push({ type: "done", reason: "stop", message: finalMessage });
		});

		const responseStream = stream(createModel(), context);
		const events = await collectEvents(responseStream);
		const result = await responseStream.result();

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"error",
		]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Tool call write (call-1) ended with stop reason stop");
	});
});
