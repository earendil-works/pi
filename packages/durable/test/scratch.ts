// A tour of the durable Session API in four small examples.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/scratch.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, createSession, defineDoc, MemoryStorage, type Task } from "../src/index.ts";

// A Session stores conversations, transcript entries, tasks, and documents.
// MemoryStorage keeps everything in memory; other storage backends keep it on disk.
const session = createSession(new MemoryStorage());

// Every Session call takes a context, which is used for cancellation.
// BACKGROUND_CONTEXT means "never cancel".
const context = BACKGROUND_CONTEXT;

// ─── 1. Create a standalone conversation ────────────────────────────────────
// All writes happen inside session.commit(). The callback receives a
// transaction `tx`; everything it writes is saved together when the callback
// returns, or discarded if it throws.
// "ownerless" means no task created this conversation.
const standalone = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
console.log("1. standalone conversation:", standalone);

// ─── 2. Store document state next to transcript entries ─────────────────────
// A document is a JSON object attached to something; here, one per conversation.
// "rewindable" keeps old values readable, so you can ask what the document
// looked like when a particular entry was written.
// `fork` says what a forked copy of the conversation starts with (see example 3).
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
console.log("2. latest notes:", await session.snapshot(Notes, chat.id, context));
console.log("2. notes at first entry:", await session.snapshotAsOf(Notes, chat.id, firstEntry.id, context));
console.log("2. notes at second entry:", await session.snapshotAsOf(Notes, chat.id, secondEntry.id, context));

// ─── 3. Fork a conversation ─────────────────────────────────────────────────
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
	"3. fork transcript:",
	branchEntries.items.map((entry) => entry.data),
);
console.log("3. fork notes:", await session.snapshot(Notes, branch.id, context));

// The fork's copy is independent: editing it leaves the parent unchanged.
await session.commit(async (tx) => {
	(await tx.doc(Notes, branch.id)).text = "changed only in the fork";
}, context);
console.log("3. fork notes after edit:", await session.snapshot(Notes, branch.id, context));
console.log("3. parent notes after edit:", await session.snapshot(Notes, chat.id, context));

// ─── 4. Background task that owns a child conversation ──────────────────────
// A typical agent setup: a background task supervises a helper conversation,
// and the main conversation keeps a registry that maps agent names to their
// conversations. All three are created in one commit, so after a crash either
// all of them exist or none do.

// A task definition needs a name, a version, and the task's starting state.
// This example only creates the task record; nothing runs it yet.
const Supervisor: Task<null, { phase: "ready" }, null, object> = {
	definition: {
		name: "example.supervisor",
		version: 1,
		initial: () => ({ phase: "ready" }),
	},
};

// "latest" keeps only the current value. "initial" means forks of this
// conversation start without a registry, so a child doesn't inherit its
// parent's list of agents.
const AgentRegistry = defineDoc<{
	agents: Record<string, { conversationId: ConversationId; requestId: string }>;
}>({
	kind: "example.agent-registry",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ agents: {} }),
});

const main = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);

const setup = await session.commit(async (tx) => {
	// `background: true` means the task is side work: waiting for the main
	// conversation to finish does not wait for it.
	const supervisorId = await tx.createTask(Supervisor, null, { conversationId: main.id, background: true });

	// The child records that it belongs to the supervisor task. The task was
	// created a few lines above in this same commit, which is allowed.
	const child = await tx.createConversation({ ownership: { kind: "task", taskId: supervisorId } });

	// requestId is a fixed name for the child's first message. Later code sends
	// that message using this requestId, so a retry after a crash cannot
	// deliver it twice.
	(await tx.doc(AgentRegistry, main.id)).agents.researcher = {
		conversationId: child.id,
		requestId: `researcher:first-message:${supervisorId}`,
	};
	return { supervisorId, child };
}, context);

console.log("4. supervisor task:", setup.supervisorId);
console.log("4. child conversation:", setup.child);
console.log("4. registry:", await session.snapshot(AgentRegistry, main.id, context));

await session.close(context);
