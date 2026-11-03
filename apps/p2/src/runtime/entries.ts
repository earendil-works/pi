// Inputs that are not a person's (browser-safe): a peer conversation's message, a main agent's task for its subagent
// and a subagent's message. Their entry kinds and header blocks are read across plugins (attribution, search, the fake
// provider) and by both UIs (transcript rows).

import { num, obj, type Static, str, union } from "@earendil-works/pi-schema";
import { literal } from "./schema.ts";

/** The first block of a peer conversation's message (the conversations tool): `<mobile-conversation>{id,title}</…>`. */
export const CONVERSATION_PREFIX = "<mobile-conversation>";

/** Who started a tool's turn when it may act for someone: the owner, or an authenticated peer conversation. */
export type ConversationOrigin = "owner" | "peer";

/**
 * A main agent's message to its subagent (`subagent spawn`/`send`) whose turn the owner started: its entry kind, with
 * `{ origin: "owner" }`. The subagent's turn inherits that attribution (`originOf`), so the owner-only tools it was
 * granted (the location tools) work for it; other messages to a subagent are unattributed.
 */
export const SUBAGENT_TASK_ENTRY = "p2.subagent-task";

/**
 * A message from a subagent, as its own entry kind: its end-of-turn report to the main agent (`answered`, `failed`), or
 * what it sent with the `team` tool (`question`, `note`) to the main agent or another subagent. Readers use this data;
 * the model reads a server-written first line (`[subagent <name> …]`).
 */
export const AGENT_MESSAGE_ENTRY = "p2.agent-message";
export const AgentMessageSchema = obj(
	{
		from: obj({ name: str(), conversationId: num() }, { open: true }),
		intent: union([literal("answered"), literal("failed"), literal("question"), literal("note")]),
		text: str(),
	},
	{ open: true },
);
export type AgentMessage = Static<typeof AgentMessageSchema>;
