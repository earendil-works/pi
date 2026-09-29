// Fork a conversation.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/02-forks.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineDoc, MemoryStorage } from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
const session = createSession(new MemoryStorage());

const Notes = defineDoc<{ text: string }>({
	kind: "example.notes",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ text: "" }),
});

const chat = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
const firstEntry = await session.commit(async (tx) => {
	const entry = await tx.appendEntry(chat.id, { kind: "note", data: "hello" });
	(await tx.doc(Notes, chat.id)).text = "after hello";
	return entry;
}, context);
await session.commit(async (tx) => {
	await tx.appendEntry(chat.id, { kind: "note", data: "goodbye" });
	(await tx.doc(Notes, chat.id)).text = "after goodbye";
}, context);

// A fork is a new conversation that continues from one entry of another. It
// sees the parent's transcript up to that entry, and each document follows its
// own `fork` setting. Notes uses "asOf", so the fork starts with the notes
// value from the fork entry.
const branch = await session.commit(
	(tx) => tx.forkConversation(chat.id, firstEntry.id, { ownership: { kind: "ownerless" } }),
	context,
);

// scanEntries() pages through visible entries, newest first. The fork sees
// "hello" (inherited from the parent) but not "goodbye", which came later.
const branchEntries = await session.commit((tx) => tx.scanEntries({ conversationId: branch.id }, 10), context);
console.log(
	"fork transcript:",
	branchEntries.items.map((entry) => entry.data),
);
console.log("fork notes:", await session.snapshot(Notes, branch.id, context));

// The fork's copy is independent: editing it leaves the parent unchanged.
await session.commit(async (tx) => {
	(await tx.doc(Notes, branch.id)).text = "changed only in the fork";
}, context);
console.log("fork notes after edit:", await session.snapshot(Notes, branch.id, context));
console.log("parent notes after edit:", await session.snapshot(Notes, chat.id, context));

await session.close(context);
