// Reload extension code through the registry.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/10-registry-reload.ts
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, type ToolRegistration } from "../../src/index.ts";

function exampleTool(name: string, description: string): ToolRegistration {
	return {
		name,
		description,
		parameters: Type.Object({ path: Type.String() }),
		execute: async (args) => ({ content: [{ type: "text", text: `${name} ${JSON.stringify(args)}` }] }),
	};
}

const registry = createRegistry();
registry.tools.add(exampleTool("read", "Read a file"));
const grep = registry.tools.add(exampleTool("grep", "Search files"));

// batch() publishes a replacement at once, so no snapshot ever sees the tool
// missing. Work that already started keeps using the snapshot it took.
registry.batch(() => {
	grep.dispose();
	registry.tools.add(exampleTool("grep", "Search files, faster"));
});
console.log(
	"tools after reload:",
	registry.tools.list().map((entry) => `${entry.name}: ${entry.description}`),
);

// Wrappers decorate a tool without replacing it, and survive its reload.
registry.tools.wrap("read", "audit", (tool) => ({ ...tool, description: `${tool.description} (audited)` }));
console.log("wrapped read:", registry.snapshot().tool("read")?.description);
