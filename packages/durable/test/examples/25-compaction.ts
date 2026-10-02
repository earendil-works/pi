// Compaction: a long trip-planning chat whose older messages are summarized so the model context stays small.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/25-compaction.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	CompactionEntry,
	type Conversation,
	createRegistry,
	Harness,
	LiveDoc,
	MemoryStorage,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// A fake model with a tiny 3000-token window. It answers chat messages, writes summaries when asked to summarize,
// and once rejects a request as too long, the way real providers report a context overflow.
let overflowOnce = false;
let summaries = 0;
// While set, the next chat answer waits for it, which keeps the conversation busy.
let hold: Promise<void> | undefined;
async function respond(transcript: TranscriptContext): Promise<AssistantMessage> {
	const first = transcript.messages[0];
	if (first?.role === "system" && typeof first.content === "string" && first.content.includes("summarization")) {
		summaries++;
		return fauxAssistantMessage(`## Goal\nPlan a week in Lisbon (summary #${summaries}).`);
	}
	if (overflowOnce) {
		overflowOnce = false;
		return fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" });
	}
	const held = hold;
	hold = undefined;
	await held;
	const question = transcript.messages.findLast((message) => message.role === "user");
	return fauxAssistantMessage(`A detailed answer to "${text(question)}": ${"details ".repeat(200)}`);
}
const faux = fauxProvider({ models: [{ id: "tiny", contextWindow: 3000, maxTokens: 1000 }] });
faux.setResponses(Array.from({ length: 100 }, () => respond));
const models = createModels();
models.setProvider(faux.provider);

// Generation blocks to compact above 3000 - 1000 = 2000 tokens and starts a background compaction above 2000 - 800.
// Settings are read at every use, so the getter makes `backgroundTokens` live.
let backgroundTokens = 800;
const settings = {
	get compaction() {
		return { reserveTokens: 1000, keepRecentTokens: 400, backgroundTokens };
	},
};
const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry(), settings }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "tiny" } } });

async function ask(question: string): Promise<void> {
	const submission = await root.submit({ type: "input", content: question }, context);
	const record = await submission.wait(context);
	// Let a background compaction started by this turn finish, so its summary shows below.
	const running = (await harness.snapshot(LiveDoc, root.id, context))?.compactions ?? [];
	for (const { taskId } of running) await harness.waitForTask(taskId, context);
	await show(root, `after "${question}" (${record.status === "done" ? "answered" : record.reason})`);
}

// 1. A long chat: once the context crosses the background threshold, a compaction runs while the chat goes on, and
// its summary lands at once when the conversation is idle, otherwise at the next turn boundary.
for (const question of [
	"Where should we stay?",
	"What should we eat?",
	"Which day trips?",
	"Any museums?",
	"Nightlife?",
]) {
	await ask(question);
}

// 2. A manual compaction while an answer is still being written. The summary is ready first, waits in the inbox,
// and is placed right after the answer.
let finishAnswer!: () => void;
hold = new Promise((resolve) => {
	finishAnswer = resolve;
});
const busy = await root.submit({ type: "input", content: "How do we get around?" }, context);
const manual = await root.compact("Keep the hotel shortlist", context);
const { state } = await harness.waitForTask(manual, context);
const placement = state.outcome.status === "completed" ? state.outcome.result.submissionId : undefined;
const summary = (await harness.submission(placement!, context))!;
console.log("\nmanual compaction finished; its summary is", (await summary.status(context)).status);
finishAnswer();
await busy.wait(context);
console.log("after the answer, the summary is", (await summary.wait(context)).status);
await show(root, "after compact()");

// 3. The provider rejects a request as too long: generation compacts and retries it once. Background compaction is
// turned off so the summary below is the overflow one.
backgroundTokens = 0;
await ask("What should we pack?");
overflowOnce = true;
await ask("Summarize the plan for my partner");

await harness.close(context);

/** Print the model context: one line per message, and the number of stored entries behind it. */
async function show(conversation: Conversation, label: string): Promise<void> {
	const view = await conversation.context(context);
	const stored = (await conversation.entries({}, 1000, undefined, context)).items.length;
	console.log(`\n${label}: ${view.messages.length} messages in context, ${stored} entries stored`);
	const reason = CompactionEntry.is(view.head) ? view.head.data.reason : undefined;
	if (reason !== undefined) console.log(`  (${reason} compaction summary first)`);
	for (const message of view.messages) {
		console.log(
			`  ${message.role.padEnd(9)} ${message.role === "system" ? "(system prompt)" : text(message).slice(0, 70)}`,
		);
	}
}

function text(message: Message | undefined): string {
	if (message === undefined || message.role === "system") return "";
	if (typeof message.content === "string") return message.content;
	const block = message.content.find((content) => content.type === "text");
	return block?.type === "text" ? block.text.replaceAll("\n", " ") : "";
}
