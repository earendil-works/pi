// Print mode: submit one prompt and print its answer, like `pi -p`. The host awaits its own Submission, not global
// idle. Uses OpenAI when OPENAI_API_KEY is set, and a scripted faux model otherwise.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/18-print.ts "What is in this directory?"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from "../../src/index.ts";
import { createBashTool, createReadTool } from "../../src/tools/index.ts";

const context = BACKGROUND_CONTEXT;
const prompt = process.argv[2] ?? "What is in this directory?";

const models = createModels();
let model = { provider: "openai", modelId: "gpt-6-sol" };
if (process.env.OPENAI_API_KEY !== undefined) {
	models.setProvider(openaiProvider());
} else {
	const faux = fauxProvider();
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
const harness = await Harness.open(new MemoryStorage(), { models, registry, env }, context);
const root = await harness.root(context);
await root.setModel(model, context);

const submission = await root.submit({ type: "input", content: prompt }, context);
const settled = await submission.wait(context);
if (settled.status === "done" && settled.type === "input") {
	const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	const answer = entry?.model?.[0] as AssistantMessage;
	console.log(answer.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join(""));
} else {
	console.error(`unanswered: ${settled.status === "unanswered" ? settled.reason : settled.status}`);
	process.exitCode = 1;
}
await harness.close(context);
