import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel } from "../src/compat.ts";
import type { Model, ProviderResponse } from "../src/types.ts";

const MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

let server: Server | undefined;

afterEach(async () => {
	if (!server) return;
	await new Promise<void>((resolve, reject) => {
		server?.close((error) => (error ? reject(error) : resolve()));
	});
	server = undefined;
});

async function startBedrockResponseServer(): Promise<string> {
	server = createServer((_req, res) => {
		res.writeHead(200, {
			"content-type": "application/vnd.amazon.eventstream",
			"x-bifrost-provider": "bedrock",
			"x-bifrost-resolved-model": MODEL_ID,
			"x-amzn-requestid": "req-123",
		});
		res.end();
	});

	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
	return `http://127.0.0.1:${address.port}`;
}

describe("bedrock response headers", () => {
	it("forwards raw Smithy response headers to onResponse", async () => {
		const baseModel = getModel("amazon-bedrock", MODEL_ID) as Model<"bedrock-converse-stream">;
		const model = { ...baseModel, baseUrl: await startBedrockResponseServer() };
		const responses: ProviderResponse[] = [];

		const result = await streamBedrock(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
			{
				cacheRetention: "none",
				env: { AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1" },
				onResponse: (response) => {
					responses.push(response);
				},
			},
		).result();

		// The fake server intentionally returns an empty event stream; this assertion
		// documents that the header callback still fires before stream consumption.
		expect(result.stopReason).toBe("error");
		expect(responses).toHaveLength(1);
		expect(responses[0].status).toBe(200);
		expect(responses[0].headers["x-amzn-requestid"]).toBe("req-123");
		expect(responses[0].headers["x-bifrost-provider"]).toBe("bedrock");
		expect(responses[0].headers["x-bifrost-resolved-model"]).toBe(MODEL_ID);
	});
});
