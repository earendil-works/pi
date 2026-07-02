import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Context, Model, Tool } from "../src/types.ts";

interface CapturedRequest {
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

function createModel(baseUrl: string, compat?: Model<"anthropic-messages">["compat"]): Model<"anthropic-messages"> {
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
		compat: { forceAdaptiveThinking: true, ...compat },
	};
}

// Mirrors the core edit tool: strict opt-in, nested object array.
const editLikeTool: Tool = {
	name: "edit",
	description: "Edit a file",
	parameters: Type.Object(
		{
			path: Type.String({ description: "Path to the file" }),
			edits: Type.Array(
				Type.Object(
					{
						oldText: Type.String(),
						newText: Type.String(),
					},
					{ additionalProperties: false },
				),
			),
		},
		{ additionalProperties: false, description: "Targeted replacements" },
	),
	strict: true,
};

// No strict opt-in.
const plainTool: Tool = {
	name: "plain",
	description: "Tool without strict opt-in",
	parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
};

function createContext(tools: Tool[]): Context {
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

function getTools(body: Record<string, unknown>): Record<string, unknown>[] {
	const tools = body.tools;
	if (!Array.isArray(tools)) {
		throw new Error("Expected tools in request body");
	}
	return tools as Record<string, unknown>[];
}

describe("Anthropic strict tool use", () => {
	it("sends strict: true for opted-in tools when the model supports strict tools", async () => {
		const request = await captureAnthropicRequest({ supportsStrictTools: true }, createContext([editLikeTool]));

		const [tool] = getTools(request.body);
		expect(tool.strict).toBe(true);
		const inputSchema = tool.input_schema as Record<string, unknown>;
		expect(inputSchema.additionalProperties).toBe(false);
		expect(inputSchema.required).toEqual(["path", "edits"]);
		const edits = (inputSchema.properties as Record<string, Record<string, unknown>>).edits;
		expect((edits.items as Record<string, unknown>).additionalProperties).toBe(false);
		// Strict schemas are sent as declared, root-level keywords included.
		expect(inputSchema.description).toBe("Targeted replacements");
		// eager_input_streaming is independent of strict and stays on by default
		expect(tool.eager_input_streaming).toBe(true);
	});

	it("does not send strict for tools that did not opt in", async () => {
		const request = await captureAnthropicRequest(
			{ supportsStrictTools: true },
			createContext([plainTool, editLikeTool]),
		);

		const [plain, edit] = getTools(request.body);
		expect(plain.strict).toBeUndefined();
		// Top-level additionalProperties: false is still passed through non-strict.
		expect((plain.input_schema as Record<string, unknown>).additionalProperties).toBe(false);
		expect(edit.strict).toBe(true);
	});

	it("does not send strict when the model does not support strict tools", async () => {
		const request = await captureAnthropicRequest(undefined, createContext([editLikeTool]));

		const [tool] = getTools(request.body);
		expect(tool.strict).toBeUndefined();
	});
});
