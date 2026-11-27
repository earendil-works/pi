// The session's subagents (the subagents' part, `subagents.ts`, starts and drives them; `reporter.ts` delivers their
// messages): the document listing them by name (`Subagents`, the session's, so every top-level conversation sees the
// same names), the task owning each one's conversation (`Anchor`), what a subagent gets from the agent when it is
// configured (the agent's tools it may be given now, its thinking level clamped to its model), the request ids of its
// messages (which carry the generation they were sent in), the task that ends an older generation's work
// (`Stopper`), and the move of version 1's per-conversation documents into the session's.

import type { Context } from "@earendil-works/p3/v1";
import {
	type Agent,
	type ConversationId,
	clampThinkingLevel,
	defineDoc,
	defineTask,
	type EntryId,
	type Harness,
	LiveDoc,
	type Models,
	type ModelThinkingLevel,
	type TaskId,
} from "@earendil-works/p3/v1/worker";
import type { HarnessTool } from "../things/contract.worker.ts";
import type { ModelRef } from "./agent-parts.ts";

/** The subagents' tool: a `main` tool, so the agent's (its top-level conversations'), never a subagent's. */
export const SUBAGENT_TOOL = "subagent";

/**
 * A subagent: its conversation; its answers that were reported (several messages may end in one answer), and to whom
 * (each sender once); the model (`provider/modelId`) and thinking level it was given (the level as asked: it is clamped
 * to the model when applied); the tools it was given by name (none: every tool the agent may give it); its generation,
 * which every stop and archive bumps (a message sent before is not delivered after), and the stopper still ending the
 * older generation's work (`stopping`: messages sent meanwhile wait for it); the follow-ups waiting for its current
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
	stopping?: TaskId;
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
	// 2: the session's (1 was each conversation's, `SubagentsV1`, moved over by `adoptConversationRosters`).
	version: 2,
	// The session's: a top-level branch sees the same subagents; each answer goes to the conversation that asked.
	scope: "session",
	initial: () => ({ agents: {} }),
});

/** A subagent as version 1 of the document listed it: in the conversation that started it. */
type SubagentV1 = { readonly conversationId: ConversationId; readonly reported: EntryId[] };

/** Version 1 of the document: each conversation's subagents (read once by `adoptConversationRosters`). */
const SubagentsV1 = defineDoc<{ agents: Record<string, SubagentV1> }>({
	checkpointWhen: () => false,
	kind: "harness.subagents",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ agents: {} }),
});

/** What adopting the old documents reads and writes: the harness's commits, snapshots and conversations' agents. */
type Adopting = Pick<Harness, "commit" | "snapshot" | "conversation">;

/**
 * Moves the subagents version 1 listed per conversation into the session's document, once: when the session's does
 * not exist yet (decision 125: stored data survives an update). Each keeps its conversation and reported answers
 * (reported to the conversation that listed it), gets the model and thinking level its conversation's agent has, every
 * tool the agent may give, generation 0. Every conversation's document is read, a subagent's too (Astra, round 4 of the
 * port). A name taken already gets a free one (`freeName`); version 1's reporters find their subagent by its
 * conversation (`sentTo`). Runs before the harness resumes, so no reporter reads the session's document before.
 */
export async function adoptConversationRosters(durable: Adopting, context: Context): Promise<void> {
	if ((await durable.snapshot(Subagents, context)) !== undefined) return;
	const owners = await durable.commit(async (tx) => {
		const all: ConversationId[] = [];
		let cursor: Parameters<typeof tx.scanConversations>[2];
		do {
			const page = await tx.scanConversations({}, 200, cursor);
			for (const record of page.items) all.push(record.id);
			cursor = page.next;
		} while (cursor !== undefined);
		return all;
	}, context);
	const adopted: { name: string; agent: Subagent }[] = [];
	for (const owner of owners) {
		const listed = (await durable.snapshot(SubagentsV1, owner, context))?.agents ?? {};
		for (const [name, { conversationId, reported }] of Object.entries(listed)) {
			const own = await (await durable.conversation(conversationId, context))?.agent(context);
			const model = own?.model === undefined ? "" : modelText(own.model);
			const reportedTo = reported.map((answer) => ({ answer, to: owner }));
			const agent = { conversationId, reported: [...reported], reportedTo, model, generation: 0, followUps: [] };
			adopted.push({ name, agent: { ...agent, thinkingLevel: own?.thinkingLevel ?? "off" } });
		}
	}
	await durable.commit(async (tx) => {
		const roster = await tx.doc(Subagents);
		for (const { name, agent } of adopted) roster.agents[freeName(roster.agents, name, agent.conversationId)] = agent;
	}, context);
}

