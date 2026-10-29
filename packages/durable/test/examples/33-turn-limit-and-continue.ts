// A per-conversation turn limit stops a long run after a number of tool rounds; a continue resumes it without a user
// message, with a fresh budget. A host learns that a run stopped from `pi.live.runFailure`.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/33-turn-limit-and-continue.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	ConversationBusy,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	LiveDoc,
	MemoryStorage,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

const step = defineTool({
	name: "step",
	description: "Do one step of the work",
	parameters: Type.Object({ n: Type.Number() }),
	execute: async (args) => ({ output: [{ type: "text", text: `step ${args.n} done` }] }),
});
const call = (n: number) => fauxAssistantMessage(fauxToolCall("step", { n }), { stopReason: "toolUse" });

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
// Four steps, then the answer. Two tool rounds per run are allowed.
faux.setResponses([call(1), call(2), call(3), call(4), fauxAssistantMessage("All four steps are done.")]);

const registry = createRegistry();
registry.install(defineExtension({ name: "steps", tools: [step] }));
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
// Stored on the conversation, like its model: children and forks inherit it.
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, maxTurns: 2 } });

const first = await (await root.submit({ type: "input", content: "Do the four steps." }, context)).wait(context);
const failure = (await harness.snapshot(LiveDoc, root.id, context))?.runFailure;
console.log("first run:", first.status, first.reason, `(${failure?.detail})`);

// An idle conversation runs a continue on the context as it is, the round's results last, with a fresh budget.
const resumed = await root.submit({ type: "continue" }, context);
// It never queues: while that run works, another continue is refused.
try {
	await root.submit({ type: "continue" }, context);
} catch (error) {
	if (!(error instanceof ConversationBusy)) throw error;
	console.log("second continue while busy: ConversationBusy");
}
const second = await resumed.wait(context);
console.log("first continue:", second.status, second.status === "done" ? "" : second.reason);
const third = await (await root.submit({ type: "continue" }, context)).wait(context);
const live = await harness.snapshot(LiveDoc, root.id, context);
console.log("second continue:", third.status, live?.runFailure === undefined ? "(runFailure cleared)" : "");

const page = await root.entries({ order: "ascending" }, 100, undefined, context);
for (const entry of page.items) {
	const message = entry.model?.[0];
	if (message?.role === "user") console.log(">", message.content);
	if (message?.role === "toolResult")
		console.log("  tool:", message.content[0]?.type === "text" ? message.content[0].text : "");
	if (message?.role === "assistant" && message.stopReason === "stop") {
		console.log("agent:", message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""));
	}
}
// A continue after an answer has nothing to answer: it ends without a model request.
const after = await (await root.submit({ type: "continue" }, context)).wait(context);
console.log("continue after the answer:", after.status, after.reason);
await harness.close(context);
