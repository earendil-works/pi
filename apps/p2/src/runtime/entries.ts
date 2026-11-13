// Inputs that are not a person's (browser-safe): a peer conversation's message, a main agent's task for its subagent
// and a subagent's message. Their entry kinds and data are read across plugins (attribution, search) and by both UIs
// (transcript rows).

import { compile, num, obj, type Static, str, union } from "@earendil-works/pi-schema";
import { literal } from "./schema.ts";

/**
 * A peer session's message (the conversations tool), as its own entry kind: the sending session and what it wrote.
 * Readers use this data; the model reads the server-written `<sender kind="session" …/>` block in front of the text.
 */
export const PEER_MESSAGE_ENTRY = "p2.peer-message";
export const PeerMessageSchema = obj(
	{ from: obj({ id: str(), title: str() }, { open: true }), text: str() },
	{ open: true },
);
export type PeerMessage = Static<typeof PeerMessageSchema>;
const isPeerMessage = compile(PeerMessageSchema).check;

/** The peer message an entry of kind `kind` with `data` records, if it is one. */
export const peerMessage = (kind: string, data: unknown): PeerMessage | undefined =>
	kind === PEER_MESSAGE_ENTRY && isPeerMessage(data) ? data : undefined;

/**
 * An agent's task for another agent: a main agent's message to its subagent (`subagent spawn`/`send`) or a script's
 * prompt to its one-shot agent, as its own entry kind (transcripts show it as the agent's, not a person's).
 */
export const SUBAGENT_TASK_ENTRY = "p2.subagent-task";

/**
 * A message from a subagent, as its own entry kind: its end-of-turn report to the main agent (`answered`, `failed`), or
 * what it sent with the `team` tool (`question`, `note`) to the main agent or another subagent. Readers use this data;
 * the model reads a server-written `<sender kind="subagent" name="…"/>` block, then `[<intent>] <text>`.
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
const isAgentMessage = compile(AgentMessageSchema).check;

/** The subagent message an entry of kind `kind` with `data` records, if it is one. */
export const agentMessage = (kind: string, data: unknown): AgentMessage | undefined =>
	kind === AGENT_MESSAGE_ENTRY && isAgentMessage(data) ? data : undefined;
