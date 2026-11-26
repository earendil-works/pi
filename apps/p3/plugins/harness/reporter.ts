// A subagent's conversation and the messages it is sent (the subagents' part, `subagents.ts`, starts and drives them):
// the document listing a conversation's subagents (`Subagents`), the task owning each subagent's conversation
// (`Anchor`) and the task delivering one message and reporting its answer back (`Reporter`). The tasks are an
// extension of their own the harness installs always (`SUBAGENT_TASKS`), so a reporter under way when Use is withheld
// still delivers its answer: the subagent finishes its step and gets no new message, since the tool is gone.

import type { Context } from "@earendil-works/p3/v1";
import {
	AssistantEntry,
	type ConversationId,
	type configure,
	defineDoc,
	defineExtension,
	defineTask,
	type EntryId,
	type Extension,
	type Message,
	type TaskRuntime,
} from "@earendil-works/p3/v1/worker";

/**
 * A subagent: its conversation, the answers already reported (several messages may end in one answer), the model
 * (`provider/modelId`), thinking level and tools it was given (no `tools`: every tool the agent may give it, live), and
 * whether it is archived (hidden from `status`; still usable).
 */
export type Subagent = {
	readonly conversationId: ConversationId;
	readonly reported: EntryId[];
	model?: string;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	archived?: true;
};

/** A thinking level, as a conversation's agent has it. */
export type ThinkingLevel = NonNullable<Parameters<typeof configure>[2]["thinkingLevel"]>;

/** A conversation's subagents by name: the ones the `subagent` tool started there. */
export const Subagents = defineDoc<{ agents: Record<string, Subagent> }>({
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

/** What a reporter delivers: to which subagent, the message, and whether it waits for the current answer. */
export type ReporterInput = { name: string; conversationId: ConversationId; message: string; followUp: boolean };

/** A reporter's phases: deliver the message and wait for the answer, then report it (none: nothing to report). */
type ReporterState = { phase: "deliver" } | { phase: "withdraw" } | { phase: "report"; report?: string };

/** What a reporter tells the agent when the message waited behind a subagent run that failed and was withdrawn. */
const STRANDED = "its run failed before it took the message";

/**
 * Delivers one message to a subagent and reports its answer to the agent's conversation as a follow-up input, a
 * background task (the agent's stop and idle waits leave it alone). Request ids make a repeated submission return the
 * first: after a restart the subagent gets the message once and the agent the report once. A message left queued
 * behind a run that failed (Durable keeps it until the next input, which a subagent may never get) is withdrawn in a
 * phase of its own, `withdraw`, decided in a commit before the withdrawal: a restart in between withdraws it again and
 * still reports it (Astra, rounds 1, 2).
 */
export const Reporter = defineTask<ReporterInput, ReporterState, null>({
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
 * reported for a subagent the document no longer has under that name with that conversation (Astra, rounds 1, 2), nor
 * for a message withdrawn by a stop or an archive (`aborted` without `stranded`); `stranded` reports the withdrawal.
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
export function textOf(message: Message | undefined): string {
	if (message?.role !== "assistant") return "";
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** The subagents' tasks: installed always, so reporters under way finish whatever the agent's grants are now. */
export const SUBAGENT_TASKS: Extension = defineExtension({ name: "harness.subagent-tasks", tasks: [Anchor, Reporter] });
