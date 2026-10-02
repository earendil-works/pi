// One sandbox per conversation: the app records each conversation's sandbox in its own document, and the Harness
// environment function looks it up for every tool call. Here a sandbox is a directory; a hosted product would return
// an ExecutionEnv that runs inside the conversation's container.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/29-sandbox-per-conversation.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import { createRegistry, defineDoc, Harness, MemoryStorage } from "../../src/index.ts";
import { CodingTools } from "../../src/tools/index.ts";

const context = BACKGROUND_CONTEXT;

// Which sandbox a conversation runs in. `fork: "initial"`: a fork gets no sandbox until the app assigns one.
const Sandbox = defineDoc<{ path?: string }>({
	kind: "app.sandbox",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
});

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const note = (text: string) =>
	fauxAssistantMessage(fauxToolCall("write", { path: "note.txt", content: text }), { stopReason: "toolUse" });
faux.setResponses([
	note("from alice"),
	fauxAssistantMessage("Saved."),
	note("from bob"),
	fauxAssistantMessage("Saved."),
]);

const registry = createRegistry();
registry.install(CodingTools);
const harness = await Harness.open(
	new MemoryStorage(),
	{
		models,
		registry,
		// Committed reads only; a conversation without a sandbox gets no environment, so its tools fail cleanly.
		env: async ({ conversationId, read }, envContext) => {
			const sandbox = await read.snapshot(Sandbox, conversationId, envContext);
			return sandbox?.path === undefined ? undefined : new NodeExecutionEnv({ cwd: sandbox.path });
		},
	},
	context,
);

// Each user's conversation gets a fresh sandbox in the creating commit.
const model = { provider: "faux", modelId: "faux-1" };
async function conversationFor(user: string) {
	const path = await mkdtemp(join(tmpdir(), `pi-durable-sandbox-${user}-`));
	const conversation = await harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model },
			init: async (tx, id) => {
				(await tx.doc(Sandbox, id)).path = path;
			},
		},
		context,
	);
	return { conversation, path };
}

const alice = await conversationFor("alice");
const bob = await conversationFor("bob");
await (await alice.conversation.submit({ type: "input", content: "Leave a note." }, context)).wait(context);
await (await bob.conversation.submit({ type: "input", content: "Leave a note." }, context)).wait(context);
console.log("alice's sandbox:", await readFile(join(alice.path, "note.txt"), "utf8"));
console.log("bob's sandbox:", await readFile(join(bob.path, "note.txt"), "utf8"));

await harness.close(context);
await rm(alice.path, { recursive: true, force: true });
await rm(bob.path, { recursive: true, force: true });
