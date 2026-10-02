import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type ConversationId,
	configure,
	defineExtension,
	defineTask,
	defineTool,
	section,
} from "@earendil-works/pi-durable";

// ─── search: slow, fake, and safe to rerun ──────────────────────────────────

/** Canned results; each topic takes a different time, so a crash can land between them. */
const SEARCHES = {
	weather: {
		seconds: 6,
		results: ["Saturday: 24°C and sunny", "Sunday: 21°C, a short shower around 3 pm"],
	},
	museums: {
		seconds: 10,
		results: [
			"Kunsthistorisches Museum: open 10-18, book a time slot",
			"Belvedere: Klimt's The Kiss, quietest before 11",
			"Albertina: Monet to Picasso, open until 21 on Friday",
		],
	},
	trains: {
		seconds: 30,
		results: ["Railjet from Salzburg: 2h 22m, every 30 min", "Nightjet from Munich: arrives 06:20"],
	},
} as const;

const search = defineTool({
	name: "search",
	description:
		"Search travel information about a city. Topics: weather, museums, trains. Slow; call several in parallel.",
	parameters: Type.Object({
		topic: Type.Union([Type.Literal("weather"), Type.Literal("museums"), Type.Literal("trains")]),
		city: Type.String(),
	}),
	// Only reads, so a call cut off by a crash simply runs again.
	replay: "safe",
	execute: async (args, api, context) => {
		const found = SEARCHES[args.topic];
		const steps = Math.ceil(found.seconds / 2);
		for (let step = 1; step <= steps; step++) {
			api.output(`searching ${args.topic} in ${args.city}: source ${step}/${steps}\n`);
			await sleep(2000, undefined, { signal: context.abortSignal });
		}
		for (const result of found.results) api.output(`- ${result}\n`);
		return {};
	},
});

/** What the research subagent gets: only `search`. */
export const Search = defineExtension({ name: "vacation-search", tools: [search] });

// ─── research: a background subagent that reports back ──────────────────────

type ResearchState = { phase: "deliver" } | { phase: "report"; report: string };

/** Delivers the task to its subagent and posts the report to the main conversation as a new message. */
const Research = defineTask<{ task: string }, ResearchState, null>({
	name: "vacation.research",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (task, runtime, context) => {
			// The subagent's conversation is owned by this task. No Session call may run inside a commit.
			let owned: ConversationId | undefined;
			await runtime.commit(async (tx) => {
				owned = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0]?.id;
				return undefined;
			}, context);
			const child = await runtime.conversation(owned!, context);
			// A rerun after a crash gets the same submission back.
			const request = { type: "input", content: task.input.task, requestId: `research:${task.id}` } as const;
			const settled = await (await child!.submit(request, context)).wait(context);
			await runtime.commit(async (tx) => {
				let report = `[research report] The research failed: ${settled.status === "unanswered" ? settled.reason : "?"}`;
				if (settled.status === "done" && settled.type === "input") {
					const message = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0];
					const text =
						message?.role === "assistant"
							? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
							: "";
					report = `[research report] ${text}`;
				}
				return { status: "running", checkpoint: { phase: "report", report } };
			}, context);
		},
		report: async (task, runtime, context) => {
			const main = await runtime.conversation(runtime.conversationId, context);
			const report = { type: "input", content: task.state.checkpoint.report, whenBusy: "followUp" } as const;
			await main!.submit({ ...report, requestId: `research-report:${task.id}` }, context);
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

const research = defineTool({
	name: "research",
	description:
		"Start a research subagent in the background. It searches while you keep talking with the user; its report arrives later as a message starting with [research report].",
	parameters: Type.Object({ task: Type.String({ description: "What to research, with the city and dates" }) }),
	execute: async (args, api, context) => {
		await api.commit(async (tx) => {
			// Background: the main conversation stays free while the research runs.
			const owner = await tx.createTask(
				Research,
				{ task: args.task },
				{ ownership: { kind: "conversation" }, background: true },
			);
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
			await configure(tx, child.id, {
				extensions: [Search],
				instructions:
					"You are a research subagent for a vacation planner. Search weather, museums, and trains in parallel, in one step, then report the findings in a few short bullet points.",
			});
		}, context);
		return { content: [{ type: "text", text: "Research started in the background." }] };
	},
});

/** What the main conversation gets: the prompt, `research`, and the task that delivers its report. */
export const Vacation = defineExtension({
	name: "vacation",
	tools: [research],
	tasks: [Research],
	sections: [
		section(
			"preamble",
			() =>
				"You are a friendly vacation planning assistant. Keep answers short. Hand all research to the research tool; while it runs, keep chatting with the user. When a [research report] arrives, turn it into a short plan.",
			{ tag: false },
		),
	],
});
