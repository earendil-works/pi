// A background task that owns a child conversation.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/03-owned-conversations.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, createSession, defineDoc, defineTask, MemoryStorage } from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
const session = createSession(new MemoryStorage());

// A typical agent setup: a background task supervises a helper conversation,
// and the main conversation keeps a registry that maps agent names to their
// conversations. All three are created in one commit, so after a crash either
// all of them exist or none do.

// A task definition needs a name, a version, the task's starting state, a
// handler for every phase, and an abort handler (12-tasks.ts runs a task).
// This example only creates the task record; a plain Session never runs it.
const Supervisor = defineTask<null, { phase: "ready" }, null>({
	name: "example.supervisor",
	version: 1,
	initial: () => ({ phase: "ready" }),
	phases: { ready: async () => {} },
	abort: async () => {},
});

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
	const supervisorId = await tx.createTask(Supervisor, null, {
		ownership: { kind: "conversation" },
		conversationId: main.id,
		background: true,
	});

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

console.log("supervisor task:", setup.supervisorId);
console.log("child conversation:", setup.child);
console.log("registry:", await session.snapshot(AgentRegistry, main.id, context));

await session.close(context);
