// Conversation handles, typed entries, created conversations, and forks.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/08-harness-conversations.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineEntry, Harness, MemoryStorage } from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
const harness = await Harness.open(
	new MemoryStorage(),
	{ models: createModels(), registry: createRegistry() },
	context,
);
const root = await harness.root(context);
await root.configure({ thinkingLevel: "high" }, context);

// Conversation handles are stateless; compare them by id. They bind commits
// to their conversation. An entry token types an entry kind's `data`.
const Message = defineEntry<{ from: string }>("message");
const hello = await root.commit(
	(tx) =>
		tx.appendEntry(Message, root.id, {
			data: { from: "example" },
			model: [{ role: "user", content: "hello", timestamp: 1 }],
		}),
	context,
);
console.log("typed entry:", Message.is(hello), hello.data.from);

// createConversation() and fork() apply `agent` and run `init` in the
// creating commit. A fork starts with the agent the parent had at the fork
// entry.
const helper = await harness.createConversation(
	{ ownership: { kind: "ownerless" }, agent: { thinkingLevel: "minimal" } },
	context,
);
const retry = await root.fork(hello.id, { ownership: { kind: "ownerless" } }, context);
console.log("helper thinking:", (await helper.agent(context)).thinkingLevel);
console.log("fork thinking:", (await retry.agent(context)).thinkingLevel);
console.log("lookup:", (await harness.conversation(retry.id, context))?.id === retry.id);

await harness.close(context);
