// Pi on Discord (browser-safe contracts): a bot on the p2 server listens to bound channels; a mention by someone
// allowed to wake Pi delivers the messages since the binding's cursor to the bound session as one input, and the
// session's answer goes back as a reply. A thread of a bound channel gets a subagent forked from the main conversation.
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

/** A Discord thread of a bound channel: its subagent conversation and its own cursor. */
export const ThreadBindingSchema = obj({
	conversation: int({ minimum: 1 }),
	name: str(),
	cursor: union([str(), nul()]),
});

/** One channel bound to one session. */
export const BindingSchema = obj({
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
	session: str(),
	/** The binding's channel (the reply goes to `replyChannelId`: the channel, or a thread of it). */
	channelId: str(),
	replyChannelId: str(),
	messageId: str(),
	submissionId: num(),
	since: num(),
});
export type Pending = Static<typeof PendingSchema>;

/** The bot's connection as the owner sees it. */
export const BotStatusSchema = union([
	obj({ state: literal("off") }),
	obj({ state: literal("connecting") }),
	obj({ state: literal("error"), error: str() }),
	obj({
		state: literal("connected"),
		user: str(),
		applicationId: str(),
		inviteUrl: str(),
		guilds: arr(obj({ id: str(), name: str() })),
	}),
]);
export type BotStatus = Static<typeof BotStatusSchema>;

export const ChannelSchema = obj({ id: str(), name: str(), guildId: str(), guildName: str() });
export type Channel = Static<typeof ChannelSchema>;

/** What binding a channel takes: the session, who may wake Pi, where its first batch starts, and the session's lock. */
export const BindSchema = obj({
	channelId: str(),
	session: str(),
	wake: WakeSchema,
	/** `now`: after the channel's newest message; `last50`: the first mention delivers the last 50. */
	from: union([literal("now"), literal("last50")]),
	lock: SessionLockSchema,
});
export type Bind = Static<typeof BindSchema>;

/** The owner's methods on the bot and its bindings (the store serves them; the owner's view forwards them). */
const OWNER_METHODS = {
	/** Saves the bot token (null removes the bot) and connects with it. */
	setToken: method(obj({ token: union([str({ minLength: 10, maxLength: 200 }), nul()]) })),
	/** The text channels the bot sees. */
	channels: method(undefined, arr(ChannelSchema)),
	/** The MCP servers of mcp.json, for the lock's picks. */
	mcpServers: method(undefined, arr(str())),
	/** Binds a channel to a session, which must work in a sandbox, and locks the session (replacing its binding). */
	bind: method(BindSchema),
	/** Changes who may wake Pi in a bound channel. */
	setWake: method(obj({ channelId: str(), wake: WakeSchema })),
	/** Stops listening: the binding goes, and the session's lock with its last binding. */
	unbind: method(obj({ channelId: str() })),
	/** Delivers the messages since the cursor now, as if the newest one had mentioned Pi. */
	deliverNow: method(obj({ channelId: str() })),
};

/** The bot, its bindings and the relay between Discord and sessions (server, host-internal, host lifetime). */
export const DiscordStore = local("p2.discord-store", {
	version: 1,
	params: {},
	members: { status: BotStatusSchema, bindings: arr(BindingSchema), ...OWNER_METHODS },
});

/** The owner's Discord sheet: the bot, its bindings, and binding channels to sessions. */
export const Discord = remote("p2.discord", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: { state: { status: BotStatusSchema, bindings: arr(BindingSchema) }, methods: OWNER_METHODS },
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
