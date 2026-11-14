// MCP tools as Durable tools (plugins/mcp/tools.ts): pi's names, with the hash suffix for every colliding name whatever
// the order; pi's exposures (code mode only by default, `tool_search` without code mode); one composing extension whose
// wraps give each conversation the servers its location's lease uses, each with its namespace, pi's one-line summary
// and instructions; variants of one tool at two locations, the session's with the plain name; calls only as the variant
// the caller's instance describes; the `mcp_servers` section per conversation without code mode; structured output only
// for tools with an output schema (error results included); and error results with text.
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	Agent,
	ConversationId,
	Extension,
	PromptSection,
	ToolExecutionApi,
	ToolRegistration,
} from "@earendil-works/pi-durable";
import type { CallToolResult } from "@earendil-works/pi-mcp";
import { BACKGROUND_CONTEXT, type Location } from "@p2/app/v1";
import type { P2Tool } from "@p2/app/v1/worker";
import type { Instance, McpTool, SessionLease } from "../../plugins/mcp/contract.ts";
import {
	createMcpExtension,
	type McpCall,
	type McpLocate,
	type McpReach,
	offeredInstances,
} from "../../plugins/mcp/tools.ts";

type ServerTool = { readonly server: string; readonly tool: McpTool };

const tool = (name: string, extra: Partial<McpTool> = {}): McpTool => ({
	name,
	inputSchema: { type: "object" },
	...extra,
});
const noCall: McpCall = async () => ({ content: [] });
/** Where the session works, and a subagent's own location. */
const HERE: Location = { env: null, cwd: "/repo" };
const THERE: Location = { env: "gpu", cwd: "/work" };
/** Conversation 1 works HERE, every other one THERE. */
const locate: McpLocate = async (conversationId) => (conversationId === 1 ? HERE : THERE);

/** An instance as the manager lists it: connected, its ID from its server unless `extra` says otherwise. */
const instance = (server: string, extra: Partial<Instance> = {}): Instance => ({
	id: `id-${server}`,
	server,
	source: "owner",
	location: null,
	runsOn: "host",
	status: "connected",
	tools: [],
	...extra,
});

/** The MCP extension for `instances`, each used by the leases of `leases` (default: one lease HERE using them all). */
const extensionOf = (
	instances: readonly Instance[],
	{
		leases = [{ location: HERE, instances: instances.map((each) => each.id) }],
		reach = "codemode",
		call = noCall,
	}: { leases?: SessionLease[]; reach?: McpReach; call?: McpCall } = {},
) => createMcpExtension({ instances: offeredInstances(instances), leases, session: HERE, reach }, call, locate);

/** The instances of `tools`: one per server. */
const instancesOf = (tools: readonly ServerTool[]): Instance[] =>
	[...new Set(tools.map((entry) => entry.server))].map((server) =>
		instance(server, { tools: tools.filter((entry) => entry.server === server).map((entry) => entry.tool) }),
	);

/** The registration of each of `tools`, in order. */
const registrations = (tools: readonly ServerTool[], reach: McpReach = "codemode"): ToolRegistration[] => {
	const registered = extensionOf(instancesOf(tools), { reach }).tools ?? [];
	return tools.map(
		(entry) =>
			registered.find((each) => each.description === `MCP tool ${entry.tool.name} from server ${entry.server}`)!,
	);
};
const names = (tools: readonly ServerTool[]) => registrations(tools).map((registration) => registration.name);

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

test("exposure: as pi's default, code mode only, deferred so the codemode section leaves the tools out", () => {
	const tools = [{ server: "docs", tool: tool("search") }];
	const [scripted] = registrations(tools);
	assert.deepEqual([scripted!.deferred, scripted!.callers], [true, ["tools"]]);
	// Without code mode (pi's fallback), `tool_search` loads them for the model.
	const [loaded] = registrations(tools, "tool_search");
	assert.deepEqual([loaded!.deferred, loaded!.callers], [true, undefined]);
});

