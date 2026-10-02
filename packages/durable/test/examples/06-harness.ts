// Open a Harness with a registry of extensions.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/06-harness.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	AgentDoc,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// A Harness is a Session plus conversation handles and durable tasks. Extension
// code (tools, prompt sections, hooks, tasks) comes in named extensions
// installed in a registry the application owns. Nothing in the registry is
// saved; it is this process's code.
const read = defineTool({
	name: "read",
	description: "Read a file",
	parameters: Type.Object({ path: Type.String() }),
	execute: async (args) => ({ content: [{ type: "text", text: `contents of ${args.path}` }] }),
});
const Files = defineExtension({ name: "files", tools: [read] });
const registry = createRegistry();
registry.install(Files);

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
// its built-in documents, the `agent` choices, and whatever `init` writes, all
// in one commit. Later calls, including after a restart, return it and ignore
// both options.
const root = await harness.root(context, {
	agent: { thinkingLevel: "low" },
	init: async (tx, rootId) => {
		(await tx.doc(Notes, rootId)).text = "root notes";
	},
});
console.log("root:", root.id, await harness.snapshot(Notes, root.id, context));
// The stored choices are names; agent() resolves them against the registry.
console.log("stored agent:", await harness.snapshot(AgentDoc, root.id, context));
const agent = await root.agent(context);
console.log(
	"resolved:",
	agent.thinkingLevel,
	agent.extensions.map((extension) => extension.name),
	agent.tools.map((tool) => tool.name),
);

await harness.close(context);
