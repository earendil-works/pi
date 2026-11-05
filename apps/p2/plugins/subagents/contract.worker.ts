// Worker-side contracts of the subagents plugin: the session's subagent registry (a Durable document other worker
// plugins read: one-shot agents, search, PowerShell), the tool choices subagents and one-shot agents resolve alike
// from their caller's tools, and giving a subagent its own location (a granted `location_move`).

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, type Models } from "@earendil-works/pi-ai/models";
import {
	type Agent,
	type ConversationId,
	configure,
	defineDoc,
	type EntryId,
	type ModelRef,
	ROOT_CONVERSATION_ID,
	type TaskId,
	type ToolExecutionApi,
	type ToolRegistration,
	type Tx,
} from "@earendil-works/pi-durable";
import type { Context, Location } from "@p2/app/v1";
import type { P2Tool } from "@p2/app/v1/worker";

export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const TEAM_TOOL = "team";

export type Subagent = {
	conversationId: ConversationId;
	model: string;
	thinkingLevel: string;
	tools: string[];
	/**
	 * Its own location, chosen at spawn (e.g. a git worktree, on the caller's environment) and kept when the session
	 * moves; absent: it follows the session.
	 */
	location?: Location;
	/**
	 * An own cwd from version 1, which did not record the environment: the worker places it (`placeSubagents`) on the
	 * environment it was spawned on before the Harness is live, so no one else reads it.
	 */
	unplacedCwd?: string;
	/**
	 * The top-level conversation that last spawned it or sent it a message (the main conversation or a `/tree` branch):
	 * where `team send to: "parent"` goes. Absent (spawned before it was recorded): the current main conversation.
	 */
	parent?: ConversationId;
	/** Answers already reported: several messages can end in one answer, reported once. */
	reported: EntryId[];
	/** Hidden from the sidebar's list and `status`; still usable, and `send` restores it. */
	archived?: true;
};
/** A code mode script's one-shot agent (plugins/agent), listed for inspection from the script's tool card. */
export type OneShot = {
	conversationId: ConversationId;
	label: string;
	model: string;
	thinkingLevel: string;
	tools: string[];
};
export type SubagentState = {
	agents: Record<string, Subagent>;
	reporters: Record<string, TaskId>;
	/** One-shot agents by the nested call ID that ran them (`<script call ID>/c<n>`). */
	oneShots?: Record<string, OneShot>;
};
/**
 * The session's subagent registry. Kept on conversation 1 for every top-level conversation (the main conversation and
 * its `/tree` branches, `docs/tree.md`): subagents are session-wide and outlive branch switches.
 * TODO: this should probably be a session-scoped document; moving it there needs a migration of existing sessions.
 */
export const Subagents = defineDoc<SubagentState>({
	kind: "p2.subagents",
	// 2: an own location (environment and cwd) instead of an own cwd (version 1's is `unplacedCwd` until placed).
	version: 2,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ agents: {}, reporters: {} }),
	migrate: (value, fromVersion) => {
		if (fromVersion !== 1) throw new Error(`Unknown p2.subagents version ${fromVersion}`);
		const state = value as unknown as SubagentState & { agents: Record<string, Subagent & { cwd?: string }> };
		return {
			...state,
			agents: Object.fromEntries(
				Object.entries(state.agents).map(([name, { cwd, ...agent }]) => [
					name,
					cwd === undefined ? agent : { ...agent, unplacedCwd: cwd },
				]),
			),
		};
	},
	checkpointWhen: (_v, _o, { deltasSinceBase }) => deltasSinceBase >= 64,
});

/** A subagent's model ('provider/modelId'), thinking level and tools, as the tools take them. */
export type AgentChoice = { model?: string; thinkingLevel?: string; tools?: string[] };

/** The tools an agent gets, as `resolveTools` resolves them. */
export type ToolChoice = {
	/** The tools it chose (or got by default), by name: what its registry entry records and `configure` keeps. */
	readonly chosen: string[];
	/** Every tool it gets: the chosen ones, the script-only ones with code mode, a subagent's `scope: "subagent"` ones. */
	readonly tools: ToolRegistration[];
	/** Deferred tools it is offered from the start: the `scope: "subagent"` ones, and deferred ones chosen by name. */
	readonly loaded: ToolRegistration[];
};

/**
 * Validates a choice before any commit, so a typo changes nothing; an error is returned as text. Unset fields keep
 * `current`'s (its recorded tools as far as the caller can still give them), or for a new agent the caller's model and
 * thinking level and every tool the caller may give (`resolveTools`).
 */
