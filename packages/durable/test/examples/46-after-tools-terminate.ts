// An `afterTools` hook that asks a person, after every tool round, whether the agent should go on. Its task parks on the
// person's answer, so the Session needs no process meanwhile; "go on" answers the run with a steer the next request
// sees, "stop" ends the run with `{ terminate: true }`, as a round whose calls all asked to terminate.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/46-after-tools-terminate.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { obj, oneOf, str } from "@earendil-works/pi-schema";
import {
	type AfterToolsDecision,
	createRegistry,
	defineExtension,
	defineSignal,
	defineTask,
	defineTool,
	GenerationTask,
	Harness,
	hook,
	hookTask,
	MemoryStorage,
	type TaskId,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

const Choice = defineSignal({ name: "example.go-on", version: 1, schema: obj({ choice: oneOf(["go on", "stop"]) }) });
const asking = new Set<TaskId>();

// Asks, sleeps until the person answers, then steers or ends the run.
const AskToGoOn = defineTask<null, { phase: "ask" } | { phase: "answered" }, AfterToolsDecision | null>({
	name: "example.ask-to-go-on",
	version: 1,
	initial: () => ({ phase: "ask" }),
	phases: {
		ask: (_task, runtime, ctx) => {
			asking.add(runtime.taskId);
			return runtime.commit(
				() => ({ status: "sleeping", checkpoint: { phase: "answered" }, signals: [Choice.key("choice")] }),
				ctx,
			);
		},
		answered: async (_task, runtime, ctx) => {
			asking.delete(runtime.taskId);
			const state = await runtime.readSignal(Choice, "choice", ctx);
			const choice = state !== undefined && "value" in state ? state.value.choice : "stop";
			const handle = (await runtime.conversation(runtime.conversationId, ctx))!;
			await runtime.commit(async (tx) => {
				if (choice === "stop")
					return { status: "terminal", outcome: { status: "completed", result: { terminate: true } } };
				// A steer in the task's terminal commit: the round's boundary places it before the next request.
				await handle.submit(tx, { type: "input", content: "The person says: go on.", whenBusy: "steer" });
				return { status: "terminal", outcome: { status: "completed", result: null } };
			}, ctx);
		},
	},
	abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

const step = defineTool({
	name: "step",
	description: "Do one step of the work",
	parameters: obj({ what: str() }),
	execute: async ({ what }) => ({ output: [{ type: "text", text: `did ${what}` }] }),
});

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const callStep = (what: string) => fauxAssistantMessage(fauxToolCall("step", { what }), { stopReason: "toolUse" });
faux.setResponses([callStep("step 1"), callStep("step 2"), fauxAssistantMessage("Not reached.")]);
const registry = createRegistry();
registry.install(
	defineExtension({
		name: "checkpoints",
		tools: [step],
		tasks: [AskToGoOn],
		hooks: [hook(GenerationTask, { afterTools: async () => ({ tasks: [hookTask(AskToGoOn, null)] }) })],
	}),
);
const harness = await Harness.open(new MemoryStorage(), { models, registry, onWake: () => {} }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
const asked = async () => {
	while (asking.size === 0) await new Promise((r) => setTimeout(r, 1));
	await new Promise((r) => setTimeout(r, 5));
	return [...asking][0]!;
};

const submission = await root.submit({ type: "input", content: "Do the work, step by step" }, context);
let task = await asked();
console.log("round 1 done, asking the person; wake:", harness.wake());
console.log("answer:", await harness.signal(task, Choice, "choice", { choice: "go on" }, context));
task = await asked();
console.log("round 2 done, asking again; wake:", harness.wake());
console.log("answer:", await harness.signal(task, Choice, "choice", { choice: "stop" }, context));
const settled = await submission.wait(context);
console.log("run:", settled.status, "with requests:", faux.state.callCount);
const page = await root.entries({ order: "ascending" }, 50, undefined, context);
for (const entry of page.items) {
	const message = entry.model?.[0];
	if (message?.role === "user") console.log(">", message.content);
	if (message?.role === "toolResult")
		console.log("  tool:", message.content.map((part) => (part.type === "text" ? part.text : "")).join(""));
}
await harness.close(context);
