// Pi on Discord (browser-safe contracts): the owner's bots run on the p2 server; a session linked to a channel through
// one of them gets, at a mention by someone allowed to wake Pi, the messages since the link's cursor as one input, and
// its answer goes back as a reply. A thread of a linked channel gets a subagent forked from the main conversation.
import { arr, bool, int, nul, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import {
	literal,
	local,
	MAX_ATTACHMENTS,
	method,
	param,
	record,
	remote,
	SessionLockSchema,
	serverHost,
	sessionHost,
} from "@p2/app/v1";

/** Entry kind of a delivered batch: a person's message (its data is message data) with the Discord details. */
export const DISCORD_BATCH = "discord.batch";

/** Who may wake Pi in a channel: anyone, or the listed Discord user and role IDs. */
export const WakeSchema = obj({
	anyone: bool(),
	users: arr(str({ maxLength: 32 }), { maxItems: 100 }),
	roles: arr(str({ maxLength: 32 }), { maxItems: 100 }),
});
export type Wake = Static<typeof WakeSchema>;

/** A Discord thread of a linked channel: its subagent conversation and its own cursor. */
export const ThreadBindingSchema = obj({
	conversation: int({ minimum: 1 }),
	name: str(),
	cursor: union([str(), nul()]),
});

/** One channel linked to one session, through one bot. A session has at most one, a channel at most one. */
export const BindingSchema = obj({
	/** The bot that listens (an ID of `discord.json`'s bots). */
	botId: str(),
	channelId: str(),
	channelName: str(),
	guildId: str(),
	guildName: str(),
	session: str(),
	wake: WakeSchema,
	/** The last Discord message delivered (null: none yet, the next batch starts with the newest 50). */
	cursor: union([str(), nul()]),
	threads: record(ThreadBindingSchema),
	createdAt: num(),
});
export type Binding = Static<typeof BindingSchema>;

/** A delivered batch waiting for its turn's answer, to go back as a reply to the message that woke Pi. */
export const PendingSchema = obj({
	botId: str(),
	session: str(),
	/** The binding's channel (the reply goes to `replyChannelId`: the channel, or a thread of it). */
	channelId: str(),
	replyChannelId: str(),
	messageId: str(),
	submissionId: num(),
	since: num(),
});
export type Pending = Static<typeof PendingSchema>;

/** A Discord server (guild). */
export const GuildSchema = obj({ id: str(), name: str() });
export type Guild = Static<typeof GuildSchema>;

/** A bot's connection as the owner sees it. */
export const BotStatusSchema = union([
	obj({ state: literal("connecting") }),
	obj({ state: literal("error"), error: str() }),
	obj({
		state: literal("connected"),
		user: str(),
		applicationId: str(),
		avatarUrl: opt(str()),
		inviteUrl: str(),
		guilds: arr(GuildSchema),
	}),
]);
export type BotStatus = Static<typeof BotStatusSchema>;

/** One configured bot: its ID (stable, p2's own) and its connection. */
export const BotSchema = obj({ id: str(), status: BotStatusSchema });
export type BotView = Static<typeof BotSchema>;

/** A Discord server's text channels and roles, as the link form picks them. */
export const ServerDetailsSchema = obj({
	channels: arr(obj({ id: str(), name: str() })),
	roles: arr(obj({ id: str(), name: str() })),
});
export type ServerDetails = Static<typeof ServerDetailsSchema>;

/**
 * Linking a session to a channel: the bot and channel, who may wake Pi, the sandbox the session moves into (where it
 * works from then on), and its lock (the resources it may use).
 */
export const LinkSchema = obj({
	session: str(),
	bot: str(),
	guild: str(),
	channel: str(),
	wake: WakeSchema,
	sandbox: str(),
	lock: SessionLockSchema,
});
export type Link = Static<typeof LinkSchema>;

const Token = str({ minLength: 10, maxLength: 200 });

/** The owner's methods on bots and links (the store serves them; the owner's view forwards them). */
const OWNER_METHODS = {
	/** Connects a new bot with `token` and keeps it: its ID; refused with Discord's reason (nothing kept). */
	addBot: method(obj({ token: Token }), obj({ id: str() })),
	/** Connects bot `bot` with a new token, kept once Discord accepts it. */
	setBotToken: method(obj({ bot: str(), token: Token })),
	/** Removes bot `bot`; its sessions are unlinked (and unlocked). */
	removeBot: method(obj({ bot: str() })),
	/** The text channels and roles of server `guild`, as bot `bot` sees them. */
	server: method(obj({ bot: str(), guild: str() }), ServerDetailsSchema),
	/** The MCP servers of mcp.json, for the lock's picks. */
	mcpServers: method(undefined, arr(str())),
	/**
	 * Links a session to a channel: moves it into the sandbox (as Relocate does), locks it, and listens. Refused when
	 * the session or the channel is linked already, or the move is refused (a busy session).
	 */
	link: method(LinkSchema),
	/** Stops listening for `session`, and lifts its lock. */
	unlink: method(obj({ session: str() })),
};

/** The bots, the links and the relay between Discord and sessions (server, host-internal, host lifetime). */
export const DiscordStore = local("p2.discord-store", {
	version: 2,
	params: {},
	members: { bots: arr(BotSchema), bindings: arr(BindingSchema), ...OWNER_METHODS },
});

/**
 * The owner's bots and links. 2: several bots, links made from a session (v1 lived a day on the owner's own device
 * only; its pages bind again after a reload, no `accepts` kept).
 */
export const Discord = remote("p2.discord", {
	version: 2,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: { state: { bots: arr(BotSchema), bindings: arr(BindingSchema) }, methods: OWNER_METHODS },
	},
});

/** A Discord attachment to download into the session's uploads (at most 25 MiB; larger ones are links). */
export const DiscordFileSchema = obj({ url: str(), name: str(), size: num(), key: str(), ref: str() });

/** What the server hands a session's worker (server only): batches, finished turns, threads. */
export const DiscordIngress = remote("p2.discord-ingress", {
	version: 1,
	params: { session: param.str() },
	hostAddress: sessionHost,
	variants: {
		server: {
			methods: {
				/**
				 * Places a batch as one input of `conversation` (default: the main conversation), queued while it is busy;
				 * a retried `requestId` is placed once. `lock`: the session's lock, committed first.
				 */
				deliver: method(
					obj({
						conversation: opt(int({ minimum: 1 })),
						requestId: str({ maxLength: 200 }),
						author: obj({ id: str(), name: str() }),
						text: str({ maxLength: 200_000 }),
						context: obj({ channel: str(), guild: str(), messages: int(), thread: opt(str()) }),
						files: arr(DiscordFileSchema, { maxItems: MAX_ATTACHMENTS }),
						lock: union([SessionLockSchema, nul()]),
					}),
					obj({ conversation: int(), submissionId: num() }),
				),
				/** The submission's turn: still pending, answered (the answer's text), or ended without one. */
				turn: method(
					obj({ submissionId: num() }),
					union([
						obj({ state: literal("pending") }),
						obj({ state: literal("answered"), text: str() }),
						obj({ state: literal("unanswered"), reason: str() }),
					]),
				),
				/**
				 * A subagent for a Discord thread: forked from the main conversation at its last finished answer before
				 * `before` (the thread's creation, ms), registered as subagent `name`. Its conversation.
				 */
				thread: method(obj({ name: str({ maxLength: 100 }), before: num() }), obj({ conversation: int() })),
			},
		},
	},
});
