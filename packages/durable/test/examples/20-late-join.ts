// Late join: a client attaches while a run is already underway. It gets the current state first, the conversation
// view, and then only what changes after that.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/20-late-join.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	type LiveState,
	MemoryStorage,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A tool that prints a line every 100 ms, then a slowly streamed answer.
const registry = createRegistry();
registry.install(
	defineExtension({
		name: "count",
		tools: [
			defineTool({
				name: "count",
				description: "Counts to ten",
				parameters: Type.Object({}),
				execute: async (_args, api) => {
					for (let n = 1; n <= 10; n++) {
						api.output(`${n}\n`);
						await pause(100);
					}
					return {};
				},
			}),
		],
	}),
);
const faux = fauxProvider({ tokensPerSecond: 40, tokenSize: { min: 1, max: 1 } });
faux.setResponses([
	fauxAssistantMessage([fauxToolCall("count", {}, { id: "call-1" })], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxText("Counted to ten, and this answer streams slowly.")]),
]);
const models = createModels();
models.setProvider(faux.provider);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

const submission = await root.submit({ type: "input", content: "Count to ten, then tell me." }, context);
// Join while the tool is halfway through.
await pause(500);

// The view holds the newest entries and the documents, including the running tool's output and, later, the answer
// being streamed.
const view = await root.watch(context);
const live = view.value.docs["pi.live"] as LiveState;
console.log(
	"view entries:",
	view.value.entries.map((entry) => entry.kind),
);
console.log("view tool slot:", live.tools?.[0]?.status, JSON.stringify(live.tools?.[0]?.output));
let shown = "";
view.start(async (call) => {
	if (call.kind !== "value") return;
	const { value } = call;
	const state = value.docs["pi.live"] as LiveState;
	const slot = state.tools?.[0];
	if (slot?.status === "running") console.log("view output now:", JSON.stringify(slot.output));
	const partial = state.generation?.message?.content.find((block) => block.type === "text")?.text ?? "";
	if (partial !== shown && partial !== "") console.log("view answer now:", JSON.stringify(partial));
	shown = partial;
	if (state.run === undefined)
		console.log(
			"view entries:",
			value.entries.map((entry) => entry.kind),
		);
});

await submission.wait(context);
await harness.waitForIdle(context);
await pause(0);
await view.stop();
await harness.close(context);
