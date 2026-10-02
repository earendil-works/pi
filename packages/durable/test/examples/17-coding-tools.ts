// A coding-agent tool turn on JSONL storage: the model reads, edits, and runs commands, then answers. A hook times a
// `cat` of /tmp/1gb.txt (create it first to measure; without it that call ends in an error result). The storage
// directory is left behind for inspection.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/17-coding-tools.ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import {
	AssistantEntry,
	createRegistry,
	defineExtension,
	Harness,
	hook,
	ToolResultEntry,
	ToolTask,
} from "../../src/index.ts";
import { openNodeJsonlStorage } from "../../src/storage/jsonl/node.ts";
import { type BashToolInput, CodingTools } from "../../src/tools/index.ts";

const context = BACKGROUND_CONTEXT;
const directory = await mkdtemp(join(tmpdir(), "pi-durable-example-"));
await writeFile(join(directory, "notes.txt"), "hello world\n");

// The faux provider plays the model: four tool-calling answers, then a final answer.
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const toolCall = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) =>
	fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
faux.setResponses([
	toolCall("read", { path: "notes.txt" }, "r"),
	toolCall("edit", { path: "notes.txt", edits: [{ oldText: "world", newText: "durable" }] }, "e"),
	toolCall("bash", { command: "cat notes.txt" }, "b"),
	toolCall("bash", { command: "cat /tmp/1gb.txt" }, "c"),
	fauxAssistantMessage([fauxText("The file now greets durable.")]),
]);

// Hooks see every call before and after execution; these time the big `cat`.
const isBigCat = (call: { name: string; arguments: unknown }) =>
	call.name === "bash" && (call.arguments as BashToolInput).command.includes("1gb.txt");
let start = 0;
const Timing = defineExtension({
	name: "timing",
	hooks: [
		hook(ToolTask, {
			beforeTool: (call) => {
				if (isBigCat(call)) start = Date.now();
				return undefined;
			},
			afterTool: (call) => {
				if (isBigCat(call)) console.log(`cat /tmp/1gb.txt took ${Date.now() - start} ms`);
				return undefined;
			},
		}),
	],
});
const registry = createRegistry();
// CodingTools brings read, write, edit, and bash. Tools reach files and processes only through the environment the
// Harness builds for each call.
registry.install(CodingTools);
registry.install(Timing);

// The environment is built per use and follows the conversation's agent `cwd`.
const storage = await openNodeJsonlStorage(directory, context);
const harness = await Harness.open(
	storage,
	{ models, registry, env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? process.cwd() }) },
	context,
);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: directory } });

// Each tool call runs as a durable pi.tool task owned by the generation, which waits for them and continues the run with the next generation.
const settled = await (await root.submit({ type: "input", content: "Greet durable instead." }, context)).wait(context);
console.log("status:", settled.status);
const transcript = await root.entries({}, 20, undefined, context);
for (const entry of [...transcript.items].reverse()) {
	if (!ToolResultEntry.is(entry)) {
		console.log(entry.kind);
		continue;
	}
	const result = entry.model![0] as ToolResultMessage;
	const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("");
	console.log(
		`${entry.kind} ${result.toolName}:`,
		JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text),
	);
}
if (settled.status === "done" && settled.type === "input") {
	const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	const message = answer?.model?.[0];
	console.log("answer:", message?.role === "assistant" ? message.content : message);
}
console.log("file:", JSON.stringify(await readFile(join(directory, "notes.txt"), "utf8")));
await harness.close(context);
console.log("storage:", directory);
