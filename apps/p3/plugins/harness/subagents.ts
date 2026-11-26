// The subagents' harness part (`harness.subagents`): the one tool `subagent`, with a tagged action (spawn, send,
// configure, stop, archive, restore, answer, status, models), offered while the agent's reference has the flag `use`.
// Each subagent is a conversation of the session, named by the agent, its transcript the session's (decision 76): it
// starts as a copy of the session's agent (the same things: it is the same party), with a model, thinking level and
// tools of its own if the agent chose them. The tool has `scope: "main"`: a subagent is never given it (its tools
// leave it out, and the harness refuses its calls there), so no subagent starts subagents (decision 116). Messages
// travel in reporter tasks (`reporter.ts`), which hand each answer back to the agent as a new message once it arrives.

import { arr, bool, type Context, invalid, obj, oneOf, opt, type Static, str } from "@earendil-works/p3/v1";
import {
	AssistantEntry,
	type ConversationId,
	configure,
	defineTool,
	LiveDoc,
	type ToolExecutionApi,
} from "@earendil-works/p3/v1/worker";
import { type HarnessExtension, type HarnessTool, thingHarnessPart } from "../things/contract.worker.ts";
import { SubagentsKind } from "./kind.ts";
import { closeModels, listModels, refOf } from "./model-list.ts";
import { Anchor, Reporter, type Subagent, Subagents, textOf } from "./reporter.ts";

/** The subagents' part: the `subagent` tool while the nearest reference has `use` (the kind stacks `nearest`). */
export const subagentsPart = thingHarnessPart(SubagentsKind, (things) => {
	const nearest = things[things.length - 1];
	if (nearest === undefined || !nearest.ref.granted.has("use")) return {};
	return { extension: SUBAGENT_TOOLS };
});

/** The thinking levels a subagent may be given (its model's provider clamps them to what the model has). */
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

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

/** The tool `subagent`: one action per call, answering JSON (a subagent's answer as its own text). */
const subagentTool = defineTool({
	name: "subagent",
	description: [
		"Manages your subagents: each is a persistent conversation of its own, a copy of you working in the background",
		"while you go on. Answers JSON. Actions (`action`):",
		"- spawn (`name`, `message`; optional `model`, `thinkingLevel`, `tools`): starts a subagent and sends it its first",
		"  message. `model` is `provider/modelId` (default: yours; see models); `thinkingLevel` is",
		"  off|minimal|low|medium|high|xhigh|max (default: yours); `tools` names tools of yours it gets (default: every",
		"  one you may give it, as yours change; [] for none). This tool cannot be given.",
		"- send (`name`, `message`; `followUp: true` waits until its current answer instead of reaching it at its next",
		"  step). Restores an archived subagent.",
		"- configure (`name`; `model`, `thinkingLevel`, `tools`): replaces them for its later work.",
		"- stop (`name`): stops its current work and drops its queued messages; it stays usable.",
		"- archive (`name`): stops it and hides it from status; restore (`name`) or send brings it back.",
		"- answer (`name`): its latest completed answer again, as its text.",
		"- status (optional `name`): your subagents, whether each is working, its model, thinking level and tools;",
		"  archived ones only by name.",
		"- models (optional `model`: a provider or words of a model's id or name): the models you can give, by `model`.",
		"Each answer comes back to you as a message `[subagent <name> answered] ...` once it arrives (or",
		"`[subagent <name> failed: ...]`): do not wait or poll for it.",
	].join("\n"),
	parameters: Args,
	// A call a crash interrupted is not run again (a stop must not hit newer work): the model sees it was
	// interrupted and can check with status.
	replay: "unsafe",
	execute: async (call, api, context) => {
		const answer = await act(call, api, context);
		return { output: [{ type: "text", text: typeof answer === "string" ? answer : JSON.stringify(answer) }] };
	},
});

/** The subagent tools (the harness installs them under the kind's name): the one tool, for the main conversation. */
const SUBAGENT_TOOLS: HarnessExtension = { tools: [{ ...subagentTool, scope: "main" }] };

