// The session's subagents (the subagents' part, `subagents.ts`, starts and drives them; `reporter.ts` delivers their
// messages): the document listing them by name (`Subagents`, the session's, so every top-level conversation sees the
// same names), the task owning each one's conversation (`Anchor`), what a subagent gets from the agent when it is
// configured (the agent's tools it may be given now, its thinking level clamped to its model), the request ids of its
// messages (which carry the generation they were sent in), and the stop of an older generation's work.

import type { Context } from "@earendil-works/p3/v1";
import {
	type Agent,
	type ConversationId,
	clampThinkingLevel,
	defineDoc,
	defineTask,
	type EntryId,
	LiveDoc,
	type Models,
	type ModelThinkingLevel,
	type TaskId,
	type Tx,
} from "@earendil-works/p3/v1/worker";
import type { HarnessTool } from "../things/contract.worker.ts";
import type { ModelRef } from "./agent-parts.ts";

/** The subagents' tool: a `main` tool, so the agent's (its top-level conversations'), never a subagent's. */
export const SUBAGENT_TOOL = "subagent";

/**
 * A subagent: its conversation; its answers that were reported (several messages may end in one answer), and to whom
 * (each sender once); the model (`provider/modelId`) and thinking level it was given (the level as asked: it is clamped
 * to the model when applied); the tools it was given by name (none: every tool the agent may give it); its generation,
 * which every stop and archive bumps (a message sent before is not delivered after), and whether that stop still has
 * to abort the older generation's work (`stopping`: a restart finishes it); the follow-ups waiting for its current
 * answer, by reporter, in the order sent; and whether it is archived (hidden from `status`, still usable).
 */
export type Subagent = {
	readonly conversationId: ConversationId;
	readonly reported: EntryId[];
	readonly reportedTo: { readonly answer: EntryId; readonly to: ConversationId }[];
	model: string;
	thinkingLevel: ModelThinkingLevel;
	tools?: string[];
	generation: number;
	stopping?: true;
	followUps: TaskId[];
	archived?: true;
};

/**
 * The session's subagents by name; whether Use is withheld from the agent (`withheld`: the harness writes it before it
 * withdraws the queued messages, and a reporter checks it in the commit that admits its message); and how often it was
 * withheld (`withholds`: a message sent before a withhold is never delivered, also after a regrant).
 */
export const Subagents = defineDoc<{ agents: Record<string, Subagent>; withheld?: true; withholds?: number }>({
	checkpointWhen: () => false,
	kind: "harness.subagents",
	// 2: the session's (1 was each conversation's).
	version: 2,
	// The session's: a top-level branch sees the same subagents; each message's answer goes to the conversation that sent it.
	scope: "session",
	initial: () => ({ agents: {} }),
});

/** The subagent `name` of `agents` (`Object.hasOwn`: a name is the model's text); none: there is no such subagent. */
export function subagentOf<T extends Subagent>(agents: Readonly<Record<string, T>>, name: string): T | undefined {
	return Object.hasOwn(agents, name) ? agents[name] : undefined;
}

/**
 * What owns a subagent's conversation: a background task that ends at once. A subagent outlives the agent's turns; a
 * background task is a boundary, so the agent's stop and idle waits do not reach it.
 */
