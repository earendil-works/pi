// The subagents' harness part (`harness.subagents`): the one tool `subagent`, with a tagged action (spawn, send,
// configure, stop, archive, restore, answer, status, models), offered while the agent's reference has the flag `use`.
// Each subagent is a conversation of the session, named by the agent, its transcript the session's (decision 76): it
// starts as a copy of the session's agent (the same things: it is the same party), with a model, thinking level and
// tools of its own if the agent chose them, and gets the agent's tools again with every message (never one the agent
// has not now). The tool has `scope: "main"`: a subagent is never given it (its tools leave it out, and the harness
// refuses its calls there), so no subagent starts subagents (decision 116). The subagents are the session's
// (`roster.ts`); messages travel in reporter tasks (`reporter.ts`), which hand each answer back to the conversation
// that sent the message once it arrives.

import { arr, bool, type Context, invalid, obj, oneOf, opt, type Static, str } from "@earendil-works/p3/v1";
import {
	type Agent,
	type AgentChange,
	AssistantEntry,
	type ConversationId,
	configure,
	defineTool,
	LiveDoc,
	type ModelThinkingLevel,
	type ToolExecutionApi,
} from "@earendil-works/p3/v1/worker";
import { type HarnessExtension, thingHarnessPart } from "../things/contract.worker.ts";
import type { ModelRef } from "./agent-parts.ts";
import { SubagentsKind } from "./kind.ts";
import { closeModels, listModels } from "./model-list.ts";
import { Reporter, textOf } from "./reporter.ts";
import {
	Anchor,
	finishStop,
	givable,
	levelOf,
	modelRef,
	modelText,
	SUBAGENT_TOOL,
	type Subagent,
	Subagents,
	subagentOf,
	toolsOf,
} from "./roster.ts";

/** The subagents' part: the `subagent` tool while the nearest reference has `use` (the kind stacks `nearest`). */
export const subagentsPart = thingHarnessPart(SubagentsKind, (things) => {
	const nearest = things[things.length - 1];
	if (nearest === undefined || !nearest.ref.granted.has("use")) return {};
	return { extension: SUBAGENT_TOOLS };
});

/** The thinking levels a subagent may be given, clamped to its model (pi-ai's list, which its index does not export). */
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies ModelThinkingLevel[];

/** The tool's arguments: the action, and the fields the actions take. */
const Args = obj({
	action: oneOf("spawn", "send", "configure", "stop", "archive", "restore", "answer", "status", "models"),
	name: opt(str({ min: 1, max: 100 })),
	message: opt(str({ min: 1 })),
	followUp: opt(bool()),
	model: opt(str({ min: 1 })),
	thinkingLevel: opt(oneOf(...THINKING)),
	tools: opt(arr(str())),
});

/** What the tool is called with. */
type Call = Static<typeof Args>;

/** The tool `subagent`: one action per call, answering JSON. */
const subagentTool = defineTool({
	name: SUBAGENT_TOOL,
	description: [
		"Manages your subagents: each is a persistent conversation of its own, a copy of you working in the background",
		"while you go on. Answers JSON. Actions (`action`):",
		"- spawn (`name`, `message`; optional `model`, `thinkingLevel`, `tools`): starts a subagent and sends it its first",
		"  message. `model` is `provider/modelId` (default: yours; see models); `thinkingLevel` is",
		"  off|minimal|low|medium|high|xhigh|max, clamped to the model (default: yours); `tools` names tools of yours it",
		"  gets (default: every one you may give it; [] for none). With each message it gets them as you have them then.",
		"  This tool cannot be given.",
		"- send (`name`, `message`; `followUp: true` waits until its current answer instead of reaching it at its next",
		"  step). Restores an archived subagent.",
		"- configure (`name`; `model`, `thinkingLevel`, `tools`): replaces what is given, for its later work.",
		"- stop (`name`): stops its current work and drops the messages it has not taken yet; it stays usable.",
		"- archive (`name`): stops it and hides it from status; restore (`name`) or send brings it back.",
		"- answer (`name`): its latest reported answer again, and whether it is working on a newer one.",
		"- status (optional `name`): your subagents, whether each is working, its model, thinking level (as used) and",
		"  tools; archived ones only by name.",
		"- models (optional `model`: a provider or words of a model's id or name): the models you can give, by `model`.",
		"Each answer comes back to you as a message `[subagent <name> answered] ...` once it arrives (or",
		"`[subagent <name> failed: ...]`): do not wait or poll for it.",
	].join("\n"),
	parameters: Args,
	// A call a crash interrupted is not run again (a stop must not hit newer work): the model sees it was
	// interrupted and can check with status.
	replay: "unsafe",
	execute: async (call, api, context) => {
		const answer = await ACTIONS[call.action](call, api, context);
		return { output: [{ type: "text", text: JSON.stringify(answer) }] };
	},
});

