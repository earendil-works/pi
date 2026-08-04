import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Context, Model, Tool } from "../src/types.ts";

/**
 * Non-strict tools must keep `$defs` in `input_schema`.
 *
 * The non-strict projection rebuilds the schema from `type`/`properties`/
 * `required`. `properties` routinely contains `$ref: "#/$defs/…"` pointers —
 * any generator that factors shared shapes into `$defs` (zod, for one)
 * produces them — so dropping `$defs` sends Anthropic a schema with dangling
 * references, and the model free-forms the referenced shapes.
 */

function createModel(baseUrl: string): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		api: "anthropic-messages",
		provider: "test-anthropic",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

const parametersWithDefs = {
	$defs: {
		item: {
			properties: { name: { type: "string" } },
			required: ["name"],
			type: "object",
		},
	},
	additionalProperties: false,
	properties: {
		item: { $ref: "#/$defs/item" },
	},
	required: ["item"],
	type: "object",
} as unknown as Tool["parameters"];

const tool: Tool = {
	name: "lookup",
	description: "Look up a value",
	parameters: parametersWithDefs,
};

const context: Context = {
	messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }],
	tools: [tool],
};

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

async function captureAnthropicRequestBody(): Promise<Record<string, unknown>> {
	let capturedBody: Record<string, unknown> | undefined;

	const server = createServer(async (request, response) => {
		capturedBody = await readRequestBody(request);
		writeEmptySseResponse(response);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;

	try {
		const stream = streamAnthropic(createModel(`http://127.0.0.1:${address.port}`), context, {
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

	if (!capturedBody) {
		throw new Error("Anthropic request was not captured");
	}
	return capturedBody;
}

function getFirstToolInputSchema(body: Record<string, unknown>): Record<string, unknown> {
	const tools = body.tools;
	if (!Array.isArray(tools) || typeof tools[0] !== "object" || tools[0] === null) {
		throw new Error("Expected first tool in request body");
	}
	const inputSchema = (tools[0] as Record<string, unknown>).input_schema;
	if (typeof inputSchema !== "object" || inputSchema === null || Array.isArray(inputSchema)) {
		throw new Error("Expected first tool input schema in request body");
	}
	return inputSchema as Record<string, unknown>;
}

describe("Anthropic non-strict tool schemas", () => {
	it("keeps $defs referenced from properties in the outbound input_schema", async () => {
		const inputSchema = getFirstToolInputSchema(await captureAnthropicRequestBody());

		expect(inputSchema.$defs).toEqual({
			item: {
				properties: { name: { type: "string" } },
				required: ["name"],
				type: "object",
			},
		});
		expect(inputSchema.properties).toEqual({ item: { $ref: "#/$defs/item" } });
		expect(inputSchema.required).toEqual(["item"]);
		expect(inputSchema.type).toBe("object");
	});
});
