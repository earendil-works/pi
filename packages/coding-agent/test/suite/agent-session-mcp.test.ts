import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { SystemMessage, ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createCodemodeTool } from "../../src/core/tools/codemode.ts";
import type { McpExposure, McpServerEntry } from "../../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { createMcpToolName } from "../../src/extensions/mcp/tools.ts";
import { createHarness, type Harness } from "./harness.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const SERVER_TOOLS = [
	{
		name: "search",
		description: "Search the docs.",
		inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		outputSchema: {
			type: "object",
			properties: { hits: { type: "array", items: { type: "string" } } },
			required: ["hits"],
		},
	},
	{ name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
	{ name: "shot", description: "Returns an image.", inputSchema: { type: "object", properties: {} } },
];

/** Minimal MCP server over an in-memory transport. Records the tool calls it receives. */
function createFakeServer(calls: string[]) {
	const pair = createInMemoryTransportPair();
	const respond = (request: JsonRpcRequest): unknown => {
		switch (request.method) {
			case "initialize":
				return {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "docs", version: "1.0.0" },
				};
			case "tools/list":
				return { tools: SERVER_TOOLS };
			case "tools/call": {
				const params = request.params as { name: string; arguments?: { query?: string } };
				calls.push(`${params.name}:${JSON.stringify(params.arguments ?? {})}`);
				if (params.name === "search") {
					const hits = [`${params.arguments?.query} guide`, `${params.arguments?.query} faq`];
					return { content: [{ type: "text", text: hits.join("\n") }], structuredContent: { hits } };
				}
				if (params.name === "shot") {
					return { content: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }] };
				}
				return { content: [{ type: "text", text: "server exploded" }], isError: true };
			}
			default:
				return {};
		}
	};
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		queueMicrotask(() => {
			void pair.server.send({ jsonrpc: "2.0", id: request.id, result: respond(request) });
		});
	});
	return pair;
}

describe("AgentSession MCP integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(exposure: McpExposure) {
		const calls: string[] = [];
		const entry: McpServerEntry = {
			name: "docs",
			config: { url: "http://unused.invalid", exposure },
			source: "test",
		};
		const harness = await createHarness({
			tools: [createCodemodeTool()],
			initialActiveToolNames: [],
			extensionFactories: [
				createMcpExtension({
					loadConfig: () => ({ servers: [entry], errors: [] }),
					createTransport: () => {
						const pair = createFakeServer(calls);
						void pair.server.start();
						return pair.client;
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return { harness, calls };
	}

	function declaredToolNames(harness: Harness): string[] {
		return harness.session.messages
			.filter((message): message is SystemMessage => message.role === "system")
			.flatMap((message) => (message.toolsAdded ?? []).map((tool) => tool.name));
	}

	function toolResult(harness: Harness, toolName: string): ToolResultMessage {
		const result = harness.session.messages.find(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === toolName,
		);
		if (!result) throw new Error(`No ${toolName} tool result`);
		return result;
	}

	function text(message: ToolResultMessage): string {
		return message.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("\n");
	}

	it("exposes codemode-only MCP tools through codemode and hides them from the model", async () => {
		const { harness, calls } = await setup("codemode");
		const searchName = createMcpToolName("docs", "search");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `
							const [a, b] = await Promise.all([
								tools.${searchName}({ query: "mcp" }),
								tools.${searchName}({ query: "pi" }),
							]);
							let failure;
							try { await tools.mcp__docs__fail({}); } catch (error) { failure = error.message; }
							const shot = await tools.mcp__docs__shot({});
							image(shot);
							return { hits: [...a.hits, ...b.hits], failure, shot };
						`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("search the docs");

		// Codemode was activated for the codemode-exposed server; MCP tools are never declared.
		expect(harness.session.getActiveToolNames()).toContain("codemode");
		expect(harness.session.getActiveToolNames()).toContain(searchName);
		expect(declaredToolNames(harness)).toEqual(["codemode"]);
		const codemode = harness.session.agent.state.tools.find((tool) => tool.name === "codemode");
		expect(codemode?.description).toContain(`${searchName}(args: {`);
		expect(codemode?.description).toContain("}): Promise<{\n    hits: string[];\n  }>;");

		const result = toolResult(harness, "codemode");
		expect(result.isError).toBe(false);
		const [json] = text(result).split("\n<image>");
		expect(JSON.parse(json)).toEqual({
			hits: ["mcp guide", "mcp faq", "pi guide", "pi faq"],
			failure: "server exploded",
			shot: "[image:1 image/png]",
		});
		expect(result.content.at(-1)?.type).toBe("image");
		expect(calls).toEqual(['search:{"query":"mcp"}', 'search:{"query":"pi"}', "fail:{}", "shot:{}"]);
	});

	it("rejects direct model calls to codemode-only MCP tools", async () => {
		const { harness, calls } = await setup("codemode");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(createMcpToolName("docs", "search"), { query: "x" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = toolResult(harness, "mcp__docs__search");
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("Tool mcp__docs__search not found");
		expect(calls).toEqual([]);
	});

	it("declares directly exposed MCP tools to the model", async () => {
		const { harness } = await setup("direct");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "direct" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(declaredToolNames(harness)).toEqual(["mcp__docs__search", "mcp__docs__fail", "mcp__docs__shot"]);
		expect(harness.session.getActiveToolNames()).not.toContain("codemode");
		const result = toolResult(harness, "mcp__docs__search");
		expect(text(result)).toBe("direct guide\ndirect faq");
	});
});
