import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { SystemMessage, ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import type { McpExposure, McpServerEntry } from "../../src/extensions/mcp/config.ts";
import { createMcpExtension, MCP_SERVERS_SECTION } from "../../src/extensions/mcp/index.ts";
import { createMcpToolName } from "../../src/extensions/mcp/tools.ts";
import { createToolSearchExtension } from "../../src/extensions/tool-search/index.ts";
import { TOOL_SEARCH_DESCRIPTION } from "../../src/extensions/tool-search/tool.ts";
import {
	createHarness,
	createTestUiContext,
	getAssistantTexts,
	getMessageText,
	type Harness,
	getToolResult as toolResult,
} from "./harness.ts";

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
	{
		name: "fail",
		description: "Always fails.",
		inputSchema: { type: "object", properties: {} },
		annotations: { title: "Fail", destructiveHint: true, readOnlyHint: false, idempotentHint: "yes" },
	},
	{ name: "shot", description: "Returns an image.", inputSchema: { type: "object", properties: {} } },
];

/**
 * Minimal MCP server over an in-memory transport. Records the tool calls it receives.
 * `initializeDelayMs` delays the answer to `initialize`; `Infinity` never answers.
 */
function createFakeServer(
	calls: string[],
	options: {
		listTools?: () => unknown[];
		resources?: boolean;
		instructions?: string;
		initializeDelayMs?: number;
	} = {},
) {
	const { listTools = () => SERVER_TOOLS, resources = false, instructions, initializeDelayMs = 0 } = options;
	const pair = createInMemoryTransportPair();
	const respond = (request: JsonRpcRequest): unknown => {
		switch (request.method) {
			case "initialize":
				return {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {}, ...(resources ? { resources: {} } : {}) },
					serverInfo: { name: "docs", version: "1.0.0" },
					...(instructions ? { instructions } : {}),
				};
			case "tools/list":
				return { tools: listTools() };
			case "resources/list":
				return {
					resources: [
						{ uri: "docs://intro", name: "intro", mimeType: "text/markdown", _meta: { x: 1 } },
						// MCP App user interfaces are left out.
						{ uri: "ui://docs/viewer", name: "viewer", mimeType: "text/html;profile=mcp-app" },
					],
				};
			case "resources/templates/list":
				return {
					resourceTemplates: [
						{ uriTemplate: "docs://pages/{slug}", name: "page", icons: [{ src: "data:image/png;base64,AAAA" }] },
					],
				};
			case "resources/read": {
				const { uri } = request.params as { uri: string };
				calls.push(`read:${uri}`);
				return { contents: [{ uri, mimeType: "text/markdown", text: `# ${uri}` }] };
			}
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
		const send = () => void pair.server.send({ jsonrpc: "2.0", id: request.id, result: respond(request) });
		if (request.method !== "initialize" || initializeDelayMs === 0) queueMicrotask(send);
		else if (Number.isFinite(initializeDelayMs)) setTimeout(send, initializeDelayMs);
	});
	return pair;
}

