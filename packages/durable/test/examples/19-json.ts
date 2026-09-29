// JSON mode: stream one prompt's run as JSON lines, like `pi --mode json`. Two modes:
//   --events (default): the experimental agent events of watchEvents(), starting with a `snapshot` event.
//   --ops: the raw ConversationView frames, starting with the view itself; each later line holds one commit's ops.
// --storage sqlite (default) | jsonl | memory: sqlite writes a temporary database file, jsonl a temporary directory;
// neither is deleted, and the path is printed to stderr at the end.
// Uses OpenAI when OPENAI_API_KEY is set, and a scripted faux model otherwise.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/19-json.ts --events "What is in this directory?"
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import { createRegistry, Harness, MemoryStorage, type Storage, watchEvents } from "../../src/index.ts";
import { openNodeJsonlStorage } from "../../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../../src/storage/sqlite/node.ts";
import { createBashTool, createReadTool } from "../../src/tools/index.ts";

const context = BACKGROUND_CONTEXT;
const args = process.argv.slice(2);
const mode = args.includes("--ops") ? "ops" : "events";
const storageIndex = args.indexOf("--storage");
const storageKind = storageIndex < 0 ? "sqlite" : args[storageIndex + 1];
const prompt =
	args.find((arg, index) => !arg.startsWith("--") && (storageIndex < 0 || index !== storageIndex + 1)) ??
	"What is in this directory?";

let storage: Storage;
let location: string | undefined;
if (storageKind === "sqlite") {
	location = join(tmpdir(), `pi-durable-json-${Date.now()}.sqlite`);
	storage = await openNodeSqliteStorage(location);
} else if (storageKind === "jsonl") {
	location = await mkdtemp(join(tmpdir(), "pi-durable-json-"));
	storage = await openNodeJsonlStorage(location, context);
} else if (storageKind === "memory") {
	storage = new MemoryStorage();
} else {
	throw new Error(`Unknown --storage ${storageKind}; use sqlite, jsonl, or memory`);
}
const print = (value: unknown): void => void process.stdout.write(`${JSON.stringify(value)}\n`);

const models = createModels();
let model = { provider: "openai", modelId: "gpt-6-sol" };
if (process.env.OPENAI_API_KEY !== undefined) {
	models.setProvider(openaiProvider());
} else {
	const faux = fauxProvider({ tokensPerSecond: 200 });
	models.setProvider(faux.provider);
	model = { provider: "faux", modelId: "faux-1" };
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: "ls" }, { id: "call-1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("This directory holds the durable package sources, tests, and docs.")]),
	]);
}

const registry = createRegistry();
registry.systemPrompt.section("preamble", () => "You are a concise coding assistant.", { tag: false });
registry.tools.add(createReadTool());
registry.tools.add(createBashTool());
const env = new NodeExecutionEnv({ cwd: process.cwd() });
const harness = await Harness.open(storage, { models, registry, env }, context);
const root = await harness.root(context);
await root.setModel(model, context);

// Attach before submitting, so the stream covers the whole run.
let stop: () => Promise<unknown>;
if (mode === "events") {
	const stream = await watchEvents(harness, root.id, context);
	print(stream.snapshot);
	stream.start(async (events) => {
		for (const event of events) print(event);
	});
	stop = () => stream.stop();
} else {
	const watch = await root.watch(context);
	print({ view: watch.value });
	watch.start(async (_value, ops) => print({ ops }));
	stop = () => watch.stop();
}

const submission = await root.submit({ type: "input", content: prompt }, context);
await submission.wait(context);
await harness.waitForIdle(context);
// Let the last batch reach the listener before stopping.
await new Promise((resolve) => setTimeout(resolve, 0));
await stop();
await harness.close(context);
if (location !== undefined) console.error(`${storageKind} storage: ${location}`);
