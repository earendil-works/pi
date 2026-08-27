import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { AssistantMessage, Context, Model, Usage } from "../src/types.ts";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function buildModel(overrides: Partial<Model<"openai-completions">>): Model<"openai-completions"> {
	return {
		id: "repro-model",
		name: "Repro Model",
		api: "openai-completions",
		provider: "repro-provider",
		baseUrl: "http://127.0.0.1:1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...overrides,
	};
}

function buildForeignAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "internal reasoning from another provider", thinkingSignature: "reasoning" },
			{ type: "text", text: "visible answer" },
			{
				type: "toolCall",
				id: "call_1",
				name: "repro",
				arguments: {},
				thoughtSignature: "some-thought-signature",
			},
		],
		api: "openai-completions",
		provider: "openrouter",
		model: "stealth/ox-alpha",
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function buildContext(assistant: AssistantMessage): Context {
	return {
		messages: [
			{ role: "user", content: "hello", timestamp: 1 },
			assistant,
			{ role: "user", content: "continue", timestamp: 3 },
		],
	};
}

describe("transform-messages cross-model DeepSeek reasoning replay", () => {
	it("keeps cross-model thinking as reasoning_content when the target is a DeepSeek-family model", () => {
		const model = buildModel({
			id: "deepseek-v4-flash",
			provider: "b-ai",
			baseUrl: "https://api.b.ai/v1",
		});

		const [assistant] = transformMessages(buildContext(buildForeignAssistant()).messages, model).filter(
			(msg): msg is AssistantMessage => msg.role === "assistant",
		);

		expect(assistant.content).toContainEqual({
			type: "thinking",
			thinking: "internal reasoning from another provider",
			thinkingSignature: "reasoning_content",
		});
	});

	it("still downgrades cross-model thinking to text for non-DeepSeek targets", () => {
		const model = buildModel({ id: "repro-model", provider: "repro-provider" });

		const [assistant] = transformMessages(buildContext(buildForeignAssistant()).messages, model).filter(
			(msg): msg is AssistantMessage => msg.role === "assistant",
		);

		expect(assistant.content).toContainEqual({ type: "text", text: "internal reasoning from another provider" });
		expect(assistant.content.some((block) => block.type === "thinking")).toBe(false);
	});
});

describe("openai-completions cross-model DeepSeek reasoning replay", () => {
	async function captureRequest(model: Model<"openai-completions">): Promise<{
		messages: Array<Record<string, unknown>>;
	}> {
		const requestBodies: Array<Record<string, unknown>> = [];
		const server = http.createServer(async (req, res) => {
			let body = "";
			for await (const chunk of req) {
				body += chunk.toString();
			}
			requestBodies.push(JSON.parse(body) as Record<string, unknown>);

			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-repro",
					object: "chat.completion.chunk",
					created: 0,
					model: model.id,
					choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
				})}\n\n`,
			);
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-repro",
					object: "chat.completion.chunk",
					created: 0,
					model: model.id,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				})}\n\n`,
			);
			res.write("data: [DONE]\n\n");
			res.end();
		});

		server.listen(0, "127.0.0.1");
		await once(server, "listening");

		try {
			const { port } = server.address() as AddressInfo;
			const stream = streamOpenAICompletions(
				{ ...model, baseUrl: `http://127.0.0.1:${port}` },
				buildContext(buildForeignAssistant()),
				{ apiKey: "test-key" },
			);
			for await (const _event of stream) {
				// drain
			}
		} finally {
			server.close();
			await once(server, "close");
		}

		return requestBodies[0] as { messages: Array<Record<string, unknown>> };
	}

	it("emits reasoning_content on cross-model assistant messages for a DeepSeek-family target", async () => {
		const request = await captureRequest(
			buildModel({
				id: "deepseek-v4-flash",
				provider: "b-ai",
				baseUrl: "https://api.b.ai/v1",
			}),
		);

		const assistant = request.messages.find((msg) => msg.role === "assistant");
		expect(assistant).toEqual(
			expect.objectContaining({
				role: "assistant",
				reasoning_content: "internal reasoning from another provider",
			}),
		);
	});

	it("keeps the text-only downgrade for non-DeepSeek targets", async () => {
		const request = await captureRequest(buildModel({ id: "repro-model", provider: "repro-provider" }));

		const assistant = request.messages.find((msg) => msg.role === "assistant");
		expect(assistant).toEqual(
			expect.objectContaining({
				role: "assistant",
				content: "internal reasoning from another providervisible answer",
			}),
		);
		expect(assistant?.reasoning_content).toBeUndefined();
	});
});