describe("AgentSession MCP integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(
		exposure: McpExposure,
		listTools?: () => unknown[],
		options: {
			autoEnableCodemode?: boolean;
			builtInTools?: string[];
			extensionFactories?: ExtensionFactory[];
			toolExposure?: Record<string, McpExposure>;
			resources?: boolean;
			withoutToolSearch?: boolean;
			description?: string;
			instructions?: string;
		} = {},
	) {
		const {
			builtInTools,
			extensionFactories = [],
			toolExposure,
			resources,
			withoutToolSearch,
			description,
			instructions,
			...configOptions
		} = options;
		const calls: string[] = [];
		const notifications: string[] = [];
		const servers: ReturnType<typeof createFakeServer>["server"][] = [];
		const entry: McpServerEntry = {
			name: "docs",
			config: {
				url: "http://unused.invalid",
				exposure,
				...(toolExposure ? { toolExposure } : {}),
				...(description ? { description } : {}),
			},
			source: "test",
		};
		// `builtInTools` are the built-in tools active at the start. The MCP extension activates codemode
		// or tool_search.
		const harness = await createHarness({
			initialActiveToolNames: builtInTools ?? [],
			extensionFactories: [
				...extensionFactories,
				createCodemodeExtension(),
				...(withoutToolSearch ? [] : [createToolSearchExtension()]),
				createMcpExtension({
					loadConfig: () => ({ servers: [entry], errors: [], ...configOptions }),
					createTransport: () => {
						const pair = createFakeServer(calls, { listTools, resources, instructions });
						servers.push(pair.server);
						void pair.server.start();
						return pair.client;
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
		});
		// The first prompt waits only for servers with direct tools; wait for the others here.
		await vi.waitFor(() =>
			expect(harness.session.getAllTools().some((tool) => tool.name === "mcp__docs__search")).toBe(true),
		);
		return { harness, calls, servers, notifications };
	}

	function declaredToolNames(harness: Harness): string[] {
		return harness.session.messages
			.filter((message): message is SystemMessage => message.role === "system")
			.flatMap((message) => (message.toolsAdded ?? []).map((tool) => tool.name));
	}

	/** The `mcp_servers` prompt section as the model currently has it. */
	function serversSection(harness: Harness): string | null | undefined {
		let section: string | null | undefined;
		for (const message of harness.session.messages) {
			if (message.role === "system" && message.sections && MCP_SERVERS_SECTION in message.sections) {
				section = message.sections[MCP_SERVERS_SECTION];
			}
		}
		return section;
	}

	function nestedToolNames(harness: Harness): string[] {
		return harness.session.getCallableToolNames();
	}

	it("exposes codemode-only MCP tools through codemode and hides them from the model", async () => {
		const { harness, calls } = await setup("codemode");
		const searchName = createMcpToolName("docs", "search");
		// MCP tools resolve to their CallToolResult, errors included.
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `
							const [a, b] = await Promise.allSettled([
								tools.${searchName}({ query: "mcp" }),
								tools.${searchName}({ query: "pi" }),
							]);
							const failure = await tools.mcp__docs__fail({});
							const shot = await tools.mcp__docs__shot({});
							image(shot.content[0]);
							text(JSON.stringify({
								hits: [...a.value.structuredContent.hits, ...b.value.structuredContent.hits],
								failed: failure.isError,
								failure: failure.content[0].text,
								found: ALL_TOOLS.filter((tool) => tool.name.includes("search")).map((tool) => tool.name),
							}));
						`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("search the docs");

		// Exec was activated for the codemode-exposed server; MCP tools are never declared.
		expect(harness.session.getActiveToolNames()).toEqual(["codemode"]);
		expect(declaredToolNames(harness)).toEqual(["codemode"]);
		expect(nestedToolNames(harness)).toEqual([searchName, "mcp__docs__fail", "mcp__docs__shot"]);
		// The description lists neither the server nor its tools; scripts search for them.
		const codemode = harness.session.agent.state.tools.find((tool) => tool.name === "codemode");
		expect(codemode?.description).not.toContain("mcp__docs");
		expect(codemode?.description).not.toContain("Shared MCP Types:");

		const result = toolResult(harness, "codemode");
		expect(result.isError).toBe(false);
		// Output items keep the order the script produced them in.
		expect(result.content[1]).toEqual({ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
		expect(JSON.parse((result.content[2] as { text: string }).text)).toEqual({
			hits: ["mcp guide", "mcp faq", "pi guide", "pi faq"],
			failed: true,
			failure: "server exploded",
			found: [searchName],
		});
		expect(result.content).toHaveLength(3);
		expect(calls).toEqual(['search:{"query":"mcp"}', 'search:{"query":"pi"}', "fail:{}", "shot:{}"]);
	});

	it("keeps codemode-only MCP tools callable across tree navigation", async () => {
		const { harness } = await setup("codemode");
		const searchName = createMcpToolName("docs", "search");
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		expect(harness.session.getActiveToolNames()).toEqual(["codemode"]);
		expect(nestedToolNames(harness)).toContain(searchName);

		const firstAssistant = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!firstAssistant) throw new Error("No assistant entry");
		await harness.session.navigateTree(firstAssistant.id);

		expect(harness.session.getActiveToolNames()).toEqual(["codemode"]);
		expect(nestedToolNames(harness)).toContain(searchName);
	});

	// Regression: #10239.
	it.each([false, true])("routes tools whose names differ only in - and _ (reverse: %s)", async (reverse) => {
		const tools = [
			{ name: "read-file", description: "dashed", inputSchema: { type: "object", properties: {} } },
			{ name: "read_file", description: "underscored", inputSchema: { type: "object", properties: {} } },
		];
		if (reverse) tools.reverse();
		const { harness, calls } = await setup("codemode", () => [...tools, ...SERVER_TOOLS]);
		const code = `for (const query of ["dashed", "underscored"]) await tools[(await searchTools(query))[0].name]({});`;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(calls).toEqual(["read-file:{}", "read_file:{}"]);
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
		expect(getMessageText(result)).toBe("Tool mcp__docs__search not found");
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
		// Boolean annotation hints are passed on for permission extensions.
		const annotations = new Map(harness.session.getAllTools().map((tool) => [tool.name, tool.annotations]));
		expect(annotations.get("mcp__docs__fail")).toEqual({ destructiveHint: true, readOnlyHint: false });
		expect(annotations.get("mcp__docs__search")).toBeUndefined();
		const result = toolResult(harness, "mcp__docs__search");
		expect(getMessageText(result)).toBe("direct guide\ndirect faq");
	});

	it.each(["direct", "codemode"] as const)(
		"withdraws and restores %s MCP tools the server changes",
		async (exposure) => {
			let tools = SERVER_TOOLS;
			const { harness, servers } = await setup(exposure, () => tools);
			harness.setResponses([fauxAssistantMessage("ready")]);
			await harness.session.prompt("start");
			// Direct tools are declared to the model, codemode tools are only callable from codemode.
			const reachable = () =>
				exposure === "direct" ? harness.session.getActiveToolNames() : nestedToolNames(harness);
			const listChanged = async () => {
				await servers[0].send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
				await new Promise((resolve) => setTimeout(resolve, 10));
			};
			expect(reachable()).toContain("mcp__docs__fail");

			tools = SERVER_TOOLS.filter((tool) => tool.name !== "fail");
			await listChanged();
			expect(reachable()).not.toContain("mcp__docs__fail");
			expect(reachable()).toContain("mcp__docs__search");
			const codemode = harness.session.agent.state.tools.find((tool) => tool.name === "codemode");
			expect(codemode?.description ?? "").not.toContain("mcp__docs__fail");

			tools = SERVER_TOOLS;
			await listChanged();
			expect(reachable()).toContain("mcp__docs__fail");
		},
	);

	it("lists and reads resources with Codex's resource tools", async () => {
		const { harness, calls } = await setup("direct", undefined, { resources: true });
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("list_mcp_resources", {}),
					fauxToolCall("list_mcp_resource_templates", { server: "docs" }),
					fauxToolCall("read_mcp_resource", { server: "docs", uri: "docs://pages/setup" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("read_mcp_resource", { server: "nope", uri: "docs://x" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read");

		// The resource tools take the exposure of the servers they reach.
		expect(harness.session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]),
		);
		expect(JSON.parse(getMessageText(toolResult(harness, "list_mcp_resources")))).toEqual({
			resources: [{ server: "docs", uri: "docs://intro", name: "intro", mimeType: "text/markdown" }],
		});
		expect(JSON.parse(getMessageText(toolResult(harness, "list_mcp_resource_templates")))).toEqual({
			server: "docs",
			resourceTemplates: [{ server: "docs", uriTemplate: "docs://pages/{slug}", name: "page" }],
		});
		const results = harness.session.messages.filter(
			(message): message is ToolResultMessage =>
				message.role === "toolResult" && message.toolName === "read_mcp_resource",
		);
		expect(getMessageText(results[0])).toBe("# docs://pages/setup");
		expect(results[1].isError).toBe(true);
		expect(getMessageText(results[1])).toBe('MCP server "nope" has no resources. Servers with resources: docs');
		expect(calls).toEqual(["read:docs://pages/setup"]);
		const annotations = harness.session.getAllTools().find((tool) => tool.name === "read_mcp_resource");
		expect(annotations?.annotations).toEqual({ readOnlyHint: true });
	});

	it("makes the resource tools callable from codemode for codemode servers", async () => {
		const { harness, calls } = await setup("codemode", undefined, { resources: true });
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `const listed = await tools.list_mcp_resources({ server: "docs" });
const read = await tools.read_mcp_resource({ server: "docs", uri: listed.resources[0].uri });
return { uris: listed.resources.map((r) => r.uri), text: read.contents[0].text };`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read");

		expect(harness.session.getActiveToolNames()).toEqual(["codemode"]);
		expect(JSON.parse(getMessageText(toolResult(harness, "codemode")).split("\n").at(-1) ?? "")).toEqual({
			uris: ["docs://intro"],
			text: "# docs://intro",
		});
		expect(calls).toEqual(["read:docs://intro"]);
	});

	it("applies per-tool exposure overrides", async () => {
		const { harness } = await setup("hidden", undefined, { toolExposure: { search: "direct", "s*": "codemode" } });
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		// `search` is declared, `shot` is only callable from codemode, `fail` keeps the server's `hidden`.
		expect(declaredToolNames(harness)).toEqual(["codemode", "mcp__docs__search"]);
		expect(nestedToolNames(harness)).toEqual(["mcp__docs__search", "mcp__docs__shot"]);
		const codemode = harness.session.agent.state.tools.find((tool) => tool.name === "codemode");
		expect(codemode?.description).not.toContain("mcp__docs__shot");
		expect(codemode?.description).not.toContain("mcp__docs__fail");
	});

	it("describes the server with its configured description and returns its instructions to scripts", async () => {
		const { harness } = await setup("codemode", undefined, {
			description: "Search the product docs",
			instructions: "Always search before reading.",
			builtInTools: ["tool_search"],
		});
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `const docs = await describeNamespace("mcp__docs");
const aliases = await Promise.all(["docs", "mcp__docs"].map((name) => describeNamespace(name)));
return { docs, sameForAliases: aliases.every((alias) => JSON.stringify(alias) === JSON.stringify(docs)), none: await describeNamespace("mcp__nope") };`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		// The instructions stay out of every tool description.
		const description = (name: string) =>
			harness.session.agent.state.tools.find((tool) => tool.name === name)?.description ?? "";
		expect(description("codemode")).not.toContain("mcp__docs");
		expect(description("tool_search")).toBe(TOOL_SEARCH_DESCRIPTION);
		for (const name of ["codemode", "tool_search"]) expect(description(name)).not.toContain("Always search");
		expect(JSON.parse(getMessageText(toolResult(harness, "codemode")).split("\n").at(-1) ?? "")).toEqual({
			docs: {
				name: "mcp__docs",
				description: "Search the product docs",
				instructions: "Always search before reading.",
				tools: ["mcp__docs__search", "mcp__docs__fail", "mcp__docs__shot"],
			},
			sameForAliases: true,
		});
		// The system prompt lists the server with its configured description rather than its instructions.
		expect(serversSection(harness)).toContain("- mcp__docs (codemode): Search the product docs");
	});

	it("lists servers by the first line of their instructions without a configured description", async () => {
		const { harness } = await setup("deferred", undefined, { instructions: "Docs search.\nLong guidance." });
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("go");

		const section = serversSection(harness);
		expect(section).toContain("- mcp__docs (tool_search): Docs search.\n");
		expect(section).not.toContain("Long guidance");
	});

	it("does not activate codemode when autoEnableCodemode is false", async () => {
		const { harness, notifications } = await setup("codemode", undefined, { autoEnableCodemode: false });
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		expect(harness.session.getActiveToolNames()).toEqual([]);
		expect(nestedToolNames(harness)).toContain("mcp__docs__search");
		expect(notifications).toEqual([
			"MCP tools are only reachable from the codemode or tool_search tool, but neither is active (autoEnableCodemode is false); they cannot be called.",
		]);
	});

	it("treats codemode MCP tools as reachable through an active tool_search", async () => {
		const { harness, notifications } = await setup("codemode", undefined, {
			autoEnableCodemode: false,
			builtInTools: ["tool_search"],
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "search the docs", limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "loaded" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");

		expect(harness.session.getActiveToolNames()).toEqual(["tool_search", "mcp__docs__search"]);
		expect(getMessageText(toolResult(harness, "mcp__docs__search"))).toBe("loaded guide\nloaded faq");
		expect(notifications).toEqual([]);
	});

	it("reaches deferred MCP tools through codemode when tool_search is not available", async () => {
		const { harness, notifications } = await setup("deferred", undefined, {
			builtInTools: ["codemode"],
			withoutToolSearch: true,
		});
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		expect(harness.session.getActiveToolNames()).toEqual(["codemode"]);
		expect(nestedToolNames(harness)).toContain("mcp__docs__search");
		expect(notifications).toEqual([]);
	});

	it("warns when deferred MCP tools have neither tool_search nor codemode", async () => {
		const { harness, notifications } = await setup("deferred", undefined, { withoutToolSearch: true });
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		expect(harness.session.getActiveToolNames()).toEqual([]);
		expect(notifications).toEqual([
			"MCP tools are only reachable from the codemode or tool_search tool, but neither is active; they cannot be called.",
		]);
	});

	it("does not activate another extension's tool named codemode", async () => {
		// Registered first, so it wins over the codemode extension's codemode.
		const otherExec: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "codemode",
				label: "codemode",
				description: "Another extension's codemode tool.",
				parameters: Type.Object({}),
				defaultActive: false,
				execute: async () => ({ content: [], details: undefined }),
			});
		};
		const { harness } = await setup("codemode", undefined, { extensionFactories: [otherExec] });
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		expect(harness.session.getActiveToolNames()).toEqual([]);
	});

	/** A server named `slow` whose answer to `initialize` takes `initializeDelayMs`, without waiting for it. */
	async function setupSlow(
		config: {
			exposure?: McpExposure;
			toolExposure?: Record<string, McpExposure>;
			name?: string;
			instructions?: string;
		},
		initializeDelayMs: number,
		startupWaitMs?: number,
	) {
		const calls: string[] = [];
		const notifications: string[] = [];
		const { name = "slow", instructions, ...serverConfig } = config;
		const entry: McpServerEntry = { name, config: { url: "http://unused.invalid", ...serverConfig }, source: "test" };
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				createCodemodeExtension(),
				createToolSearchExtension(),
				createMcpExtension({
					loadConfig: () => ({ servers: [entry], errors: [] }),
					createTransport: () => {
						const pair = createFakeServer(calls, { initializeDelayMs, instructions });
						void pair.server.start();
						return pair.client;
					},
					...(startupWaitMs === undefined ? {} : { startupWaitMs }),
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
		});
		return { harness, calls, notifications };
	}

	it("does not hold the first prompt for codemode servers that are still connecting", async () => {
		// The server never answers `initialize`.
		const { harness } = await setupSlow({}, Number.POSITIVE_INFINITY);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		expect(getAssistantTexts(harness)).toEqual(["ready"]);
		// Codemode is activated from the config, before the server connects.
		expect(declaredToolNames(harness)).toEqual(["codemode"]);
	});

	it("keeps the codemode description unchanged when the server connects", async () => {
		const { harness } = await setupSlow({}, 20);
		const description = () => harness.session.agent.state.tools.find((tool) => tool.name === "codemode")?.description;
		const before = description();
		expect(before).toBeDefined();
		await vi.waitFor(() => expect(harness.session.getCallableToolNames()).toContain("mcp__slow__search"));
		expect(description()).toBe(before);
	});

	it("lists a server before it connects and appends its summary with the next prompt", async () => {
		const { harness } = await setupSlow({ instructions: "Slow docs.\nMore." }, 30);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);

		await harness.session.prompt("first");
		await vi.waitFor(() => expect(harness.session.getCallableToolNames()).toContain("mcp__slow__search"));
		await harness.session.prompt("second");

		const systemMessages = harness.session.messages.filter(
			(message): message is SystemMessage => message.role === "system",
		);
		// The first request lists the server by name; its summary follows as an appended patch.
		expect(systemMessages).toHaveLength(2);
		expect(systemMessages[0].sections?.[MCP_SERVERS_SECTION]).toContain("- mcp__slow (codemode)\n");
		expect(systemMessages[1].sections).toEqual({
			[MCP_SERVERS_SECTION]: expect.stringContaining("- mcp__slow (codemode): Slow docs."),
		});
		expect(harness.session.messages.indexOf(systemMessages[1])).toBeGreaterThan(
			harness.session.messages.findIndex((message) => message.role === "assistant"),
		);
	});

	it("waits for servers with direct tools before listing the servers", async () => {
		const { harness } = await setupSlow(
			{ exposure: "direct", toolExposure: { shot: "codemode" }, instructions: "Slow docs." },
			30,
		);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		expect(serversSection(harness)).toContain("- mcp__slow (codemode): Slow docs.");
	});

	it("leaves servers with only direct tools out of the servers section", async () => {
		const { harness } = await setupSlow({ exposure: "direct" }, 0);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		expect(serversSection(harness)).toBeUndefined();
	});

	it("waits for the servers a codemode script names", async () => {
		const { harness, calls } = await setupSlow({}, 30);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `return (await tools.mcp__slow__search({ query: "q" })).structuredContent;`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = toolResult(harness, "codemode");
		expect(result.isError).toBe(false);
		expect(JSON.parse(getMessageText(result).split("\n").at(-1) ?? "")).toEqual({ hits: ["q guide", "q faq"] });
		expect(calls).toEqual(['search:{"query":"q"}']);
	});

	it("waits for servers whose script identifiers differ from their names", async () => {
		const { harness, calls } = await setupSlow({ name: "slow-docs" }, 30);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `await tools.mcp__slow_docs__search({ query: "q" }); return (await describeNamespace("slow_docs")).name;`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(toolResult(harness, "codemode").isError).toBe(false);
		expect(getMessageText(toolResult(harness, "codemode")).split("\n").at(-1)).toBe("mcp__slow_docs");
		expect(calls).toEqual(['search:{"query":"q"}']);
	});

	it("does not wait for servers a codemode script does not name", async () => {
		const { harness } = await setupSlow({}, Number.POSITIVE_INFINITY);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code: "return 1 + 1;" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(getMessageText(toolResult(harness, "codemode")).split("\n").at(-1)).toBe("2");
	});

	it("waits for servers before tool_search searches", async () => {
		const { harness } = await setupSlow({ exposure: "deferred" }, 30);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "search the docs", limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("mcp__slow__search", { query: "late" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(getMessageText(toolResult(harness, "mcp__slow__search"))).toBe("late guide\nlate faq");
	});

	it("holds the first prompt for servers with direct tools", async () => {
		const { harness } = await setupSlow({ exposure: "direct" }, 30);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		expect(declaredToolNames(harness)).toContain("mcp__slow__search");
	});

	it("holds the first prompt for servers with direct tools only up to startupWaitMs", async () => {
		const { harness, notifications } = await setupSlow({ exposure: "direct" }, Number.POSITIVE_INFINITY, 20);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		expect(getAssistantTexts(harness)).toEqual(["ready"]);
		expect(harness.session.getActiveToolNames()).toEqual([]);
		expect(notifications).toEqual(["MCP servers are still connecting; their tools become available once connected."]);
	});

	it("does not let codemode call itself or inactive direct tools", async () => {
		const { harness } = await setup("direct");
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");
		harness.session.setActiveToolsByName(["codemode", "mcp__docs__search"]);

		expect(nestedToolNames(harness)).toEqual(["mcp__docs__search"]);
	});

	it("finds tools from scripts with searchTools() and describeTool()", async () => {
		const { harness, calls } = await setup("codemode");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `
							const [match] = await searchTools("search the docs", { limit: 1 });
							const none = await searchTools("docs", { namespace: "mcp__other" });
							const declaration = await describeTool(match.name);
							const result = await tools[match.name]({ query: "found" });
							text(JSON.stringify({
								name: match.name,
								sameAsAllTools: ALL_TOOLS.find((tool) => tool.name === match.name).description === match.description,
								none: none.length,
								declared: declaration.includes("codemode tool declaration:"),
								missing: (await describeTool("nope")) === undefined,
								hits: result.structuredContent.hits,
							}));
						`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = toolResult(harness, "codemode");
		expect(result.isError).toBe(false);
		expect(JSON.parse((result.content[1] as { text: string }).text)).toEqual({
			name: "mcp__docs__search",
			sameAsAllTools: true,
			none: 0,
			declared: true,
			missing: true,
			hits: ["found guide", "found faq"],
		});
		expect(calls).toEqual(['search:{"query":"found"}']);
	});

	it("activates tool_search for deferred MCP tools and keeps loaded tools declared on the branch", async () => {
		// No built-in tools are active; the MCP extension activates tool_search, not codemode.
		const { harness, calls } = await setup("deferred");
		const searchName = createMcpToolName("docs", "search");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "search the docs", limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall(searchName, { query: "loaded" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("find a docs tool");

		expect(harness.session.getActiveToolNames()).toEqual(["tool_search", searchName]);
		// The description does not depend on the connected servers.
		const toolSearch = harness.session.agent.state.tools.find((tool) => tool.name === "tool_search");
		expect(toolSearch?.description).toBe(TOOL_SEARCH_DESCRIPTION);

		const search = toolResult(harness, "tool_search");
		expect(getMessageText(search)).toBe(
			`Loaded 1 tool. They are available from your next call:\n- ${searchName}: Search the docs.`,
		);
		// Only the loaded tool is added; earlier declarations are not repeated.
		const loadMessages = harness.session.messages.filter(
			(message): message is SystemMessage =>
				message.role === "system" && (message.toolsAdded ?? []).some((tool) => tool.name === searchName),
		);
		expect(loadMessages).toHaveLength(1);
		expect(loadMessages[0].toolsAdded?.map((tool) => tool.name)).toEqual([searchName]);
		expect(getMessageText(toolResult(harness, searchName))).toBe("loaded guide\nloaded faq");
		expect(calls).toEqual(['search:{"query":"loaded"}']);

		// Loads are recorded in the transcript: navigating back before the load drops the tool,
		// navigating to a later entry restores it.
		const branch = harness.sessionManager.getBranch();
		const firstUser = branch.find((entry) => entry.type === "message" && entry.message.role === "user");
		const last = branch.at(-1);
		if (!firstUser || !last) throw new Error("Missing entries");
		await harness.session.navigateTree(firstUser.id);
		expect(harness.session.getActiveToolNames()).not.toContain(searchName);
		await harness.session.navigateTree(last.id);
		expect(harness.session.getActiveToolNames()).toContain(searchName);
	});

	it("finds nothing to load when every matching tool is already declared", async () => {
		const { harness } = await setup("direct", undefined, { builtInTools: ["tool_search"] });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "docs" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(getMessageText(toolResult(harness, "tool_search"))).toBe("No matching tools found.");
	});
});

describe("AgentSession MCP servers registered by extensions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** `configured` are the mcp.json servers; `plugins` register servers through the extension API. */
	async function setup(plugins: ExtensionFactory | ExtensionFactory[], configured: McpServerEntry[] = []) {
		const connected: McpServerEntry[] = [];
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				...(Array.isArray(plugins) ? plugins : [plugins]),
				createCodemodeExtension(),
				createMcpExtension({
					loadConfig: () => ({ servers: configured, errors: [] }),
					createTransport: (entry) => {
						connected.push(entry);
						const pair = createFakeServer([]);
						void pair.server.start();
						return pair.client;
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return { harness, connected };
	}

	it("connects servers registered while extensions load", async () => {
		const { harness, connected } = await setup((pi) => {
			pi.registerMcpServer("plugin", { url: "http://plugin.invalid", exposure: "direct" });
		});
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		expect(connected.map((entry) => [entry.name, entry.scope])).toEqual([["plugin", "extension"]]);
		expect(harness.session.getActiveToolNames()).toContain("mcp__plugin__search");
	});

	it("connects and disconnects servers registered during the session", async () => {
		let api: ExtensionAPI | undefined;
		const { harness, connected } = await setup((pi) => {
			api = pi;
		});
		if (!api) throw new Error("No extension API");
		const pi = api;

		pi.registerMcpServer("late", { url: "http://late.invalid" });
		await vi.waitFor(() => expect(harness.session.getCallableToolNames()).toContain("mcp__late__search"));
		expect(connected.map((entry) => entry.name)).toEqual(["late"]);
		// Codemode-exposed tools need the codemode tool, which is activated for them.
		expect(harness.session.getActiveToolNames()).toContain("codemode");

		pi.unregisterMcpServer("late");
		await vi.waitFor(() => expect(harness.session.getCallableToolNames()).not.toContain("mcp__late__search"));
	});

	// "my_docs" shares the namespace of "my-docs" (#10239).
	it.each(["my-docs", "my_docs"])("prefers the mcp.json server over a registered %s", async (name) => {
		const configured: McpServerEntry = {
			name: "my-docs",
			config: { url: "http://config.invalid" },
			source: "mcp.json",
		};
		const { connected } = await setup(
			(pi) => {
				pi.registerMcpServer(name, { url: "http://plugin.invalid" });
			},
			[configured],
		);
		await vi.waitFor(() => expect(connected).toEqual([configured]));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(connected).toEqual([configured]);
	});

	it("rejects names another extension registered", async () => {
		const errors: string[] = [];
		await setup([
			(pi) => {
				pi.registerMcpServer("taken", { url: "http://x.invalid" });
				// Registering again replaces the extension's own registration.
				pi.registerMcpServer("taken", { url: "http://y.invalid" });
				pi.registerMcpServer("my-server", { url: "http://x.invalid" });
			},
			(pi) => {
				for (const name of ["taken", "my_server"]) {
					try {
						pi.registerMcpServer(name, { url: "http://z.invalid" });
					} catch (caught) {
						errors.push(String(caught));
					}
				}
			},
		]);
		expect(errors).toEqual([
			expect.stringMatching(/MCP server "taken" is already registered by extension/),
			// Names that differ only in - and _ share a namespace (#10239).
			'Error: MCP server "my_server" conflicts with registered server "my-server"',
		]);
	});

	it("reports registered servers when no extension connects them", async () => {
		const harness = await createHarness({
			extensionFactories: [(pi) => pi.registerMcpServer("orphan", { url: "http://orphan.invalid" })],
		});
		harnesses.push(harness);
		const errors: string[] = [];
		await harness.session.bindExtensions({ onError: (error) => errors.push(error.error) });

		expect(errors).toEqual([expect.stringContaining('MCP server "orphan" is registered, but no loaded extension')]);
	});
});
