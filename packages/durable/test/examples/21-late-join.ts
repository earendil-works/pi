// Late join: a client attaches while a run is already underway. It gets the current state first, the conversation
// view or the snapshot event, and then only what changes after that.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/21-late-join.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	type AgentEvent,
	createRegistry,
	Harness,
	type LiveState,
	MemoryStorage,
	watchEvents,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A tool that prints a line every 100 ms, then a slowly streamed answer.
const registry = createRegistry();
registry.tools.add({
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
});
const faux = fauxProvider({ tokensPerSecond: 40, tokenSize: { min: 1, max: 1 } });
faux.setResponses([
	fauxAssistantMessage([fauxToolCall("count", {}, { id: "call-1" })], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxText("Counted to ten, and this answer streams slowly.")]),
]);
const models = createModels();
models.setProvider(faux.provider);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context);
await root.setModel({ provider: "faux", modelId: "faux-1" }, context);

const submission = await root.submit({ type: "input", content: "Count to ten, then tell me." }, context);
// Join while the tool is halfway through.
await pause(500);

// Structural client: the view holds the committed transcript and documents, including the running tool's output.
const view = await root.viewState(context);
const live = view.value.docs["pi.live"] as LiveState;
console.log(
	"view entries:",
	view.value.entries.map((entry) => entry.kind),
);
console.log("view tool slot:", live.tools?.[0]?.status, JSON.stringify(live.tools?.[0]?.output));
view.subscribe((value) => {
	const slot = (value.docs["pi.live"] as LiveState).tools?.[0];
	if (slot?.status === "running") console.log("view output now:", JSON.stringify(slot.output));
});

// Event client: the snapshot event carries the same state; later events apply on top of it.
const stream = await watchEvents(harness, root.id, context);
console.log(
	"snapshot tools:",
	stream.snapshot.tools.map((slot) => `${slot.name} ${slot.status}`),
);
let output = stream.snapshot.tools[0]?.output ?? "";
stream.start(async (events: readonly AgentEvent[]) => {
	for (const event of events) {
		if (event.type === "tool_execution_update" && event.output !== undefined) {
			output =
				"set" in event.output
					? event.output.set
					: output.slice(event.output.trimStart ?? 0) + (event.output.append ?? "");
			console.log("event output now:", JSON.stringify(output));
		} else if (event.type === "message_update") {
			const deltas = event.changes.flatMap((change) => (change.type === "text_delta" ? [change.delta] : []));
			console.log("event text delta:", JSON.stringify(deltas.join("")));
		} else {
			console.log("event:", event.type);
		}
	}
});

await submission.wait(context);
await harness.waitForIdle(context);
await pause(0);
await stream.stop();
view.dispose();
await harness.close(context);
