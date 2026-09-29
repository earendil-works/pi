// Open a Harness with a registry.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/06-harness.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	ConversationConfig,
	createRegistry,
	defineDoc,
	Harness,
	MemoryStorage,
	type ToolRegistration,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// A Harness is a Session plus conversation handles and durable tasks. Extension
// code (tools, hooks, tasks, system prompt sections, conversation setups) lives
// in a registry the application owns. Nothing in the registry is saved; it is
// this process's code.
const registry = createRegistry();
const read: ToolRegistration = {
	name: "read",
	description: "Read a file",
	parameters: Type.Object({ path: Type.String() }),
	execute: async (args) => ({ content: [{ type: "text", text: `read ${JSON.stringify(args)}` }] }),
};
registry.tools.add(read);

// `models` is pi-ai's model access; generation calls models through it.
const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);

const Notes = defineDoc<{ text: string }>({
	kind: "example.notes",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ text: "" }),
});

// The root conversation always has ID 1. The first root() call creates it,
// its built-in documents, and whatever `init` writes, all in one commit. Later
// calls, including after a restart, return it and ignore `init`.
const root = await harness.root(context, {
	init: async (tx, rootId) => {
		(await tx.doc(Notes, rootId)).text = "root notes";
		(await tx.doc(ConversationConfig, rootId)).thinkingLevel = "low";
	},
});
console.log("root:", root.id, await harness.snapshot(Notes, root.id, context));
console.log("root config:", await harness.snapshot(ConversationConfig, root.id, context));

await harness.close(context);
