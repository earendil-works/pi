// Serialize asynchronous document work with a watch.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/04-watches.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineDoc, MemoryStorage } from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
const session = createSession(new MemoryStorage());

const Notes = defineDoc<{ text: string }>({
	checkpointWhen: () => false,
	kind: "example.notes",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ text: "" }),
});
const chat = await session.commit(async (tx) => {
	const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
	(await tx.doc(Notes, conversation.id)).text = "first";
	return conversation;
}, context);

// A watch starts from one stable acquisition revision. Callbacks never overlap:
// commits made while one runs arrive folded into the next call, which gets the
// newest value and ops that turn the previously delivered value into it (one
// full-value replacement `[["r", value]]` once more than 10,000 ops pile up).
const notesWatch = await session.watchDoc(Notes, chat.id, context);
if (notesWatch === undefined) throw new Error("notes are absent");
console.log("watch baseline:", notesWatch.value);
const busy = Promise.withResolvers<void>();
const done = Promise.withResolvers<void>();
let calls = 0;
notesWatch.start(async (call, _deliveryContext) => {
	// Calls are tagged: a `failed` call is a failure a source recovers from, which Durable never sends (its failures
	// end the watch, see `closed`).
	if (call.kind !== "value") return;
	const { value, ops } = call;
	console.log("watch update:", value, JSON.stringify(ops));
	// The first call stays busy, as a slow consumer would, while three more commits land.
	if (++calls === 1) await busy.promise;
	else done.resolve();
});
await session.commit(async (tx) => {
	(await tx.doc(Notes, chat.id)).text = "observed";
}, context);
for (const more of [" asynchronously", ", folded", "!"]) {
	await session.commit(async (tx) => {
		(await tx.doc(Notes, chat.id)).text += more;
	}, context);
}
busy.resolve();
await done.promise;
console.log("listener calls:", calls);
await notesWatch.stop();

await session.close(context);
