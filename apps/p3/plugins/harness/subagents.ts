// The subagents' harness part (`harness.subagents`): the tools to start, steer, list and archive subagents, offered
// while the agent's reference has the flag `use`. Each subagent is a conversation of the session, named by the agent,
// its transcript the session's (decision 76); it starts as a copy of the session's agent (the same things: it is the
// same party) without the subagent tools, so it starts none of its own. A message to a subagent travels in a reporter
// task, which hands the answer back to the agent as a new message once it arrives. The tasks are an extension of their
// own the harness installs always (`SUBAGENT_TASKS`), so a reporter under way when Use is withheld still delivers its
// answer: the subagent finishes its step and gets no new message, since the tools are gone.

import { bool, type Context, obj, opt, str } from "@earendil-works/p3/v1";
import {
	AssistantEntry,
	type ConversationId,
	configure,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type EntryId,
	type Extension,
	LiveDoc,
	type Message,
	type TaskRuntime,
	type ToolExecutionApi,
} from "@earendil-works/p3/v1/worker";
import { thingHarnessPart } from "../things/contract.worker.ts";
import { SubagentsKind } from "./kind.ts";

/** The subagents' part: the four tools while the nearest reference has `use` (the kind stacks `nearest`). */
export const subagentsPart = thingHarnessPart(SubagentsKind, (things) => {
	const nearest = things[things.length - 1];
	if (nearest === undefined || !nearest.ref.granted.has("use")) return {};
	return { extension: SUBAGENT_TOOLS };
});

/** A subagent: its conversation, and the answers already reported (several messages may end in one answer). */
type Subagent = { readonly conversationId: ConversationId; readonly reported: EntryId[] };

/** The session agent's subagents by name, in its conversation. */
const Subagents = defineDoc<{ agents: Record<string, Subagent> }>({
	checkpointWhen: () => false,
	kind: "harness.subagents",
	version: 1,
	scope: "conversation",
	history: "latest",
	// A fork of the conversation starts without subagents.
	fork: "initial",
	initial: () => ({ agents: {} }),
});

/**
 * What owns a subagent's conversation: a background task that ends at once. A subagent outlives the agent's turns; a
 * background task is a boundary, so the agent's stop and idle waits do not reach it.
 */
