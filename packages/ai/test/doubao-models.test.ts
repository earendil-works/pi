import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { stream as streamOpenAI } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { builtinProviders } from "../src/providers/all.ts";
import type { Context } from "../src/types.ts";

const originalArkApiKey = process.env.ARK_API_KEY;
const originalArkModelId = process.env.ARK_MODEL_ID;

afterEach(() => {
	if (originalArkApiKey === undefined) {
		delete process.env.ARK_API_KEY;
	} else {
		process.env.ARK_API_KEY = originalArkApiKey;
	}
	if (originalArkModelId === undefined) {
		delete process.env.ARK_MODEL_ID;
	} else {
		process.env.ARK_MODEL_ID = originalArkModelId;
	}
});

describe("Doubao models", () => {
	it("registers Doubao as a built-in provider factory", () => {
		const provider = builtinProviders().find((candidate) => candidate.id === "doubao");

		expect(provider).toBeDefined();
		expect(provider?.name).toBe("Doubao");
		expect(provider?.getModels().map((model) => model.id)).toContain("doubao");
	});

	it("registers a stable Ark model alias via OpenAI-compatible Chat Completions API", () => {
		const model = getModel("doubao", "doubao");

		expect(model).toBeDefined();
		expect(model.id).toBe("doubao");
		expect(model.name).toBe("Doubao (ARK_MODEL_ID)");
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("doubao");
		expect(model.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/v3");
		expect(model.reasoning).toBe(false);
		expect(model.input).toEqual(["text"]);
		expect(model.contextWindow).toBe(128000);
		expect(model.maxTokens).toBe(16000);
		expect(model.compat).toEqual({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
			supportsLongCacheRetention: false,
		});
	});

	it("requires ARK_API_KEY and ARK_MODEL_ID from the environment", () => {
		process.env.ARK_API_KEY = "test-ark-key";
		delete process.env.ARK_MODEL_ID;

		expect(findEnvKeys("doubao")).toBeUndefined();
		expect(getEnvApiKey("doubao")).toBeUndefined();

		process.env.ARK_MODEL_ID = "test-ark-model";

		expect(findEnvKeys("doubao")).toEqual(["ARK_API_KEY", "ARK_MODEL_ID"]);
		expect(getEnvApiKey("doubao")).toBe("test-ark-key");
	});

	it("sends ARK_MODEL_ID as the provider request model", async () => {
		const captured = await captureDoubaoRequestBody();

		expect(captured.model).toBe("ep-test-model");
	});
});

const context: Context = {
	messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
};

async function captureDoubaoRequestBody(): Promise<Record<string, unknown>> {
	let capturedBody: Record<string, unknown> | undefined;
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk.toString();
		});
		req.on("end", () => {
			capturedBody = JSON.parse(body);
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n');
			res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	try {
		const model = {
			...getModel("doubao", "doubao"),
			baseUrl: `http://127.0.0.1:${port}/v1`,
		};
		await streamOpenAI(model, context, {
			apiKey: "test-key",
			env: { ARK_MODEL_ID: "ep-test-model" },
		}).result();
		if (!capturedBody) {
			throw new Error("No request body captured");
		}
		return capturedBody;
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}
