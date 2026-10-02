// Persistent background subagents. One `subagent` tool lets the main agent start named subagents, message them
// (steer or follow up), stop them mid-answer, and list them. Subagents keep working while the main agent
// answers the user, and each answer is delivered back to the main agent as a new message once it arrives. Everything
// survives a restart: the example closes the Harness while a subagent works and reopens it.
// Uses OpenAI when OPENAI_API_KEY is set, and a scripted faux model otherwise.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/23-subagent-background.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessage, type FauxResponseStep, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
	type AgentEvent,
	AssistantEntry,
	type ConversationId,
	configure,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type EntryId,
	Harness,
	LiveDoc,
	type TaskId,
	watchEvents,
} from "../../src/index.ts";
import { openNodeSqliteStorage } from "../../src/storage/sqlite/node.ts";

const context = BACKGROUND_CONTEXT;

// ─── Product code ────────────────────────────────────────────────────────────

// Each subagent is its own conversation with its own transcript, so it remembers earlier messages. The main
// conversation keeps a small document that maps subagent names to their conversations. Documents are durable state
// next to a transcript, changed in commits like entries.
type Subagent = {
	conversationId: ConversationId;
	/** Answers already reported to the main agent: several messages can end in one answer, reported once. */
	reported: EntryId[];
};
const Subagents = defineDoc<{ agents: Record<string, Subagent>; reporters: Record<string, TaskId> }>({
	kind: "app.subagents",
	version: 1,
	scope: "conversation",
	history: "latest",
	// A fork of the main conversation starts without subagents.
	fork: "initial",
	initial: () => ({ agents: {}, reporters: {} }),
});

// Every task and conversation has an owner, and that decides what an abort or an idle wait reaches: aborting a task
// aborts what it owns, and waiting for a conversation to be idle waits for its work. A subagent must outlive the main
// agent's turns, so its conversation is owned by an anchor: a background task that finishes at once. A background task
// is a boundary: the main agent's Esc and idle waits stop there, but `abort({ background: true })` still reaches past
// it, so a host can stop everything.
const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "app.subagent-anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_anchor, runtime, taskContext) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), taskContext),
	},
	abort: (_anchor, runtime, taskContext) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});

// A reporter delivers one message to a subagent and reports the answer to the main agent. It is a background task
// too, so the main agent's Esc and idle waits leave it alone. Tasks are durable: each phase ends with a saved
// checkpoint, and after a restart the task continues from the last one. Request IDs make a repeated submission return
// the first one, so the subagent gets the message once and the main agent gets the report once.
type ReporterInput = { name: string; conversationId: ConversationId; message: string; followUp: boolean };
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };
const Reporter = defineTask<ReporterInput, ReporterState, null>({
	name: "app.subagent-reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		// Send the message, wait for its answer, and decide what to report.
		deliver: async (reporter, runtime, taskContext) => {
			const { name, conversationId, message, followUp } = reporter.input;
			// While the subagent is busy, a steer reaches it at its next step and a follow-up after its current answer.
			const subagent = (await runtime.conversation(conversationId, taskContext))!;
			const request = { type: "input", content: message, whenBusy: followUp ? "followUp" : "steer" } as const;
			const submission = await subagent.submit({ ...request, requestId: `subagent:${reporter.id}` }, taskContext);
			const settled = await submission.wait(taskContext);
			// One commit decides the report and records the answer as delivered, so a restart does not decide again.
			await runtime.commit(async (tx) => {
				const next = (report?: string) => ({ status: "running", checkpoint: { phase: "report", report } }) as const;
				// `aborted`: stopped, or withdrawn while queued. Nothing to report.
				if (settled.status === "unanswered") {
					return next(settled.reason === "aborted" ? undefined : `[subagent ${name} failed: ${settled.reason}]`);
				}
				// Always an answered input here; the check tells TypeScript.
				if (settled.type !== "input") return next();
				const agent = (await tx.doc(Subagents, runtime.conversationId)).agents[name]!;
				if (agent.reported.includes(settled.answer)) return next();
				agent.reported.push(settled.answer);
				const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage;
				return next(`[subagent ${name} answered, no reply needed] ${textOf(answer)}`);
			}, taskContext);
		},
		// Post the report as a follow-up input: it starts a turn when the main agent is idle, or waits for its current
		// answer. If the user presses Esc while it waits in the main agent's queue, it is dropped with the other input; a
		// report that arrives after Esc starts a new turn.
		report: async (reporter, runtime, taskContext) => {
			const report = reporter.state.checkpoint.report;
			if (report !== undefined) {
				const main = (await runtime.conversation(runtime.conversationId, taskContext))!;
				const input = { type: "input", content: report, whenBusy: "followUp" } as const;
				await main.submit({ ...input, requestId: `subagent-report:${reporter.id}` }, taskContext);
			}
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
				taskContext,
			);
		},
	},
	abort: (_reporter, runtime, taskContext) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});

