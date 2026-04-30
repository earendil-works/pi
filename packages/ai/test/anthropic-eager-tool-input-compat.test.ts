import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { Context, Model, Tool } from "../src/types.js";

interface CapturedRequest {
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

function createModel(baseUrl: string, compat?: Model<"anthropic-messages">["compat"]): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7",
		api: "anthropic-messages",
		provider: "test-anthropic",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat,
	};
}

const tool: Tool = {
	name: "lookup",
	description: "Look up a value",
	parameters: Type.Object({ value: Type.String() }),
};

function createContext(tools: Tool[] = [tool]): Context {
	return {
		messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }],
		...(tools.length > 0 ? { tools } : {}),
	};
}

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function writeEmptySseResponse(response: ServerResponse): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end();
}

async function captureAnthropicRequest(
	compat: Model<"anthropic-messages">["compat"],
	context: Context,
): Promise<CapturedRequest> {
	let capturedRequest: CapturedRequest | undefined;

	const server = createServer(async (request, response) => {
		capturedRequest = {
			headers: request.headers,
			body: await readRequestBody(request),
		};
		writeEmptySseResponse(response);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;

	try {
		const stream = streamAnthropic(createModel(`http://127.0.0.1:${address.port}`, compat), context, {
			apiKey: "test-key",
			cacheRetention: "none",
		});

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	if (!capturedRequest) {
		throw new Error("Anthropic request was not captured");
	}
	return capturedRequest;
}

function getFirstTool(body: Record<string, unknown>): Record<string, unknown> {
	const tools = body.tools;
	if (!Array.isArray(tools) || typeof tools[0] !== "object" || tools[0] === null) {
		throw new Error("Expected first tool in request body");
	}
	return tools[0] as Record<string, unknown>;
}

describe("Anthropic eager tool input streaming compatibility", () => {
	it("sends per-tool eager_input_streaming by default", async () => {
		const request = await captureAnthropicRequest(undefined, createContext());

		expect(getFirstTool(request.body).eager_input_streaming).toBe(true);
		expect(request.headers["anthropic-beta"]).toBeUndefined();
	});

	it("uses the legacy fine-grained tool streaming beta when eager tool input streaming is disabled", async () => {
		const request = await captureAnthropicRequest({ supportsEagerToolInputStreaming: false }, createContext());

		expect(getFirstTool(request.body).eager_input_streaming).toBeUndefined();
		expect(request.headers["anthropic-beta"]).toBe("fine-grained-tool-streaming-2025-05-14");
	});

	it("does not send the legacy fine-grained tool streaming beta when there are no tools", async () => {
		const request = await captureAnthropicRequest({ supportsEagerToolInputStreaming: false }, createContext([]));

		expect(request.body.tools).toBeUndefined();
		expect(request.headers["anthropic-beta"]).toBeUndefined();
	});
});
