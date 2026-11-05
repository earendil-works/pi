// MCP tools as Durable tools (plugins/mcp/tools.ts): pi's names, with the hash suffix for every colliding name whatever
// the order, pi's exposures (code mode only by default, `tool_search` without code mode) with the `mcp_servers` section,
// structured output only for tools with an output schema (error results included), and error results with text.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { CallToolResult } from "@earendil-works/pi-mcp";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import type { McpTool } from "../../plugins/mcp/contract.ts";
import {
	createMcpExtension,
	MCP_SERVERS_SECTION,
	type McpCall,
	type McpReach,
	type ServerTool,
} from "../../plugins/mcp/tools.ts";

const tool = (name: string, extra: Partial<McpTool> = {}): McpTool => ({
	name,
	inputSchema: { type: "object" },
	...extra,
});
const names = (tools: readonly ServerTool[]) =>
	(createMcpExtension(offer(tools), async () => ({ content: [] })).tools ?? []).map(
		(registration) => registration.name,
	);

/** What the worker offers for `tools`: their servers, reached from code mode unless `reach` says otherwise. */
function offer(tools: readonly ServerTool[], reach: McpReach = "codemode") {
	return { servers: [...new Set(tools.map((entry) => entry.server))].sort(), signIn: [], tools, reach };
}

test("tool names: pi's, and every tool of a colliding name gets the hash suffix whatever the order", () => {
	const plain = [
		{ server: "docs", tool: tool("search") },
		{ server: "docs", tool: tool("a-b") },
		{ server: "docs", tool: tool("a_b") },
	];
	const [search, dash, underscore] = names(plain);
	assert.equal(search, "mcp__docs__search");
	assert.match(dash!, /^mcp__docs__a_b_[0-9a-f]{8}$/);
	assert.match(underscore!, /^mcp__docs__a_b_[0-9a-f]{8}$/);
	assert.notEqual(dash, underscore);
	// The other order gives each tool the same name.
	assert.deepEqual(names([...plain].reverse()), [underscore, dash, search]);
	// A new tool that collides with nothing renames nothing; one that collides renames only its rival.
	assert.deepEqual(names([...plain, { server: "docs", tool: tool("fetch") }]), [
		search,
		dash,
		underscore,
		"mcp__docs__fetch",
	]);
	assert.equal(names([{ server: "docs", tool: tool("x-y") }])[0], "mcp__docs__x_y");
	const rivals = names([
		{ server: "docs", tool: tool("search") },
		{ server: "docs", tool: tool("x-y") },
		{ server: "docs", tool: tool("x.y") },
	]);
	assert.equal(rivals[0], "mcp__docs__search");
	assert.match(rivals[1]!, /^mcp__docs__x_y_[0-9a-f]{8}$/);
	assert.match(rivals[2]!, /^mcp__docs__x_y_[0-9a-f]{8}$/);
});

test("tool names: a collision across servers suffixes both tools too", () => {
	const [first, second] = names([
		{ server: "a", tool: tool("b__c") },
		{ server: "a__b", tool: tool("c") },
	]);
	assert.match(first!, /^mcp__a__b__c_[0-9a-f]{8}$/);
	assert.match(second!, /^mcp__a__b__c_[0-9a-f]{8}$/);
	assert.notEqual(first, second);
	assert.equal(names([{ server: "a", tool: tool("b__c") }])[0], "mcp__a__b__c");
});

test("exposure: as pi's default, code mode only, deferred so the codemode section leaves the tools out", async () => {
	const tools = [{ server: "docs", tool: tool("search") }];
	const codemode = createMcpExtension(offer(tools), async () => ({ content: [] }));
	const [scripted] = codemode.tools as ToolRegistration[];
	assert.deepEqual([scripted!.deferred, scripted!.callers], [true, ["tools"]]);
	// Without code mode (pi's fallback), `tool_search` loads them for the model.
	const searched = createMcpExtension(offer(tools, "tool_search"), async () => ({ content: [] }));
	const [loaded] = searched.tools as ToolRegistration[];
	assert.deepEqual([loaded!.deferred, loaded!.callers], [true, undefined]);
});

