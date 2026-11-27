// The messages to subagents (`subagents.ts` sends them): a reporter task per message, which delivers it to the
// subagent and hands its answer back to the conversation that sent it, and, when Use is withheld, the record of it and
// the withdrawal of the queued messages. The tasks (with the roster's anchor and stopper) are an extension of their own
// the harness installs always (`SUBAGENT_TASKS`), so a reporter under way when Use is withheld still reports: a
// subagent that runs finishes its step, and gets no new message.

import type { Context } from "@earendil-works/p3/v1";
import {
	AssistantEntry,
	type ConversationHandle,
	type ConversationId,
	configure,
	defineExtension,
	defineTask,
	type Extension,
	type Harness,
	LiveDoc,
	type Message,
	type SettledSubmissionRecord,
	type Submission,
	type TaskId,
	type TaskRuntime,
} from "@earendil-works/p3/v1/worker";
import { Anchor, REQUEST, requestOf, Stopper, Subagents, subagentOf, toolsOf } from "./roster.ts";

/**
 * What a reporter delivers: to which subagent (its name and conversation, and its generation when the message was
 * sent), how often Use was withheld by then (`withholds`), the message, and whether it waits for the current answer;
 * `v1`: a reporter of version 1, whose message's request id carries no generation (`subagent:<reporter>`).
 */
export type ReporterInput = {
	name: string;
	conversationId: ConversationId;
	generation: number;
	withholds: number;
	message: string;
	followUp: boolean;
	v1?: true;
};

/** A reporter's phases: deliver the message and wait for the answer, then report it (none: nothing to report). */
type ReporterState = { phase: "deliver" } | { phase: "withdraw" } | { phase: "report"; report?: string };

/** What a reporter tells the agent when the message waited behind a subagent run that failed and was withdrawn. */
const STRANDED = "its run failed before it took the message";

/** What a reporter tells the agent when the message was withdrawn otherwise before it ran (Use withheld, a stop). */
const WITHDRAWN = "the message was withdrawn before it ran (Use was withheld, or the subagent was stopped)";

/**
 * Delivers one message to a subagent and reports its answer to the conversation that sent it as a follow-up input, a
 * background task (the agent's stop and idle waits leave it alone). The message is admitted in the commit that checks
 * the subagent is still the one it was sent to, in the same generation, and that Use is not withheld; the same commit
 * gives the subagent the sender's tools as they are now. A follow-up is admitted only once the subagent is idle and the
 * follow-ups sent before it went, so the run it starts has its sender's tools (Astra, round 2 of the port); a steer
 * joins the running work at once. Request ids make a repeated submission return the first: after a restart the
 * subagent gets the message once and the agent the report once. A steer left queued behind a run that failed (Durable
 * keeps it until the next input, which a subagent may never get) is withdrawn in a phase of its own, `withdraw`,
 * decided in a commit before the withdrawal: a restart in between withdraws it again and still reports it (Astra,
 * rounds 1, 2).
 */