/** The subagent tools (the harness installs them under the kind's name): the one tool, for the main conversation. */
const SUBAGENT_TOOLS: HarnessExtension = { tools: [{ ...subagentTool, scope: "main" }] };

/** What an action answers: a value the tool answers as JSON. */
type Answer = object;

/** The actions, by name. */
const ACTIONS: Record<Call["action"], (call: Call, api: ToolExecutionApi, context: Context) => Promise<Answer>> = {
	spawn,
	send,
	configure: configureAgent,
	stop,
	archive,
	restore,
	answer: answerOf,
	status,
	models,
};

/** Both tasks belong to the agent's conversation and are background: its stop and idle waits skip them. */
const BACKGROUND = { ownership: { kind: "conversation" }, background: true } as const;

/** Starts the subagent `name` and sends it `message`. */
async function spawn(call: Call, api: ToolExecutionApi, context: Context): Promise<Answer> {
	const name = nameOf(call);
	const message = messageOf(call);
	if (Object.hasOwn(await subagentsOf(api, context), name)) throw exists(name);
	const own = await api.agent(context);
	const model = await modelOf(call.model, own.model, api);
	const tools = call.tools === undefined ? undefined : chosenTools(call.tools, own);
	const thinkingLevel = call.thinkingLevel ?? own.thinkingLevel;
	await api.commit(async (tx) => {
		const roster = await tx.doc(Subagents);
		const withholds = roster.withholds ?? 0;
		// Spawned meanwhile by a call running beside this one.
		if (Object.hasOwn(roster.agents, name)) throw exists(name);
		const anchor = await tx.createTask(Anchor, null, BACKGROUND);
		// Owned by a task of the agent's conversation: it starts as a copy of the agent.
		const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
		const agent: Subagent = {
			conversationId: child.id,
			reported: [],
			reportedTo: [],
			model: modelText(model),
			thinkingLevel,
			...(tools === undefined ? {} : { tools }),
			generation: 0,
			followUps: [],
		};
		roster.agents[name] = agent;
		const instructions = instructionsOf(name);
		await configure(tx, child.id, { ...levelOf(agent, api.models), ...toolsOf(agent, own), instructions });
		const input = { name, conversationId: child.id, generation: 0, withholds, message, followUp: false };
		await tx.createTask(Reporter, input, BACKGROUND);
	}, context);
	return { name, done: "started" };
}

/**
 * The refusal of a name that is taken: a state, refused as the kind pattern decides (`invalid("args")` for a state that
 * refuses).
 */
function exists(name: string) {
	return invalid("args", `subagent: ${name} exists already (see status; archived ones too): send to it`);
}

/** What a subagent is told it is. */
function instructionsOf(name: string): string {
	return (
		`You are the subagent "${name}", working for the session's agent. Do the requested work and answer ` +
		"concisely; your final answer is reported back to it."
	);
}

/**
 * Sends `message` to the subagent `name` (a steer, or a follow-up), restoring it if archived. The reporter delivers it
 * in the subagent's generation now: a stop or archive after this commit drops it.
 */
async function send(call: Call, api: ToolExecutionApi, context: Context): Promise<Answer> {
	const name = nameOf(call);
	const message = messageOf(call);
	await api.commit(async (tx) => {
		const roster = await tx.doc(Subagents);
		const agent = subagentNamed(roster.agents, name);
		delete agent.archived;
		const { conversationId, generation } = agent;
		const followUp = call.followUp === true;
		const withholds = roster.withholds ?? 0;
		const input = { name, conversationId, generation, withholds, message, followUp };
		const reporter = await tx.createTask(Reporter, input, BACKGROUND);
		// Follow-ups go in the order sent.
		if (followUp) agent.followUps.push(reporter);
	}, context);
	return { name, done: "sent" };
}

