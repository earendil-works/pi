// MCP tools as Durable tools (plugins/mcp/tools.ts): pi's names, with the hash suffix for every colliding name whatever
// the order, structured output only for tools with an output schema (error results included), and error results with
// text.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { CallToolResult } from "@earendil-works/pi-mcp";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import type { McpTool } from "../../plugins/mcp/contract.ts";
import { createMcpExtension, type McpCall, type ServerTool } from "../../plugins/mcp/tools.ts";

const tool = (name: string, extra: Partial<McpTool> = {}): McpTool => ({
	name,
	inputSchema: { type: "object" },
	...extra,
});
const names = (tools: readonly ServerTool[]) =>
	(createMcpExtension(tools, async () => ({ content: [] })).tools ?? []).map((registration) => registration.name);

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

/** The registration of `mcpTool` calling a server that answers `result`, and what it was called with. */
function registration(mcpTool: McpTool, result: CallToolResult) {
	const calls: Parameters<McpCall>[0][] = [];
	const call: McpCall = async (request) => {
		calls.push(request);
		return result;
	};
	const [registered] = createMcpExtension([{ server: "docs", tool: mcpTool }], call).tools as ToolRegistration[];
	// The tool reads only the conversation ID and the reader from the API.
	const api = { conversationId: 1 } as unknown as ToolExecutionApi;
	return { registered: registered!, calls, run: () => registered!.execute({ q: "x" }, api, BACKGROUND_CONTEXT) };
}

test("results: structured output only with an output schema, error results included; errors always have text", async () => {
	const schema = { type: "object", properties: { hits: { type: "number" } } };
	const structured = { content: [{ type: "text" as const, text: "2 hits" }], structuredContent: { hits: 2 } };
	const withSchema = registration(tool("search", { outputSchema: schema }), structured);
	assert.deepEqual(withSchema.registered.structuredOutputSchema, schema);
	assert.equal(withSchema.registered.deferred, true);
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
