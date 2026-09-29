// System prompt sections.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/15-system-prompt.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	type Conversation,
	ConversationConfig,
	type ConversationInit,
	createRegistry,
	defineDoc,
	Harness,
	MemoryStorage,
	SystemEntry,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage("Done."), fauxAssistantMessage("Done."), fauxAssistantMessage("Done.")]);

// Pico stores no prompt state. Before each model request, the registry's
// sections render the desired prompt, and only the difference to what the
// model already saw is appended to the transcript as a `pi.system` entry.
// Sections read per-conversation data through `input.read`; here a coding
// agent keeps its own profile document.
const AgentProfile = defineDoc<{ role: "main" | "subagent"; cwd: string }>({
	kind: "example.agent-profile",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ role: "main", cwd: "/repo" }),
});

const registry = createRegistry();
// `tag: false` sends the text as is; by default it is wrapped in <key>...</key>.
registry.systemPrompt.section("preamble", () => "You are a coding agent.", { tag: false });
registry.systemPrompt.section("cwd", async (input, renderContext) => {
	return (await input.read.snapshot(AgentProfile, input.conversationId, renderContext))?.cwd;
});
// Returning undefined omits the section, here for subagents.
registry.systemPrompt.section("agents_md", async (input, renderContext) => {
	const profile = await input.read.snapshot(AgentProfile, input.conversationId, renderContext);
	return profile?.role === "subagent" ? undefined : "Run npm run check after changes.";
});
// Another extension decorates a section without replacing it.
registry.systemPrompt.wrap("preamble", "tone", (section) => ({
	...section,
	render: async (input, renderContext) => `${await section.render(input, renderContext)} Be terse.`,
}));

const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const withModel: ConversationInit = async (tx, id) => {
	(await tx.doc(ConversationConfig, id)).model = { provider: "faux", modelId: "faux-1" };
	await tx.doc(AgentProfile, id);
};
const root = await harness.root(context, { init: withModel });
const subagent = await harness.createConversation(
	{
		ownership: { kind: "ownerless" },
		init: async (tx, id) => {
			await withModel(tx, id);
			(await tx.doc(AgentProfile, id)).role = "subagent";
		},
	},
	context,
);

async function systemEntries(conversation: Conversation) {
	const page = await conversation.entries({}, 20, undefined, context);
	return [...page.items].reverse().flatMap((entry) => (SystemEntry.is(entry) ? (entry.model ?? []) : []));
}

await (await root.submit({ type: "input", content: "Fix the build." }, context)).wait(context);
await (await subagent.submit({ type: "input", content: "Read the logs." }, context)).wait(context);
console.log("root system prompt:", await systemEntries(root));
console.log("subagent system prompt:", await systemEntries(subagent));

// When a section's output changes, the next request appends only the change.
await root.commit(async (tx) => {
	(await tx.doc(AgentProfile, root.id)).cwd = "/repo/packages";
}, context);
await (await root.submit({ type: "input", content: "Now the package." }, context)).wait(context);
console.log("root system entries after cwd change:", await systemEntries(root));

await harness.close(context);