/** The longest name the `subagent` tool takes. */
export const MAX_NAME = 100;

/**
 * `name` if no subagent of `agents` has it, else the first free one of `<name>-<conversation>`,
 * `<name>-<conversation>-2`, ...; `name` cut so the whole stays within `MAX_NAME`, so the tool reaches it (Astra, round
 * 4 of the port).
 */
function freeName(agents: Record<string, Subagent>, name: string, conversation: ConversationId): string {
	if (subagentOf(agents, name) === undefined && name.length <= MAX_NAME) return name;
	for (let n = 1; ; n++) {
		const suffix = n === 1 ? `-${conversation}` : `-${conversation}-${n}`;
		const candidate = `${name.slice(0, MAX_NAME - suffix.length)}${suffix}`;
		if (subagentOf(agents, candidate) === undefined) return candidate;
	}
}

/**
 * The subagent a reporter's message went to, and its name now: the one of its name with its conversation; for a
 * reporter of version 1, whose subagent the move may have renamed, the one with its conversation. None: gone or
 * replaced.
 */
export function sentTo<T extends Subagent>(
	agents: Record<string, T>,
	input: { readonly name: string; readonly conversationId: ConversationId; readonly v1?: true },
): { readonly name: string; readonly agent: T } | undefined {
	const named = subagentOf(agents, input.name);
	if (named?.conversationId === input.conversationId) return { name: input.name, agent: named };
	if (input.v1 !== true) return undefined;
	const found = Object.entries(agents).find(([, agent]) => agent.conversationId === input.conversationId);
	return found === undefined ? undefined : { name: found[0], agent: found[1] };
}

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
	const [, generation] = requestId.slice(REQUEST.length).split(":");
	// A reporter of version 1 (`subagent:<reporter>`) sent in generation 0 (Astra, round 4 of the port).
	if (generation === undefined) return 0;
	const number = Number(generation);
	return Number.isSafeInteger(number) ? number : undefined;
}

/** What a stopper ends: the subagent `name`, and its conversation. */
type StopperInput = { name: string; conversationId: ConversationId };

/** A stopper's phases: decide whether older work runs, abort it, then clear the subagent's mark. */
type StopperState = { phase: "decide" } | { phase: "abort" } | { phase: "clear" };

/**
 * Ends the work of a subagent's older generations, after a stop's or an archive's commit (which bumped the generation
 * and marked the subagent `stopping` with this task): aborts its current run only if a message of a generation before
 * the subagent's current one started it, then clears the mark in the commit that ends the task, so the messages held
 * back for the stop wait for this task's end (Astra, rounds 2 and 3 of the port). A stop while one is pending bumps
 * the generation again and reuses this task: one stopper decides and clears, so no stopper outlives the mark and aborts
 * work admitted after it (Astra, round 5 of the port). A background task with its own context: a stop whose caller is
 * cancelled (the agent stopped meanwhile) still finishes, and a restart resumes it at its phase.
 */
export const Stopper = defineTask<StopperInput, StopperState, null>({
	name: "harness.subagent-stopper",
	version: 1,
	initial: () => ({ phase: "decide" }),
	phases: {
		decide: async (stopper, runtime, context) => {
			const { name, conversationId } = stopper.input;
			await runtime.commit(async (tx) => {
				const generation = subagentOf((await tx.doc(Subagents)).agents, name)?.generation ?? 0;
				for (const input of (await tx.doc(LiveDoc, conversationId)).run?.inputs ?? []) {
					const sent = generationOf((await tx.submission(input))?.requestId);
					if (sent === undefined || sent < generation)
						return { status: "running", checkpoint: { phase: "abort" } };
				}
				return { status: "running", checkpoint: { phase: "clear" } };
			}, context);
		},
		abort: async (stopper, runtime, context) => {
			await (await runtime.conversation(stopper.input.conversationId, context))?.abort(context);
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "clear" } }), context);
		},
		clear: (stopper, runtime, context) =>
			runtime.commit(async (tx) => {
				clearMark(stopper.input.name, stopper.id, (await tx.doc(Subagents)).agents);
				return { status: "terminal", outcome: { status: "completed", result: null } };
			}, context),
	},
	// Aborted itself: the messages held back for it go on.
	abort: (stopper, runtime, context) =>
		runtime.commit(async (tx) => {
			clearMark(stopper.input.name, stopper.id, (await tx.doc(Subagents)).agents);
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context),
});

/** Clears subagent `name`'s stop mark if it is still `stopper`'s (a later stop has its own). */
function clearMark(name: string, stopper: TaskId, agents: Record<string, Subagent>): void {
	const agent = subagentOf(agents, name);
	if (agent?.stopping === stopper) delete agent.stopping;
}
