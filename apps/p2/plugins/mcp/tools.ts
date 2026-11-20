// MCP tools as Durable tools, exposed as pi exposes them by default: one tool per tool of the session's servers, named as
// pi names them (`mcp__<server>__<tool>`), callable only from code mode scripts (or loaded through `tool_search` while
// code mode is off), calling the server's instance where the calling conversation works.
//
// Durable gives every conversation of a session the same tools, while a server may have an instance per location (an
// owner's stdio server run per location, a project's server) and a project may turn an owner's server on or off where
// it is. So the MCP plugin contributes one composing extension, `mcp`:
// - it registers every variant of every tool of the session's instances: a variant is a tool as one instance describes
//   it (`toolDescriptor`); instances that describe a tool alike share its registration;
// - its wraps give each conversation the view of the servers its location's lease uses: the `codemode` section, a
//   script's tools and namespaces (`searchTools()`, `describeNamespace()`), and `tool_search`'s candidates are cut to
//   them, each server with its own namespace (`mcp__<server>`), summary and instructions; a server another location
//   has, and a variant another location's instance describes, are not there;
// - a call goes to the instance where the calling conversation works, and only as the variant that instance describes.
// The model learns of a server as in pi: its namespace in the `codemode` section with a one-line summary (the
// configured `description`, else the first line of the server's instructions), or, without code mode, a line in the
// `mcp_servers` section; the full instructions come from `describeNamespace()`.

import { createHash } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord/json";
import {
	type Agent,
	type ConversationId,
	type DocumentReader,
	defineExtension,
	type Extension,
	type PromptSection,
	section,
	type ToolExecutionApi,
	type ToolNamespace,
	type ToolRegistration,
	type Wrap,
	wrapSection,
} from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import { TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";
import {
	type CallToolResult,
	createMcpToolName,
	limitMcpContent,
	mcpNamespace,
	mcpServerSummary,
	normalizeMcpInputSchema,
	toLlmContent,
} from "@earendil-works/pi-mcp";
import { type Context, type Location, locationText, sameLocation } from "@p2/app/v1";
import type { P2Tool } from "@p2/app/v1/worker";
import { type Instance, type McpTool, type SessionLease, signInLink } from "./contract.ts";

/**
 * How the model reaches MCP tools, as pi's exposures: `codemode` (pi's default) from code mode scripts, which find them
 * with `searchTools()`; `tool_search` (pi's `deferred`, its fallback without code mode) by loading them with
 * `tool_search`, then calling them directly.
 */
export type McpReach = "codemode" | "tool_search";

/**
 * One of the session's instances as the extension offers it: its ID and server, whether it signs in with OAuth (its
 * namespace says how the user signs in), its one-line summary (empty: none), its instructions from `initialize`, and its
 * tools. Its status is left out: a status change changes nothing the model sees.
 */
export type OfferedInstance = {
	readonly id: string;
	readonly server: string;
	readonly oauth: boolean;
	readonly summary: string;
	readonly instructions?: string;
	readonly tools: readonly McpTool[];
};

/**
 * What the MCP extension offers: the session's instances, its leases (which instances each location uses), where the
 * session works (whose variants keep the plain names), and how the model reaches the tools.
 */
export type McpOffer = {
	readonly instances: readonly OfferedInstance[];
	readonly leases: readonly SessionLease[];
	readonly session: Location;
	readonly reach: McpReach;
};

/** A call of `server`'s `tool` at `location`, through the instance the lease there uses. */
export type McpCall = (
	request: {
		readonly location: Location;
		readonly server: string;
		readonly tool: string;
		readonly args: Record<string, unknown>;
	},
	context: Context,
) => Promise<CallToolResult>;

/** Where conversation `conversationId` works (its documents read through `read`). */
export type McpLocate = (conversationId: ConversationId, read: DocumentReader, context: Context) => Promise<Location>;

/** The name of the MCP extension. */
export const MCP_EXTENSION = "mcp";

/** The MCP extension without instances: nothing to offer, nothing to cut. */
export const EMPTY_MCP_EXTENSION: Extension<P2Tool> = defineExtension<P2Tool>({ name: MCP_EXTENSION });

/** The longest summary a server's namespace or `mcp_servers` line shows, as in pi. */
const MAX_SUMMARY_CHARS = 250;

/** The session's instances as the extension offers them, by server name, then ID. */
export function offeredInstances(instances: readonly Instance[]): OfferedInstance[] {
	return [...instances]
		.sort((a, b) => order(a.server, b.server) || order(a.id, b.id))
		.map((instance) => ({
			id: instance.id,
			server: instance.server,
			oauth: instance.auth === "oauth",
			summary: summaryOf(instance),
			...(instance.instructions === undefined ? {} : { instructions: instance.instructions }),
			tools: instance.tools,
		}));
}

/** The instance's summary as pi shows it: its first line, at most `MAX_SUMMARY_CHARS` characters. */
function summaryOf(instance: Instance): string {
	const characters = [...mcpServerSummary(instance.description, instance.instructions)];
	if (characters.length <= MAX_SUMMARY_CHARS) return characters.join("");
	return `${characters
		.slice(0, MAX_SUMMARY_CHARS - 1)
		.join("")
		.trimEnd()}…`;
}

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A tool's descriptor: a hash of what the model reads of it and what checks its arguments and results (title,
 * description, input and output schemas). Two instances whose tool has the same name and descriptor offer one variant.
 */
