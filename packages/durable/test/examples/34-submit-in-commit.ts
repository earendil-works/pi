// A host lets people message an agent while it works: a message must join the current run as a steer and never start a
// run of its own. `submit(tx, draft)` admits it inside the host's own commit, together with the host's check and its own
// state; `whenIdle: "reject"` refuses it when no run is working.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/34-submit-in-commit.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	ConversationIdle,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// The host's own state: who may message this conversation, and what they sent.
const Visitors = defineDoc<{ muted: string[]; sent: { from: string; text: string }[] }>({
	kind: "app.visitors",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ muted: [], sent: [] }),
	checkpointWhen: () => false,
});

// A tool that waits until released, so messages arrive while the run works.
let release!: () => void;
const working = new Promise<void>((resolve) => {
	release = resolve;
});
const build = defineTool({
	name: "build",
	description: "Build the project",
	parameters: Type.Object({}),
	execute: async () => {
		await working;
		return { output: [{ type: "text", text: "built" }] };
	},
});

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("build", {}), { stopReason: "toolUse" }),
	fauxAssistantMessage("Built, and I added the test Ana asked for."),
]);
const registry = createRegistry();
registry.install(defineExtension({ name: "build", tools: [build] }));
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
await root.commit(async (tx) => {
	(await tx.doc(Visitors, root.id)).muted.push("bob");
}, context);

/** A visitor's message: checked, admitted as a steer of the current run, and recorded, in one commit or not at all. */
async function message(from: string, text: string, requestId: string): Promise<string> {
	try {
		return await harness.commit(async (tx) => {
			const visitors = await tx.doc(Visitors, root.id);
			if (visitors.muted.includes(from)) return `${from} is muted`;
			// Before the commit's own table writes; document writes may come before or after.
			const id = await root.submit(tx, {
				type: "input",
				content: `${from}: ${text}`,
				whenBusy: "steer",
				whenIdle: "reject",
				requestId,
			});
			visitors.sent.push({ from, text });
			return `${from}'s message is submission ${id}`;
		}, context);
	} catch (error) {
		if (error instanceof ConversationIdle) return `${from}: the agent isn't working now`;
		throw error;
	}
}

console.log(await message("ana", "Add a test for the build.", "ana-1")); // idle: refused, nothing written
const run = await root.submit({ type: "input", content: "Build the project." }, context);
console.log(await message("ana", "Add a test for the build.", "ana-2")); // busy: joins the run as a steer
console.log(await message("bob", "Delete everything.", "bob-1")); // the host's own check refuses it
release();
await run.wait(context);
await root.waitForIdle(context);

const page = await root.entries({ order: "ascending" }, 100, undefined, context);
for (const entry of page.items) {
	const message = entry.model?.[0];
	if (message?.role === "user") console.log(">", message.content);
	if (message?.role === "assistant" && message.stopReason === "stop") {
		console.log("agent:", message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""));
	}
}
console.log("recorded:", (await harness.snapshot(Visitors, root.id, context))?.sent);
await harness.close(context);