/** What an action answers: a value the tool answers as JSON, or a subagent's text as it is. */
type Answer = string | object;

/** Runs `call`'s action. */
function act(call: Call, api: ToolExecutionApi, context: Context): Promise<Answer> {
	switch (call.action) {
		case "spawn":
			return spawn(call, api, context);
		case "send":
			return send(call, api, context);
		case "configure":
			return configureAgent(call, api, context);
		case "stop":
			return stop(call, api, context);
		case "archive":
			return archive(call, api, context);
		case "restore":
			return restore(call, api, context);
		case "answer":
			return answerOf(call, api, context);
		case "status":
			return status(call, api, context);
		case "models":
			return models(call, api);
	}
}

/** Both tasks belong to the agent's conversation and are background: its stop and idle waits skip them. */
const BACKGROUND = { ownership: { kind: "conversation" }, background: true } as const;

/** Starts the subagent `name` and sends it `message`. */
async function spawn(call: Call, api: ToolExecutionApi, context: Context): Promise<Answer> {
	const name = nameOf(call);
	const message = messageOf(call);
	if (Object.hasOwn(await subagentsOf(api, context), name)) throw exists(name);
	const choice = await choose(call, undefined, api, context);
	await api.commit(async (tx) => {
		const state = await tx.doc(Subagents, api.conversationId);
		// Spawned meanwhile by a call running beside this one.
		if (Object.hasOwn(state.agents, name)) throw exists(name);
		const anchor = await tx.createTask(Anchor, null, BACKGROUND);
		// Owned by a task of the agent's conversation: it starts as a copy of the agent.
		const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
		await configure(tx, child.id, { ...choice.change, instructions: instructionsOf(name) });
		state.agents[name] = { conversationId: child.id, reported: [], ...choice.recorded };
		await tx.createTask(Reporter, { name, conversationId: child.id, message, followUp: false }, BACKGROUND);
	}, context);
	return { name };
}

/** The refusal of a name that is taken. */
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

/** Sends `message` to the subagent `name` (a steer, or a follow-up), restoring it if archived. */
async function send(call: Call, api: ToolExecutionApi, context: Context): Promise<Answer> {
	const name = nameOf(call);
	const message = messageOf(call);
	await api.commit(async (tx) => {
		const agent = subagentNamed((await tx.doc(Subagents, api.conversationId)).agents, name);
		delete agent.archived;
		const input = { name, conversationId: agent.conversationId, message, followUp: call.followUp === true };
		await tx.createTask(Reporter, input, BACKGROUND);
	}, context);
	return { name };
}

/** Gives the subagent `name` another model, thinking level or tools, for its later work. */
async function configureAgent(call: Call, api: ToolExecutionApi, context: Context): Promise<Answer> {
	const name = nameOf(call);
	if (call.model === undefined && call.thinkingLevel === undefined && call.tools === undefined)
		throw invalid("args", "subagent: configure takes `model`, `thinkingLevel` or `tools`");
	const current = subagentNamed(await subagentsOf(api, context), name);
	const choice = await choose(call, current, api, context);
	await api.commit(async (tx) => {
		const agent = subagentNamed((await tx.doc(Subagents, api.conversationId)).agents, name);
		await configure(tx, agent.conversationId, choice.change);
		Object.assign(agent, choice.recorded);
	}, context);
	const agent = subagentNamed(await subagentsOf(api, context), name);
	return statusOf(name, agent, await working(agent.conversationId, api, context));
}

/** Stops what the subagent `name` is doing and drops its queued messages; it stays. */
async function stop(call: Call, api: ToolExecutionApi, context: Context): Promise<{ name: string }> {
	const name = nameOf(call);
	const agent = subagentNamed(await subagentsOf(api, context), name);
	await (await api.conversation(agent.conversationId, context))?.abort(context);
	return { name };
}

