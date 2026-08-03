import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

interface CapturedRequest {
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

const context: Context = {
	messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
};

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function successfulEvents(model = "claude-fable-5"): Array<{ event: string; data: string }> {
	return [
		{
			event: "message_start",
			data: JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_test",
					model,
					usage: {
						input_tokens: 12,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			}),
		},
		{
			event: "content_block_start",
			data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		},
		{
			event: "content_block_delta",
			data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
		},
		{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
		{
			event: "message_delta",
			data: JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: {
					input_tokens: 12,
					output_tokens: 5,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			}),
		},
		{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
	];
}

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function writeSseResponse(response: ServerResponse): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end(
		successfulEvents()
			.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`)
			.join("\n"),
	);
}

function cloneModel(baseUrl: string, provider = "anthropic"): Model<"anthropic-messages"> {
	return { ...getModel("anthropic", "claude-fable-5"), provider, baseUrl };
}

async function request(
	model: Model<"anthropic-messages">,
	fallbacks?: "default" | string[],
	headers?: Record<string, string | null>,
): Promise<CapturedRequest> {
	let captured: CapturedRequest | undefined;
	const server = createServer(async (incoming, response) => {
		captured = { headers: incoming.headers, body: await readRequestBody(incoming) };
		writeSseResponse(response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;

	try {
		await streamAnthropic({ ...model, baseUrl: `http://127.0.0.1:${address.port}` }, context, {
			apiKey: "test-key",
			cacheRetention: "none",
			fallbacks,
			headers,
		}).result();
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}

	if (!captured) throw new Error("Anthropic request was not captured");
	return captured;
}

describe("Anthropic server-side fallback", () => {
	it("sends the beta payload and header only for opted-in official Anthropic requests", async () => {
		const official = cloneModel("https://api.anthropic.com");
		const optedIn = await request(official, "default");
		const optedOut = await request(official);
		const compatible = await request(cloneModel("https://example.test", "test-anthropic"), "default");
		const optedInWithBeta = await request(official, "default", { "anthropic-beta": "another-beta" });

		expect(optedIn.body.fallbacks).toBe("default");
		expect(optedIn.headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
		expect(optedInWithBeta.headers["anthropic-beta"]).toBe("another-beta,server-side-fallback-2026-07-01");
		expect(optedOut.body.fallbacks).toBeUndefined();
		expect(optedOut.headers["anthropic-beta"]).toBeUndefined();
		expect(compatible.body.fallbacks).toBeUndefined();
		expect(compatible.headers["anthropic-beta"]).toBeUndefined();
	});

	it("keeps non-opted compatible responses on their configured model cost", async () => {
		const model = {
			...cloneModel("https://example.test", "test-anthropic"),
			cost: { input: 4, output: 8, cacheRead: 0.4, cacheWrite: 5 },
		};
		const client = {
			messages: {
				create: () => ({ asResponse: async () => createSseResponse(successfulEvents("served-alias")) }),
			},
		} as unknown as Anthropic;

		const result = await streamAnthropic(model, context, { client }).result();
		expect(result.responseModel).toBeUndefined();
		expect(result.usage.cost.total).toBeCloseTo(0.000088, 10);
	});

	it("persists fallback transitions, uses the serving model cost, and replays only when opted in", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const firstResponse = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_fallback",
						model: "claude-fable-5",
						usage: {
							input_tokens: 100,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "fallback",
						from: { model: "claude-fable-5" },
						to: { model: "claude-sonnet-5" },
						trigger: { type: "refusal", category: "cyber" },
					},
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
			{
				event: "content_block_start",
				data: JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 1,
					delta: { type: "text_delta", text: "Hello" },
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 1 }) },
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: {
						input_tokens: 100,
						output_tokens: 10,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
						iterations: [
							{ type: "message", model: "claude-fable-5" },
							{ type: "fallback_message", model: "claude-sonnet-5" },
						],
					},
				}),
			},
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		]);
		const responses = [firstResponse, createSseResponse(successfulEvents()), createSseResponse(successfulEvents())];
		const client = {
			messages: {
				create: (params: Record<string, unknown>) => {
					calls.push(params);
					const response = responses.shift();
					if (!response) throw new Error("Unexpected request");
					return { asResponse: async () => response };
				},
			},
		} as unknown as Anthropic;
		const model = cloneModel("https://api.anthropic.com");

		const first = await streamAnthropic(model, context, { client, fallbacks: "default" }).result();
		expect(first.responseModel).toBe("claude-sonnet-5");
		expect(first.content).toEqual([
			{
				type: "fallback",
				from: { model: "claude-fable-5" },
				to: { model: "claude-sonnet-5" },
				trigger: { type: "refusal", category: "cyber" },
			},
			{ type: "text", text: "Hello" },
		]);
		expect(first.usage.cost.total).toBeCloseTo(0.0003, 10);

		const history: Context = {
			messages: [context.messages[0], first, { role: "user", content: "Continue.", timestamp: Date.now() }],
		};
		await streamAnthropic(model, history, { client, fallbacks: "default" }).result();
		await streamAnthropic(model, history, { client }).result();

		const optedInMessages = calls[1].messages as Array<{ role: string; content: Array<{ type: string }> }>;
		const optedOutMessages = calls[2].messages as Array<{ role: string; content: Array<{ type: string }> }>;
		expect(optedInMessages[1].content[0]).toEqual({
			type: "fallback",
			from: { model: "claude-fable-5" },
			to: { model: "claude-sonnet-5" },
			trigger: { type: "refusal", category: "cyber" },
		});
		expect(optedOutMessages[1].content).toEqual([{ type: "text", text: "Hello" }]);
	});
});