test("the mcp_servers section names each server's namespace and how its tools are reached, as pi's", async () => {
	const render = async (extension: ReturnType<typeof createMcpExtension>) => {
		const [listing] = extension.sections ?? [];
		assert.equal(listing?.key, MCP_SERVERS_SECTION);
		// The section renders a constant: it reads nothing of its input.
		return listing!.render(undefined as never, BACKGROUND_CONTEXT);
	};
	const tools = [
		{ server: "my-docs", tool: tool("search") },
		{ server: "app", tool: tool("read") },
	];
	assert.equal(
		await render(createMcpExtension(offer(tools), async () => ({ content: [] }))),
		"MCP servers whose tools are not declared to you. Call the tools of `codemode` servers from codemode scripts.\n- mcp__app (codemode)\n- mcp__my_docs (codemode)",
	);
	assert.equal(
		await render(createMcpExtension(offer(tools, "tool_search"), async () => ({ content: [] }))),
		"MCP servers whose tools are not declared to you. Load the tools of `tool_search` servers with `tool_search`.\n- mcp__app (tool_search)\n- mcp__my_docs (tool_search)",
	);
	// A server still connecting has no tools yet, and is listed; without servers there is no section.
	const starting = createMcpExtension({ servers: ["slow"], signIn: [], tools: [], reach: "codemode" }, async () => ({
		content: [],
	}));
	assert.match(String(await render(starting)), /- mcp__slow \(codemode\)$/);
	// A server waiting for a sign-in is listed with the link the user signs in with.
	const locked = createMcpExtension(
		{ servers: ["my-docs"], signIn: ["my-docs"], tools: [], reach: "codemode" },
		async () => ({ content: [] }),
	);
	assert.match(
		String(await render(locked)),
		/- mcp__my_docs \(codemode; needs a sign-in, no tools yet: the user signs in from the MCP panel in p2's sidebar or at \/mcp\/sign-in\/my-docs on p2\)$/,
	);
	assert.deepEqual(createMcpExtension(offer([]), async () => ({ content: [] })).sections, []);
});

/** The registration of `mcpTool` calling a server that answers `result`, and what it was called with. */
function registration(mcpTool: McpTool, result: CallToolResult) {
	const calls: Parameters<McpCall>[0][] = [];
	const call: McpCall = async (request) => {
		calls.push(request);
		return result;
	};
	const [registered] = createMcpExtension(offer([{ server: "docs", tool: mcpTool }]), call)
		.tools as ToolRegistration[];
	// The tool reads only the conversation ID and the reader from the API.
	const api = { conversationId: 1 } as unknown as ToolExecutionApi;
	return { registered: registered!, calls, run: () => registered!.execute({ q: "x" }, api, BACKGROUND_CONTEXT) };
}

test("results: structured output only with an output schema, error results included; errors always have text", async () => {
	const schema = { type: "object", properties: { hits: { type: "number" } } };
	const structured = { content: [{ type: "text" as const, text: "2 hits" }], structuredContent: { hits: 2 } };
	const withSchema = registration(tool("search", { outputSchema: schema }), structured);
	assert.deepEqual(withSchema.registered.structuredOutputSchema, schema);
	assert.deepEqual(await withSchema.run(), {
		output: [{ type: "text", text: "2 hits" }],
		isError: false,
		details: { server: "docs", tool: "search" },
		structuredOutput: { hits: 2 },
	});
	assert.deepEqual(withSchema.calls[0]?.args, { q: "x" });
	assert.equal(withSchema.calls[0]?.tool, "search");
	const withoutSchema = registration(tool("search"), structured);
	assert.equal(withoutSchema.registered.structuredOutputSchema, undefined);
	assert.equal("structuredOutput" in (await withoutSchema.run()), false);
	const failed = registration(tool("search", { outputSchema: schema }), {
		content: [],
		structuredContent: { hits: 0 },
		isError: true,
	});
	const error = await failed.run();
	assert.equal(error.isError, true);
	assert.deepEqual(error.structuredOutput, { hits: 0 });
	// Without content the structured content becomes the text; without either, an error still says so.
	assert.match(JSON.stringify(error.output), /hits/);
	const bare = await registration(tool("search"), { content: [], isError: true }).run();
	assert.deepEqual(bare.output, [{ type: "text", text: "MCP tool docs/search returned an error" }]);
});
