// Transcript history and model context.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/09-context.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, StopReason, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
const harness = await Harness.open(
	new MemoryStorage(),
	{ models: createModels(), registry: createRegistry() },
	context,
);

// Entries are immutable. `model` holds the messages an entry contributes to
// the next model request; `data` is for the app only. context() turns the
// stored transcript into those request messages:
//   - an entry with `head` starts a new context; older entries stay stored,
//   - `edits` replace or omit what an earlier entry contributes,
//   - aborted, error, and deferred assistant messages are not sent,
//   - tool results are sent right after their call, in call order,
//   - a call without a result gets a synthesized error result.
function assistantMessage(text: string, calls: readonly string[] = [], stopReason?: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			...calls.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: {} })),
		],
		api: "example",
		provider: "example",
		model: "example",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: stopReason ?? (calls.length > 0 ? "toolUse" : "stop"),
		timestamp: 2,
	};
}

function toolResultMessage(id: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text: `file ${id}` }],
		isError: false,
		timestamp: 3,
	};
}

function show(message: Message): string {
	switch (message.role) {
		case "user":
			return `user: ${message.content as string}`;
		case "system":
			return `system: ${JSON.stringify(message.sections)}`;
		case "assistant":
			return `assistant: ${message.content
				.map((part) => (part.type === "text" ? part.text : part.type === "toolCall" ? `call(${part.id})` : ""))
				.join(" ")}`;
		case "toolResult":
			return `result(${message.toolCallId})${message.isError ? " error" : ""}`;
	}
}

const transcript = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
const say = (kind: string, ...model: Message[]) =>
	transcript.commit((tx) => tx.appendEntry(transcript.id, { kind, model }), context);

const question = await say("message", { role: "user", content: "read a and b", timestamp: 1 });
await say("message", assistantMessage("I crashed", [], "aborted")); // stored, never sent
const calls = await say("message", assistantMessage("reading", ["a", "b"]));
await say("message", toolResultMessage("b")); // results finish out of order
await say("pi.system", { role: "system", content: "", sections: { cwd: "<cwd>/repo</cwd>" }, timestamp: 4 });
await say("message", toolResultMessage("a"));
await say("message", assistantMessage("a and b look fine"));
await transcript.commit(
	(tx) =>
		tx.appendEntry(transcript.id, {
			kind: "edit",
			data: "user fixed a typo",
			edits: [
				{
					target: question.id,
					action: "replace",
					messages: [{ role: "user", content: "read files a and b", timestamp: 1 }],
				},
			],
		}),
	context,
);
await transcript.commit((tx) => tx.appendEntry(transcript.id, { kind: "note", data: "display only" }), context);

let view = await transcript.context(context);
console.log(
	"raw active entries:",
	view.entries.map((entry) => entry.kind),
);
console.log("request messages:", view.messages.map(show));

// A fork at the tool call has no results yet; context() fills them in.
const cut = await transcript.fork(calls.id, { ownership: { kind: "ownerless" } }, context);
console.log("fork messages:", (await cut.context(context)).messages.map(show));

// A headed summary replaces everything before the entry it points at.
// "self" points the head at the summary entry itself.
await transcript.commit(
	(tx) =>
		tx.appendEntry(transcript.id, {
			kind: "summary",
			head: "self",
			model: [{ role: "user", content: "Summary: a and b are fine.", timestamp: 5 }],
		}),
	context,
);
view = await transcript.context(context);
console.log("after summary:", view.head?.kind, view.messages.map(show));

// entries() pages the stored transcript, newest first, including inherited
// parent entries. Nothing is ever deleted by heads or edits.
const history = await transcript.entries({}, 3, undefined, context);
console.log(
	"newest stored entries:",
	history.items.map((entry) => entry.kind),
	"more:",
	history.next !== undefined,
);

await harness.close(context);
