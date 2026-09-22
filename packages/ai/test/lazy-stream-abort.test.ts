import { describe, expect, it } from "vitest";
import { lazyApi, lazyStream } from "../src/api/lazy.ts";
import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderStreams } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function testModel(): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function assistantMessage(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
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
		stopReason,
		timestamp: Date.now(),
	};
}

function context() {
	return normalizeContext({
		messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }],
	});
}

function failingSetup(error: unknown) {
	return async (): Promise<AsyncIterable<AssistantMessageEvent>> => {
		throw error;
	};
}

function abortError() {
	return new DOMException("This operation was aborted", "AbortError");
}

async function drain(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

function errorEvent(events: AssistantMessageEvent[]): Extract<AssistantMessageEvent, { type: "error" }> {
	const last = events.at(-1);
	expect(last?.type).toBe("error");
	return last as Extract<AssistantMessageEvent, { type: "error" }>;
}

describe("lazyStream setup failures", () => {
	it("reports a setup failure without a signal as an error", async () => {
		const model = testModel();
		const events = await drain(lazyStream(model, failingSetup(new Error("No API key for provider: test-provider"))));
		const event = errorEvent(events);

		expect(event.reason).toBe("error");
		expect(event.error.stopReason).toBe("error");
		expect(event.error.errorMessage).toBe("No API key for provider: test-provider");
		expect(event.error.provider).toBe(model.provider);
	});

	it("reports a setup failure with an aborted signal as an aborted response", async () => {
		const controller = new AbortController();
		controller.abort();

		const events = await drain(lazyStream(testModel(), failingSetup(abortError()), controller.signal));
		const event = errorEvent(events);
		const message: AssistantMessage = event.error;

		expect(event.reason).toBe("aborted");
		expect(message.stopReason).toBe("aborted");
		expect(message.errorMessage).toBe("Request was aborted");
		expect(message.content).toEqual([]);
		expect(message.usage.totalTokens).toBe(0);
	});

	it("reports an abort that lands while setup is still running as an aborted response", async () => {
		const controller = new AbortController();
		const events = await drain(
			lazyStream(
				testModel(),
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 10));
					controller.abort();
					throw new Error("fetch failed");
				},
				controller.signal,
			),
		);

		expect(errorEvent(events).reason).toBe("aborted");
	});

	it("keeps reporting failures as errors while the signal is not aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		expect(
			errorEvent(await drain(lazyStream(testModel(), failingSetup(abortError()), controller.signal))).reason,
		).toBe("aborted");

		const events = await drain(
			lazyStream(testModel(), failingSetup(new Error("Provider is not configured")), new AbortController().signal),
		);
		const event = errorEvent(events);
		expect(event.reason).toBe("error");
		expect(event.error.errorMessage).toBe("Provider is not configured");
	});

	it("forwards a successful setup stream unchanged", async () => {
		const inner = new AssistantMessageEventStream();
		inner.push({ type: "start", partial: assistantMessage("pending") });
		inner.end(assistantMessage("stop"));

		const events = await drain(lazyStream(testModel(), async () => inner));
		expect(events.map((event) => event.type)).toEqual(["start"]);
	});
});

describe("lazyApi signal forwarding", () => {
	function implementation(seen: Array<AbortSignal | undefined>): ProviderStreams {
		return {
			stream: () => new AssistantMessageEventStream(),
			streamSimple: (_model, _context, options) => {
				seen.push(options?.signal);
				// The provider request fails during setup while the caller already aborted.
				throw abortError();
			},
		};
	}

	it("passes the caller signal to lazyStream so a cancellation is not an error", async () => {
		const seen: Array<AbortSignal | undefined> = [];
		const api = lazyApi(async () => implementation(seen));
		const controller = new AbortController();
		controller.abort();

		const events = await drain(api.streamSimple(testModel(), context(), { signal: controller.signal }));

		expect(seen).toEqual([controller.signal]);
		expect(errorEvent(events).reason).toBe("aborted");
	});

	it("still reports the same failure as an error without a signal", async () => {
		const api = lazyApi(async () => implementation([]));
		const events = await drain(api.streamSimple(testModel(), context()));

		expect(errorEvent(events).reason).toBe("error");
	});
});
