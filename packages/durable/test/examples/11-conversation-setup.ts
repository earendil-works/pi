// Give every new conversation the application's own documents.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/11-conversation-setup.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, Harness, LiveDoc, MemoryStorage } from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// A coding agent keeps a profile per conversation. Readers and watchers want it
// to exist from the first moment, like the built-in documents.
const AgentProfile = defineDoc<{ role: "main" | "subagent"; cwd: string }>({
	kind: "example.agent-profile",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ role: "main", cwd: process.cwd() }),
});

// A conversation setup runs in every commit that creates or forks a
// conversation, including raw tx.createConversation() in a tool, after the
// built-in `pi` setup and before the host's `init`. A fork already has its
// copied documents, so this setup leaves them alone.
const registry = createRegistry();
registry.conversations.setup("agent", async (tx, conversation) => {
	if (conversation.parent === undefined) await tx.doc(AgentProfile, conversation.id);
});

const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, context);
const root = await harness.root(context);
const subagent = await harness.createConversation(
	{
		ownership: { kind: "ownerless" },
		// `init` runs after every setup, so the profile already exists here.
		init: async (tx, id) => {
			(await tx.doc(AgentProfile, id)).role = "subagent";
		},
	},
	context,
);
console.log("root profile:", await harness.snapshot(AgentProfile, root.id, context));
console.log("subagent profile:", await harness.snapshot(AgentProfile, subagent.id, context));
// The built-in setup created pi.live, so a UI can watch it before the first turn.
console.log("root live state:", await harness.snapshot(LiveDoc, root.id, context));

await harness.close(context);
