import assert from "node:assert/strict";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { it as test } from "vitest";
import { requestQuickAnswer } from "../examples/extensions/async-mode/model-request.ts";

const model: Model<"openai-completions"> = {
	id: "test",
	name: "Test",
	provider: "custom-ark",
	api: "openai-completions",
	baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 4096,
};
function context(stream: ExtensionContext["modelRegistry"]["streamSimple"]): ExtensionContext {
	// This fixture implements only the model-request boundary.
	return { model, modelRegistry: { streamSimple: stream } } as unknown as ExtensionContext;
}

test("uses the selected model unchanged without a provider-specific adaptation", async () => {
	let payload: unknown;
	const ctx = context((selected, input, options) => {
		assert.equal(selected, model);
		return streamSimple(selected as Model<"openai-completions">, normalizeContext(input), {
			...options,
			apiKey: "offline-test",
			onPayload: (body) => {
				payload = body;
			},
			fetch: async () =>
				new Response(
					'data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}\n\n' +
						'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				),
		});
	});
	const answer = await requestQuickAnswer(
		ctx,
		{ messages: [] },
		{
			signal: new AbortController().signal,
			maxTokens: 900,
			timeoutMs: 2000,
			onProgress: () => {},
		},
	);
	assert.equal(answer.stopReason, "stop");
	assert.equal((payload as { thinking?: unknown }).thinking, undefined);
	assert.equal(model.compat, undefined);
});

test("deadline releases callers even when a provider ignores cancellation", async () => {
	let signal: AbortSignal | undefined;
	const ctx = context((_model, _input, options) => {
		signal = options?.signal;
		return createAssistantMessageEventStream();
	});
	await assert.rejects(
		requestQuickAnswer(
			ctx,
			{ messages: [] },
			{
				signal: new AbortController().signal,
				maxTokens: 900,
				timeoutMs: 20,
				onProgress: () => {},
			},
		),
		/timed out/,
	);
	assert.equal(signal?.aborted, true);
	const next = context(() => {
		const stream = createAssistantMessageEventStream();
		stream.end(fauxAssistantMessage("Next request succeeded"));
		return stream;
	});
	assert.equal(
		(
			await requestQuickAnswer(
				next,
				{ messages: [] },
				{
					signal: new AbortController().signal,
					maxTokens: 900,
					timeoutMs: 1000,
					onProgress: () => {},
				},
			)
		).stopReason,
		"stop",
	);
});

test("reports stages without exposing thought content and cancels promptly", async () => {
	const stages: string[] = [];
	const controller = new AbortController();
	const stream = createAssistantMessageEventStream();
	const reply = fauxAssistantMessage("done");
	const promise = requestQuickAnswer(
		context(() => stream),
		{ messages: [] },
		{
			signal: controller.signal,
			maxTokens: 900,
			timeoutMs: 1000,
			onProgress: (stage) => stages.push(stage),
		},
	);
	stream.push({ type: "thinking_start", contentIndex: 0, partial: reply });
	stream.push({ type: "text_start", contentIndex: 0, partial: reply });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(stages, ["Waiting for model", "Model thinking", "Receiving answer"]);
	controller.abort();
	await assert.rejects(promise, /cancelled/);
});
