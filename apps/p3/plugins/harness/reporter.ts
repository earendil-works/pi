// The messages to subagents (`subagents.ts` sends them): a reporter task per message, which delivers it to the
// subagent and hands its answer back to the conversation that sent it, and the withdrawal of the queued ones when Use
// is withheld. The tasks are an extension of their own the harness installs always (`SUBAGENT_TASKS`), so a reporter
// under way when Use is withheld still reports: a subagent that runs finishes its step, and gets no new message.

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
	type Message,
	type SettledSubmissionRecord,
	type Submission,
	type TaskRuntime,
} from "@earendil-works/p3/v1/worker";
import { Anchor, SUBAGENT_TOOL, type Subagent, Subagents, toolsOf } from "./roster.ts";

/**
 * What a reporter delivers: to which subagent (its name and conversation, and its generation when the message was
 * sent), the message, and whether it waits for the current answer.
 */
export type ReporterInput = {
	name: string;
	conversationId: ConversationId;
	generation: number;
	message: string;
	followUp: boolean;
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
 * the subagent is still the one it was sent to, in the same generation, and that the agent still has the `subagent`
 * tool; the same commit gives the subagent the agent's tools as they are now. Request ids make a repeated submission
 * return the first: after a restart the subagent gets the message once and the agent the report once. A message left
 * queued behind a run that failed (Durable keeps it until the next input, which a subagent may never get) is withdrawn
 * in a phase of its own, `withdraw`, decided in a commit before the withdrawal: a restart in between withdraws it again
 * and still reports it (Astra, rounds 1, 2).
 */
export const Reporter = defineTask<ReporterInput, ReporterState, null>({
	name: "harness.subagent-reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
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
type Reporting = { readonly id: string | number; readonly input: ReporterInput };

/** The prefix of a message's request id: `subagent:<reporter>`. */
const REQUEST = "subagent:";

/** The reporter's message as a submission: a steer reaches a busy subagent at its next step, a follow-up after it. */
function draftOf({ id, input }: Reporting) {
	const whenBusy = input.followUp ? "followUp" : "steer";
	return { type: "input", content: input.message, whenBusy, requestId: `${REQUEST}${id}` } as const;
}

/**
 * Admits the message in one commit with its checks, and gives the subagent the agent's tools as they are now; true:
 * admitted (now, or before a restart). Refused, the same commit decides the report: nothing for a subagent stopped,
 * archived or replaced since; the withdrawal for an agent without the `subagent` tool (Use withheld).
 */
async function admit(
	reporter: Reporting,
	subagent: ConversationHandle,
	runtime: ReporterRuntime,
	context: Context,
): Promise<boolean> {
	const own = await runtime.agent(context);
	const draft = draftOf(reporter);
	let admitted = false;
	await runtime.commit(async (tx) => {
		if ((await tx.submissionByRequest(subagent.id, draft.requestId)) !== undefined) {
			admitted = true;
			return undefined;
		}
		const agent = current(reporter.input, (await tx.doc(Subagents)).agents);
		if (agent === undefined) return reportOf();
		if (!own.tools.some((tool) => tool.name === SUBAGENT_TOOL)) return reportOf(failed(reporter.input, WITHDRAWN));
		await configure(tx, subagent.id, toolsOf(agent, own));
		await subagent.admit(tx, draft);
		admitted = true;
		return undefined;
	}, context);
	return admitted;
}

/** The subagent `input` was sent to, if it is still that one in the same generation (not stopped or archived since). */
function current(input: ReporterInput, agents: Record<string, Subagent>): Subagent | undefined {
	const agent = Object.hasOwn(agents, input.name) ? agents[input.name] : undefined;
	if (agent?.conversationId !== input.conversationId || agent.generation !== input.generation) return undefined;
	return agent;
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
 * One commit decides the report and records the answer as delivered, so a restart does not decide again. Nothing is
 * reported for a subagent stopped, archived or replaced since (`current`: Astra, rounds 1, 2), so a stop's withdrawal
 * is silent; a message withdrawn otherwise reports why (`stranded`, or Use withheld).
 */
async function decide(
	input: ReporterInput,
	settled: SettledSubmissionRecord,
	stranded: string | undefined,
	runtime: ReporterRuntime,
	context: Context,
): Promise<void> {
	await runtime.commit(async (tx) => {
		const agent = current(input, (await tx.doc(Subagents)).agents);
		if (agent === undefined) return reportOf();
		if (settled.status === "unanswered") {
			const why = stranded ?? (settled.reason === "aborted" ? WITHDRAWN : settled.reason);
			return reportOf(failed(input, why));
		}
		if (settled.type !== "input" || agent.reported.includes(settled.answer)) return reportOf();
		agent.reported.push(settled.answer);
		const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0];
		return reportOf(`[subagent ${input.name} answered] ${textOf(answer)}`);
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
 * Withdraws every message to a subagent still queued (Use withheld: a subagent that runs takes no new message). Each
 * reporter then reports the withdrawal to the conversation that sent it.
 */
export async function withdrawQueued(durable: Harness, context: Context): Promise<void> {
	const { submissions } = await durable.inspect(context);
	for (const queued of submissions) {
		if (queued.status !== "queued" || queued.requestId?.startsWith(REQUEST) !== true) continue;
		await (await durable.submission(queued.id, context))?.abort(context);
	}
}

/** The subagents' tasks: installed always, so reporters under way finish whatever the agent's grants are now. */
export const SUBAGENT_TASKS: Extension = defineExtension({ name: "harness.subagent-tasks", tasks: [Anchor, Reporter] });
