// Conversation configuration: model, thinking level, and active tools.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/07-configuration.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage, type ToolRegistration } from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// Apps may attach their own metadata to tools, such as a prompt snippet.
type AppTool = ToolRegistration & { readonly snippet?: string };

function exampleTool(name: string, description: string): AppTool {
	return {
		name,
		description,
		parameters: Type.Object({ path: Type.String() }),
		snippet: `Use ${name} for files.`,
		execute: async (args) => ({ content: [{ type: "text", text: `${name} ${JSON.stringify(args)}` }] }),
	};
}

const registry = createRegistry<AppTool>();
registry.tools.add(exampleTool("read", "Read a file"));
const writeRegistration = registry.tools.add(exampleTool("write", "Write a file"));
registry.tools.add(exampleTool("grep", "Search files"));
const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);
const root = await harness.root(context);

// Model, thinking level, and active tool names live in the built-in
// ConversationConfig document. New conversations start with every registered
// tool active. Each setter is one commit.
console.log("active tools:", await root.getActiveTools(context));
await root.setModel({ provider: "anthropic", modelId: "claude-sonnet-4-5" }, context);
await root.setThinkingLevel("high", context);
await root.setActiveTools(["write", "read"], context);
console.log("snippet kept on the app tool:", registry.tools.list()[0]!.snippet);
console.log("model:", await root.getModel(context), "thinking:", await root.getThinkingLevel(context));

// Adding a name that is not registered is rejected, and nothing is written.
await root.setActiveTools(["read", "find"], context).catch((error: Error) => console.log("rejected:", error.message));

// Names that were already active are never rechecked. After "write" is
// unregistered it stays in the configuration; requests just stop offering it
// until it is registered again.
writeRegistration.dispose();
await root.setActiveTools(["write", "read", "grep"], context);
console.log("active tools without a registered write:", await root.getActiveTools(context));
console.log(
	"registered tools:",
	registry.tools.list().map((entry) => entry.name),
);

// Request options and the durable retry policy are configuration too.
await root.setStreamOptions({ timeoutMs: 60_000 }, context);
console.log("stream options:", await root.getStreamOptions(context));
console.log("retry policy:", await root.getRetryPolicy(context));

await harness.close(context);
