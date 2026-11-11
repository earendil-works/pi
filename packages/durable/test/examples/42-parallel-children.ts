// A tool that starts two nested calls without waiting for them and parks until either ends, so the Session holds no
// process while they run. Each wake adds the ended calls to its checkpoint; the last one collects every result by key.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/42-parallel-children.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { obj, str } from "@earendil-works/pi-schema";
import {
	createRegistry,
	defineExtension,
	defineSignal,
	defineTool,
	Harness,
	LiveDoc,
	MemoryStorage,
	type TaskId,
	ToolResultEntry,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// A research call parks until a (simulated) external researcher reports back.
const Report = defineSignal({ name: "example.report", version: 1, schema: obj({ text: str() }) });
const research = defineTool({
	name: "research",
	description: "Research a topic",
	parameters: obj({ topic: str() }),
	replay: "safe",
	async execute({ topic }, api, ctx) {
		const state = await api.readSignal(Report, "report", ctx);
		if (state !== undefined && "value" in state)
			return { output: [{ type: "text", text: `${topic}: ${state.value.text}` }] };
		return { sleep: { signals: [Report.key("report")] } };
	},
});

type ResearchCheckpoint = { done: TaskId[] };
let runs = 0;
const ResearchParameters = obj({ x: str(), y: str() });
const researchBoth = defineTool<typeof ResearchParameters, never, ResearchCheckpoint>({
	name: "research_both",
	description: "Research two topics in parallel",
	parameters: ResearchParameters,
	replay: "safe",
	async execute({ x, y }, api, ctx) {
		// Keys name the calls across wakes: the same key finds the same call again.
		const a = await api.executeTool("research", { topic: x }, ctx, { key: "a", wait: false });
		const b = await api.executeTool("research", { topic: y }, ctx, { key: "b", wait: false });
		runs++;
		const done = new Set(api.checkpoint?.done ?? []);
		if (api.wake?.reason === "tasks") for (const id of api.wake.ended) done.add(id);
		console.log(`  [research_both] run with wake ${JSON.stringify(api.wake)}, ${done.size} of 2 done`);
		const open = [a, b].filter((call) => !done.has(call.taskId));
		if (open.length > 0)
			return { wait: { checkpoint: { done: [...done] }, on: open.map((call) => call.taskId), policy: "any" } };
		const [ra, rb] = await Promise.all([a.result(ctx), b.result(ctx)]);
		return { output: [{ type: "text", text: `${String(ra.structuredOutput)}\n${String(rb.structuredOutput)}` }] };
	},
});

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("research_both", { x: "durable objects", y: "sqlite" }), {
		stopReason: "toolUse",
	}),
	fauxAssistantMessage("Both researched."),
]);
const registry = createRegistry();
registry.install(defineExtension({ name: "research", tools: [research, researchBoth] }));
const harness = await Harness.open(new MemoryStorage(), { models, registry, onWake: () => {} }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
const submission = await root.submit({ type: "input", content: "Research both" }, context);

// Wait until both nested calls are parked; their tool call waits on them.
const nested = async () => (await harness.snapshot(LiveDoc, root.id, context))?.nestedTools ?? [];
while ((await nested()).filter((slot) => slot.status === "sleeping").length < 2)
	await new Promise((r) => setTimeout(r, 1));
await new Promise((r) => setTimeout(r, 1));
const tools = (await harness.snapshot(LiveDoc, root.id, context))?.tools ?? [];
console.log(
	"tool:",
	tools.map((slot) => `${slot.name} ${slot.status}`),
	"nested:",
	(await nested()).map((slot) => `${slot.callId} ${slot.status}`),
);
console.log("wake while everything is parked:", harness.wake());

const [a, b] = await nested();
console.log("report b:", await harness.signal(b!.taskId, Report, "report", { text: "embedded, single file" }, context));
// The parent wakes for b, runs again, and waits on a.
const waiting = async () => (await harness.snapshot(LiveDoc, root.id, context))?.tools?.[0]?.status === "waiting";
while (runs < 2 || !(await waiting())) await new Promise((r) => setTimeout(r, 1));
console.log(
	"report a:",
	await harness.signal(a!.taskId, Report, "report", { text: "one per object, with storage" }, context),
);
await submission.wait(context);
const page = await root.entries({}, 10, undefined, context);
const result = page.items.find((entry) => ToolResultEntry.is(entry))?.model?.[0] as ToolResultMessage;
console.log(`result:\n${result.content.map((part) => (part.type === "text" ? part.text : "")).join("")}`);
await harness.close(context);
