// Reload an extension while a call runs, then restart the process. Running work finishes on the code it started
// with; stored choices are names, so they survive a restart and bind to whatever code the new process installs.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/31-reload-and-restart.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ToolResultMessage, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, ToolResultEntry } from "../../src/index.ts";
import { openNodeSqliteStorage } from "../../src/storage/sqlite/node.ts";

const context = BACKGROUND_CONTEXT;

// Stand-in for code loaded from disk: each call builds the extension as the file currently reads.
let started = (): void => {};
let gate = Promise.resolve();
function loadVersioned(version: string) {
	return defineExtension({
		name: "versioned",
		tools: [
			defineTool({
				name: "version",
				description: "Report the tool's code version",
				parameters: Type.Object({}),
				execute: async () => {
					started();
					await gate;
					return { content: [{ type: "text", text: version }] };
				},
			}),
		],
	});
}

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const callVersion = () => fauxAssistantMessage(fauxToolCall("version", {}), { stopReason: "toolUse" });
faux.setResponses([callVersion(), fauxAssistantMessage("Done."), callVersion(), fauxAssistantMessage("Done.")]);

const directory = await mkdtemp(join(tmpdir(), "pi-durable-reload-"));
const open = async (registry: ReturnType<typeof createRegistry>) =>
	Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), { models, registry }, context);

// First process.
let registry = createRegistry();
registry.install(loadVersioned("v1"));
let harness = await open(registry);
let root = await harness.root(context, {
	// Selected by name. The name is what is stored, never the code.
	agent: { model: { provider: "faux", modelId: "faux-1" }, extensions: [loadVersioned("v1")] },
});
const lastResult = async () => {
	const page = await root.entries({}, 10, undefined, context);
	const result = page.items.find((entry) => ToolResultEntry.is(entry))?.model?.[0] as ToolResultMessage;
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
};

// The file changes while a call runs: the running call finishes on v1, the next call uses v2.
let release = (): void => {};
gate = new Promise((resolve) => {
	release = resolve;
});
const running = new Promise<void>((resolve) => {
	started = resolve;
});
const submission = await root.submit({ type: "input", content: "Which version?" }, context);
await running;
registry.install(loadVersioned("v2"));
release();
await submission.wait(context);
console.log("call running during the reload:", await lastResult());
await (await root.submit({ type: "input", content: "And now?" }, context)).wait(context);
console.log("next call:", await lastResult());
await harness.close(context);

// Second process: the conversation still selects "versioned", but this process has not installed it yet.
registry = createRegistry();
harness = await open(registry);
root = await harness.root(context);
const tools = async () => (await root.agent(context)).tools.map((tool) => tool.name);
console.log("after restart, before install:", await tools());
registry.install(loadVersioned("v3"));
console.log("after install:", await tools());

await harness.close(context);
await rm(directory, { recursive: true, force: true });
