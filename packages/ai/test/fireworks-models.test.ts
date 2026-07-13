import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel, getModels } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import type { Context, Model, Tool } from "../src/types.ts";

const originalFireworksApiKey = process.env.FIREWORKS_API_KEY;

afterEach(() => {
	if (originalFireworksApiKey === undefined) {
		delete process.env.FIREWORKS_API_KEY;
	} else {
		process.env.FIREWORKS_API_KEY = originalFireworksApiKey;
	}
});

describe("Fireworks models", () => {
	it("registers the default Kimi K2.6 model via Anthropic-compatible Messages API", () => {
		const model = getModel("fireworks", "accounts/fireworks/models/kimi-k2p6");

		expect(model).toBeDefined();
		expect(model.api).toBe("anthropic-messages");
		expect(model.provider).toBe("fireworks");
		expect(model.baseUrl).toBe("https://api.fireworks.ai/inference");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(262000);
		expect(model.maxTokens).toBe(262000);
		expect(model.cost).toEqual({
			input: 0.95,
			output: 4,
			cacheRead: 0.16,
			cacheWrite: 0,
		});
	});

	it("registers the Fire Pass turbo router model", () => {
		const model = getModels("fireworks").find(
			(candidate) => candidate.id.startsWith("accounts/fireworks/routers/") && candidate.id.endsWith("-turbo"),
		);

		expect(model).toBeDefined();
		expect(model?.api).toBe("anthropic-messages");
		expect(model?.baseUrl).toBe("https://api.fireworks.ai/inference");
		expect(model?.input).toEqual(["text", "image"]);
	});

	it("aligns GLM 5.2 Fast with GLM 5.2's OpenAI-compatible config", () => {
		const base = getModel("fireworks", "accounts/fireworks/models/glm-5p2");
		const fast = getModel("fireworks", "accounts/fireworks/routers/glm-5p2-fast");

		expect(fast.api).toBe(base.api);
		expect(fast.baseUrl).toBe(base.baseUrl);
		expect(fast.compat).toEqual(base.compat);
		expect(fast.thinkingLevelMap).toEqual(base.thinkingLevelMap);
	});

	it("resolves FIREWORKS_API_KEY from the environment", () => {
		process.env.FIREWORKS_API_KEY = "test-fireworks-key";

		expect(findEnvKeys("fireworks")).toEqual(["FIREWORKS_API_KEY"]);
		expect(getEnvApiKey("fireworks")).toBe("test-fireworks-key");
	});

	it("sets Fireworks-specific compat for session affinity and unsupported tool fields", () => {
		const model = getModel("fireworks", "accounts/fireworks/models/kimi-k2p6");

		expect(model.compat).toBeDefined();
		expect(model.compat?.sendSessionAffinityHeaders).toBe(true);
		expect(model.compat?.supportsEagerToolInputStreaming).toBe(false);
		expect(model.compat?.supportsCacheControlOnTools).toBe(false);
		expect(model.compat?.supportsLongCacheRetention).toBe(false);
	});
});

// --- Integration tests for Fireworks Anthropic session affinity and tool compat ---

interface CapturedRequest {
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

const tool: Tool = {
	name: "lookup",
	description: "Look up a value",
	parameters: Type.Object({ value: Type.String() }),
};

const FIREWORKS_ANTHROPIC_COMPAT = {
	sendSessionAffinityHeaders: true,
	supportsEagerToolInputStreaming: false,
	supportsCacheControlOnTools: false,
	supportsLongCacheRetention: false,
} satisfies NonNullable<Model<"anthropic-messages">["compat"]>;

function createFireworksModel(
	compat: Model<"anthropic-messages">["compat"] = FIREWORKS_ANTHROPIC_COMPAT,
): Model<"anthropic-messages"> {
	return {
		id: "accounts/fireworks/models/kimi-k2p6",
		name: "Kimi K2.6",
		api: "anthropic-messages",
		provider: "fireworks",
		baseUrl: "http://127.0.0.1:0", // overridden by captureAnthropicRequest
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
		contextWindow: 262000,
		maxTokens: 262000,
		compat,
	};
}

function createAnthropicModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "http://127.0.0.1:0", // overridden by captureAnthropicRequest
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

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
	model: Model<"anthropic-messages">,
	context: Context,
	options?: { sessionId?: string; cacheRetention?: string },
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
		// Override the model's baseUrl to point to the local test server
		const localModel = { ...model, baseUrl: `http://127.0.0.1:${address.port}` };

		const stream = streamAnthropic(localModel, context, {
			apiKey: "test-key",
			cacheRetention: (options?.cacheRetention as "none" | "short" | "long") ?? "short",
			sessionId: options?.sessionId,
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

function getTools(body: Record<string, unknown>): Record<string, unknown>[] {
	const tools = body.tools;
	if (!Array.isArray(tools)) {
		throw new Error("Expected tools in request body");
	}
	return tools as Record<string, unknown>[];
}

describe("Fireworks Anthropic session affinity and tool compat", () => {
	it("sends x-session-affinity header for Fireworks models", async () => {
		const model = createFireworksModel();
		// Need a real port, capture will assign one
		const request = await captureAnthropicRequest(model, createContext(), {
			sessionId: "fireworks-session-1",
		});

		expect(request.headers["x-session-affinity"]).toBe("fireworks-session-1");
	});

	it("omits x-session-affinity header for native Anthropic models", async () => {
		const model = createAnthropicModel();
		const request = await captureAnthropicRequest(model, createContext(), {
			sessionId: "anthropic-session-1",
		});

		expect(request.headers["x-session-affinity"]).toBeUndefined();
	});

	it("omits x-session-affinity header when cacheRetention is none", async () => {
		const model = createFireworksModel();
		const request = await captureAnthropicRequest(model, createContext(), {
			sessionId: "fireworks-session-2",
			cacheRetention: "none",
		});

		expect(request.headers["x-session-affinity"]).toBeUndefined();
	});

	it("omits cache_control on tools for Fireworks models", async () => {
		const model = createFireworksModel();
		const request = await captureAnthropicRequest(model, createContext());

		const tools = getTools(request.body);
		const lastTool = tools[tools.length - 1];
		expect(lastTool.cache_control).toBeUndefined();
	});

	it("omits eager_input_streaming on tools for Fireworks models", async () => {
		const model = createFireworksModel();
		const request = await captureAnthropicRequest(model, createContext());

		const tools = getTools(request.body);
		for (const t of tools) {
			expect(t.eager_input_streaming).toBeUndefined();
		}
	});

	it("sends cache_control on tools for native Anthropic models", async () => {
		const model = createAnthropicModel();
		const request = await captureAnthropicRequest(model, createContext());

		const tools = getTools(request.body);
		const lastTool = tools[tools.length - 1];
		expect(lastTool.cache_control).toBeDefined();
		expect((lastTool.cache_control as { type: string }).type).toBe("ephemeral");
	});

	it("sends eager_input_streaming on tools for native Anthropic models", async () => {
		const model = createAnthropicModel();
		const request = await captureAnthropicRequest(model, createContext());

		const tools = getTools(request.body);
		expect(tools[0].eager_input_streaming).toBe(true);
	});
});