export async function resolveChoice(
	models: Models,
	api: Pick<ToolExecutionApi, "agent">,
	access: ReadonlyMap<string, P2Tool>,
	choice: AgentChoice,
	current: Subagent | undefined,
	kind: AgentKind,
	context: Context,
): Promise<({ model: ModelRef; thinkingLevel: ModelThinkingLevel } & ToolChoice) | string> {
	const own = await api.agent(context);
	const text = choice.model ?? current?.model;
	const slash = text?.indexOf("/") ?? -1;
	const ref =
		text === undefined
			? own.model
			: slash > 0
				? { provider: text.slice(0, slash), modelId: text.slice(slash + 1) }
				: undefined;
	const model = ref ? models.getModel(ref.provider, ref.modelId) : undefined;
	if (!ref || !model)
		return `Unknown model ${choice.model ?? "(none)"}. Use the subagent tool's models action to list them.`;
	if (choice.thinkingLevel !== undefined && !THINKING.includes(choice.thinkingLevel))
		return `Invalid thinkingLevel ${choice.thinkingLevel}.`;
	const requested = (choice.thinkingLevel ?? current?.thinkingLevel ?? own.thinkingLevel) as ModelThinkingLevel;
	const tools = resolveTools(own, access, choice.tools ?? stillGiven(own, access, current), choice.tools ?? [], kind);
	if (typeof tools === "string") return tools;
	return { model: ref, thinkingLevel: clampThinkingLevel(model, requested), ...tools };
}

/** Which agent gets the tools: a persistent subagent also gets the `scope: "subagent"` ones. */
export type AgentKind = "subagent" | "one-shot";

/** The caller's tools an agent may be given: the ones its model calls, except `scope: "main"` and `"subagent"` ones. */
export function choosableTools(caller: CallerTools, access: ReadonlyMap<string, P2Tool>): ToolRegistration[] {
	return everyTool(caller).filter((tool) => calledByModel(tool) && scopeOf(tool, access) === "any");
}

/** `current`'s recorded tools that the caller can still give; undefined for a new agent (all of them). */
export function stillGiven(
	caller: CallerTools,
	access: ReadonlyMap<string, P2Tool>,
	current: Subagent | undefined,
): string[] | undefined {
	const choosable = new Set(choosableTools(caller, access).map((tool) => tool.name));
	return current?.tools.filter((name) => choosable.has(name));
}

/**
 * The tools an agent of `kind` gets from a caller with tools `caller`: `names` among its choosable tools (default: all),
 * with code mode the caller's script-only tools (MCP tools, the terminal, `agent`, code mode's own), and for a
 * subagent the `scope: "subagent"` ones. Deferred tools stay deferred, except those in `load`. Text names the tools
 * `names` may not choose.
 */
export function resolveTools(
	caller: CallerTools,
	access: ReadonlyMap<string, P2Tool>,
	names: readonly string[] | undefined,
	load: readonly string[],
	kind: AgentKind,
): ToolChoice | string {
	const all = everyTool(caller);
	const choosable = choosableTools(caller, access);
	const unknown = (names ?? []).filter((name) => !choosable.some((tool) => tool.name === name));
	if (unknown.length)
		return `Unknown tools: ${unknown.join(", ")}. Choose from your own tools: ${choosable.map((tool) => tool.name).join(", ")}.`;
	// In the order given, each once.
	const chosen =
		names === undefined
			? choosable
			: [...new Set(names)].flatMap((name) => choosable.filter((tool) => tool.name === name));
	const scripts = chosen.some((tool) => tool.name === CODEMODE_TOOL)
		? all.filter((tool) => !calledByModel(tool) && scopeOf(tool, access) !== "main")
		: [];
	const own = kind === "subagent" ? all.filter((tool) => scopeOf(tool, access) === "subagent") : [];
	return {
		chosen: chosen.map((tool) => tool.name),
		tools: [...chosen, ...scripts, ...own],
		loaded: [...own, ...chosen.filter((tool) => tool.deferred && load.includes(tool.name))],
	};
}

/** A caller's resolved agent: the tools offered to its model, its deferred ones and the ones scripts call. */
export type CallerTools = Pick<Agent, "tools" | "deferred" | "callable">;

/** The code mode tool (plugins/codemode): choosing it brings the tools only scripts call. */
export const CODEMODE_TOOL = "codemode";

/** Whether the model may call `tool` (`callers`); the others are script-only: MCP tools in code mode, `agent`, … */
export const calledByModel = (tool: ToolRegistration): boolean => tool.callers?.includes("model") ?? true;

/** Every tool the caller has, each once. */
const everyTool = (caller: CallerTools): ToolRegistration[] => [
	...new Map([...caller.tools, ...caller.deferred, ...caller.callable].map((tool) => [tool.name, tool])).values(),
];

/** Where a tool works, as its plugin declared it. */
const scopeOf = (tool: ToolRegistration, access: ReadonlyMap<string, P2Tool>) => access.get(tool.name)?.scope ?? "any";

/**
 * Gives the subagent working in `conversationId` its own location `location` (a granted `location_move`), in `tx`:
 * its registry entry and its agent cwd. False when the conversation is not a subagent (one-shot agents are not).
 */
export async function placeSubagent(tx: Tx, conversationId: ConversationId, location: Location): Promise<boolean> {
	const agent = Object.values((await tx.doc(Subagents, ROOT_CONVERSATION_ID)).agents).find(
		(each) => each.conversationId === conversationId,
	);
	if (!agent) return false;
	agent.location = location;
	await configure(tx, conversationId, { cwd: location.cwd });
	return true;
}