/** Stops the subagent `name` and hides it from status (`restore` or `send` brings it back). */
async function archive(call: Call, api: ToolExecutionApi, context: Context): Promise<Answer> {
	const { name } = await stop(call, api, context);
	await api.commit(async (tx) => {
		subagentNamed((await tx.doc(Subagents, api.conversationId)).agents, name).archived = true;
	}, context);
	return { name };
}

/** Shows the archived subagent `name` in status again. */
async function restore(call: Call, api: ToolExecutionApi, context: Context): Promise<Answer> {
	const name = nameOf(call);
	await api.commit(async (tx) => {
		delete subagentNamed((await tx.doc(Subagents, api.conversationId)).agents, name).archived;
	}, context);
	return { name };
}

/** The latest completed answer of the subagent `name`, as its text. */
async function answerOf(call: Call, api: ToolExecutionApi, context: Context): Promise<Answer> {
	const name = nameOf(call);
	const agent = subagentNamed(await subagentsOf(api, context), name);
	const answer = await latestAnswer(agent.conversationId, api, context);
	if (answer !== undefined) return answer;
	const busy = (await working(agent.conversationId, api, context)) ? " (it is working)" : "";
	throw invalid("args", `subagent: ${name} has not answered yet${busy}`);
}

/** How many entries `answer` looks through, newest first, for a completed answer; and how many per read. */
const MAX_SCANNED = 2000;
const PAGE = 200;

/** The newest answer of `conversationId` that completed (stop reason `stop`) with text; none in the newest entries. */
async function latestAnswer(
	conversationId: ConversationId,
	api: ToolExecutionApi,
	context: Context,
): Promise<string | undefined> {
	return api.commit(async (tx) => {
		let cursor: Parameters<typeof tx.scanEntries>[2];
		for (let scanned = 0; scanned < MAX_SCANNED; scanned += PAGE) {
			const page = await tx.scanEntries({ conversationId }, PAGE, cursor);
			for (const entry of page.items) {
				const message = AssistantEntry.is(entry) ? entry.model?.[0] : undefined;
				const text = textOf(message);
				if (message?.role === "assistant" && message.stopReason === "stop" && text.trim() !== "") return text;
			}
			if (page.next === undefined) return undefined;
			cursor = page.next;
		}
		return undefined;
	}, context);
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
		subagents.push(statusOf(name, agent, await working(agent.conversationId, api, context)));
	const archived = named === undefined ? Object.keys(agents).length - listed.length : 0;
	return archived === 0 ? { subagents } : { subagents, archived };
}