/**
 * Gives the subagent `name` another model, thinking level or tools, for its later work. Checked before the commit; the
 * commit writes only what the call names, so two configures at once keep both (Astra, round 1 of the port).
 */
async function configureAgent(call: Call, api: ToolExecutionApi, context: Context): Promise<Answer> {
	const name = nameOf(call);
	if (call.model === undefined && call.thinkingLevel === undefined && call.tools === undefined)
		throw invalid("args", "subagent: configure takes `model`, `thinkingLevel` or `tools`");
	subagentNamed(await subagentsOf(api, context), name);
	const own = await api.agent(context);
	const model = call.model === undefined ? undefined : await modelOf(call.model, undefined, api);
	const tools = call.tools === undefined ? undefined : chosenTools(call.tools, own);
	await api.commit(async (tx) => {
		const agent = subagentNamed((await tx.doc(Subagents)).agents, name);
		if (model !== undefined) agent.model = modelText(model);
		if (call.thinkingLevel !== undefined) agent.thinkingLevel = call.thinkingLevel;
		if (tools !== undefined) agent.tools = tools;
		const leveled = model !== undefined || call.thinkingLevel !== undefined;
		const change: AgentChange = {
			...(leveled ? levelOf(agent, api.models) : {}),
			...(tools === undefined ? {} : toolsOf(agent, own)),
		};
		await configure(tx, agent.conversationId, change);
	}, context);
	const agent = subagentNamed(await subagentsOf(api, context), name);
	return statusOf(name, agent, api, await working(agent.conversationId, api, context));
}

/**
 * Stops what the subagent `name` is doing and drops the messages it has not taken: a new generation first (so a message
 * sent before is not delivered after), then the abort.
 */
async function stop(call: Call, api: ToolExecutionApi, context: Context): Promise<Answer> {
	return { name: await halt(call, api, context), done: "stopped" };
}

/** Stops the subagent `name` and hides it from status (`restore` or `send` brings it back). */
async function archive(call: Call, api: ToolExecutionApi, context: Context): Promise<Answer> {
	const name = await halt(call, api, context, (agent) => {
		agent.archived = true;
	});
	return { name, done: "archived" };
}

/**
 * Stops the call's subagent: one commit bumps its generation (and makes `also`'s change) and marks the stop, then the
 * older generation's work is aborted (`finishStop`; a restart in between finishes it). A send whose commit comes later
 * restores it and is delivered, and its work is not aborted; one before is dropped (Astra, rounds 1 and 2 of the
 * port).
 */
async function halt(
	call: Call,
	api: ToolExecutionApi,
	context: Context,
	also?: (agent: Subagent) => void,
): Promise<string> {
	const name = nameOf(call);
	await api.commit(async (tx) => {
		const agent = subagentNamed((await tx.doc(Subagents)).agents, name);
		agent.generation += 1;
		agent.stopping = true;
		also?.(agent);
	}, context);
	await finishStop(api, name, context);
	return name;
}

/** Shows the archived subagent `name` in status again. */
async function restore(call: Call, api: ToolExecutionApi, context: Context): Promise<Answer> {
	const name = nameOf(call);
	await api.commit(async (tx) => {
		delete subagentNamed((await tx.doc(Subagents)).agents, name).archived;
	}, context);
	return { name, done: "restored" };
}

/**
 * The latest answer of the subagent `name` that was reported back (its reporters record each), `null` before the
 * first, and whether it is working (on a newer one).
 */
async function answerOf(call: Call, api: ToolExecutionApi, context: Context): Promise<Answer> {
	const name = nameOf(call);
	const agent = subagentNamed(await subagentsOf(api, context), name);
	const latest = agent.reported.at(-1);
	const entry = latest === undefined ? undefined : await api.commit((tx) => tx.entry(AssistantEntry, latest), context);
	const answer = entry === undefined ? null : textOf(entry.model?.[0]);
	return { name, working: await working(agent.conversationId, api, context), answer };
}

