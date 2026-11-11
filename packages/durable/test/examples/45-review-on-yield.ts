// An `onYield` hook that asks a review task whether an answer stands. While the review runs, the answer is in the
// transcript but the run's input stays open, so whoever waits on it sees only a reviewed answer. The review's
// `{ continue }` sends the agent back to work in the same run; a user message queued meanwhile wins over it.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/45-review-on-yield.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	defineExtension,
	defineTask,
	GenerationTask,
	Harness,
	hook,
	hookTask,
	LiveDoc,
	MemoryStorage,
	type YieldDecision,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// The review: reads the answer the hook asked about from `run.yield`, and sends the agent back when it is too short.
let release = (): void => {};
const Review = defineTask<null, { phase: "review" }, YieldDecision>({
	name: "example.review",
	version: 1,
	initial: () => ({ phase: "review" }),
	phases: {
		review: async (_task, runtime, ctx) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			const live = await runtime.snapshot(LiveDoc, runtime.conversationId, ctx);
			const entry = await runtime.entry(live!.run!.yield!.answer, ctx);
			const message = entry?.model?.[0];
			const text =
				message?.role === "assistant"
					? message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
					: "";
			const decision: YieldDecision = text.length < 20 ? { continue: "Too short: explain your reasoning." } : {};
			console.log(`  [review] "${text}" -> ${JSON.stringify(decision)}`);
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: decision } }), ctx);
		},
	},
	abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

// A review of every answer, a continuation's too.
const Reviewer = defineExtension({
	name: "reviewer",
	tasks: [Review],
	hooks: [hook(GenerationTask, { onYield: async () => ({ tasks: [hookTask(Review, null)] }) })],
});

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage("Yes."),
	fauxAssistantMessage("Yes: the build passed and the tests are green, so it can ship."),
	fauxAssistantMessage("No."),
	fauxAssistantMessage("Answering the queued question instead."),
]);
const registry = createRegistry();
registry.install(Reviewer);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
const reviewing = async () => {
	while ((await harness.snapshot(LiveDoc, root.id, context))?.run?.yield === undefined) {
		await new Promise((r) => setTimeout(r, 1));
	}
	await new Promise((r) => setTimeout(r, 5));
};
const transcript = async () => {
	const page = await root.entries({ order: "ascending" }, 50, undefined, context);
	return page.items.flatMap((entry) => {
		const message = entry.model?.[0];
		if (message?.role === "user") return [`> ${message.content}`];
		if (message?.role === "assistant")
			return [message.content.map((part) => (part.type === "text" ? part.text : "")).join("")];
		return [];
	});
};

// 1. The review sends the agent back; the input settles with the reviewed answer.
const first = await root.submit({ type: "input", content: "Can we ship?" }, context);
await reviewing();
console.log("while reviewing, the input is:", (await first.status(context)).status);
release();
await reviewing();
release();
console.log("input:", (await first.wait(context)).status);
console.log(await transcript());

// 2. A follow-up queued during the review wins over the review's continuation.
const second = await root.submit({ type: "input", content: "Is it Friday?" }, context);
await reviewing();
await root.submit({ type: "input", content: "Skip that: what is 2 + 2?", whenBusy: "followUp" }, context);
release();
await second.wait(context);
await reviewing();
release();
await root.waitForIdle(context);
console.log((await transcript()).slice(4));
await harness.close(context);
