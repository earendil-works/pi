import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { Context, Model } from "../src/types.js";

type CapturedRequest = Record<string, unknown>;

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
	await Promise.all(
		Array.from(
			servers,
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => {
						if (error) reject(error);
						else resolve();
					});
				}),
		),
	);
	servers.clear();
});

function createAnthropicModel(baseUrl: string): Model<"anthropic-messages"> {
	return {
		id: "claude-test",
		name: "Claude Test",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function createContext(): Context {
	return {
		systemPrompt: "System A",
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
		tools: [
			{
				name: "zeta_tool",
				description: "z desc",
				parameters: Type.Object({ value: Type.String() }),
			},
			{
				name: "alpha_tool",
				description: "a desc",
				parameters: Type.Object({ value: Type.String() }),
			},
		],
	};
}

function createAnthropicSseResponse(): string {
	return [
		"event: message_start\n" +
			'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"test","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
		"event: content_block_start\n" +
			'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
		"event: content_block_delta\n" +
			'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
		"event: content_block_stop\n" + 'data: {"type":"content_block_stop","index":0}\n\n',
		"event: message_delta\n" +
			'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":1,"output_tokens":1}}\n\n',
		"event: message_stop\n" + 'data: {"type":"message_stop"}\n\n',
	].join("");
}

async function captureAnthropicRequest(): Promise<CapturedRequest> {
	let captured: CapturedRequest | null = null;

	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}

		captured = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequest;
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(createAnthropicSseResponse());
	});

	servers.add(server);
	await new Promise<void>((resolve, reject) => {
		server.listen(0, "127.0.0.1", (error?: Error) => {
			if (error) reject(error);
			else resolve();
		});
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Failed to bind local Anthropic capture server");
	}

	const stream = streamAnthropic(
		createAnthropicModel(`http://127.0.0.1:${(address as AddressInfo).port}`),
		createContext(),
		{
			apiKey: "test-key",
			maxTokens: 32,
		},
	);
	await stream.result();

	if (!captured) {
		throw new Error("Anthropic request was not captured");
	}

	return captured;
}

describe("anthropic prompt-cache policy integration", () => {
	it("sorts tools alphabetically before serializing the request body", async () => {
		const captured = await captureAnthropicRequest();
		const tools = captured.tools;
		expect(Array.isArray(tools)).toBe(true);
		expect((tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["alpha_tool", "zeta_tool"]);
	});
});
