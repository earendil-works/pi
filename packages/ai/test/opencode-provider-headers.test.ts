import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { withOpenCodeSessionHeader } from "../src/providers/opencode-headers.ts";
import type { Api, Context, Model, ProviderStreams, StreamOptions } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const model: Model<Api> = {
	id: "test-model",
	name: "Test model",
	api: "test-api",
	provider: "opencode",
	baseUrl: "https://opencode.ai/zen/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function completedStream(): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = fauxAssistantMessage("ok");
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

function recordingStreams(capture: (options: StreamOptions | undefined) => void): ProviderStreams {
	return {
		stream: (_model, _context, options) => {
			capture(options);
			return completedStream();
		},
		streamSimple: (_model, _context, options) => {
			capture(options);
			return completedStream();
		},
	};
}

describe("OpenCode provider headers", () => {
	// Regression test for https://github.com/earendil-works/pi/issues/9326
	it.each(["stream", "streamSimple"] as const)(
		"maps sessionId for %s requests even without cache retention",
		(method) => {
			let captured: StreamOptions | undefined;
			const streams = withOpenCodeSessionHeader(
				recordingStreams((options) => {
					captured = options;
				}),
			);

			streams[method](model, context, { sessionId: "conversation-1", cacheRetention: "none" });

			expect(captured?.headers).toEqual({ "x-opencode-session": "conversation-1" });
		},
	);

	it.each([
		{ headers: { "X-OpenCode-Session": "caller-value" }, expected: { "X-OpenCode-Session": "caller-value" } },
		{ headers: { "X-OpenCode-Session": null }, expected: { "X-OpenCode-Session": null } },
	] as const)("preserves a case-insensitive caller override", ({ headers, expected }) => {
		let captured: StreamOptions | undefined;
		const streams = withOpenCodeSessionHeader(
			recordingStreams((options) => {
				captured = options;
			}),
		);

		streams.streamSimple(model, context, { sessionId: "generated-value", headers });

		expect(captured?.headers).toEqual(expected);
	});

	it("does not fabricate a session header when sessionId is absent", () => {
		let captured: StreamOptions | undefined;
		const streams = withOpenCodeSessionHeader(
			recordingStreams((options) => {
				captured = options;
			}),
		);

		streams.streamSimple(model, context, { headers: { "x-custom": "value" } });

		expect(captured?.headers).toEqual({ "x-custom": "value" });
	});
});
