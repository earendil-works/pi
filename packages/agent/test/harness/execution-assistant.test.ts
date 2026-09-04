import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxProvider,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../../src/harness/context.ts";
import { type AssistantResponseMetadata, streamHarnessAssistant } from "../../src/harness/execution/assistant.ts";
import { AbortRequested } from "../../src/harness/execution/effect-gate.ts";
import type { AgentMessage } from "../../src/types.ts";

function usage() {
	return {
		input: 1,
		output: 2,
		cacheRead: 3,
		cacheWrite: 4,
		totalTokens: 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function model(): Model<Api> {
	return {
		id: "model",
		name: "Model",
		api: "test",
		provider: "provider",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function assistant(
	text: string,
	stopReason: Exclude<AssistantMessage["stopReason"], "pending"> = "stop",
): AssistantMessage & { stopReason: Exclude<AssistantMessage["stopReason"], "pending"> } {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "provider",
		model: "model",
		usage: usage(),
		stopReason,
		...(stopReason === "error" ? { errorMessage: text } : {}),
		timestamp: 2,
	};
}

function toProviderMessages(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message): message is Message =>
			message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

describe("streamHarnessAssistant", () => {
	it("maps curated options and runs the assistant lifecycle without mutating input", async () => {
		const input: AgentMessage[] = [user("original")];
		const originalArray = input;
		const requestModel = model();
		const controller = new AbortController();
		const order: string[] = [];
		const starts: AssistantMessage[] = [];
		const updates: AssistantMessage[] = [];
		const ends: AssistantMessage[] = [];
		let transformedInputWasCopy = false;
		let convertedMessages: AgentMessage[] = [];
		let requestContext: Parameters<NonNullable<SimpleStreamOptions["onPayload"]>>[0] | undefined;
		let receivedContext: { systemPrompt?: string; messages: Message[]; tools?: unknown[] } | undefined;
		let receivedOptions: SimpleStreamOptions | undefined;
		let responseMetadata: AssistantResponseMetadata | undefined;
		let startEventType: string | undefined;

		const result = await streamHarnessAssistant(
			input,
			{
				model: requestModel,
				systemPrompt: "system",
				thinkingLevel: "high",
				streamOptions: {
					transport: "websocket",
					timeoutMs: 123,
					maxRetries: 2,
					maxRetryDelayMs: 456,
					headers: { authorization: "test" },
					metadata: { tenant: "one" },
					cacheRetention: "long",
					deferred: { window: "1h" },
				},
				transformContext: async (context) => {
					order.push("transform_context");
					transformedInputWasCopy = context.messages !== originalArray;
					context.messages.push(user("injected"));
					return { messages: context.messages, systemPrompt: "transformed system" };
				},
				toProviderMessages: (messages) => {
					order.push("to_provider_messages");
					convertedMessages = messages;
					return toProviderMessages(messages);
				},
				beforePayload: (payload, seenModel) => {
					order.push("before_payload");
					expect(seenModel.id).toBe("resolved");
					requestContext = payload;
					return { replaced: true };
				},
				afterResponse: async (message, metadata) => {
					order.push("after_response");
					responseMetadata = metadata;
					return { ...message, content: [{ type: "text", text: "transformed" }] };
				},
				request: async (context, options) => {
					order.push("request");
					receivedContext = context;
					receivedOptions = options;
					expect(await options.onPayload?.({ original: true }, { ...requestModel, id: "resolved" })).toEqual({
						replaced: true,
					});
					await options.onResponse?.({ status: 201, headers: { "request-id": "r1" } }, requestModel);
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => {
						const initial = { ...assistant(""), stopReason: "pending" as const };
						const partial = { ...initial, content: [{ type: "text" as const, text: "raw" }] };
						stream.push({ type: "start", partial: initial });
						stream.push({ type: "text_delta", contentIndex: 0, delta: "raw", partial });
						stream.push({ type: "done", reason: "stop", message: assistant("raw") });
					});
					return stream;
				},
				observer: {
					start(message, event) {
						order.push("observer_start");
						starts.push(message);
						startEventType = event.type;
					},
					update(message) {
						order.push("observer_update");
						updates.push(message);
					},
					end(message) {
						order.push("observer_end");
						ends.push(message);
					},
				},
			},
			withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
		);

		expect(input).toEqual([user("original")]);
		expect(transformedInputWasCopy).toBe(true);
		expect(convertedMessages).toEqual([user("original"), user("injected")]);
		expect(receivedContext).toMatchObject({
			systemPrompt: "transformed system",
			messages: [user("original"), user("injected")],
		});
		expect(requestContext).toEqual({ original: true });
		expect(receivedOptions).toMatchObject({
			transport: "websocket",
			timeoutMs: 123,
			maxRetries: 2,
			maxRetryDelayMs: 456,
			headers: { authorization: "test" },
			metadata: { tenant: "one" },
			cacheRetention: "long",
			deferred: { window: "1h" },
			reasoning: "high",
			signal: controller.signal,
			telemetryContext: NOOP_TELEMETRY_CONTEXT,
		});
		expect(responseMetadata).toEqual({ status: 201, headers: { "request-id": "r1" } });
		expect(starts).toHaveLength(1);
		expect(startEventType).toBe("start");
		expect(starts[0]).not.toBe(updates[0]);
		expect(updates).toHaveLength(1);
		expect(ends[0]).toBe(result);
		expect(result.content).toEqual([{ type: "text", text: "transformed" }]);
		expect(order).toEqual([
			"transform_context",
			"to_provider_messages",
			"request",
			"before_payload",
			"observer_start",
			"observer_update",
			"after_response",
			"observer_end",
		]);
	});

	it("runs against the faux provider request boundary", async () => {
		const faux = fauxProvider({ tokenSize: { min: 1, max: 1 } });
		faux.setResponses([fauxAssistantMessage("hello")]);
		const lifecycle: string[] = [];
		let seenContext: Message[] = [];

		const result = await streamHarnessAssistant(
			[user("prompt")],
			{
				model: faux.getModel(),
				systemPrompt: "system",
				thinkingLevel: "off",
				streamOptions: {},
				toProviderMessages,
				request: (context, options) => {
					seenContext = context.messages;
					return faux.provider.streamSimple(faux.getModel(), context, options);
				},
				observer: {
					start() {
						lifecycle.push("start");
					},
					update() {
						lifecycle.push("update");
					},
					end() {
						lifecycle.push("end");
					},
				},
			},
			BACKGROUND_CONTEXT,
		);

		expect(seenContext).toEqual([user("prompt")]);
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		expect(lifecycle[0]).toBe("start");
		expect(lifecycle.at(-1)).toBe("end");
		expect(lifecycle.filter((event) => event === "update").length).toBeGreaterThan(0);
	});

	it("rejects a successful terminal event before start", async () => {
		const final = assistant("complete");
		let options: SimpleStreamOptions | undefined;
		await expect(
			streamHarnessAssistant(
				[user("prompt")],
				{
					model: model(),
					systemPrompt: "system",
					thinkingLevel: "off",
					streamOptions: {},
					toProviderMessages,
					request: (_context, requestOptions) => {
						options = requestOptions;
						const stream = createAssistantMessageEventStream();
						queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: final }));
						return stream;
					},
					observer: { start() {}, update() {}, end() {} },
				},
				BACKGROUND_CONTEXT,
			),
		).rejects.toThrow("done before start");
		expect(options).not.toHaveProperty("reasoning");
	});

	it("keeps the raw settlement when cancellation interrupts after_response", async () => {
		const final = assistant("raw");
		const ended: AssistantMessage[] = [];
		const result = await streamHarnessAssistant(
			[user("prompt")],
			{
				model: model(),
				systemPrompt: "system",
				thinkingLevel: "off",
				streamOptions: {},
				toProviderMessages,
				request: () => {
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => {
						stream.push({ type: "start", partial: { ...final, content: [], stopReason: "pending" } });
						stream.push({ type: "done", reason: "stop", message: final });
					});
					return stream;
				},
				afterResponse: async () => {
					throw new AbortRequested(Promise.resolve());
				},
				observer: {
					start() {},
					update() {},
					end(message) {
						ended.push(message);
					},
				},
			},
			BACKGROUND_CONTEXT,
		);

		expect(result).toBe(final);
		expect(ended).toEqual([final]);
	});

	it("returns provider error settlements through the same lifecycle", async () => {
		const final = assistant("provider failed", "error");
		const events: string[] = [];
		const result = await streamHarnessAssistant(
			[user("prompt")],
			{
				model: model(),
				systemPrompt: "system",
				thinkingLevel: "off",
				streamOptions: {},
				toProviderMessages,
				request: () => {
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => stream.push({ type: "error", reason: "error", error: final }));
					return stream;
				},
				observer: {
					start() {
						throw new Error("pre-generation error must not synthesize start");
					},
					update() {
						events.push("update");
					},
					end(message) {
						events.push(`end:${message.stopReason}`);
					},
				},
			},
			BACKGROUND_CONTEXT,
		);

		expect(result).toBe(final);
		expect(events).toEqual(["end:error"]);
	});
});