/** The subagents (with `name`: that one, archived too; without: those not archived, and how many are archived). */
async function status(call: Call, api: ToolExecutionApi, context: Context): Promise<Answer> {
	const agents = await subagentsOf(api, context);
	const named = call.name;
	const listed =
		named === undefined
			? Object.entries(agents).filter(([, agent]) => agent.archived === undefined)
			: [[named, subagentNamed(agents, named)] as const];
	const subagents = [];
	for (const [name, agent] of listed)
		subagents.push(statusOf(name, agent, api, await working(agent.conversationId, api, context)));
	const archived = named === undefined ? Object.keys(agents).length - listed.length : 0;
	return archived === 0 ? { subagents } : { subagents, archived };
}

/** A subagent as status shows it: the thinking level as its model takes it. */
function statusOf(name: string, agent: Subagent, api: ToolExecutionApi, busy: boolean) {
	return {
		name,
		working: busy,
		model: agent.model,
		thinkingLevel: levelOf(agent, api.models).thinkingLevel,
		tools: agent.tools ?? "all",
		...(agent.archived === undefined ? {} : { archived: true }),
	};
}

/** Whether `conversationId` is working: it has a run, from an input until its answer. */
async function working(conversationId: ConversationId, api: ToolExecutionApi, context: Context): Promise<boolean> {
	return (await api.snapshot(LiveDoc, conversationId, context))?.run !== undefined;
}

/** How long reading the models with credentials may take. */
const MODELS_MS = 10_000;

/** The models with credentials, all or those `model` matches. */
async function models(call: Call, api: ToolExecutionApi): Promise<Answer> {
	return listModels(await api.models.getAvailable(undefined, { signal: AbortSignal.timeout(MODELS_MS) }), call.model);
}

/** The session's subagents, as its document has them. */
async function subagentsOf(api: ToolExecutionApi, context: Context): Promise<Record<string, Subagent>> {
	return (await api.snapshot(Subagents, context))?.agents ?? {};
}

/** The call's `name`, which every action but status and models needs. */
function nameOf(call: Call): string {
	if (call.name === undefined) throw invalid("args", `subagent: ${call.action} takes \`name\``);
	return call.name;
}

/** The call's `message`, which spawn and send need. */
function messageOf(call: Call): string {
	if (call.message === undefined) throw invalid("args", `subagent: ${call.action} takes \`message\``);
	return call.message;
}

/** The subagent `name` of `agents`, or the refusal naming it. */
function subagentNamed<T extends Subagent>(agents: Record<string, T>, name: string): T {
	const agent = subagentOf(agents, name);
	if (agent === undefined) throw invalid("args", `subagent: you have no subagent named ${name} (see status)`);
	return agent;
}

/** The model `text` names (`provider/modelId`; none: the agent's own), or the refusal with close matches. */
async function modelOf(text: string | undefined, own: ModelRef | undefined, api: ToolExecutionApi): Promise<ModelRef> {
	const ref = text === undefined ? own : modelRef(text);
	if (ref !== undefined && api.models.getModel(ref.provider, ref.modelId) !== undefined) return ref;
	if (text === undefined)
		throw invalid("args", "subagent: you have no model to copy: name one with `model` (see models)");
	const available = await api.models.getAvailable(undefined, { signal: AbortSignal.timeout(MODELS_MS) });
	const close = closeModels(available, text);
	const hint = close.length === 0 ? "" : ` Close matches: ${close.join(", ")}.`;
	throw invalid("args", `subagent: no model ${text}.${hint} The models action lists them.`);
}

/**
 * The names `names` of tools the agent `own` may give now (`givable`), in the order named, each once; a name of no such
 * tool is refused, listing the ones it may give.
 */
function chosenTools(names: readonly string[], own: Agent): string[] {
	const choosable = givable(own).map((tool) => tool.name);
	for (const name of names) {
		if (choosable.includes(name)) continue;
		throw invalid(
			"args",
			`subagent: you cannot give the tool ${name}; you may give: ${choosable.join(", ") || "none"}`,
		);
	}
	return [...new Set(names)];
}
