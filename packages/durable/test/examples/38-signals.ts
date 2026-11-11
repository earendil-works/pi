// Signals: a typed JSON value delivered to a live task from outside, and what each delivery returns. A value that
// arrives before the task sleeps on its key is kept, and the sleep wakes at once.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/38-signals.ts
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
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// A signal kind: a name, a version, and a pi-schema schema of a JSON value. Deliveries are checked against it.
const Greeting = defineSignal({ name: "example.greeting", version: 1, schema: obj({ text: str() }) });

// A task that first does some work, then sleeps until a greeting arrives under the key "hello".
const Greeter = defineTask<null, { phase: "work" } | { phase: "greeted" }, string>({
	name: "example.greeter",
	version: 1,
	initial: () => ({ phase: "work" }),
	phases: {
		work: (_task, runtime, ctx) =>
			runtime.commit(
				() => ({ status: "sleeping", checkpoint: { phase: "greeted" }, signals: [Greeting.key("hello")] }),
				ctx,
			),
		greeted: async (task, runtime, ctx) => {
			// The wake names the key; readSignal() is how the value is read.
			const wake = task.state.wake;
			const state = await runtime.readSignal(Greeting, "hello", ctx);
			const text = state !== undefined && "value" in state ? state.value.text : "(none)";
			console.log(`  [greeter] woke by ${JSON.stringify(wake)}, read "${text}"`);
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: text } }), ctx);
		},
	},
	abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

const registry = createRegistry();
registry.install(defineExtension({ name: "greeter", tasks: [Greeter] }));
const harness = await Harness.open(
	new MemoryStorage(),
	{ models: createModels(), registry, onWake: () => {} },
	context,
);
const root = await harness.root(context);
const id = await root.commit((tx) => tx.createTask(Greeter, null, { ownership: { kind: "conversation" } }), context);

// 1. Delivered before the task ran at all: kept in the task. harness.signal() also starts scheduling.
console.log("early:", await harness.signal(id, Greeting, "hello", { text: "hi there" }, context));
// 2. Webhook retries of the same key are answered `duplicate`.
console.log("retry:", await harness.signal(id, Greeting, "hello", { text: "hi again" }, context));
// 3. A value that does not match the schema is `invalid`; nothing is stored.
console.log("bad value:", await harness.signal(id, Greeting, "other", { text: 42 } as never, context));
// 4. No such task.
console.log("unknown task:", await harness.signal(999_999 as TaskId, Greeting, "hello", { text: "?" }, context));

// The sleep finds the early value and wakes at once.
console.log("result:", (await harness.waitForTask(id, context)).state.outcome);
// 5. The task ended: every later delivery is `closed`.
console.log("after the end:", await harness.signal(id, Greeting, "hello", { text: "too late" }, context));

// A second greeter sleeps first. While it sleeps it holds no invocation: the Session needs no process (`active`
// false) and has no deadline (`at` absent), so a host could let it hibernate until a delivery comes.
const second = await root.commit(
	(tx) => tx.createTask(Greeter, null, { ownership: { kind: "conversation" } }),
	context,
);
harness.resume();
while ((await harness.getTask(second, context))?.state.status !== "sleeping")
	await new Promise((r) => setTimeout(r, 1));
await new Promise((r) => setTimeout(r, 1));
console.log("asleep, wake:", harness.wake());
console.log("late:", await harness.signal(second, Greeting, "hello", { text: "good morning" }, context));
console.log("result:", (await harness.waitForTask(second, context)).state.outcome);
await harness.close(context);