function textOf(message: AssistantMessage | undefined): string {
	return (message?.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
}

const subagentTool = defineTool({
	name: "subagent",
	description:
		"Manage persistent subagents that work in the background. Actions: spawn (name, message), send (name, message; " +
		"followUp: true queues it after the current answer instead of steering), stop (name: aborts its current work), " +
		"status (name, or all subagents without one). Answers are reported back to you when they arrive.",
	parameters: Type.Object({
		action: Type.Union([Type.Literal("spawn"), Type.Literal("send"), Type.Literal("stop"), Type.Literal("status")]),
		name: Type.Optional(Type.String()),
		message: Type.Optional(Type.String()),
		followUp: Type.Optional(Type.Boolean()),
	}),
	// A call interrupted by a crash is not rerun: repeating `stop` could stop newer work. The model sees that the call
	// was interrupted and can check with `status`.
	replay: "unsafe",
	execute: async (args, api, callContext) => {
		const { action, name, message, followUp } = args;
		const reply = (text: string, conversationId?: ConversationId) => ({
			content: [{ type: "text" as const, text }],
			// A UI can attach to the subagent's conversation through the call's details.
			...(conversationId === undefined || name === undefined ? {} : { details: { name, conversationId } }),
		});
		const registry = (await api.snapshot(Subagents, api.conversationId, callContext)) ?? {
			agents: {},
			reporters: {},
		};

		if (action === "status") {
			const names = name === undefined ? Object.keys(registry.agents) : [name];
			const lines: string[] = [];
			for (const each of names) {
				const found = Object.hasOwn(registry.agents, each) ? registry.agents[each] : undefined;
				if (found === undefined) continue;
				// A conversation is busy while it has a run: from an input until its final answer.
				const busy = (await api.snapshot(LiveDoc, found.conversationId, callContext))?.run !== undefined;
				lines.push(`${each}: ${busy ? "working" : "idle"}`);
			}
			return reply(lines.length === 0 ? "No subagents." : lines.join("\n"));
		}
		if (name === undefined) return reply(`${action} needs a name.`);
		const agent = Object.hasOwn(registry.agents, name) ? registry.agents[name] : undefined;
		if (action !== "spawn" && agent === undefined) return reply(`No subagent named ${name}.`);

		if (action === "stop") {
			// Aborts the subagent's current answer and tools and drops its queued messages. It stays usable.
			await (await api.conversation(agent!.conversationId, callContext))!.abort(callContext);
			return reply(`Stopped ${name}.`, agent!.conversationId);
		}
		if (message === undefined) return reply(`${action} needs a message.`);

		// spawn and send: one commit starts a reporter for the message.
		const result = await api.commit(async (tx) => {
			const state = await tx.doc(Subagents, api.conversationId);
			// Both tasks belong to the main conversation and are background: its Esc and idle waits skip them.
			const background = { ownership: { kind: "conversation" }, background: true } as const;
			if (action === "spawn") {
				if (Object.hasOwn(state.agents, name)) return `${name} already exists; use send.`;
				const anchor = await tx.createTask(Anchor, null, background);
				// Owned by a task of the main conversation: starts as a copy of the main agent.
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
				// Subagents cannot start subagents, and know who they are.
				await configure(tx, child.id, {
					extensions: { remove: [SubagentTools] },
					instructions: `You are the subagent "${name}". Answer the main agent's requests.`,
				});
				state.agents[name] = { conversationId: child.id, reported: [] };
			}
			const conversationId = state.agents[name]!.conversationId;
			const input = { name, conversationId, message, followUp: action === "send" && followUp === true };
			state.reporters[api.taskId] = await tx.createTask(Reporter, input, background);
			return action === "send" ? `Sent to ${name}.` : `Started ${name}.`;
		}, callContext);
		const current = (await api.snapshot(Subagents, api.conversationId, callContext))?.agents[name];
		return reply(result, current?.conversationId);
	},
});

// The task definitions come with the extension, so pending reporters resume after a restart once the host installs
// it again.
const SubagentTools = defineExtension({ name: "subagent-tools", tasks: [Anchor, Reporter], tools: [subagentTool] });

// ─── Host setup ─────────────────────────────────────────────────────────────

const models = createModels();
let model = { provider: "openai", modelId: "gpt-6-sol" };
if (process.env.OPENAI_API_KEY !== undefined) {
	models.setProvider(openaiProvider());
} else {
	// The main agent and the subagent share one scripted model, which answers each request by its last message.
	// It streams its answers at 50 tokens per second, like a slow real model.
	const faux = fauxProvider({ tokensPerSecond: 50 });
	models.setProvider(faux.provider);
	model = { provider: "faux", modelId: "faux-1" };
	const call = (input: Record<string, string>) =>
		fauxAssistantMessage([fauxToolCall("subagent", input)], { stopReason: "toolUse" });
	const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
	const route: FauxResponseStep = (request) => {
		// System messages carry prompt changes; the request is about the message before them.
		const last = request.messages.findLast((message) => message.role !== "system")!;
		const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
		const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		// The main agent repeats what the tool said.
		if (last.role === "toolResult") return answer(`OK. ${text}`);
		// The main agent.
		if (text.includes("Start a subagent")) {
			return call({ action: "spawn", name: "reader", message: "Summarize the plot of Moby Dick." });
		}
		if (text.includes("whale's name"))
			return call({ action: "send", name: "reader", message: "What is the whale called?" });
		if (text.includes("every chapter")) {
			return call({ action: "send", name: "reader", message: "Now go through all chapters in detail." });
		}
		if (text.includes("Stop reader")) return call({ action: "stop", name: "reader" });
		if (text.includes("my subagents")) return call({ action: "status" });
		if (text.includes("[subagent")) return answer("Noted.");
		// The subagent: short answers, and a long chapter walk-through that is stopped halfway.
		if (text.includes("Summarize the plot")) return answer("A whale, a captain, an obsession.");
		if (text.includes("whale called")) return answer("Moby Dick.");
		const chapters = Array.from({ length: 135 }, (_, index) => `Chapter ${index + 1}: more whaling.`);
		return answer(chapters.join("\n"));
	};
	// More responses than the script needs; each request takes the next one.
	faux.setResponses(Array.from({ length: 40 }, () => route));
}
const registry = createRegistry();
registry.install(SubagentTools);
const directory = await mkdtemp(join(tmpdir(), "pi-durable-subagents-"));
const open = async () => {
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(directory, "session.sqlite")),
		{ models, registry },
		context,
	);
	const root = await harness.root(context, { agent: { model } });
	return { harness, root };
};

