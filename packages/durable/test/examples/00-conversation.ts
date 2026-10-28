// A Session stores conversations, transcript entries, tasks, and documents.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/00-conversation.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, MemoryStorage } from "../../src/index.ts";

// MemoryStorage keeps everything in memory; other storage backends keep it on disk.
const session = createSession(new MemoryStorage());

// Every Session call takes a context, which is used for cancellation.
// BACKGROUND_CONTEXT means "never cancel".
const context = BACKGROUND_CONTEXT;

// All writes happen inside session.commit(). The callback receives a
// transaction `tx`; everything it writes is saved together when the callback
// returns, or discarded if it throws.
// "ownerless" means no task created this conversation.
const standalone = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
console.log("standalone conversation:", standalone);

await session.close(context);
