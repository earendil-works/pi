import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "../src/providers/faux.ts";
import type { AssistantMessage, AssistantMessageEvent, Model, TranscriptContext } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { allocatedBytes, collectGarbage } from "./memory-helpers.ts";

// #9265: every provider re-parsed the accumulated tool-call arguments on each delta and kept the raw text on the
// content block, where it reached partial messages, Durable commits and transcripts.

const content = Array.from({ length: 20_000 }, (_, line) => `const line${line} = "value ${line}"; // \\ done\n`).join(
	"",
);

/** `write` arguments with `size` characters of file content, and their JSON text. */
function writeCall(size: number) {
	const args = { path: "/src/file.ts", content: content.slice(0, size) };
	return { args, text: JSON.stringify(args) };
}

function deltasOf(text: string, size: number): string[] {
	const deltas: string[] = [];
	for (let index = 0; index < text.length; index += size) deltas.push(text.slice(index, index + size));
	return deltas;
}

/** A fetch whose response streams `events` as server-sent events, produced lazily. */
function sseFetch(events: () => Iterable<string>): typeof fetch {
	return async () => {
		const iterator = events()[Symbol.iterator]();
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				let chunk = "";
				for (let count = 0; count < 16; count++) {
					const next = iterator.next();
					if (next.done) {
						if (chunk) controller.enqueue(encoder.encode(chunk));
						controller.close();
						return;
					}
					chunk += next.value;
				}
				controller.enqueue(encoder.encode(chunk));
			},
		});
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
}

const sse = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;

const baseModel = {
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};

const context: TranscriptContext = normalizeContext({ messages: [{ role: "user", content: "write", timestamp: 0 }] });

function* anthropicEvents(deltas: readonly string[]): Generator<string> {
	yield sse(
		{
			type: "message_start",
			message: { id: "msg_1", model: "claude-test", usage: { input_tokens: 1, output_tokens: 1 } },
		},
		"message_start",
	);
	yield sse(
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "toolu_1", name: "write", input: {} },
		},
		"content_block_start",
	);
	for (const delta of deltas) {
		yield sse(
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: delta } },
			"content_block_delta",
		);
	}
	yield sse({ type: "content_block_stop", index: 0 }, "content_block_stop");
	yield sse(
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } },
		"message_delta",
	);
	yield sse({ type: "message_stop" }, "message_stop");
}

function* chatEvents(deltas: readonly string[], withIdEveryChunk: boolean): Generator<string> {
	const base = { id: "chat_1", object: "chat.completion.chunk", created: 1, model: "test" };
	const call = (fields: object) => ({
		...base,
		choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...fields }] } }],
	});
	yield sse(call({ id: "call_1", type: "function", function: { name: "write", arguments: "" } }));
	for (const delta of deltas) {
		yield sse(
			call(
				withIdEveryChunk
					? { id: "call_1", function: { name: "write", arguments: delta } }
					: { function: { arguments: delta } },
			),
		);
	}
	yield sse({
		...base,
		choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	});
	yield "data: [DONE]\n\n";
}

function* piMessagesEvents(deltas: readonly string[], args: object): Generator<string> {
	yield sse({ type: "start" });
	yield sse({ type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "write" });
	for (const delta of deltas) yield sse({ type: "toolcall_delta", contentIndex: 0, delta });
	yield sse({
		type: "toolcall_end",
		contentIndex: 0,
		toolCall: { type: "toolCall", id: "call_1", name: "write", arguments: args },
	});
	yield sse({
		type: "done",
		reason: "toolUse",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
}

function* responsesEvents(deltas: readonly string[], text: string): Generator<ResponseStreamEvent> {
	const item = {
		type: "function_call",
		id: "fc_1",
		call_id: "call_1",
		name: "write",
		arguments: "",
		status: "in_progress",
	};
	yield { type: "response.output_item.added", output_index: 0, sequence_number: 0, item } as ResponseStreamEvent;
	for (const delta of deltas) {
		yield {
			type: "response.function_call_arguments.delta",
			output_index: 0,
			item_id: "fc_1",
			sequence_number: 0,
			delta,
		} as ResponseStreamEvent;
	}
	yield {
		type: "response.function_call_arguments.done",
		output_index: 0,
		item_id: "fc_1",
		sequence_number: 0,
		arguments: text,
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		output_index: 0,
		sequence_number: 0,
		item: { ...item, arguments: text, status: "completed" },
	} as ResponseStreamEvent;
	yield {
		type: "response.completed",
		sequence_number: 0,
		response: {
			id: "resp_1",
			status: "completed",
			output: [],
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		},
	} as unknown as ResponseStreamEvent;
}

type Path = {
	readonly name: string;
	/** Stream one `write` call whose argument text arrives as `deltas`. */
	readonly stream: (deltas: readonly string[], args: object, text: string) => AssistantMessageEventStream;
};

const PATHS: readonly Path[] = [
	{
		name: "anthropic-messages",
		stream: (deltas) =>
			streamAnthropic(
				{
					...baseModel,
					id: "claude-test",
					name: "c",
					api: "anthropic-messages",
					provider: "anthropic",
					baseUrl: "https://api.anthropic.com",
				},
				context,
				{ apiKey: "sk-ant-test", fetch: sseFetch(() => anthropicEvents(deltas)) },
			),
	},
	{
		name: "openai-completions",
		stream: (deltas) =>
			streamOpenAICompletions(
				{
					...baseModel,
					id: "gpt-test",
					name: "g",
					api: "openai-completions",
					provider: "openai",
					baseUrl: "https://api.openai.com/v1",
				},
				context,
				{ apiKey: "sk-test", fetch: sseFetch(() => chatEvents(deltas, false)) },
			),
	},
	{
		name: "openai-responses",
		stream: (deltas, _args, text) => {
			const output: AssistantMessage = {
				role: "assistant",
				content: [],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "pending",
				timestamp: 0,
			};
			const events = new AssistantMessageEventStream();
			const model = {
				...baseModel,
				id: "gpt-test",
				name: "g",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
			} satisfies Model<"openai-responses">;
			void (async () => {
				events.push({ type: "start", partial: output });
				await processResponsesStream(
					(async function* () {
						yield* responsesEvents(deltas, text);
					})(),
					output,
					events,
					model,
				);
				events.push({ type: "done", reason: "toolUse", message: output });
				events.end();
			})();
			return events;
		},
	},
	{
		name: "mistral-conversations",
		stream: (deltas) =>
			streamMistral(
				{
					...baseModel,
					id: "devstral",
					name: "d",
					api: "mistral-conversations",
					provider: "mistral",
					baseUrl: "https://api.mistral.ai",
				},
				context,
				{ apiKey: "test", fetch: sseFetch(() => chatEvents(deltas, true)) },
			),
	},
	{
		name: "pi-messages",
		stream: (deltas, args) =>
			streamPiMessages(
				{
					...baseModel,
					id: "auto",
					name: "a",
					api: "pi-messages",
					provider: "radius",
					baseUrl: "https://example.test/v1",
				},
				context,
				{ apiKey: "test", fetch: sseFetch(() => piMessagesEvents(deltas, args)) },
			),
	},
	{
		name: "faux",
		stream: (_deltas, args) => {
			const faux = fauxProvider({ tokenSize: { min: 8, max: 8 } });
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("write", args as never, { id: "call_1" })], { stopReason: "toolUse" }),
			]);
			return faux.provider.streamSimple!(faux.getModel(), context, {}) as AssistantMessageEventStream;
		},
	},
];

