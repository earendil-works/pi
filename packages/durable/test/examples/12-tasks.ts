// Run a durable task.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/12-tasks.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTask, Harness, MemoryStorage } from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// A task is a small state machine. Its state, the checkpoint, is saved after
// every step, so after a crash the next open continues from the last saved
// step. The usual pattern: save what you are about to do, do it, then save
// the result. A crash between doing and saving reruns that step, so the step
// must be safe to repeat; here the fake payment service ignores a repeated key.
const payments = new Map<string, number>();
type PaymentState = { phase: "prepare" } | { phase: "charge"; key: string };
const Payment = defineTask<{ amount: number }, PaymentState, { receipt: number }>({
	name: "example.payment",
	version: 1,
	initial: () => ({ phase: "prepare" }),
	// One handler per phase. Each must save progress through runtime.commit():
	// its callback returns the next checkpoint or the final outcome, and that
	// state is saved in the same commit as everything else the callback wrote.
	phases: {
		prepare: async (task, runtime, taskContext) => {
			await runtime.commit(
				() => ({ status: "running", checkpoint: { phase: "charge", key: `payment-${task.id}` } }),
				taskContext,
			);
		},
		charge: async (task, runtime, taskContext) => {
			const key = task.state.checkpoint.key;
			if (!payments.has(key)) payments.set(key, task.input.amount * 100);
			const receipt = payments.get(key)!;
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: { receipt } } }),
				taskContext,
			);
		},
	},
	// Runs instead of the phases after harness.abortTask(); it decides the outcome.
	abort: async (_task, runtime, taskContext) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
	},
});

// Extensions bring task code; the Harness finds it by name in the registry.
// Nothing runs until resume() or a call that waits for progress, such as
// waitForTask().
const registry = createRegistry();
registry.install(defineExtension({ name: "payments", tasks: [Payment] }));
const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);
const root = await harness.root(context);
// Every task names its owner. This one belongs to the conversation; a task can
// also own child tasks and wait for them (24-child-tasks.ts).
const paymentId = await root.commit(
	(tx) => tx.createTask(Payment, { amount: 5 }, { ownership: { kind: "conversation" } }),
	context,
);
// The finished task record is the durable receipt; waitForTask() knows its result type.
const paid = await harness.waitForTask(paymentId, context);
console.log("payment outcome:", paid.state.outcome);

await harness.close(context);
