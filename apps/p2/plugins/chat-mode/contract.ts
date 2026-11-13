// Chat mode: the people viewing a conversation talk to each other in its transcript. The agent reads along only
// when someone mentions it. Served by each session worker.

import { arr, bool, compile, int, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { literal, local, MessageDataSchema, method, param, propertiesOf, remote, sessionHost } from "@p2/app/v1";

/** Entry kind of a chat message: display-only, it carries no model message. */
export const CHAT_ENTRY = "chat.message";
/** Entry kind of a mention: an input whose model message is the digest, and whose data is what the person wrote. */
export const MENTION_ENTRY = "chat.mention";
/**
 * The message a reply answers: an entry of the same conversation, with its author and the start of its text. The
 * worker derives author and excerpt from that entry; a client only names the entry. Pi's answers can be replied to.
 */
export const ReplyToSchema = obj(
	{
		entryId: int({ minimum: 1 }),
		author: obj(
			{
				kind: union([literal("owner"), literal("guest"), literal("agent")]),
				id: str(),
				name: str(),
			},
			{ open: true },
		),
		excerpt: str(),
	},
	{ open: true },
);
export type ReplyTo = Static<typeof ReplyToSchema>;

/**
 * A chat entry's data: a person's message (author stamped by the worker, attachments as the session's upload IDs),
 * perhaps answering another.
 */
export const ChatMessageSchema = obj(
	{
		...propertiesOf(MessageDataSchema),
		replyTo: opt(ReplyToSchema),
	},
	{ open: true },
);
export type ChatMessage = Static<typeof ChatMessageSchema>;

/** A mention entry's data: what the person wrote, and the IDs of the chat entries its digest passed on to Pi. */
export const MentionSchema = obj(
	{
		...propertiesOf(ChatMessageSchema),
		included: arr(int()),
	},
	{ open: true },
);
export type Mention = Static<typeof MentionSchema>;

const isChatMessage = compile(ChatMessageSchema).check;
const isMention = compile(MentionSchema).check;

/** Entries are history: read their data defensively, never assume this code wrote it. */
export const chatMessage = (data: unknown): ChatMessage | undefined => (isChatMessage(data) ? data : undefined);
export const mention = (data: unknown): Mention | undefined => (isMention(data) ? data : undefined);

/**
 * The name people call the agent by in a conversation (chat mode's setting): one word, as it is spoken and mentioned
 * ("Pi", "Claude"). Letters, digits, `_` and `-`, starting with a letter.
 */
export const DEFAULT_AGENT_NAME = "Pi";
export const AgentNameSchema = str({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,31}$" });

/** The mention of the agent called `name`: `@` and the name in lower case ("@pi", "@claude"). */
export const mentionToken = (name: string): string => `@${name.toLowerCase()}`;

/** The name as a regular expression, matched literally (a valid name holds no special character; `-` is literal). */
const escapeName = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `@<name>` in any case, as a word of its own: with the default, "@pi", "@Pi," and "(@PI)" mention; "@pizza" and "me@pi"
 * do not.
 */
export const mentionPattern = (name = DEFAULT_AGENT_NAME): RegExp =>
	new RegExp(`(?<![\\p{L}\\p{N}_@])@${escapeName(name)}(?![\\p{L}\\p{N}_-])`, "iu");
export const MENTION = mentionPattern();
export const mentionsAgent = (text: string, name = DEFAULT_AGENT_NAME): boolean => mentionPattern(name).test(text);

/**
 * The agent's name spoken anywhere in an utterance, as speech recognition writes it (no "@"): a whole word in any case,
 * whatever punctuation surrounds it. With the default: "Hey Pi, …", "can Pi summarize this", "what do you think,
 * Pi?". Not "pie", "piano", "pip" or "Pi-hole"; and not "Pi's": a possessive or contraction talks about the agent more
 * often than to it ("Pi's answer was odd"), and is cheap to say again.
 */
const spokenName = (name: string): RegExp =>
	new RegExp(`(?<![\\p{L}\\p{N}_'’@-])${escapeName(name)}(?![\\p{L}\\p{N}_'’-])`, "iu");

/**
 * A spoken message as chat mode reads it: one that names the agent gets its mention in front (what was said is kept
 * whole, for the context: "@pi can Pi summarize this"). One already holding the mention stays as it is.
 */
export function spokenMention(text: string, name = DEFAULT_AGENT_NAME): string {
	if (mentionsAgent(text, name)) return text;
	return spokenName(name).test(text) ? `${mentionToken(name)} ${text.trim()}` : text;
}

/** One conversation's switch and agent name (worker-local), followed from its Durable document. */
export const ChatModeSetting = local("p2.chat-mode-setting", {
	/** 2: the agent's name. 3: `waiting`. */
	version: 3,
	params: { conversation: param.int() },
	members: {
		enabled: bool(),
		name: AgentNameSchema,
		/** How many chat messages a mention would pass on now (the composer's count); 0 while chat mode is off. */
		waiting: num(),
		set: method(obj({ enabled: bool() })),
		rename: method(obj({ name: AgentNameSchema })),
	},
});

/**
 * Chat mode of one conversation as a browser sees it: everyone reads it and the agent's name; only the owner switches
 * it and renames the agent.
 */
export const ChatMode = remote("p2.chat-mode", {
	/** 2: the agent's name (a state schema change needs a new contract version). */
	version: 2,
	params: { session: param.str(), conversation: param.int() },
	hostAddress: sessionHost,
	variants: {
		reader: { state: { enabled: bool(), waiting: num(), name: AgentNameSchema } },
		owner: {
			state: { enabled: bool(), waiting: num(), name: AgentNameSchema },
			methods: {
				set: method(obj({ enabled: bool() })),
				rename: method(obj({ name: AgentNameSchema })),
			},
		},
	},
});