/** Own keys a content block may carry; anything else is stream state leaking into partial messages. */
const BLOCK_KEYS: Record<string, readonly string[]> = {
	text: ["type", "text", "textSignature"],
	thinking: ["type", "thinking", "thinkingSignature", "redacted"],
	toolCall: ["type", "id", "name", "arguments", "argumentsError", "thoughtSignature", "namespace"],
};

function expectNoStreamState(message: AssistantMessage, label: string): void {
	for (const block of message.content) {
		for (const key of Object.keys(block))
			expect(BLOCK_KEYS[block.type], `${label}: ${block.type}.${key}`).toContain(key);
	}
}

async function consume(
	events: AssistantMessageEventStream,
	onEvent: (event: AssistantMessageEvent) => void = () => {},
) {
	for await (const event of events) onEvent(event);
	return events.result();
}

describe.each(PATHS)("$name tool-call argument streaming", (path) => {
	it("shows growing partial arguments, keeps stream state off every partial, and finishes with the exact arguments", async () => {
		const { args, text } = writeCall(5_000);
		let shown = -1;
		let partials = 0;
		const message = await consume(path.stream(deltasOf(text, 24), args, text), (event) => {
			const partial = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
			expectNoStreamState(partial, event.type);
			if (event.type !== "toolcall_delta") return;
			const call = partial.content[event.contentIndex];
			const shownContent = call?.type === "toolCall" ? call.arguments.content : undefined;
			if (typeof shownContent !== "string") return;
			partials++;
			expect(args.content.startsWith(shownContent)).toBe(true);
			expect(shownContent.length).toBeGreaterThanOrEqual(shown);
			shown = shownContent.length;
		});
		expect(message.stopReason).toBe("toolUse");
		expect(partials).toBeGreaterThan(100);
		expect(message.content).toEqual([{ type: "toolCall", id: expect.any(String), name: "write", arguments: args }]);
	});

	it("allocates linearly in the argument text", async () => {
		const run = (size: number) => {
			const { args, text } = writeCall(size);
			return allocatedBytes(() => consume(path.stream(deltasOf(text, 32), args, text)));
		};
		const small = await run(25_000);
		const large = await run(250_000);
		// Ten times the text: linear growth is about 10x, re-parsing the accumulated text about 100x.
		expect(large / small).toBeLessThan(25);
		expect(large / writeCall(250_000).text.length).toBeLessThan(5_000);
	});

	it("releases the stream, its partial messages and argument snapshots once the caller drops them", async () => {
		const references: WeakRef<object>[] = [];
		await (async () => {
			const { args, text } = writeCall(2_000);
			const events = path.stream(deltasOf(text, 16), args, text);
			references.push(new WeakRef(events));
			await consume(events, (event) => {
				if (event.type !== "toolcall_delta") return;
				const call = event.partial.content[event.contentIndex];
				if (call?.type === "toolCall") references.push(new WeakRef(call.arguments));
			});
		})();
		await collectGarbage();
		expect(references.filter((reference) => reference.deref() !== undefined)).toHaveLength(0);
	});
});

describe("tool-call stream state on errors", () => {
	it("leaves no stream state on the error message of a stream cut off mid-call", async () => {
		const { text } = writeCall(2_000);
		const cut = deltasOf(text, 16).slice(0, 20);
		const message = await consume(
			streamAnthropic(
				{
					...baseModel,
					id: "claude-test",
					name: "c",
					api: "anthropic-messages",
					provider: "anthropic",
					baseUrl: "https://api.anthropic.com",
				},
				context,
				{
					apiKey: "sk-ant-test",
					fetch: sseFetch(function* () {
						const events = [...anthropicEvents(cut)];
						// Drop the block stop and the message end, as a dropped connection does.
						yield* events.slice(0, -3);
					}),
				},
			),
		);
		expect(message.stopReason).toBe("error");
		expectNoStreamState(message, "error");
		expect(message.content[0]).toMatchObject({ type: "toolCall", arguments: { path: "/src/file.ts" } });
	});
});
