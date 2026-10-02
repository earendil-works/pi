// Per-conversation agent choices and Harness-wide settings.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/07-configuration.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	AgentDoc,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	type HarnessSettings,
	MemoryStorage,
	section,
	type ToolRegistration,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// Apps may attach their own metadata to tools, such as a prompt snippet.
type AppTool = ToolRegistration & { readonly snippet?: string };

function exampleTool(name: string, description: string): AppTool {
	const tool = defineTool({
		name,
		description,
		parameters: Type.Object({ path: Type.String() }),
		execute: async (args) => ({ content: [{ type: "text", text: `${name} ${args.path}` }] }),
	});
	return { ...tool, snippet: `Use ${name} for files.` };
}

const read = exampleTool("read", "Read a file");
const write = exampleTool("write", "Write a file");
const grep = exampleTool("grep", "Search files");
const Files = defineExtension<AppTool>({ name: "files", tools: [read, write] });
const Search = defineExtension<AppTool>({ name: "search", tools: [grep] });
// Sections see the offered tools as app tools, so one can render their snippets.
const Snippets = defineExtension<AppTool>({
	name: "snippets",
	sections: [section("tool_snippets", (input) => input.agent.tools.map((tool) => tool.snippet).join("\n"))],
});

const registry = createRegistry<AppTool>();
registry.install(Files);
registry.install(Search);
registry.install(Snippets);

// Settings are Harness-wide run policy, read at every use and never stored.
// A getter makes a value live, such as one backed by the app's settings file.
let timeoutMs = 60_000;
const settings: HarnessSettings = {
	get stream() {
		return { timeoutMs };
	},
	retry: { maxRetries: 5 },
	toolExecution: "sequential",
};
const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry, settings }, context);
const root = await harness.root(context);

// A new conversation stores no choices and follows the host: every installed
// extension, all of their tools.
const tools = async () => (await root.agent(context)).tools.map((tool) => tool.name);
console.log("default tools:", await tools());

// configure() stores choices in the conversation's pi.agent document, one
// commit per call. Extensions and tools are passed as objects and stored by
// name, so a typo cannot slip in.
await root.configure(
	{
		model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
		thinkingLevel: "high",
		tools: [write, read],
	},
	context,
);
console.log("stored:", await harness.snapshot(AgentDoc, root.id, context));
const agent = await root.agent(context);
console.log("model:", agent.model, "thinking:", agent.thinkingLevel, "tools:", await tools());

// Deselect an extension; `null` clears a stored field back to the host default.
await root.configure({ extensions: { remove: [Search] }, tools: null }, context);
console.log("without search:", await tools());

// Stored names outlive the code. The conversation selects exactly these two
// extensions; uninstalling "files" leaves it selected, and requests just stop
// offering its tools until it is back.
await root.configure({ extensions: [Files, Search] }, context);
registry.uninstall(Files);
console.log("files uninstalled:", await tools());
registry.install(Files);
console.log("files reinstalled:", await tools());

// Settings changes need no commit; the next request uses the new timeout.
timeoutMs = 120_000;

await harness.close(context);