const Anchor = defineTask<null, { phase: "done" }, null>({
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

/** What a reporter delivers: to which subagent, the message, and whether it waits for the current answer. */
type ReporterInput = { name: string; conversationId: ConversationId; message: string; followUp: boolean };

/** A reporter's phases: deliver the message and wait for the answer, then report it (none: nothing to report). */
type ReporterState = { phase: "deliver" } | { phase: "withdraw" } | { phase: "report"; report?: string };

/** What a reporter tells the agent when the message waited behind a subagent run that failed and was withdrawn. */
const STRANDED = "its run failed before it took the message";

/**
 * Delivers one message to a subagent and reports its answer to the agent, a background task (the agent's stop and
 * idle waits leave it alone). Request ids make a repeated submission return the first: after a restart the subagent
 * gets the message once and the agent the report once. A message left queued behind a run that failed (Durable keeps
 * it until the next input, which a subagent may never get) is withdrawn in a phase of its own, `withdraw`, decided in
 * a commit before the withdrawal: a restart in between withdraws it again and still reports it (Astra, rounds 1, 2).
 */
const Reporter = defineTask<ReporterInput, ReporterState, null>({
	name: "harness.subagent-reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (reporter, runtime, context) => {
			const sent = await send(reporter, runtime, context);
			if (sent === undefined) return finish(runtime, context);
			const settled = await settle(sent.subagent, sent.submission, context);
			if (settled === "stranded") {
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "withdraw" } }), context);
				return;
			}
			await decide(reporter.input, settled, undefined, runtime, context);
		},
		withdraw: async (reporter, runtime, context) => {
			const sent = await send(reporter, runtime, context);
			if (sent === undefined) return finish(runtime, context);
			// Placed meanwhile after all, or settled: it reports as delivered; withdrawn by us: as stranded.
			const outcome = await sent.submission.abort(context);
			const settled = await sent.submission.wait(context);
			const why = outcome === "already_placed" ? undefined : STRANDED;
			await decide(reporter.input, settled, why, runtime, context);
		},
		// A follow-up input: it starts a turn when the agent is idle, or waits for its current answer.
		report: async (reporter, runtime, context) => {
			const report = reporter.state.checkpoint.report;
			if (report !== undefined) {
				const main = await runtime.conversation(runtime.conversationId, context);
				const input = { type: "input", content: report, whenBusy: "followUp" } as const;
				await main?.submit({ ...input, requestId: `subagent-report:${reporter.id}` }, context);
			}
			await finish(runtime, context);
		},
	},
	abort: (_reporter, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/** A reporter's task runtime. */
type ReporterRuntime = TaskRuntime<ReporterInput, ReporterState, null, object>;

/** A subagent's conversation, as a task reaches it (Durable's `ConversationHandle`). */
type Child = NonNullable<Awaited<ReturnType<ReporterRuntime["conversation"]>>>;

/** A message submitted to a subagent (Durable's `Submission`). */
type Sent = Awaited<ReturnType<Child["submit"]>>;

/** How a submitted message settled (Durable's `SettledSubmissionRecord`). */
type Settled = Awaited<ReturnType<Sent["wait"]>>;

/** Submits the reporter's message (again: the request id returns the first submission); none: the subagent is gone. */
async function send(
	reporter: { readonly id: string | number; readonly input: ReporterInput },
	runtime: ReporterRuntime,
	context: Context,
): Promise<{ subagent: Child; submission: Sent } | undefined> {
	const { conversationId, message, followUp } = reporter.input;
	const subagent = await runtime.conversation(conversationId, context);
	if (subagent === undefined) return undefined;
	// While the subagent is busy, a steer reaches it at its next step and a follow-up after its current answer.
	const request = { type: "input", content: message, whenBusy: followUp ? "followUp" : "steer" } as const;
	const submission = await subagent.submit({ ...request, requestId: `subagent:${reporter.id}` }, context);
	return { subagent, submission };
}

/**
 * Answered or unanswered, or `stranded` when the subagent went idle with the message still queued: no run will take
 * it, so the reporter withdraws it (in its `withdraw` phase).
 */
async function settle(subagent: Child, submission: Sent, context: Context): Promise<Settled | "stranded"> {
	const settled = submission.wait(context);
	const idle = subagent.waitForIdle(context).then(() => "idle" as const);
	if ((await Promise.race([settled, idle])) !== "idle") return settled;
	return (await submission.status(context)).status === "queued" ? "stranded" : settled;
}

/**
 * One commit decides the report and records the answer as delivered, so a restart does not decide again. Nothing is
 * reported for a subagent archived meanwhile or whose name was given to a new one since (Astra, rounds 1, 2), nor for
 * a message withdrawn by an archive (`aborted` without `stranded`); `stranded` reports the withdrawal.
 */
async function decide(
	{ name, conversationId }: ReporterInput,
	settled: Settled,
	stranded: string | undefined,
	runtime: ReporterRuntime,
	context: Context,
): Promise<void> {
	await runtime.commit(async (tx) => {
		const next = (report?: string) => ({ status: "running", checkpoint: { phase: "report", report } }) as const;
		const agents = (await tx.doc(Subagents, runtime.conversationId)).agents;
		const agent = Object.hasOwn(agents, name) ? agents[name] : undefined;
		if (agent === undefined || agent.conversationId !== conversationId) return next();
		if (settled.status === "unanswered") {
			const why = stranded ?? (settled.reason === "aborted" ? undefined : settled.reason);
			return next(why === undefined ? undefined : `[subagent ${name} failed: ${why}]`);
		}
		if (settled.type !== "input" || agent.reported.includes(settled.answer)) return next();
		agent.reported.push(settled.answer);
		const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0];
		return next(`[subagent ${name} answered] ${textOf(answer)}`);
	}, context);
}

/** Ends a reporter: completed. */
function finish(runtime: ReporterRuntime, context: Context): Promise<void> {
	return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
}

