// A small coding agent: the built-in coding tools, a prompt that knows the working directory, settings backed by the
// app's settings file, and an environment that follows the conversation's directory.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/26-coding-agent.ts
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import {
	createRegistry,
	defineExtension,
	Harness,
	type HarnessSettings,
	MemoryStorage,
	section,
	ToolResultEntry,
} from "../../src/index.ts";
import { CodingTools } from "../../src/tools/index.ts";

const context = BACKGROUND_CONTEXT;
const workspace = await mkdtemp(join(tmpdir(), "pi-durable-agent-"));
await mkdir(join(workspace, "app"));

// The app's own prompt, next to the coding tools.
const Coding = defineExtension({
	name: "coding",
	sections: [
		section("preamble", () => "You are a coding agent. Use the tools to inspect the project.", { tag: false }),
		section("cwd", (input) => input.env?.cwd),
	],
});
const registry = createRegistry();
registry.install(CodingTools);
registry.install(Coding);

// Settings the user edits while the agent runs, like a settings.json the app watches. The getters make every
// Harness read see the current file; nothing is copied or stored.
const userSettings = { parallelTools: true, maxRetries: 3 };
const settings: HarnessSettings = {
	get toolExecution() {
		return userSettings.parallelTools ? "parallel" : "sequential";
	},
	get retry() {
		return { maxRetries: userSettings.maxRetries };
	},
};

// The Harness calls this for every tool call and request with the conversation's `cwd`, so changing a conversation's
// directory needs no restart.
const env = ({ cwd = workspace }: { readonly cwd?: string }) => new NodeExecutionEnv({ cwd });

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const pwd = () => fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }), { stopReason: "toolUse" });
faux.setResponses([pwd(), fauxAssistantMessage("Done."), pwd(), fauxAssistantMessage("Done.")]);

const harness = await Harness.open(new MemoryStorage(), { models, registry, settings, env }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: workspace } });

const lastBashOutput = async () => {
	const page = await root.entries({}, 10, undefined, context);
	const result = page.items.find((entry) => ToolResultEntry.is(entry))?.model?.[0] as ToolResultMessage;
	return result.content.map((part) => (part.type === "text" ? part.text.trim() : "")).join("");
};

await (await root.submit({ type: "input", content: "Where are we?" }, context)).wait(context);
console.log("bash ran in:", await lastBashOutput());

// The user switches the project directory and turns off parallel tools. Both apply from the next use.
await root.configure({ cwd: join(workspace, "app") }, context);
userSettings.parallelTools = false;
await (await root.submit({ type: "input", content: "And now?" }, context)).wait(context);
console.log("bash ran in:", await lastBashOutput());

await harness.close(context);
await rm(workspace, { recursive: true, force: true });
