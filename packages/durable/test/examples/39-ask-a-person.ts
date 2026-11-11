// A plugin task that asks a person and sleeps until the answer comes or a deadline passes, holding no process
// meanwhile. The first question is answered; the second expires, and its late answer is refused.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/39-ask-a-person.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { obj, str } from "@earendil-works/pi-schema";
import {
	createRegistry,
	defineExtension,
	defineSignal,
	defineTask,
	Harness,
	MemoryStorage,
	type TaskId,
	type Wake,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
const HOUR = 60 * 60 * 1000;

// The Harness clock, moved by hand so the deadline comes without waiting four hours.
let clock = Date.UTC(2026, 10, 9, 9);
const Answer = defineSignal({ name: "example.answer", version: 1, schema: obj({ text: str() }) });

// What shows the question to a person (an inbox, a card, a chat bridge) keeps its own record of it: Durable stores
// no description of what a sleep waits for, only its keys and deadline.
const inbox = new Map<TaskId, string>();

const AskPerson = defineTask<{ question: string }, { phase: "ask" } | { phase: "answered" }, { answer: string | null }>(
	{
		name: "example.ask-person",
		version: 1,
		initial: () => ({ phase: "ask" }),
		phases: {
			ask: async (task, runtime, ctx) => {
				inbox.set(runtime.taskId, task.input.question);
				// Sleep until the answer arrives or four hours pass, whichever comes first.
				await runtime.commit(
					() => ({
						status: "sleeping",
						signals: [Answer.key("answer")],
						until: runtime.now() + 4 * HOUR,
						checkpoint: { phase: "answered" },
					}),
					ctx,
				);
			},
			answered: async (task, runtime, ctx) => {
				inbox.delete(runtime.taskId);
				// `signal` when answered, `expired` when the deadline came first.
				const state = await runtime.readSignal(Answer, "answer", ctx);
				const answer = state !== undefined && "value" in state ? state.value.text : null;
				console.log(`  [ask] woke: ${task.state.wake?.reason}, read: ${JSON.stringify(state)}`);
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: { answer } } }),
					ctx,
				);
			},
		},
		abort: (_task, runtime, ctx) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
	},
);

// A host that wakes the process itself, as a Durable Object alarm does: it is told when work needs a process.
const wakes: Wake[] = [];
const registry = createRegistry();
registry.install(defineExtension({ name: "ask", tasks: [AskPerson] }));
const harness = await Harness.open(
	new MemoryStorage(),
	{ models: createModels(), registry, now: () => clock, onWake: (wake) => wakes.push(wake) },
	context,
);
const root = await harness.root(context);
const ask = (question: string) =>
	root.commit((tx) => tx.createTask(AskPerson, { question }, { ownership: { kind: "conversation" } }), context);
const asleep = async (id: TaskId) => {
	while ((await harness.getTask(id, context))?.state.status !== "sleeping") await new Promise((r) => setTimeout(r, 1));
	await new Promise((r) => setTimeout(r, 1));
};

// 1. Answered in time.
const first = await ask("Deploy to production?");
harness.resume();
await asleep(first);
console.log("inbox:", [...inbox.values()]);
// Nothing runs: no process needed until the deadline, four hours from now.
console.log("wake while asleep:", harness.wake(), "deadline in", (harness.wake().at! - clock) / HOUR, "h");
console.log("deliver:", await harness.signal(first, Answer, "answer", { text: "yes" }, context));
console.log("result:", (await harness.waitForTask(first, context)).state.outcome);

// 2. Nobody answers. The host's alarm fires at the deadline and resumes the Harness.
const second = await ask("Delete the staging database?");
await asleep(second);
console.log("inbox:", [...inbox.values()]);
clock = harness.wake().at!;
harness.resume();
console.log("result:", (await harness.waitForTask(second, context)).state.outcome);
// The key expired with the deadline: a late answer is refused.
console.log("late deliver:", await harness.signal(second, Answer, "answer", { text: "yes" }, context));
// onWake runs in a microtask after the commit that changed the value.
await new Promise((r) => setTimeout(r, 1));
console.log("last onWake:", wakes.at(-1));
await harness.close(context);