export function toolDescriptor(tool: McpTool): string {
	const described = [
		tool.title ?? null,
		tool.annotations?.title ?? null,
		tool.description ?? null,
		tool.inputSchema,
		tool.outputSchema ?? null,
	];
	return createHash("sha256").update(JSON.stringify(described)).digest("hex").slice(0, 16);
}

/**
 * The MCP extension for `offer`: every variant's registration, each calling through `call` at the calling
 * conversation's location (`locate`), and the wraps that cut what each conversation sees to its location's view; without
 * code mode, also the `mcp_servers` section, rendered per conversation. Without instances, an extension with nothing.
 */
export function createMcpExtension(offer: McpOffer, call: McpCall, locate: McpLocate): Extension<P2Tool> {
	if (offer.instances.length === 0) return EMPTY_MCP_EXTENSION;
	const variants = toolVariants(offer);
	const registrations = new Map(
		[...variants].map(([key, variant]) => [key, toolRegistration(variant, offer, call, locate)] as const),
	);
	const views = locationViews(offer, variants);
	const all = new Set([...variants.values()].map((variant) => variant.name));
	const viewOf = async (conversationId: ConversationId, read: DocumentReader, context: Context): Promise<View> => {
		const here = await locate(conversationId, read, context);
		return views.find((leased) => sameLocation(leased.location, here))?.view ?? NO_VIEW;
	};
	return defineExtension<P2Tool>({
		name: MCP_EXTENSION,
		tools: [...registrations.values()],
		wraps: viewWraps(all, viewOf),
		...(offer.reach === "tool_search" ? { sections: [serversSection(viewOf)] } : {}),
	});
}

/** One variant of a tool: its server, the tool as one instance lists it, its descriptor, and the name it is called by. */
type Variant = { readonly server: string; readonly tool: McpTool; readonly descriptor: string; readonly name: string };

/** A variant's key: its server, tool name and descriptor. */
const variantKey = (server: string, tool: McpTool): string => JSON.stringify([server, tool.name, toolDescriptor(tool)]);

/**
 * Every variant of `offer`'s tools, by `variantKey`, with its name. As in pi, a tool gets `mcp__<server>__<tool>`,
 * sanitized, and every tool whose name sanitizes to another tool's (of any server) gets pi's hash suffix, so no name
 * depends on the order of the list. Several variants of one tool: the one the lease where the session works uses keeps
 * the plain name (the main conversation's names do not change when a subagent works elsewhere), every other gets a
 * suffix from its descriptor; without one there, they all do.
 */
function toolVariants(offer: McpOffer): ReadonlyMap<string, Variant> {
	const groups = new Map<string, Map<string, Omit<Variant, "name">>>();
	for (const { server, tools } of offer.instances)
		for (const tool of tools) {
			const plain = createMcpToolName(server, tool.name);
			const group = groups.get(plain) ?? new Map<string, Omit<Variant, "name">>();
			groups.set(plain, group);
			group.set(variantKey(server, tool), { server, tool, descriptor: toolDescriptor(tool) });
		}
	const home = sessionVariants(offer);
	const variants = new Map<string, Variant>();
	for (const [plain, group] of groups) {
		const entries = [...group.values()];
		// Tools of several servers or names share the plain name once sanitized: pi suffixes them all.
		const clash = new Set(entries.map(({ server, tool }) => JSON.stringify([server, tool.name]))).size > 1;
		const homeKeys = [...group.keys()].filter((key) => home.has(key));
		for (const [key, entry] of group) {
			const siblings = entries.filter(
				(other) => other.server === entry.server && other.tool.name === entry.tool.name,
			).length;
			const keepsPlain = siblings === 1 || (homeKeys.length === 1 && homeKeys[0] === key);
			const name =
				siblings > 1 && !(keepsPlain && !clash)
					? variantName(entry.server, entry.tool.name, entry.descriptor)
					: clash
						? createMcpToolName(entry.server, entry.tool.name, () => true)
						: plain;
			variants.set(key, { ...entry, name });
		}
	}
	return variants;
}

