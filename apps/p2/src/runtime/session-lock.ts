// A session's lock (browser-safe): a locked session (one listening to a Discord channel, say) uses only the resources
// its owner picked, and everyone who can send it input may use all of them. Kept by the sessions plugin on the server
// (`SessionLocks`), mirrored into the session's Durable state by its worker, where the tool guard, the prompt and MCP
// placement read it.
import { arr, bool, obj, type Static, str, union } from "@earendil-works/pi-schema";
import { literal } from "./schema.ts";

/** Capabilities a locked session may get besides MCP servers and instructions. */
export const LOCK_CAPABILITIES = ["ports", "conversations"] as const;
export type LockCapability = (typeof LOCK_CAPABILITIES)[number];

export const SessionLockSchema = obj({
	/** Picked MCP servers of the owner's mcp.json, by name. */
	mcp: arr(str({ maxLength: 200 }), { maxItems: 200 }),
	/** Servers of `.pi/mcp.json` at the session's locations. */
	projectMcp: bool(),
	/** The global AGENTS.md, skills and prompt templates. */
	instructions: bool(),
	capabilities: arr(union([literal("ports"), literal("conversations")]), { maxItems: 8 }),
});
export type SessionLock = Static<typeof SessionLockSchema>;
