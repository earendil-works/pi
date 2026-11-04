// Worker-side contracts of the subagents plugin: the session's subagent registry (a Durable document other worker
// plugins read: one-shot agents, search, PowerShell), the tool choices subagents and one-shot agents validate alike,
// and giving a subagent its own location (a granted `location_move`).

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, type Models } from "@earendil-works/pi-ai/models";
import {
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

export const CODING_TOOLS = ["read", "write", "edit", "bash", "send_file", "artifact"];
/** The location tools (plugins/locations): every main agent has them; a subagent only when chosen. */
export const LOCATION_TOOLS = ["location_envs", "location_dirs", "location_move"];
/** What a subagent's `tools` may name: the coding tools (its default) and the location tools. */
export const CHOOSABLE = [...CODING_TOOLS, ...LOCATION_TOOLS];
export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const TEAM_TOOL = "team";
/** The history tools (plugins/history), when installed: every subagent gets them. */
export const HISTORY_TOOLS = ["history_search", "history_read", "history_handoff"];
/** Tools every subagent has, outside its chosen tools. */
export const ALWAYS = [TEAM_TOOL, ...HISTORY_TOOLS];

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
	/** Answers already reported: several messages can end in one answer, reported once. */
	reported: EntryId[];
	/** Hidden from the sidebar's list and `status`; still usable, and `send` restores it. */
	archived?: true;
	/** Its tools include `team` (subagents spawned before it existed get it at their next send or configure). */
	team?: true;
	/** Its tools include the history tools (likewise added at the next send or configure). */
	history?: true;
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

/**
 * Validate a choice before any commit, so a typo changes nothing; an error is returned as text. Unset fields keep
 * `current`'s, or for a new agent the caller's model and thinking level and every coding tool.
 */
export async function resolveChoice(
	models: Models,
	api: Pick<ToolExecutionApi, "agent" | "registry">,
	choice: AgentChoice,
	current: Subagent | undefined,
	context: Context,
): Promise<{ model: ModelRef; thinkingLevel: ModelThinkingLevel; tools: ToolRegistration[] } | string> {
	const own = current ? undefined : await api.agent(context);
	const text = choice.model ?? current?.model;
	const slash = text?.indexOf("/") ?? -1;
	const ref =
		text === undefined
			? own?.model
			: slash > 0
				? { provider: text.slice(0, slash), modelId: text.slice(slash + 1) }
				: undefined;
	const model = ref ? models.getModel(ref.provider, ref.modelId) : undefined;
	if (!ref || !model)
		return `Unknown model ${choice.model ?? "(none)"}. Use the subagent tool's models action to list them.`;
	if (choice.thinkingLevel !== undefined && !THINKING.includes(choice.thinkingLevel))
		return `Invalid thinkingLevel ${choice.thinkingLevel}.`;
	const requested = (choice.thinkingLevel ??
		current?.thinkingLevel ??
		own?.thinkingLevel ??
		"off") as ModelThinkingLevel;
	const names = (choice.tools ?? current?.tools ?? CODING_TOOLS).filter((tool) => !ALWAYS.includes(tool));
	const unknown = names.filter((tool) => !CHOOSABLE.includes(tool));
	if (unknown.length) return `Unknown tools: ${unknown.join(", ")}. Choose from ${CHOOSABLE.join(", ")}.`;
	const installed = api.registry.tools().map((entry) => entry.tool);
	return {
		model: ref,
		thinkingLevel: clampThinkingLevel(model, requested),
		tools: [...new Set(names)].flatMap((tool) => installed.filter((entry) => entry.name === tool).slice(0, 1)),
	};
}

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