/** The variant keys of the instances the lease where the session works uses. */
function sessionVariants(offer: McpOffer): ReadonlySet<string> {
	const lease = offer.leases.find((candidate) => sameLocation(candidate.location, offer.session));
	const used = new Set(lease?.instances ?? []);
	return new Set(
		offer.instances
			.filter((instance) => used.has(instance.id))
			.flatMap((instance) => instance.tools.map((tool) => variantKey(instance.server, tool))),
	);
}

/** Provider tool names are limited to 64 characters, as pi-mcp's names are. */
const MAX_TOOL_NAME_LENGTH = 64;

/** The name of a variant that does not keep the plain name: pi's sanitized name with a hash of the variant. */
function variantName(server: string, tool: string, descriptor: string): string {
	const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
	const hash = createHash("sha256").update(`${server}\0${tool}\0${descriptor}`).digest("hex").slice(0, 8);
	return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

/**
 * What a conversation at one location sees: the servers its lease uses, each with its namespace and the names of its
 * tools' variants, all those names, and the `mcp_servers` lines.
 */
type View = {
	readonly servers: readonly {
		readonly server: string;
		readonly namespace: ToolNamespace;
		readonly tools: ReadonlySet<string>;
	}[];
	readonly visible: ReadonlySet<string>;
	readonly lines: readonly string[];
};

/** The view of a conversation whose location has no lease yet: no servers. */
const NO_VIEW: View = { servers: [], visible: new Set(), lines: [] };

/** The view at each lease's location. */
function locationViews(
	offer: McpOffer,
	variants: ReadonlyMap<string, Variant>,
): readonly { readonly location: Location; readonly view: View }[] {
	const byId = new Map(offer.instances.map((instance) => [instance.id, instance]));
	return offer.leases.map(({ location, instances }) => {
		const used = instances
			.flatMap((id) => byId.get(id) ?? [])
			.sort((a, b) => order(a.server, b.server) || order(a.id, b.id));
		const servers = used.map((instance) => ({
			server: instance.server,
			namespace: namespaceOf(instance),
			// Every tool of an instance has its variant: `toolVariants` named them all.
			tools: new Set(instance.tools.map((tool) => variants.get(variantKey(instance.server, tool))!.name)),
		}));
		const lines = used.map((instance) => {
			const head = `- ${mcpNamespace(instance.server)} (tool_search)`;
			return instance.summary ? `${head}: ${instance.summary}` : head;
		});
		return { location, view: { servers, visible: new Set(servers.flatMap((server) => [...server.tools])), lines } };
	});
}

/**
 * An instance's namespace: its server's name, and a description with its summary, then where its tools are; an OAuth
 * server also says how the user signs in, which its tools wait for. Signing in changes nothing here; the summary changes
 * once when a server without a configured `description` first sends its instructions.
 */
function namespaceOf(instance: OfferedInstance): ToolNamespace {
	const tools = `Tools of the MCP server "${instance.server}" (find them with searchTools()).`;
	const signIn = instance.oauth
		? ` It needs the user's sign-in: if it has no tools, ask the user to sign in from the MCP panel in p2's sidebar or at ${signInLink(instance.server)} on p2.`
		: "";
	return {
		name: mcpNamespace(instance.server),
		description: instance.summary ? `${instance.summary}\n${tools}${signIn}` : `${tools}${signIn}`,
		...(instance.instructions === undefined ? {} : { instructions: instance.instructions }),
	};
}

/**
 * The wraps that show code mode and `tool_search` the conversation's view (`viewOf`): the `codemode` section renders
 * with it; the `codemode` and `tool_search` tools run with an `api` whose `agent()` is cut to it, so a script's tools
 * and namespaces (kept in its start data for replays) and `tool_search`'s candidates are. Wraps that target a tool or
 * section that is not there do nothing.
 */
function viewWraps(
	all: ReadonlySet<string>,
	viewOf: (conversationId: ConversationId, read: DocumentReader, context: Context) => Promise<View>,
): Wrap<P2Tool>[] {
	const tool = (name: string): Wrap<P2Tool> => ({
		tool: name,
		wrap: (base: P2Tool): P2Tool => ({
			...base,
			execute: (args, api, context) =>
				base.execute(
					args,
					withAgent(api, async (inner) =>
						viewAgent(await api.agent(inner), await viewOf(api.conversationId, api, inner), all),
					),
					context,
				),
		}),
	});
	return [
		wrapSection<P2Tool>("codemode", (base) => ({
			...base,
			render: async (input, context) =>
				base.render(
					{
						...input,
						agent: viewAgent(input.agent, await viewOf(input.conversationId, input.read, context), all),
					},
					context,
				),
		})),
		tool(CODEMODE_TOOL_NAME),
		tool(TOOL_SEARCH_TOOL_NAME),
	];
}

/**
 * `agent` as a conversation with `view` sees it: MCP tools only of its view, and in place of the MCP extension one
 * extension per server of the view, with its namespace and those of its tools the agent has (code mode reads nothing
 * else of an extension).
 */
function viewAgent<Tool extends ToolRegistration>(
	agent: Agent<Tool>,
	view: View,
	all: ReadonlySet<string>,
): Agent<Tool> {
	const keep = (tool: Tool) => !all.has(tool.name) || view.visible.has(tool.name);
	return {
		...agent,
		extensions: agent.extensions.flatMap((extension) =>
			extension.name !== MCP_EXTENSION
				? [extension]
				: view.servers.map((server) => ({
						name: `${MCP_EXTENSION}:${server.server}`,
						namespace: server.namespace,
						tools: agent.callable.filter((tool) => server.tools.has(tool.name)),
					})),
		),
		callable: agent.callable.filter(keep),
		deferred: agent.deferred.filter(keep),
	};
}

/** `api` with another `agent()`; its getters (`models`, `env`) and symbol-keyed members stay as they are. */
function withAgent(api: ToolExecutionApi, agent: ToolExecutionApi["agent"]): ToolExecutionApi {
	const descriptors = { ...Object.getOwnPropertyDescriptors(api), agent: { value: agent, enumerable: true } };
	// `defineProperties` returns its target's type: the descriptors are `api`'s own, with `agent` of its type.
	return Object.defineProperties({}, descriptors) as ToolExecutionApi;
}

/**
 * The `mcp_servers` section, as pi's for servers whose tools `tool_search` loads: the servers of the conversation's
 * view, with their summaries.
 */
function serversSection(
	viewOf: (conversationId: ConversationId, read: DocumentReader, context: Context) => Promise<View>,
): PromptSection<P2Tool> {
	return section<P2Tool>("mcp_servers", async ({ conversationId, read }, context) => {
		const { lines } = await viewOf(conversationId, read, context);
		if (lines.length === 0) return undefined;
		const intro =
			"MCP servers whose tools are not declared to you. Load the tools of `tool_search` servers with `tool_search`.";
		return [intro, ...lines].join("\n");
	});
}

/**
 * One variant as a Durable tool (not replay-safe: an interrupted call is not repeated). Deferred either way, so the
 * `codemode` section leaves it out; for `codemode` only other tools (scripts) may call it, so `tool_search` never
 * offers it to the model either. A call reaches the instance where the calling conversation works, and only when that
 * instance describes the tool as this variant does.
 */
function toolRegistration(
	{ server, tool, descriptor, name }: Variant,
	offer: McpOffer,
	call: McpCall,
	locate: McpLocate,
): P2Tool {
	const title = tool.title ?? tool.annotations?.title;
	return {
		name,
		description: tool.description?.trim() || title || `MCP tool ${tool.name} from server ${server}`,
		parameters: normalizeMcpInputSchema(tool.inputSchema),
		deferred: true,
		...(offer.reach === "codemode" ? { callers: ["tools" as const] } : {}),
		...(tool.outputSchema === undefined ? {} : { structuredOutputSchema: tool.outputSchema }),
		async execute(args, api, context) {
			const location = await locate(api.conversationId, api, context);
			const there = instanceAt(offer, location, server);
			if (
				there !== undefined &&
				!there.tools.some((other) => other.name === tool.name && toolDescriptor(other) === descriptor)
			)
				throw new Error(
					`MCP tool ${name} is not offered at ${locationText(location)}: find the tools there with searchTools()`,
				);
			// Durable checked `args` against `parameters`, an object schema; its type cannot follow a runtime schema.
			const result = await call(
				{ location, server, tool: tool.name, args: args as Record<string, unknown> },
				context,
			);
			const content = toLlmContent(result);
			if (result.isError && !content.some((block) => block.type === "text" && block.text.trim() !== ""))
				content.push({ type: "text", text: `MCP tool ${server}/${tool.name} returned an error` });
			const limited = await limitMcpContent(content);
			// Structured output only for a tool that declares its schema (Durable checks it), error results too. The
			// server's JSON arrived as JSON; the type says `unknown` only because MCP allows any value.
			const structured =
				tool.outputSchema !== undefined && result.structuredContent !== undefined
					? { structuredOutput: result.structuredContent as JsonValue }
					: {};
			return {
				output: limited.content,
				isError: result.isError === true,
				details: { server, tool: tool.name },
				...structured,
			};
		},
	};
}

/** The instance of `server` the lease at `location` uses, if the offer has one (else the manager answers why not). */
function instanceAt(offer: McpOffer, location: Location, server: string): OfferedInstance | undefined {
	const lease = offer.leases.find((candidate) => sameLocation(candidate.location, location));
	const used = new Set(lease?.instances ?? []);
	return offer.instances.find((instance) => used.has(instance.id) && instance.server === server);
}