/** An agent selecting `extension` and another extension with the tool `read`, its tools callable and deferred. */
function agentWith(extension: Extension<P2Tool>): Agent<P2Tool> {
	const read: P2Tool = {
		name: "read",
		description: "read",
		parameters: { type: "object" },
		execute: async () => ({ output: [] }),
	};
	const tools = [...(extension.tools ?? []), read];
	return {
		thinkingLevel: "off",
		extensions: [{ name: "coding", tools: [read] }, extension],
		tools: [read],
		callable: tools,
		deferred: extension.tools ?? [],
		sections: [],
	};
}

/** What the wrapped `codemode` section shows conversation `conversationId`: its namespaces and its callable tools. */
async function sectionView(extension: Extension<P2Tool>, conversationId: number) {
	const base: PromptSection<P2Tool> = {
		key: "codemode",
		render: ({ agent }) =>
			JSON.stringify({
				namespaces: agent.extensions.flatMap((each) => (each.namespace ? [each.namespace] : [])),
				grouped: agent.extensions.flatMap((each) =>
					each.namespace ? [[each.namespace.name, (each.tools ?? []).map((one) => one.name)]] : [],
				),
				callable: agent.callable.map((one) => one.name),
			}),
	};
	const wrap = extension.wraps!.find((each) => "section" in each && each.section === "codemode")!;
	const wrapped = "section" in wrap ? wrap.wrap(base) : base;
	const input = {
		conversationId: conversationId as ConversationId,
		agent: agentWith(extension),
		env: undefined,
		shown: {},
		read: undefined as never,
	};
	return JSON.parse((await wrapped.render(input, BACKGROUND_CONTEXT)) as string) as {
		namespaces: { name: string; description: string; instructions?: string }[];
		grouped: [string, string[]][];
		callable: string[];
	};
}

test("namespaces: each server's own, with pi's summary, then where the tools are", async () => {
	const extension = extensionOf([
		instance("app", { tools: [tool("read")], instructions: "Read before you write.\nNever write twice." }),
		instance("my-docs", { auth: "oauth", tools: [tool("search")], description: " Searches the docs. " }),
		instance("long", { description: "x".repeat(300) }),
		instance("slow", { status: "starting" }),
	]);
	assert.equal(extension.name, "mcp");
	assert.equal(extension.namespace, undefined);
	const { namespaces, grouped } = await sectionView(extension, 1);
	assert.deepEqual(
		namespaces.map((namespace) => namespace.name),
		["mcp__app", "mcp__long", "mcp__my_docs", "mcp__slow"],
	);
	// Without a configured description, the first line of the server's instructions; all of them on demand.
	assert.deepEqual(namespaces[0], {
		name: "mcp__app",
		description: 'Read before you write.\nTools of the MCP server "app" (find them with searchTools()).',
		instructions: "Read before you write.\nNever write twice.",
	});
	// As in pi, a summary is cut at 250 characters.
	assert.equal(namespaces[1]!.description.split("\n")[0], `${"x".repeat(249)}…`);
	// The configured description wins; an OAuth server says how the user signs in, signed in or not.
	assert.match(namespaces[2]!.description, /^Searches the docs\.\nTools of the MCP server "my-docs"/);
	assert.match(
		namespaces[2]!.description,
		/sign in from the MCP panel in p2's sidebar or at \/mcp\/sign-in\/my-docs on p2/,
	);
	// A server still connecting has its namespace, without tools or summary yet.
	assert.deepEqual(namespaces[3], {
		name: "mcp__slow",
		description: 'Tools of the MCP server "slow" (find them with searchTools()).',
	});
	assert.deepEqual(grouped, [
		["mcp__app", ["mcp__app__read"]],
		["mcp__long", []],
		["mcp__my_docs", ["mcp__my_docs__search"]],
		["mcp__slow", []],
	]);
	// Without instances, nothing: no tools and no wraps.
	assert.deepEqual(extensionOf([]), { name: "mcp" });
});