export const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "harness.subagent-anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_anchor, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
	},
	abort: (_anchor, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/**
 * The tools the agent `own` may give a subagent: those offered to its model now (so never one it does not have, also
 * when its own tools are a selection), minus the `main` ones. `HarnessTool`: every tool the harness installs is a
 * kind's, and keeps its scope.
 */
export function givable(own: Agent): HarnessTool[] {
	const tools: readonly HarnessTool[] = own.tools;
	return tools.filter((tool) => tool.scope === undefined);
}

/**
 * The tools a subagent gets from the agent `own` now: the ones it was given by name that the agent may still give, in
 * that order, or all the agent may give; enabled and offered exactly (a deferred one the agent loaded too).
 */
export function toolsOf(agent: Pick<Subagent, "tools">, own: Agent) {
	const all = givable(own);
	const names = agent.tools;
	const tools = names === undefined ? all : names.flatMap((name) => all.find((tool) => tool.name === name) ?? []);
	return { tools, modelTools: tools };
}

/** A model's reference as the document records it (`provider/modelId`; the model id may hold more slashes). */
export function modelText(ref: ModelRef): string {
	return `${ref.provider}/${ref.modelId}`;
}

/** The reference `text` names, if it has the form `provider/modelId`. */
export function modelRef(text: string): ModelRef | undefined {
	const slash = text.indexOf("/");
	return slash > 0 ? { provider: text.slice(0, slash), modelId: text.slice(slash + 1) } : undefined;
}

/** The model and thinking level a subagent runs with: its level clamped to its model (a model gone: as asked). */
export function levelOf(agent: Pick<Subagent, "model" | "thinkingLevel">, models: Models) {
	const ref = modelRef(agent.model);
	const model = ref === undefined ? undefined : models.getModel(ref.provider, ref.modelId);
	const thinkingLevel = model === undefined ? agent.thinkingLevel : clampThinkingLevel(model, agent.thinkingLevel);
	return { model: ref, thinkingLevel };
}

/** A message's request id: its reporter and the generation it was sent in (`subagent:<reporter>:<generation>`). */
export function requestOf(reporter: string | number, generation: number): string {
	return `${REQUEST}${reporter}:${generation}`;
}

/** The prefix of every message's request id. */
export const REQUEST = "subagent:";

/** The generation a request id names; none: not a message of a reporter. */
function generationOf(requestId: string | undefined): number | undefined {
	if (requestId?.startsWith(REQUEST) !== true) return undefined;
	const generation = Number(requestId.slice(requestId.lastIndexOf(":") + 1));
	return Number.isSafeInteger(generation) ? generation : undefined;
}

/** What finishing a stop needs: commits, and a subagent's conversation to abort (a tool's api, or the harness). */
export type Stopping = {
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
	conversation(id: ConversationId, context: Context): Promise<{ abort(context: Context): Promise<void> } | undefined>;
};

/**
 * Finishes the stop of subagent `name` its document marks (`stopping`): aborts its current work only if a message of
 * an older generation started it, never work sent after the stop's commit (Astra, round 2 of the port), then clears
 * the mark. Run by the stop itself, and again after a restart that cut it.
 */
export async function finishStop(owner: Stopping, name: string, context: Context): Promise<void> {
	const marked = await owner.commit(async (tx) => {
		const agent = subagentOf((await tx.doc(Subagents)).agents, name);
		return agent?.stopping === undefined ? undefined : agent.conversationId;
	}, context);
	if (marked === undefined) return;
	const child = await owner.conversation(marked, context);
	const older = await owner.commit(async (tx) => {
		const agent = subagentOf((await tx.doc(Subagents)).agents, name);
		if (agent === undefined) return false;
		for (const input of (await tx.doc(LiveDoc, marked)).run?.inputs ?? []) {
			const sent = generationOf((await tx.submission(input))?.requestId);
			if (sent === undefined || sent < agent.generation) return true;
		}
		return false;
	}, context);
	try {
		if (older) await child?.abort(context);
	} finally {
		// Also after a failed abort: the messages held back for the stop go on (only a restart leaves a mark).
		await owner.commit(async (tx) => {
			const agent = subagentOf((await tx.doc(Subagents)).agents, name);
			if (agent !== undefined) delete agent.stopping;
		}, context);
	}
}

/** Finishes every stop a restart cut (see `finishStop`). */
export async function finishStops(owner: Stopping, context: Context): Promise<void> {
	const marked = await owner.commit(async (tx) => {
		const { agents } = await tx.doc(Subagents);
		return Object.entries(agents).flatMap(([name, agent]) => (agent.stopping === undefined ? [] : [name]));
	}, context);
	for (const name of marked) await finishStop(owner, name, context);
}
