import { afterEach, describe, expect, it } from "vitest";
import { complete, registerApiProvider, resetApiProviders } from "../src/compat.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "custom-openai",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

function message(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
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

describe("compat legacy API fallback", () => {
	afterEach(() => {
		resetApiProviders();
	});

	it("dispatches unknown providers through the legacy API registry", async () => {
		let capturedApiKey: string | undefined;
		registerApiProvider({
			api: "openai-responses",
			stream: (_model, _context, options) => {
				capturedApiKey = options?.apiKey;
				const stream = new AssistantMessageEventStream();
				const output = message();
				stream.push({ type: "start", partial: output });
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end(output);
				return stream;
			},
			streamSimple: (_model, _context, options) => {
				capturedApiKey = options?.apiKey;
				const stream = new AssistantMessageEventStream();
				const output = message();
				stream.push({ type: "start", partial: output });
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end(output);
				return stream;
			},
		});

		await complete(model, context, { apiKey: "request-key" });

		expect(capturedApiKey).toBe("request-key");
	});
});
