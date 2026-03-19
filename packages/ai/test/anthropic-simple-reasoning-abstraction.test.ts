import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamSimple } from "../src/stream.js";
import type { Context, Model } from "../src/types.js";

type CapturedRequest = {
	method: string;
	url: string;
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
};

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

function createContext(): Context {
	return {
		messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
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

async function captureAnthropicRequest(
	model: Model<"anthropic-messages">,
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh",
): Promise<CapturedRequest> {
	let captured: CapturedRequest | null = null;

	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}

		captured = {
			method: req.method ?? "",
			url: req.url ?? "",
			headers: req.headers,
			body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
		};

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

	const proxiedModel: Model<"anthropic-messages"> = {
		...model,
		baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
	};

	const stream = streamSimple(proxiedModel, createContext(), {
		apiKey: "test-key",
		...(reasoning ? { reasoning } : {}),
	});
	await stream.result();

	if (!captured) {
		throw new Error("Anthropic request was not captured");
	}

	return captured;
}

function getAnthropicModel(id: string): Model<"anthropic-messages"> {
	const model = getModel("anthropic", id);
	if (!model || model.api !== "anthropic-messages") {
		throw new Error(`Expected anthropic-messages model for ${id}`);
	}
	return model as Model<"anthropic-messages">;
}

describe("anthropic simple reasoning abstraction", () => {
	it("omits thinking config when simple reasoning is not provided", async () => {
		const captured = await captureAnthropicRequest(getAnthropicModel("claude-sonnet-4-6"));

		expect(captured.method).toBe("POST");
		expect(captured.url).toBe("/v1/messages");
		expect(captured.body.thinking).toBeUndefined();
	});

	it("uses adaptive thinking with medium effort for Claude Sonnet 4.6", async () => {
		const captured = await captureAnthropicRequest(getAnthropicModel("claude-sonnet-4-6"), "medium");

		expect(captured.body.thinking).toEqual({ type: "adaptive" });
		expect(captured.body.output_config).toEqual({ effort: "medium" });
		expect(captured.body).not.toHaveProperty("thinking.budget_tokens");
	});

	it("maps xhigh to adaptive high effort for Claude Sonnet 4.6", async () => {
		const captured = await captureAnthropicRequest(getAnthropicModel("claude-sonnet-4-6"), "xhigh");

		expect(captured.body.thinking).toEqual({ type: "adaptive" });
		expect(captured.body.output_config).toEqual({ effort: "high" });
		expect(captured.body).not.toHaveProperty("thinking.budget_tokens");
	});

	it("maps xhigh to adaptive max effort for Claude Opus 4.6", async () => {
		const captured = await captureAnthropicRequest(getAnthropicModel("claude-opus-4-6"), "xhigh");

		expect(captured.body.thinking).toEqual({ type: "adaptive" });
		expect(captured.body.output_config).toEqual({ effort: "max" });
		expect(captured.body).not.toHaveProperty("thinking.budget_tokens");
	});

	it("keeps budget-based thinking for older Claude models", async () => {
		const captured = await captureAnthropicRequest(getAnthropicModel("claude-sonnet-4-0"), "medium");

		expect(captured.body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
		expect(captured.body.output_config).toBeUndefined();
	});
});