/** The text of an answer's message (an assistant's). */
function textOf(message: Message | undefined): string {
	if (message?.role !== "assistant") return "";
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** The subagents' tasks: installed always, so reporters under way finish whatever the agent's grants are now. */
export const SUBAGENT_TASKS: Extension = defineExtension({ name: "harness.subagent-tasks", tasks: [Anchor, Reporter] });

/** A tool's answer to the model. */
function reply(text: string) {
	return { output: [{ type: "text" as const, text }] };
}

/** The agent's subagents as its conversation's document has them. */
async function subagentsOf(api: ToolExecutionApi, context: Context): Promise<Record<string, Subagent>> {
	return (await api.snapshot(Subagents, api.conversationId, context))?.agents ?? {};
}

/** Both tasks belong to the agent's conversation and are background: its stop and idle waits skip them. */
const BACKGROUND = { ownership: { kind: "conversation" }, background: true } as const;

const spawnTool = defineTool({
	name: "subagent_spawn",
	description:
		"Starts a subagent named `name`, a copy of you without these subagent tools, working in the background on " +
		"`message`. Its answer comes back to you as a message once it arrives.",
	parameters: obj({ name: str({ min: 1, max: 100 }), message: str({ min: 1 }) }),
	// A call a crash interrupted is not run again: the model sees it was interrupted and can check with subagent_list.
	replay: "unsafe",
	execute: async ({ name, message }, api, context) => {
		const said = await api.commit(async (tx) => {
			const state = await tx.doc(Subagents, api.conversationId);
			if (Object.hasOwn(state.agents, name)) return `${name} exists already; use subagent_send.`;
			const anchor = await tx.createTask(Anchor, null, BACKGROUND);
			// Owned by a task of the agent's conversation: it starts as a copy of the agent.
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			await configure(tx, child.id, {
				extensions: { remove: [{ name: SubagentsKind.name }] },
				instructions: `You are the subagent "${name}" of this session's agent. Answer its requests.`,
			});
			state.agents[name] = { conversationId: child.id, reported: [] };
			await tx.createTask(Reporter, { name, conversationId: child.id, message, followUp: false }, BACKGROUND);
			return `Started ${name}.`;
		}, context);
		return reply(said);
	},
});

const sendTool = defineTool({
	name: "subagent_send",
	description:
		"Sends `message` to the subagent `name`. While it works, the message reaches it at its next step; with " +
		"`followUp: true` it waits until its current answer instead. The answer comes back to you as a message.",
	parameters: obj({ name: str(), message: str({ min: 1 }), followUp: opt(bool()) }),
	replay: "unsafe",
	execute: async ({ name, message, followUp }, api, context) => {
		const said = await api.commit(async (tx) => {
			const agents = (await tx.doc(Subagents, api.conversationId)).agents;
			const agent = Object.hasOwn(agents, name) ? agents[name] : undefined;
			if (agent === undefined) return `No subagent named ${name} (see subagent_list).`;
			const input = { name, conversationId: agent.conversationId, message, followUp: followUp === true };
			await tx.createTask(Reporter, input, BACKGROUND);
			return `Sent to ${name}.`;
		}, context);
		return reply(said);
	},
});

const listTool = defineTool({
	name: "subagent_list",
	description: "Lists your subagents, each working or idle.",
	parameters: obj({}),
	replay: "safe",
	execute: async (_args, api, context) => {
		const lines: string[] = [];
		for (const [name, { conversationId }] of Object.entries(await subagentsOf(api, context))) {
			// A conversation is busy while it has a run: from an input until its answer.
			const busy = (await api.snapshot(LiveDoc, conversationId, context))?.run !== undefined;
			lines.push(`${name}: ${busy ? "working" : "idle"}`);
		}
		return reply(lines.length === 0 ? "No subagents." : lines.join("\n"));
	},
});

const archiveTool = defineTool({
	name: "subagent_archive",
	description:
		"Archives the subagent `name`: stops what it is doing and drops its queued messages; its name is free again. " +
		"Its transcript stays in the session.",
	parameters: obj({ name: str() }),
	replay: "unsafe",
	execute: async ({ name }, api, context) => {
		const agent = (await subagentsOf(api, context))[name];
		if (agent === undefined) return reply(`No subagent named ${name} (see subagent_list).`);
		await (await api.conversation(agent.conversationId, context))?.abort(context);
		await api.commit(async (tx) => {
			delete (await tx.doc(Subagents, api.conversationId)).agents[name];
		}, context);
		return reply(`Archived ${name}.`);
	},
});

/** The subagent tools (the harness installs them under the kind's name, which `subagent_spawn` leaves out). */
const SUBAGENT_TOOLS = { tools: [spawnTool, sendTool, listTool, archiveTool] };
