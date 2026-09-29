// Store document state next to transcript entries.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/01-documents.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineDoc, MemoryStorage } from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
const session = createSession(new MemoryStorage());

// A document is a JSON object attached to something; here, one per conversation.
// "rewindable" keeps old values readable, so you can ask what the document
// looked like when a particular entry was written.
// `fork` says what a forked copy of the conversation starts with (see 02-forks.ts).
const Notes = defineDoc<{ text: string }>({
	kind: "example.notes",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf", // a fork starts with the value these notes had at the fork entry
	initial: () => ({ text: "" }),
});

const chat = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);

// tx.doc() returns an editable copy of the document (created on first use).
// Plain assignments to it are saved when the commit finishes.
const firstEntry = await session.commit(async (tx) => {
	const entry = await tx.appendEntry(chat.id, { kind: "note", data: "hello" });
	(await tx.doc(Notes, chat.id)).text = "after hello";
	return entry;
}, context);

const secondEntry = await session.commit(async (tx) => {
	const entry = await tx.appendEntry(chat.id, { kind: "note", data: "goodbye" });
	(await tx.doc(Notes, chat.id)).text = "after goodbye";
	return entry;
}, context);

// snapshot() reads the latest value. snapshotAsOf() reads the value that was
// saved in the same commit as the given entry.
console.log("latest notes:", await session.snapshot(Notes, chat.id, context));
console.log("notes at first entry:", await session.snapshotAsOf(Notes, chat.id, firstEntry.id, context));
console.log("notes at second entry:", await session.snapshotAsOf(Notes, chat.id, secondEntry.id, context));

await session.close(context);
