// An extension that keeps its own per-conversation document.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/11-extension-state.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
	section,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// A todo list per conversation. Rewindable with `asOf`, so a fork starts with
// the todos its parent had at the fork entry.
const Todos = defineDoc<{ items: string[] }>({
	kind: "example.todos",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ items: [] }),
});

// The tool writes the document; the section shows it to the model before every
// request. Nothing needs to create it up front: tx.doc() creates it on first
// write, and the section treats a missing document as an empty list.
const Todo = defineExtension({
	name: "todo",
	tools: [
		defineTool({
			name: "todo",
			description: "Add an item to your todo list",
			parameters: Type.Object({ item: Type.String() }),
			execute: async (args, api, callContext) => {
				await api.commit(async (tx) => {
					(await tx.doc(Todos, api.conversationId)).items.push(args.item);
				}, callContext);
				return { content: [{ type: "text", text: `added ${args.item}` }] };
			},
		}),
	],
	sections: [
		section("todos", async (input, renderContext) => {
			const todos = await input.read.snapshot(Todos, input.conversationId, renderContext);
			return todos === undefined || todos.items.length === 0 ? undefined : todos.items.join("\n");
		}),
	],
});

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(Todo);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

faux.setResponses([
	fauxAssistantMessage(fauxToolCall("todo", { item: "fix the build" }), { stopReason: "toolUse" }),
	fauxAssistantMessage("Noted."),
	fauxAssistantMessage("Working on it."),
]);
await (await root.submit({ type: "input", content: "Remember to fix the build." }, context)).wait(context);
console.log("todos:", await harness.snapshot(Todos, root.id, context));

// The next request's system prompt carries the list. The first system message
// only announced the todo tool; no section had text yet.
await (await root.submit({ type: "input", content: "What is next?" }, context)).wait(context);
const { messages } = await root.context(context);
console.log(
	"system messages:",
	messages.flatMap((message) =>
		message.role === "system"
			? [{ sections: message.sections, toolsAdded: message.toolsAdded?.map((tool) => tool.name) }]
			: [],
	),
);

await harness.close(context);