// ─── UI: the main conversation's transcript, as a user would see it ───

const color = (code: number) => (text: string) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = color(1);
const dim = color(2);
const cyan = color(36);
const yellow = color(33);
const magenta = color(35);

function contentText(content: string | readonly { type: string; text?: string }[]): string {
	return typeof content === "string"
		? content
		: content.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("");
}

/** Print the main conversation's messages as they are committed. Subagents work in their own conversations. */
async function follow(harness: Harness, id: ConversationId): Promise<void> {
	const stream = await watchEvents(harness, id, context);
	stream.start(async (events: readonly AgentEvent[]) => {
		for (const event of events) {
			if (event.type !== "message_end") continue;
			const message = event.entry.model?.[0];
			if (message?.role === "user") {
				const text = contentText(message.content);
				// Input is either the user or a subagent's report, which arrives whenever the subagent is done.
				const report = /^\[subagent (\S+) ([^\]]*)\] ?(.*)$/s.exec(text);
				if (report === null) console.log(`\n${cyan(bold(">"))} ${bold(text)}`);
				else console.log(`\n${magenta(bold(`> ${report[1]}:`))} ${report[3] || report[2]}`);
			} else if (message?.role === "assistant") {
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					const { action, name, message: sent } = part.arguments as Record<string, string | undefined>;
					const quoted = sent === undefined ? "" : ` ${JSON.stringify(sent)}`;
					console.log(yellow(`  ${part.name} ${action}${name === undefined ? "" : ` ${name}`}${quoted}`));
				}
				if (textOf(message) !== "") console.log(textOf(message));
			} else if (message?.role === "toolResult") {
				console.log(dim(`  → ${contentText(message.content)}`));
			}
		}
	});
}

let { harness, root } = await open();
await follow(harness, root.id);

/** Say something to the main agent and wait for its answer. */
const say = async (text: string): Promise<void> => {
	await (await root.submit({ type: "input", content: text }, context)).wait(context);
};
/** Wait until every message to a subagent was answered and reported, and the main agent has reacted. */
const settle = async (): Promise<void> => {
	const reporters = (await harness.snapshot(Subagents, root.id, context))?.reporters ?? {};
	for (const id of Object.values(reporters)) await harness.waitForTask(id, context);
	await root.waitForIdle(context);
	// Event callbacks run after their commit; let the last ones print. A slow machine may need longer.
	await new Promise((resolve) => setTimeout(resolve, 50));
};
/** Poll `check` for up to 10 seconds. */
const until = async (check: () => Promise<boolean>): Promise<void> => {
	for (let tries = 0; tries < 1000 && !(await check()); tries++)
		await new Promise((resolve) => setTimeout(resolve, 10));
};
const working = async (name: string): Promise<boolean> => {
	const agent = (await harness.snapshot(Subagents, root.id, context))?.agents[name];
	return agent !== undefined && (await harness.snapshot(LiveDoc, agent.conversationId, context))?.run !== undefined;
};

// The main agent answers at once; the subagent's answer is reported back when it arrives.
await say("Start a subagent named reader that summarizes Moby Dick.");
await settle();

// A long request, stopped while the subagent is still answering.
await say("Ask reader to summarize every chapter.");
await until(() => working("reader"));
await say("Stop reader.");
await settle();

await say("What are my subagents doing?");
await settle();

// The process stops while the subagent works on a message; after the restart its answer still arrives.
const reporters = async () =>
	Object.keys((await harness.snapshot(Subagents, root.id, context))?.reporters ?? {}).length;
const before = await reporters();
await root.submit({ type: "input", content: "Ask reader for the whale's name." }, context);
await until(async () => (await reporters()) > before);
await harness.close(context);
console.log(dim("\n  (process restarts)"));
({ harness, root } = await open());
await follow(harness, root.id);
await settle();

await harness.close(context);
await rm(directory, { recursive: true, force: true });