export const Reporter = defineTask<ReporterInput, ReporterState, null>({
	name: "harness.subagent-reporter",
	// 2: the generation and the withholds a message was sent in (decision 125: a reporter of version 1 still runs).
	version: 2,
	initial: () => ({ phase: "deliver" }),
	// Version 1 had the same phases; its messages were sent in generation 0, before any withhold.
	migrate: (input, checkpoint) => ({
		input: { ...(input as Omit<ReporterInput, "generation" | "withholds">), generation: 0, withholds: 0, v1: true },
		checkpoint: checkpoint as ReporterState,
	}),
	phases: {
		deliver: async (reporter, runtime, context) => {
			const subagent = await runtime.conversation(reporter.input.conversationId, context);
			if (subagent === undefined) return finish(runtime, context);
			if (!(await admit(reporter, subagent, runtime, context))) return;
			const submission = await subagent.submit(draftOf(reporter), context);
			const settled = await settle(subagent, submission, context);
			if (settled === "stranded") {
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "withdraw" } }), context);
				return;
			}
			await decide(reporter.input, settled, undefined, runtime, context);
		},
		withdraw: async (reporter, runtime, context) => {
			const subagent = await runtime.conversation(reporter.input.conversationId, context);
			if (subagent === undefined) return finish(runtime, context);
			const submission = await subagent.submit(draftOf(reporter), context);
			const outcome = await submission.abort(context);
			const settled = await submission.wait(context);
			// Withdrawn by this phase (now, or before a restart): stranded. Placed meanwhile, or settled otherwise: as it
			// settled (Astra, round 1 of the port).
			const ours = outcome !== "already_placed" && settled.status === "unanswered" && settled.reason === "aborted";
			await decide(reporter.input, settled, ours ? STRANDED : undefined, runtime, context);
		},
		// A follow-up input: it starts a turn when the agent is idle, or waits for its current answer. Kept when the
		// agent is stopped meanwhile (`onAbort: "keep"`): its next input takes it (Astra, round 1 of the port).
		report: async (reporter, runtime, context) => {
			const report = reporter.state.checkpoint.report;
			if (report !== undefined) {
				const sender = await runtime.conversation(runtime.conversationId, context);
				const input = { type: "input", content: report, whenBusy: "followUp", onAbort: "keep" } as const;
				await sender?.submit({ ...input, requestId: `subagent-report:${reporter.id}` }, context);
			}
			await finish(runtime, context);
		},
	},
	abort: (_reporter, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/** A reporter's task runtime. */
type ReporterRuntime = TaskRuntime<ReporterInput, ReporterState, null, object>;

/** A reporter as its phases get it. */
type Reporting = { readonly id: TaskId; readonly input: ReporterInput };

/** The reporter's message as a submission: a steer reaches a busy subagent at its next step, a follow-up after it. */
function draftOf({ id, input }: Reporting) {
	const whenBusy = input.followUp ? "followUp" : "steer";
	// Version 1's request id, so a message it submitted is found again, not sent twice.
	const requestId = input.v1 === true ? `${REQUEST}${id}` : requestOf(id, input.generation);
	return { type: "input", content: input.message, whenBusy, requestId } as const;
}

/**
 * What one admission commit decided: admitted (now, or before a restart), refused (the report decided), parked (the
 * reporter waits, without an invocation, for a pending stop's stopper or an earlier follow-up to end, then delivers
 * again), or to wait for an idle subagent.
 */
type Admission =
	| { readonly kind: "admitted" }
	| { readonly kind: "refused" }
	| { readonly kind: "parked" }
	| { readonly kind: "busy" };

/**
 * Admits the message, waiting first for an idle subagent when it is a follow-up: true once admitted (now, or before a
 * restart); false when refused (the report decided) or parked (the phase ends; it runs again once the task it waits
 * for ended).
 */
async function admit(
	reporter: Reporting,
	subagent: ConversationHandle,
	runtime: ReporterRuntime,
	context: Context,
): Promise<boolean> {
	for (;;) {
		const admission = await admitOnce(reporter, subagent, runtime, context);
		switch (admission.kind) {
			case "admitted":
				return true;
			case "refused":
			case "parked":
				return false;
			case "busy":
				await subagent.waitForIdle(context);
				break;
		}
	}
}

/**
 * One commit with the checks and the admission: refused for a subagent stopped, archived or replaced since (nothing
 * reported) and while Use is withheld (the withdrawal reported); a follow-up waits for the earlier ones and for an idle
 * subagent. Admitted, the subagent gets the sender's tools as they are now.
 */
async function admitOnce(
	reporter: Reporting,
	subagent: ConversationHandle,
	runtime: ReporterRuntime,
	context: Context,
): Promise<Admission> {
	const own = await runtime.agent(context);
	const draft = draftOf(reporter);
	let admission: Admission = { kind: "admitted" };
	await runtime.commit(async (tx) => {
		if ((await tx.submissionByRequest(subagent.id, draft.requestId)) !== undefined) return undefined;
		const roster = await tx.doc(Subagents);
		const agent = subagentOf(roster.agents, reporter.input.name);
		const sent = agent?.conversationId === reporter.input.conversationId ? agent : undefined;
		const current = sent?.generation === reporter.input.generation ? sent : undefined;
		const withdrawn = roster.withheld === true || (roster.withholds ?? 0) !== reporter.input.withholds;
		if (current === undefined || withdrawn) {
			admission = { kind: "refused" };
			if (sent !== undefined) sent.followUps = sent.followUps.filter((id) => id !== reporter.id);
			return reportOf(current === undefined ? undefined : failed(reporter.input, WITHDRAWN));
		}
		// A stop is ending the older generation's work: nothing new joins it meanwhile, so its abort cannot take it; the
		// stopper's end, which clears the mark, wakes the reporter (Astra, round 3 of the port).
		if (current.stopping !== undefined) {
			admission = { kind: "parked" };
			return parkedOn(current.stopping);
		}
		if (reporter.input.followUp) {
			const earlier = current.followUps[0];
			if (earlier !== undefined && earlier !== reporter.id) {
				// The earlier follow-up ends after its answer is reported: then this one's turn may come. One that ended
				// without taking itself off (aborted) is taken off here.
				if ((await tx.task(earlier))?.state.status === "terminal") {
					current.followUps.shift();
					admission = { kind: "busy" };
					return undefined;
				}
				admission = { kind: "parked" };
				return parkedOn(earlier);
			}
			if ((await tx.doc(LiveDoc, subagent.id)).run !== undefined) {
				admission = { kind: "busy" };
				return undefined;
			}
			current.followUps.shift();
		}
		await configure(tx, subagent.id, toolsOf(current, own));
		await subagent.admit(tx, draft);
		return undefined;
	}, context);
	return admission;
}

/** The next state: waiting, without an invocation, until task `task` ended, then delivering again. */
function parkedOn(task: TaskId) {
	return { status: "waiting", on: [task], policy: "allSettled", checkpoint: { phase: "deliver" } } as const;
}

/** The next state: the report phase, with `report` or nothing to report. */
function reportOf(report?: string) {
	const checkpoint = report === undefined ? { phase: "report" as const } : { phase: "report" as const, report };
	return { status: "running", checkpoint } as const;
}

/** The report of a message to `input`'s subagent that failed, and why. */
function failed({ name }: ReporterInput, why: string): string {
	return `[subagent ${name} failed: ${why}]`;
}

/**
 * Answered or unanswered, or `stranded` when the subagent went idle with the message still queued: no run will take
 * it, so the reporter withdraws it (in its `withdraw` phase).
 */
async function settle(
	subagent: ConversationHandle,
	submission: Submission,
	context: Context,
): Promise<SettledSubmissionRecord | "stranded"> {
	const settled = submission.wait(context);
	const idle = subagent.waitForIdle(context).then(() => "idle" as const);
	if ((await Promise.race([settled, idle])) !== "idle") return settled;
	return (await submission.status(context)).status === "queued" ? "stranded" : settled;
}

/**
 * One commit decides the report and records the answer, so a restart does not decide again. A completed answer is
 * recorded for `answer` once, also of a subagent stopped since (Astra, round 2 of the port), and reported once to each
 * conversation that sent a message it answers (two senders whose messages one run took both get it). Nothing is
 * reported for a subagent replaced or gone since (Astra, rounds 1, 2), nor for a message a stop or archive withdrew
 * (an older generation); a message withdrawn otherwise reports why (`stranded`, or Use withheld).
 */
async function decide(
	input: ReporterInput,
	settled: SettledSubmissionRecord,
	stranded: string | undefined,
	runtime: ReporterRuntime,
	context: Context,
): Promise<void> {
	await runtime.commit(async (tx) => {
		const agent = subagentOf((await tx.doc(Subagents)).agents, input.name);
		if (agent?.conversationId !== input.conversationId) return reportOf();
		if (settled.status === "unanswered") {
			if (agent.generation !== input.generation) return reportOf();
			return reportOf(failed(input, stranded ?? (settled.reason === "aborted" ? WITHDRAWN : settled.reason)));
		}
		if (settled.type !== "input") return reportOf();
		const { answer } = settled;
		if (!agent.reported.includes(answer)) agent.reported.push(answer);
		const to = runtime.conversationId;
		if (agent.reportedTo.some((each) => each.answer === answer && each.to === to)) return reportOf();
		agent.reportedTo.push({ answer, to });
		const message = (await tx.entry(AssistantEntry, answer))?.model?.[0];
		return reportOf(`[subagent ${input.name} answered] ${textOf(message)}`);
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

/**
 * Records whether Use is withheld from the agent (`offered`: the agent has the `subagent` tool), and when it is,
 * withdraws every message to a subagent still queued (a subagent that runs takes no new message). Recorded first, so a
 * reporter admitting after this commit refuses (Opus, round 2 of the port); each reporter reports its withdrawal to
 * the conversation that sent it.
 */
export async function recordUse(durable: Harness, offered: boolean, context: Context): Promise<void> {
	await durable.commit(async (tx) => {
		const roster = await tx.doc(Subagents);
		if (offered) delete roster.withheld;
		else if (roster.withheld === undefined) {
			roster.withheld = true;
			roster.withholds = (roster.withholds ?? 0) + 1;
		}
	}, context);
	if (offered) return;
	const { submissions } = await durable.inspect(context);
	for (const queued of submissions) {
		if (queued.status !== "queued" || queued.requestId?.startsWith(REQUEST) !== true) continue;
		await (await durable.submission(queued.id, context))?.abort(context);
	}
}

/** The subagents' tasks: installed always, so reporters under way finish whatever the agent's grants are now. */
export const SUBAGENT_TASKS: Extension = defineExtension({
	name: "harness.subagent-tasks",
	tasks: [Anchor, Reporter, Stopper],
});