test("each conversation sees the servers of its location's lease; the session's variants keep the plain names", async () => {
	// The session's project and a subagent's define `docs` differently; `lint` exists only where the subagent works;
	// `radius` (shared) both leases use.
	const docsHere = instance("docs", {
		id: "here",
		location: HERE,
		tools: [tool("search", { description: "api" }), tool("index")],
		description: "API docs.",
	});
	const docsThere = instance("docs", {
		id: "there",
		location: THERE,
		tools: [tool("search", { description: "web" }), tool("embed")],
		description: "Web docs.",
	});
	const lint = instance("lint", { location: THERE, tools: [tool("check")] });
	const radius = instance("radius", { tools: [tool("search")] });
	const extension = extensionOf([docsHere, docsThere, lint, radius], {
		leases: [
			{ location: HERE, instances: ["here", "id-radius"] },
			{ location: THERE, instances: ["there", "id-lint", "id-radius"] },
		],
	});
	const main = await sectionView(extension, 1);
	const subagent = await sectionView(extension, 2);
	assert.deepEqual(main.grouped, [
		["mcp__docs", ["mcp__docs__search", "mcp__docs__index"]],
		["mcp__radius", ["mcp__radius__search"]],
	]);
	assert.match(main.namespaces[0]!.description, /^API docs\./);
	// The subagent's `search` differs from the session's: its variant gets a suffix; `embed` and `lint` keep theirs.
	const [docs, lintSeen, radiusSeen] = subagent.grouped;
	assert.equal(docs![0], "mcp__docs");
	assert.match(docs![1][0]!, /^mcp__docs__search_[0-9a-f]{8}$/);
	assert.deepEqual(docs![1].slice(1), ["mcp__docs__embed"]);
	assert.deepEqual(lintSeen, ["mcp__lint", ["mcp__lint__check"]]);
	assert.deepEqual(radiusSeen, ["mcp__radius", ["mcp__radius__search"]]);
	assert.match(subagent.namespaces[0]!.description, /^Web docs\./);
	// Other tools stay; another location's MCP tools are not callable.
	assert.ok(main.callable.includes("read") && subagent.callable.includes("read"));
	assert.ok(!main.callable.includes("mcp__lint__check") && !main.callable.includes("mcp__docs__embed"));
	assert.ok(!subagent.callable.includes("mcp__docs__index") && !subagent.callable.includes("mcp__docs__search"));
	// The same tool described alike at both locations is one registration with the plain name.
	const same = extensionOf(
		[
			instance("files", { id: "a", location: HERE, tools: [tool("read")] }),
			instance("files", { id: "b", location: THERE, tools: [tool("read")] }),
		],
		{
			leases: [
				{ location: HERE, instances: ["a"] },
				{ location: THERE, instances: ["b"] },
			],
		},
	);
	assert.deepEqual(
		same.tools?.map((each) => each.name),
		["mcp__files__read"],
	);
	// A conversation whose location has no lease yet sees no MCP servers.
	const unleased = extensionOf([radius], { leases: [] });
	assert.deepEqual((await sectionView(unleased, 1)).namespaces, []);
});

test("the codemode and tool_search tools run with the conversation's view; everything else of the api stays", async () => {
	const extension = extensionOf(
		[
			instance("docs", { location: HERE, tools: [tool("search")] }),
			instance("lint", { location: THERE, tools: [tool("check")] }),
		],
		{
			leases: [
				{ location: HERE, instances: ["id-docs"] },
				{ location: THERE, instances: ["id-lint"] },
			],
		},
	);
	const targets = extension.wraps!.flatMap((each) => ("tool" in each ? [each.tool] : []));
	assert.deepEqual(targets, ["codemode", "tool_search"]);
	const wrap = extension.wraps!.find((each) => "tool" in each && each.tool === "codemode")!;
	const seen: { agent: Agent; models: unknown; marked: unknown }[] = [];
	const marker = Symbol("marker");
	const base: P2Tool = {
		name: "codemode",
		description: "code mode",
		parameters: { type: "object" },
		execute: async (_args, api, context) => {
			seen.push({ agent: await api.agent(context), models: api.models, marked: (api as never)[marker] });
			return { output: [] };
		},
	};
	const wrapped = "tool" in wrap ? wrap.wrap(base) : base;
	const agent = agentWith(extension) as unknown as Agent;
	let reads = 0;
	const api = {
		conversationId: 2 as ConversationId,
		agent: async () => agent,
		get models() {
			reads++;
			return "models";
		},
		[marker]: "kept",
	} as unknown as ToolExecutionApi;
	await wrapped.execute({}, api, BACKGROUND_CONTEXT);
	const [{ agent: viewed, models, marked }] = seen as [(typeof seen)[number]];
	assert.deepEqual(
		viewed.callable.map((each) => each.name),
		["mcp__lint__check", "read"],
	);
	assert.deepEqual(
		viewed.deferred.map((each) => each.name),
		["mcp__lint__check"],
	);
	// The getter is read when the base reads it, not when the api is copied.
	assert.deepEqual([models, marked, reads], ["models", "kept", 1]);
});

