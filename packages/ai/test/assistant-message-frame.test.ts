import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageFrame,
	AssistantMessageFrameEncoder,
	type Model,
	reduceAssistantMessageFrames,
} from "../src/index.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function seed(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: 1,
	};
}

function frame(encoder: AssistantMessageFrameEncoder, event: AssistantMessageEvent): AssistantMessageFrame {
	const converted = encoder.encode(event);
	if (!converted) throw new Error(`Expected ${event.type} event to produce a frame`);
	return converted;
}

describe("assistant message frames", () => {
	it("uses authoritative text end content and signature", () => {
		const partial = seed();
		const encoder = new AssistantMessageFrameEncoder();
		const frames: AssistantMessageFrame[] = [frame(encoder, { type: "start", partial })];
		partial.content.push({ type: "text", text: "Hello " });
		frames.push(frame(encoder, { type: "text_start", contentIndex: 0, partial }));
		partial.content[0] = { type: "text", text: "Hello world", textSignature: "sig-text" };
		frames.push(
			frame(encoder, { type: "text_delta", contentIndex: 0, delta: "incorrect", partial }),
			frame(encoder, { type: "text_end", contentIndex: 0, content: "Hello world", partial }),
		);

		expect(frames.at(-1)).toEqual({
			type: "text_end",
			contentIndex: 0,
			content: "Hello world",
			textSignature: "sig-text",
		});
		expect(reduceAssistantMessageFrames(frames)?.content).toEqual([
			{ type: "text", text: "Hello world", textSignature: "sig-text" },
		]);
	});

	it("preserves provider thinking level from the stream start", () => {
		const partial = seed();
		partial.providerThinkingLevel = "high";
		const encoder = new AssistantMessageFrameEncoder();
		const start = frame(encoder, { type: "start", partial });

		expect(start).toMatchObject({ type: "start", partial: { providerThinkingLevel: "high" } });
		expect(reduceAssistantMessageFrames([start])?.providerThinkingLevel).toBe("high");
	});

	it("preserves initial and final thinking metadata, including redaction", () => {
		const partial = seed();
		const encoder = new AssistantMessageFrameEncoder();
		const frames: AssistantMessageFrame[] = [frame(encoder, { type: "start", partial })];
		partial.content.push({
			type: "thinking",
			thinking: "[redacted]",
			thinkingSignature: "encrypted-start",
			redacted: true,
		});
		frames.push(frame(encoder, { type: "thinking_start", contentIndex: 0, partial }));
		partial.content[0] = {
			type: "thinking",
			thinking: "[redacted]",
			thinkingSignature: "encrypted-final",
			redacted: true,
		};
		frames.push(frame(encoder, { type: "thinking_end", contentIndex: 0, content: "[redacted]", partial }));

		expect(frames.at(-1)).toEqual({
			type: "thinking_end",
			contentIndex: 0,
			content: "[redacted]",
			thinkingSignature: "encrypted-final",
			redacted: true,
		});
		expect(reduceAssistantMessageFrames(frames)?.content[0]).toEqual({
			type: "thinking",
			thinking: "[redacted]",
			thinkingSignature: "encrypted-final",
			redacted: true,
		});
	});

	it("parses unfinished tool JSON once and uses authoritative completed arguments", () => {
		const initialFrames: AssistantMessageFrame[] = [
			{ type: "start", partial: seed() },
			{
				type: "toolcall_start",
				contentIndex: 0,
				toolCall: { type: "toolCall", id: "initial-id", name: "write", arguments: {} },
			},
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"READ' },
		];

		expect(reduceAssistantMessageFrames(initialFrames)?.content[0]).toMatchObject({
			type: "toolCall",
			arguments: { path: "READ" },
		});

		const completeFrames: AssistantMessageFrame[] = [
			...initialFrames,
			{ type: "toolcall_delta", contentIndex: 0, delta: 'ME.md","lines":[1,2]}' },
			{
				type: "toolcall_end",
				contentIndex: 0,
				id: "final-id",
				name: "write_file",
				arguments: { path: "final.md", lines: [3] },
				thoughtSignature: "thought",
				namespace: "files",
			},
		];
		expect(reduceAssistantMessageFrames(completeFrames)?.content[0]).toEqual({
			type: "toolCall",
			id: "final-id",
			name: "write_file",
			arguments: { path: "final.md", lines: [3] },
			thoughtSignature: "thought",
			namespace: "files",
		});
	});

	it("round-trips OpenAI Responses content supplied only by authoritative end events", async () => {
		const output = seed();
		output.api = "openai-responses";
		output.provider = "openai";
		const model: Model<"openai-responses"> = {
			id: output.model,
			name: "Test",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
		const events: ResponseStreamEvent[] = [
			{
				type: "response.output_item.added",
				sequence_number: 0,
				output_index: 0,
				item: { type: "message", id: "msg", role: "assistant", status: "in_progress", content: [] },
			} as ResponseStreamEvent,
			{
				type: "response.output_item.done",
				sequence_number: 1,
				output_index: 0,
				item: {
					type: "message",
					id: "msg",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "final text", annotations: [] }],
				},
			} as ResponseStreamEvent,
			{
				type: "response.output_item.added",
				sequence_number: 2,
				output_index: 1,
				item: {
					type: "function_call",
					id: "fc",
					call_id: "call",
					name: "lookup",
					arguments: "",
				},
			} as ResponseStreamEvent,
			{
				type: "response.output_item.done",
				sequence_number: 3,
				output_index: 1,
				item: {
					type: "function_call",
					id: "fc",
					call_id: "call",
					name: "lookup",
					arguments: '{"query":"pi"}',
				},
			} as ResponseStreamEvent,
			{
				type: "response.completed",
				sequence_number: 4,
				response: { id: "response", status: "completed", output: [] },
			} as unknown as ResponseStreamEvent,
		];
		async function* source(): AsyncGenerator<ResponseStreamEvent> {
			for (const event of events) yield event;
		}

		const encoder = new AssistantMessageFrameEncoder();
		const frames: AssistantMessageFrame[] = [frame(encoder, { type: "start", partial: output })];
		const stream = new AssistantMessageEventStream();
		const push = stream.push.bind(stream);
		stream.push = (event) => {
			const converted = encoder.encode(event);
			if (converted) frames.push(converted);
			push(event);
		};
		await processResponsesStream(source(), output, stream, model);

		expect(reduceAssistantMessageFrames(frames)?.content).toEqual(output.content);
	});

	it("reconciles queued text events against one advanced live partial without duplicate content", () => {
		const partial = seed();
		const events: AssistantMessageEvent[] = [{ type: "start", partial }];
		const text = { type: "text" as const, text: "" };
		partial.content.push(text);
		events.push({ type: "text_start", contentIndex: 0, partial });
		for (const delta of ["Hel", "lo", " ", "world"]) {
			text.text += delta;
			events.push({ type: "text_delta", contentIndex: 0, delta, partial });
		}

		const encoder = new AssistantMessageFrameEncoder();
		const frames = events.flatMap((event) => {
			const encoded = encoder.encode(event);
			return encoded === undefined ? [] : [encoded];
		});

		expect(frames.map((item) => item.type)).toEqual(["start", "text_start"]);
		expect(frames[0]).toMatchObject({ type: "start", partial: { content: [], stopReason: "pending" } });
		expect(reduceAssistantMessageFrames(frames)?.content).toEqual([{ type: "text", text: "Hello world" }]);
	});

	it("trims only the covered prefix when a start snapshot lands inside a delta", () => {
		const partial = seed();
		const encoder = new AssistantMessageFrameEncoder();
		const frames: AssistantMessageFrame[] = [frame(encoder, { type: "start", partial })];
		const text = { type: "text" as const, text: "Hel" };
		partial.content.push(text);
		frames.push(frame(encoder, { type: "text_start", contentIndex: 0, partial }));
		expect(encoder.encode({ type: "text_delta", contentIndex: 0, delta: "He", partial })).toBeUndefined();
		const remainder = encoder.encode({ type: "text_delta", contentIndex: 0, delta: "llo", partial });
		if (remainder === undefined) throw new Error("Expected uncovered text delta");
		frames.push(remainder);

		expect(remainder).toEqual({ type: "text_delta", contentIndex: 0, delta: "lo" });
		expect(reduceAssistantMessageFrames(frames)?.content).toEqual([{ type: "text", text: "Hello" }]);
	});

	it("checkpoints queued tool JSON without replaying covered deltas", () => {
		const partial = seed();
		const toolCall = { type: "toolCall" as const, id: "call", name: "write", arguments: {} };
		const events: AssistantMessageEvent[] = [{ type: "start", partial }];
		partial.content.push(toolCall);
		events.push({ type: "toolcall_start", contentIndex: 0, partial });
		toolCall.arguments = { path: "README.md" };
		events.push(
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"READ', partial },
			{ type: "toolcall_delta", contentIndex: 0, delta: 'ME.md"}', partial },
		);

		const encoder = new AssistantMessageFrameEncoder();
		const frames = events.flatMap((event) => {
			const encoded = encoder.encode(event);
			return encoded === undefined ? [] : [encoded];
		});
		expect(frames.map((item) => item.type)).toEqual(["start", "toolcall_start", "toolcall_checkpoint"]);
		expect(frames.at(-1)).toEqual({
			type: "toolcall_checkpoint",
			contentIndex: 0,
			json: '{"path":"README.md"}',
		});
		expect(reduceAssistantMessageFrames(frames)?.content).toEqual([
			{ type: "toolCall", id: "call", name: "write", arguments: { path: "README.md" } },
		]);
	});

	it("resumes legacy grammar tool JSON from initial arguments", () => {
		const partial = seed();
		const encoder = new AssistantMessageFrameEncoder();
		const frames: AssistantMessageFrame[] = [frame(encoder, { type: "start", partial })];
		const toolCall = { type: "toolCall" as const, id: "call", name: "bash", arguments: { input: "a" } };
		partial.content.push(toolCall);
		frames.push(frame(encoder, { type: "toolcall_start", contentIndex: 0, partial }));
		toolCall.arguments = { input: "ab" };
		frames.push(
			frame(encoder, {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: '{"input":"ab',
				partial,
			}),
		);
		toolCall.arguments = { input: "abc" };
		frames.push(
			frame(encoder, {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: 'c"}',
				partial,
			}),
		);

		expect(frames.slice(2)).toEqual([
			{ type: "toolcall_checkpoint", contentIndex: 0, json: '{"input":"ab' },
			{ type: "toolcall_delta", contentIndex: 0, delta: 'c"}' },
		]);
		expect(reduceAssistantMessageFrames(frames)?.content).toEqual([
			{ type: "toolCall", id: "call", name: "bash", arguments: { input: "abc" } },
		]);
	});

	it("streams tool JSON compactly from an empty argument start", () => {
		const partial = seed();
		const encoder = new AssistantMessageFrameEncoder();
		const frames: AssistantMessageFrame[] = [frame(encoder, { type: "start", partial })];
		const toolCall = { type: "toolCall" as const, id: "call", name: "bash", arguments: {} };
		partial.content.push(toolCall);
		frames.push(frame(encoder, { type: "toolcall_start", contentIndex: 0, partial }));
		toolCall.arguments = { command: "ls -la /tmp" };
		frames.push(
			frame(encoder, {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: '{"command":"ls -la /tmp"}',
				partial,
			}),
		);

		expect(frames.at(-1)).toEqual({
			type: "toolcall_delta",
			contentIndex: 0,
			delta: '{"command":"ls -la /tmp"}',
		});
		expect(reduceAssistantMessageFrames(frames)?.content[0]).toMatchObject({
			type: "toolCall",
			arguments: { command: "ls -la /tmp" },
		});
	});

	it("accepts a pre-generation error but rejects success or updates before start", () => {
		const failed = seed();
		failed.stopReason = "error";
		failed.errorMessage = "setup failed";
		expect(
			new AssistantMessageFrameEncoder().encode({ type: "error", reason: "error", error: failed }),
		).toBeUndefined();

		const completed = seed();
		completed.stopReason = "stop";
		expect(() =>
			new AssistantMessageFrameEncoder().encode({ type: "done", reason: "stop", message: completed }),
		).toThrow("done event appears before start");
		expect(() =>
			new AssistantMessageFrameEncoder().encode({
				type: "text_delta",
				contentIndex: 0,
				delta: "x",
				partial: seed(),
			}),
		).toThrow("text_delta event appears before start");
	});

	it("treats end signature metadata, including absence, as authoritative", () => {
		const frames: AssistantMessageFrame[] = [
			{ type: "start", partial: seed() },
			{
				type: "text_start",
				contentIndex: 0,
				content: { type: "text", text: "", textSignature: "stale-text" },
			},
			{ type: "text_end", contentIndex: 0, content: "" },
			{
				type: "thinking_start",
				contentIndex: 1,
				content: {
					type: "thinking",
					thinking: "",
					thinkingSignature: "stale-thinking",
					redacted: true,
				},
			},
			{ type: "thinking_end", contentIndex: 1, content: "", thinkingSignature: "", redacted: false },
			{
				type: "toolcall_start",
				contentIndex: 2,
				toolCall: {
					type: "toolCall",
					id: "call",
					name: "read",
					arguments: {},
					thoughtSignature: "stale-tool",
					namespace: "stale-namespace",
				},
			},
			{ type: "toolcall_end", contentIndex: 2, id: "call", name: "read", arguments: {} },
		];

		expect(reduceAssistantMessageFrames(frames)?.content).toEqual([
			{ type: "text", text: "" },
			{ type: "thinking", thinking: "", thinkingSignature: "", redacted: false },
			{ type: "toolCall", id: "call", name: "read", arguments: {} },
		]);
	});

	it("stores authoritative final arguments in toolcall_end frames", () => {
		const partial = seed();
		const toolCall = {
			type: "toolCall" as const,
			id: "call-1",
			name: "read",
			arguments: { path: "README.md" },
			thoughtSignature: "thought",
			namespace: "files",
		};
		partial.content.push(toolCall);

		const encoder = new AssistantMessageFrameEncoder();
		frame(encoder, { type: "start", partial });
		frame(encoder, { type: "toolcall_start", contentIndex: 0, partial });
		const end = frame(encoder, { type: "toolcall_end", contentIndex: 0, toolCall, partial });
		expect(end).toEqual({
			type: "toolcall_end",
			contentIndex: 0,
			id: "call-1",
			name: "read",
			arguments: { path: "README.md" },
			thoughtSignature: "thought",
			namespace: "files",
		});
	});

	it("whitelists public block fields from provider-shaped partials", () => {
		const partial = seed();
		const text = { type: "text" as const, text: "visible", textSignature: "text-sig", index: 4 };
		const thinking = {
			type: "thinking" as const,
			thinking: "reasoning",
			thinkingSignature: "thinking-sig",
			redacted: false,
			index: 5,
		};
		const toolCall = {
			type: "toolCall" as const,
			id: "call",
			name: "run",
			arguments: { value: 1 },
			thoughtSignature: "tool-sig",
			namespace: "tools",
			partialJson: '{"value":',
			streamIndex: 6,
		};
		partial.content.push(text, thinking, toolCall);
		const partialWithScratch = partial as AssistantMessage & { outputIndex?: number };
		partialWithScratch.outputIndex = 3;

		const encoder = new AssistantMessageFrameEncoder();
		const start = frame(encoder, { type: "start", partial });
		const textStart = frame(encoder, { type: "text_start", contentIndex: 0, partial });
		const thinkingStart = frame(encoder, { type: "thinking_start", contentIndex: 1, partial });
		const toolStart = frame(encoder, { type: "toolcall_start", contentIndex: 2, partial });

		expect(start.type === "start" && start.partial.content).toEqual([]);
		expect(start).not.toHaveProperty("partial.outputIndex");
		expect(textStart).not.toHaveProperty("content.index");
		expect(thinkingStart).not.toHaveProperty("content.index");
		expect(toolStart).not.toHaveProperty("toolCall.partialJson");
		expect(toolStart).not.toHaveProperty("toolCall.streamIndex");
	});

	it("supports interleaved streams by contentIndex", () => {
		const frames: AssistantMessageFrame[] = [
			{ type: "start", partial: seed() },
			{ type: "text_start", contentIndex: 0, content: { type: "text", text: "" } },
			{
				type: "toolcall_start",
				contentIndex: 1,
				toolCall: { type: "toolCall", id: "call", name: "lookup", arguments: {} },
			},
			{ type: "thinking_start", contentIndex: 2, content: { type: "thinking", thinking: "" } },
			{ type: "text_delta", contentIndex: 0, delta: "answer" },
			{ type: "toolcall_delta", contentIndex: 1, delta: '{"query":"pi"}' },
			{ type: "thinking_delta", contentIndex: 2, delta: "check" },
			{ type: "toolcall_end", contentIndex: 1, id: "call", name: "lookup", arguments: { query: "pi" } },
			{ type: "text_end", contentIndex: 0, content: "answer" },
			{ type: "thinking_end", contentIndex: 2, content: "check" },
		];

		expect(reduceAssistantMessageFrames(frames)?.content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "toolCall", id: "call", name: "lookup", arguments: { query: "pi" } },
			{ type: "thinking", thinking: "check" },
		]);
	});

	it("snapshots mutable event data and keeps reduction pure", () => {
		const partial = seed();
		partial.diagnostics = [{ type: "test", timestamp: 2, details: { value: "original" } }];
		const encoder = new AssistantMessageFrameEncoder();
		const start = frame(encoder, { type: "start", partial });
		partial.diagnostics[0]!.details!.value = "mutated";
		partial.usage.cost.total = 99;

		partial.content.push({
			type: "toolCall",
			id: "call",
			name: "run",
			arguments: { nested: { value: "original" } },
		});
		const toolStart = frame(encoder, { type: "toolcall_start", contentIndex: 0, partial });
		const sourceTool = partial.content[0];
		if (sourceTool?.type !== "toolCall") throw new Error("Expected source tool call");
		(sourceTool.arguments.nested as Record<string, unknown>).value = "mutated";

		const reduced = reduceAssistantMessageFrames([start, toolStart]);
		expect(reduced?.diagnostics?.[0]?.details?.value).toBe("original");
		expect(reduced?.usage.cost.total).toBe(0);
		expect(reduced?.content[0]).toMatchObject({ arguments: { nested: { value: "original" } } });

		if (reduced?.content[0]?.type !== "toolCall") throw new Error("Expected reduced tool call");
		reduced.content[0].arguments.nested = "changed-output";
		expect(toolStart.type === "toolcall_start" && toolStart.toolCall.arguments.nested).toEqual({
			value: "original",
		});
	});

	it("omits terminal events because settlement is separate", () => {
		const message = seed();
		const completed = new AssistantMessageFrameEncoder();
		completed.encode({ type: "start", partial: message });
		message.stopReason = "stop";
		expect(completed.encode({ type: "done", reason: "stop", message })).toBeUndefined();
		message.stopReason = "error";
		message.errorMessage = "failed";
		expect(
			new AssistantMessageFrameEncoder().encode({ type: "error", reason: "error", error: message }),
		).toBeUndefined();
	});

	it("returns undefined when there is no start frame", () => {
		expect(reduceAssistantMessageFrames([])).toBeUndefined();
		expect(reduceAssistantMessageFrames([{ type: "text_delta", contentIndex: 0, delta: "x" }])).toBeUndefined();
	});

	it("rejects frames before start, wrong block kinds, duplicate ends, and index gaps", () => {
		expect(() =>
			reduceAssistantMessageFrames([
				{ type: "text_delta", contentIndex: 0, delta: "x" },
				{ type: "start", partial: seed() },
			]),
		).toThrow("before the start frame");
		expect(() =>
			reduceAssistantMessageFrames([
				{ type: "start", partial: seed() },
				{
					type: "toolcall_start",
					contentIndex: 0,
					toolCall: { type: "toolCall", id: "call", name: "run", arguments: {} },
				},
				{ type: "text_delta", contentIndex: 0, delta: "wrong" },
			]),
		).toThrow("expected text block");
		expect(() =>
			reduceAssistantMessageFrames([
				{ type: "start", partial: seed() },
				{ type: "text_start", contentIndex: 0, content: { type: "text", text: "" } },
				{ type: "text_end", contentIndex: 0, content: "" },
				{ type: "text_end", contentIndex: 0, content: "" },
			]),
		).toThrow("follows the end");
		expect(() =>
			reduceAssistantMessageFrames([
				{ type: "start", partial: seed() },
				{ type: "text_start", contentIndex: 1, content: { type: "text", text: "" } },
			]),
		).toThrow("would leave a gap");
	});

	it("rejects conversion events whose contentIndex points to the wrong block kind", () => {
		const partial = seed();
		const encoder = new AssistantMessageFrameEncoder();
		encoder.encode({ type: "start", partial });
		partial.content.push({ type: "thinking", thinking: "" });
		expect(() => encoder.encode({ type: "text_start", contentIndex: 0, partial })).toThrow(
			"text_start event points to thinking block",
		);
	});
});
