// A real model: stream an answer from OpenAI.
// Run from packages/durable (needs OPENAI_API_KEY):
//   node --conditions=source --experimental-strip-types test/examples/16-real-model.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { AssistantEntry, createRegistry, Harness, LiveDoc, MemoryStorage } from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// Production code passes a Models collection with real providers; the Harness
// never talks to a provider any other way. openaiProvider() reads
// OPENAI_API_KEY from the environment. While the answer streams, generation
// commits throttled partials to the conversation's pi.live document. Watching
// that document streams the answer; the watch sees only committed values.
if (process.env.OPENAI_API_KEY === undefined) {
	console.log("skipped: OPENAI_API_KEY is not set");
} else {
	const models = createModels();
	models.setProvider(openaiProvider());
	const registry = createRegistry();
	registry.systemPrompt.section("preamble", () => "You are a concise assistant.", { tag: false });
	const harness = await Harness.open(new MemoryStorage(), { models: models, registry: registry }, context);
	const root = await harness.root(context);
	await root.setModel({ provider: "openai", modelId: "gpt-6-sol" }, context);
	await root.setThinkingLevel("high", context);
	const liveWatch = (await harness.watchDoc(LiveDoc, root.id, context))!;
	// Print only what each committed partial adds to the text printed so far.
	let printed = "";
	const printText = (text: string): void => {
		if (text.length <= printed.length || !text.startsWith(printed)) return;
		process.stdout.write(text.slice(printed.length));
		printed = text;
	};
	liveWatch.start(async (value) => {
		const block = value?.generation?.message?.content.find((content) => content.type === "text");
		if (block?.type === "text") printText(block.text);
	});
	harness.resume();
	process.stdout.write("answer: ");
	const poem = await root.submit({ type: "input", content: "Write a long poem" }, context);
	const settledPoem = await poem.wait(context);
	await liveWatch.stop();
	if (settledPoem.status === "done" && settledPoem.type === "input") {
		// The last throttle window may not have been committed as a partial; the answer entry has the rest.
		const entry = await root.commit((tx) => tx.entry(AssistantEntry, settledPoem.answer), context);
		const message = entry?.model?.[0];
		const block =
			message?.role === "assistant" ? message.content.find((content) => content.type === "text") : undefined;
		if (block?.type === "text") printText(block.text);
		process.stdout.write("\n");
	} else {
		console.log("unanswered:", settledPoem.reason, settledPoem.detail);
	}
	await harness.close(context);
}