test("a call goes to the caller's location, and only as the variant its instance describes", async () => {
	const calls: Parameters<McpCall>[0][] = [];
	const call: McpCall = async (request) => {
		calls.push(request);
		return { content: [{ type: "text", text: "ok" }] };
	};
	const extension = extensionOf(
		[
			instance("docs", { id: "here", location: HERE, tools: [tool("search", { description: "api" })] }),
			instance("docs", { id: "there", location: THERE, tools: [tool("search", { description: "web" })] }),
		],
		{
			leases: [
				{ location: HERE, instances: ["here"] },
				{ location: THERE, instances: ["there"] },
			],
			call,
		},
	);
	const plain = extension.tools!.find((each) => each.name === "mcp__docs__search")!;
	const variant = extension.tools!.find((each) => each.name !== "mcp__docs__search")!;
	const api = (conversationId: number) => ({ conversationId }) as unknown as ToolExecutionApi;
	await plain.execute({ q: "x" }, api(1), BACKGROUND_CONTEXT);
	assert.deepEqual(calls, [{ location: HERE, server: "docs", tool: "search", args: { q: "x" } }]);
	await variant.execute({ q: "y" }, api(2), BACKGROUND_CONTEXT);
	assert.deepEqual(calls[1], { location: THERE, server: "docs", tool: "search", args: { q: "y" } });
	// The session's variant called from where the other variant runs: refused before the server is asked.
	await assert.rejects(
		() => plain.execute({ q: "z" }, api(2), BACKGROUND_CONTEXT),
		/MCP tool mcp__docs__search is not offered at gpu:\/work: find the tools there with searchTools\(\)/,
	);
	assert.equal(calls.length, 2);
});

test("without code mode, the mcp_servers section lists the conversation's servers with their summaries", async () => {
	const instances = [
		instance("docs", { location: HERE, description: "API docs." }),
		instance("lint", { location: THERE }),
		instance("radius", { instructions: "Web search.\nMore." }),
	];
	const leases = [
		{ location: HERE, instances: ["id-docs", "id-radius"] },
		{ location: THERE, instances: ["id-lint", "id-radius"] },
	];
	assert.equal(extensionOf(instances, { leases }).sections, undefined);
	const servers = extensionOf(instances, { leases, reach: "tool_search" }).sections![0]!;
	assert.equal(servers.key, "mcp_servers");
	const render = (conversationId: number) =>
		servers.render(
			{ conversationId: conversationId as ConversationId, read: undefined } as never,
			BACKGROUND_CONTEXT,
		);
	const intro =
		"MCP servers whose tools are not declared to you. Load the tools of `tool_search` servers with `tool_search`.";
	assert.equal(
		await render(1),
		[intro, "- mcp__docs (tool_search): API docs.", "- mcp__radius (tool_search): Web search."].join("\n"),
	);
	assert.equal(
		await render(2),
		[intro, "- mcp__lint (tool_search)", "- mcp__radius (tool_search): Web search."].join("\n"),
	);
});

/** The registration of `mcpTool` calling a server that answers `result`, and what it was called with. */
function registration(mcpTool: McpTool, result: CallToolResult) {
	const calls: Parameters<McpCall>[0][] = [];
	const call: McpCall = async (request) => {
		calls.push(request);
		return result;
	};
	const [registered] = extensionOf([instance("docs", { tools: [mcpTool] })], { call }).tools as ToolRegistration[];
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