/** A subagent as status shows it. */
function statusOf(name: string, agent: Subagent, busy: boolean) {
	return {
		name,
		working: busy,
		model: agent.model,
		thinkingLevel: agent.thinkingLevel,
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

/** The agent's subagents as its conversation's document has them. */
async function subagentsOf(api: ToolExecutionApi, context: Context): Promise<Record<string, Subagent>> {
	return (await api.snapshot(Subagents, api.conversationId, context))?.agents ?? {};
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
	const agent = Object.hasOwn(agents, name) ? agents[name] : undefined;
	if (agent === undefined) throw invalid("args", `subagent: you have no subagent named ${name} (see status)`);
	return agent;
}

/** A conversation's agent settings as `configure` changes them. */
type AgentChange = Parameters<typeof configure>[2];

/** A subagent's checked choice: the change of its conversation's agent, and what the document records of it. */
type Choice = { readonly change: AgentChange; readonly recorded: Partial<Subagent> };

/**
 * Checks a spawn's or configure's choice before anything is written, so a typo changes nothing. Unset fields keep
 * `current`'s, or for a new subagent take the agent's model and thinking level and every tool it may give (live: the
 * tools the agent holds, minus the `main` ones). A subagent always gets the `subagent`-scoped tools, loaded.
 */
async function choose(
	call: Call,
	current: Subagent | undefined,
	api: ToolExecutionApi,
	context: Context,
): Promise<Choice> {
	const own = await api.agent(context);
	const model = await modelOf(call.model ?? current?.model, own.model, api);
	const thinkingLevel = call.thinkingLevel ?? current?.thinkingLevel ?? own.thinkingLevel;
	const recorded = { model: refOf({ provider: model.provider, id: model.modelId }), thinkingLevel };
	const level = { model, thinkingLevel };
	// A configure without `tools` leaves the subagent's tools as they are.
	if (call.tools === undefined && current !== undefined) return { change: level, recorded };
	const every = everyTool(own);
	const subagentOnly = every.filter((tool) => tool.scope === "subagent");
	const loaded = { modelTools: { add: subagentOnly } };
	if (call.tools === undefined) {
		const tools = { remove: every.filter((tool) => tool.scope === "main") };
		return { change: { ...level, ...loaded, tools }, recorded };
	}
	const chosen = chosenTools(call.tools, every);
	// Deferred tools it was given by name are offered from the start, as the `subagent` ones.
	const offered = [...subagentOnly, ...chosen.filter((tool) => tool.deferred === true)];
	return {
		change: { ...level, tools: [...chosen, ...subagentOnly], modelTools: { add: offered } },
		recorded: { ...recorded, tools: chosen.map((tool) => tool.name) },
	};
}

/** A model reference, as a conversation's agent names it. */
type ModelRef = NonNullable<Awaited<ReturnType<ToolExecutionApi["agent"]>>["model"]>;

/** The model `text` names (`provider/modelId`; none: the agent's own), or the refusal with close matches. */
async function modelOf(text: string | undefined, own: ModelRef | undefined, api: ToolExecutionApi): Promise<ModelRef> {
	if (text === undefined) {
		if (own !== undefined && api.models.getModel(own.provider, own.modelId) !== undefined) return own;
		throw invalid("args", "subagent: you have no model to copy: name one with `model` (see models)");
	}
	// The model id may hold more slashes: the provider ends at the first.
	const slash = text.indexOf("/");
	const ref = { provider: text.slice(0, slash), modelId: text.slice(slash + 1) };
	if (slash > 0 && api.models.getModel(ref.provider, ref.modelId) !== undefined) return ref;
	const available = await api.models.getAvailable(undefined, { signal: AbortSignal.timeout(MODELS_MS) });
	const close = closeModels(available, text);
	const hint = close.length === 0 ? "" : ` Close matches: ${close.join(", ")}.`;
	throw invalid("args", `subagent: no model ${text}.${hint} The models action lists them.`);
}

/**
 * Every tool the agent has, each once: offered, deferred, and those only other tools call; with their scopes (every
 * tool the harness installs is a kind's, a `HarnessTool`).
 */
function everyTool(agent: Awaited<ReturnType<ToolExecutionApi["agent"]>>): HarnessTool[] {
	const all = [...agent.tools, ...agent.deferred, ...agent.callable];
	return [...new Map(all.map((tool) => [tool.name, tool])).values()];
}

/**
 * The tools `names` names among those the agent may give (the model calls them, no scope), in the order named, each
 * once; a name matches regardless of case when only one tool has it so (providers may show other casings). A name of
 * no such tool is refused, listing the ones it may give.
 */
function chosenTools(names: readonly string[], every: readonly HarnessTool[]): HarnessTool[] {
	const choosable = every.filter((tool) => tool.scope === undefined && (tool.callers?.includes("model") ?? true));
	const chosen = new Set<HarnessTool>();
	for (const name of names) {
		const exact = choosable.find((tool) => tool.name === name);
		const folded = choosable.filter((tool) => tool.name.toLowerCase() === name.toLowerCase());
		const tool = exact ?? (folded.length === 1 ? folded[0] : undefined);
		if (tool === undefined) {
			const names = choosable.map((each) => each.name).join(", ");
			throw invalid("args", `subagent: you cannot give the tool ${name}; you may give: ${names || "none"}`);
		}
		chosen.add(tool);
	}
	return [...chosen];
}
