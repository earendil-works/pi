// Reload extension code through the registry.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/10-registry-reload.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, wrapTool } from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

function exampleTool(name: string, description: string) {
	return defineTool({
		name,
		description,
		parameters: Type.Object({ path: Type.String() }),
		execute: async (args) => ({ content: [{ type: "text", text: `${name} ${args.path}` }] }),
	});
}

const read = exampleTool("read", "Read a file");
const registry = createRegistry();
registry.install(defineExtension({ name: "files", tools: [read, exampleTool("grep", "Search files")] }));
const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);
const root = await harness.root(context);
const tools = async () => (await root.agent(context)).tools.map((tool) => `${tool.name}: ${tool.description}`);

// Reloading is installing a new object with the same name: it replaces the old
// one in place, in one publication, so no conversation ever sees it missing.
// A task phase that already started keeps the snapshot it took; the next phase
// uses the new code.
registry.install(defineExtension({ name: "files", tools: [read, exampleTool("grep", "Search files, faster")] }));
console.log("after reload:", await tools());

// Another extension may wrap a tool by name. The wrap applies where the
// wrapping extension is selected, and survives reloads of the wrapped tool.
const Audit = defineExtension({
	name: "audit",
	wraps: [wrapTool(read, (tool) => ({ ...tool, description: `${tool.description} (audited)` }))],
});
registry.install(Audit);
console.log("with audit:", await tools());

// Uninstall removes an extension by name; conversations that select it stop
// getting its code.
registry.uninstall(Audit);
console.log("after uninstall:", await tools());

await harness.close(context);
