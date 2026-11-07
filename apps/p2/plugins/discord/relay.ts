// What happens between a Discord channel and its linked session (server): a mention by someone allowed to wake Pi, seen
// by the link's bot, delivers the messages since the link's cursor (a thread's: to its forked subagent) as one input; a
// pending reply is posted once its turn ended. Plain logic over ports, so tests run it with fake bots and sessions.
import type { SessionLock } from "@p2/app/v1";
import type { Binding, Pending, Wake } from "./contract.ts";

/** A Discord message as the relay reads it. */
export type DiscordMessage = {
	id: string;
	channelId: string;
	author: { id: string; name: string; bot: boolean };
	roles: readonly string[];
	text: string;
	mentionsBot: boolean;
	attachments: readonly { name: string; url: string; size: number }[];
};

/** A channel or a thread of one. */
export type DiscordChannel = {
	id: string;
	name: string;
	guildId: string;
	guildName: string;
	thread?: { parentId: string; createdAt: number };
	lastMessageId: string | null;
};

/** What the relay needs of Discord. */
export type DiscordPort = {
	readonly botId: string;
	channel(id: string): Promise<DiscordChannel>;
	/** The first `limit` messages after `after` (oldest first; `"0"`: from the channel's start). */
	messages(channelId: string, query: { after: string; limit: number }): Promise<DiscordMessage[]>;
	/** Posts `text` (at most 2000 characters), as a reply to `messageId` when given. */
	reply(channelId: string, messageId: string | undefined, text: string): Promise<void>;
	typing(channelId: string): Promise<void>;
};

export type TurnState =
	| { state: "pending" }
	| { state: "answered"; text: string }
	| { state: "unanswered"; reason: string };

/** What the relay needs of a session (its worker's `DiscordIngress`, the catalog). */
export type SessionPort = {
	/** Whether the session exists, is not archived and works in a sandbox; why not otherwise. */
	usable(session: string): Promise<string | undefined>;
	lock(session: string): SessionLock | null;
	/** Whether the session's worker has live tasks (a turn under way). */
	working(session: string): boolean;
	deliver(
		session: string,
		input: {
			conversation?: number;
			requestId: string;
			author: { id: string; name: string };
			text: string;
			context: { channel: string; guild: string; messages: number; thread?: string };
			files: { url: string; name: string; size: number; key: string; ref: string }[];
			lock: SessionLock | null;
		},
	): Promise<{ conversation: number; submissionId: number }>;
	turn(session: string, submissionId: number): Promise<TurnState>;
	thread(session: string, name: string, before: number): Promise<{ conversation: number }>;
};

/** The relay's persisted state: bindings by channel, pending replies by the Discord message that woke Pi. */
export type RelayState = { bindings: Record<string, Binding>; pending: Record<string, Pending> };

export type StatePort = {
	value(): RelayState;
	change(update: (draft: RelayState) => void): Promise<void>;
};

/** Messages one history request asks for (Discord's maximum). */
export const PAGE = 100;
/** Messages one batch puts into the input at most: the newest; the header counts the earlier ones left out. */
export const BATCH_CAP = 200;
/** Discord's limit for one message's text. */
export const MESSAGE_LIMIT = 2000;
/** Attachments up to this size are downloaded into the session; larger ones are listed as links. */
export const MAX_ATTACHMENT = 25 * 1024 * 1024;
const MAX_FILES = 20;

/** A pending reply older than this is dropped with a notice: its turn is not going to end on its own. */
export const PENDING_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export class Relay {
	readonly #discord: (bot: string) => DiscordPort | undefined;
	/** Pending replies being checked: two checks at once would post one reply twice. */
	readonly #checking = new Set<string>();
	/**
	 * Each channel's and thread's delivery under way, the next one chained after it: two mentions in quick succession
	 * would otherwise both read from the same cursor and deliver overlapping batches.
	 */
	readonly #lanes = new Map<string, Promise<void>>();
	readonly #sessions: SessionPort;
	readonly #state: StatePort;

	/** `discord`: bot `bot` while it is connected. */
	constructor(discord: (bot: string) => DiscordPort | undefined, sessions: SessionPort, state: StatePort) {
		this.#discord = discord;
		this.#sessions = sessions;
		this.#state = state;
	}

	#port(bot: string): DiscordPort {
		const port = this.#discord(bot);
		if (!port) throw new Error("The Discord bot is not connected");
		return port;
	}

	/**
	 * A message bot `bot` received: a mention of it by someone allowed to wake Pi, in a channel linked through it (or a
	 * thread of one), delivers.
	 */
	async onMessage(bot: string, message: DiscordMessage): Promise<void> {
		if (message.author.bot || !message.mentionsBot) return;
		const port = this.#port(bot);
		const { bindings } = this.#state.value();
		let binding = bindings[message.channelId];
		let thread: DiscordChannel | undefined;
		if (!binding) {
			const channel = await port.channel(message.channelId);
			if (!channel.thread) return;
			binding = bindings[channel.thread.parentId];
			if (!binding) return;
			thread = channel;
		}
		// Another bot in the channel may be mentioned too: only the link's own bot listens.
		if (binding.botId !== bot || !mayWake(binding.wake, message.author.id, message.roles)) return;
		await this.deliver(binding.channelId, message, thread);
	}

	/**
	 * Delivers the batch ending at `trigger` to the binding's session (a thread's subagent for a message in a thread),
	 * then advances the cursor and records the pending reply. A session that cannot take it gets a notice instead. One
	 * delivery at a time per channel or thread: a later one starts from the cursor the earlier one left.
	 */
	async deliver(channelId: string, trigger: DiscordMessage, thread: DiscordChannel | undefined): Promise<void> {
		const target = thread?.id ?? channelId;
		const run = (this.#lanes.get(target) ?? Promise.resolve()).then(() => this.#deliver(channelId, trigger, thread));
		// The lane goes on whether this delivery failed or not; the caller still learns it failed.
		const lane = run.catch(() => {});
		this.#lanes.set(target, lane);
		try {
			await run;
		} finally {
			if (this.#lanes.get(target) === lane) this.#lanes.delete(target);
		}
	}

	async #deliver(channelId: string, trigger: DiscordMessage, thread: DiscordChannel | undefined): Promise<void> {
		const binding = this.#state.value().bindings[channelId];
		if (!binding) return;
		const port = this.#port(binding.botId);
		const where = thread?.id ?? channelId;
		const refusal = await this.#sessions.usable(binding.session);
		if (refusal) return port.reply(where, trigger.id, `Pi is not listening here right now: ${refusal}`);
		let conversation: number | undefined;
		let cursor = binding.cursor;
		if (thread) {
			let known = binding.threads[thread.id];
			if (!known) {
				const created = await this.#sessions.thread(
					binding.session,
					thread.name,
					thread.thread?.createdAt ?? Date.now(),
				);
				known = { conversation: created.conversation, name: thread.name, cursor: null };
				const value = known;
				await this.#state.change((draft) => {
					const current = draft.bindings[channelId];
					if (current) current.threads[thread.id] = value;
				});
			}
			conversation = known.conversation;
			cursor = known.cursor;
		}
		// Delivered already (a catch-up, then the same mention replayed by a resumed gateway).
		if (cursor !== null && BigInt(trigger.id) <= BigInt(cursor)) return;
		// Everything since the cursor, page by page; only the newest BATCH_CAP go into the input.
		const messages: DiscordMessage[] = [];
		let total = 0;
		for await (const message of history(port, where, cursor, trigger.id)) {
			if (message.author.bot) continue;
			total++;
			messages.push(message);
			if (messages.length > BATCH_CAP) messages.shift();
		}
		if (!messages.some((message) => message.id === trigger.id)) {
			total++;
			messages.push(trigger);
			if (messages.length > BATCH_CAP) messages.shift();
		}
		const count = `${total} message${total === 1 ? "" : "s"}`;
		const omitted = total - messages.length;
		const left = omitted ? `; the ${omitted} earliest are left out, the newest ${messages.length} follow` : "";
		const header = thread
			? `[Discord thread "${thread.name}" in #${binding.channelName} (${binding.guildName}): ${count}${left}]`
			: `[Discord #${binding.channelName} (${binding.guildName}): ${count} since the last delivery${left}]`;
		const batch = batchOf(messages, port.botId, header);
		let delivered: { conversation: number; submissionId: number };
		try {
			delivered = await this.#sessions.deliver(binding.session, {
				...(conversation === undefined ? {} : { conversation }),
				requestId: `discord:${trigger.id}`,
				author: { id: trigger.author.id, name: trigger.author.name },
				text: batch.text,
				context: {
					channel: binding.channelName,
					guild: binding.guildName,
					messages: total,
					...(thread ? { thread: thread.name } : {}),
				},
				files: batch.files,
				lock: this.#sessions.lock(binding.session),
			});
		} catch (error) {
			await port.reply(
				where,
				trigger.id,
				`Could not reach Pi: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		await this.#state.change((draft) => {
			const current = draft.bindings[channelId];
			if (!current) return;
			if (thread) {
				const known = current.threads[thread.id];
				if (known) known.cursor = trigger.id;
			} else current.cursor = trigger.id;
			draft.pending[trigger.id] = {
				botId: binding.botId,
				session: binding.session,
				channelId,
				replyChannelId: where,
				messageId: trigger.id,
				submissionId: delivered.submissionId,
				since: Date.now(),
			};
		});
		await port.typing(where).catch(() => {});
	}

	/**
	 * Bot `bot` (re)connected: what it missed. For each of its links and their threads, the newest mention since the
	 * cursor by someone allowed to wake Pi delivers, as if it had just arrived (one delivery each, the messages before it
	 * included).
	 */
	async catchUp(bot: string): Promise<void> {
		const port = this.#port(bot);
		for (const binding of Object.values(this.#state.value().bindings)) {
			if (binding.botId !== bot) continue;
			const places: { id: string; cursor: string | null; thread: boolean }[] = [
				{ id: binding.channelId, cursor: binding.cursor, thread: false },
				...Object.entries(binding.threads).map(([id, known]) => ({ id, cursor: known.cursor, thread: true })),
			];
			for (const place of places) {
				try {
					let newest: DiscordMessage | undefined;
					for await (const message of history(port, place.id, place.cursor))
						if (
							!message.author.bot &&
							message.mentionsBot &&
							mayWake(binding.wake, message.author.id, message.roles)
						)
							newest = message;
					if (!newest) continue;
					const thread = place.thread ? await port.channel(place.id) : undefined;
					await this.deliver(binding.channelId, newest, thread);
				} catch (error) {
					// A channel or thread that went away (or a session that cannot take it) skips only itself.
					console.error("p2 discord: catching up failed:", error instanceof Error ? error.message : error);
				}
			}
		}
	}

	/** Posts the replies of the turns that ended (`sessions`: only those, when given); answers split at 2000. */
	async checkPending(sessions?: ReadonlySet<string>): Promise<void> {
		const now = Date.now();
		for (const pending of Object.values(this.#state.value().pending)) {
			if ((sessions && !sessions.has(pending.session)) || this.#checking.has(pending.messageId)) continue;
			// A bot that is not connected (or was removed) keeps its replies until it is, or they time out.
			const port = this.#discord(pending.botId);
			if (!port && now - pending.since < PENDING_TIMEOUT_MS) continue;
			this.#checking.add(pending.messageId);
			try {
				await this.#check(port, pending, now);
			} finally {
				this.#checking.delete(pending.messageId);
			}
		}
	}

	async #check(port: DiscordPort | undefined, pending: Pending, now: number): Promise<void> {
		let turn: TurnState;
		try {
			turn = await this.#sessions.turn(pending.session, pending.submissionId);
		} catch (error) {
			console.error("p2 discord: reading a turn failed:", error instanceof Error ? error.message : error);
			if (now - pending.since < PENDING_TIMEOUT_MS) return;
			turn = { state: "unanswered", reason: "the session did not answer in time." };
		}
		if (turn.state === "pending") {
			if (now - pending.since < PENDING_TIMEOUT_MS) return;
			turn = { state: "unanswered", reason: "the session did not answer in time." };
		}
		const text = turn.state === "answered" ? turn.text : `(No answer: ${turn.reason})`;
		try {
			if (!port) throw new Error("its bot is not connected");
			for (const [index, chunk] of chunkText(text).entries())
				await port.reply(pending.replyChannelId, index === 0 ? pending.messageId : undefined, chunk);
		} catch (error) {
			// A channel that went away: the reply is dropped, as Discord has nowhere to show it.
			console.error("p2 discord: posting a reply failed:", error instanceof Error ? error.message : error);
		}
		await this.#state.change((draft) => {
			delete draft.pending[pending.messageId];
		});
	}

	/** "Pi is typing" in every channel with a pending reply whose session works. */
	async typing(): Promise<void> {
		const channels = new Map<string, string>();
		for (const pending of Object.values(this.#state.value().pending))
			if (this.#sessions.working(pending.session)) channels.set(pending.replyChannelId, pending.botId);
		for (const [channel, bot] of channels)
			await this.#discord(bot)
				?.typing(channel)
				.catch(() => {});
	}
}

/**
 * The messages of `channel` after `cursor` (null: from its start), oldest first, page by page; with `until`, up to and
 * with that message.
 */
async function* history(
	port: DiscordPort,
	channel: string,
	cursor: string | null,
	until?: string,
): AsyncGenerator<DiscordMessage> {
	let after = cursor ?? "0";
	for (;;) {
		const page = await port.messages(channel, { after, limit: PAGE });
		for (const message of page) {
			if (until !== undefined && BigInt(message.id) > BigInt(until)) return;
			yield message;
		}
		const last = page.at(-1);
		if (page.length < PAGE || !last) return;
		after = last.id;
	}
}

/** Whether the author of a message may wake Pi in its binding. */
export function mayWake(wake: Wake, author: string, roles: readonly string[]): boolean {
	return wake.anyone || wake.users.includes(author) || roles.some((role) => wake.roles.includes(role));
}

/**
 * A batch's text: one `Name: text` line (or paragraph) per message, oldest first, the bot's mention written `@Pi`, and
 * attachments too large to download listed as links. The attachments to download, keyed by message and position.
 */
export function batchOf(
	messages: readonly DiscordMessage[],
	botId: string,
	header: string,
): { text: string; files: { url: string; name: string; size: number; key: string; ref: string }[] } {
	const files: { url: string; name: string; size: number; key: string; ref: string }[] = [];
	const lines = messages.map((message) => {
		const text = message.text.replaceAll(`<@${botId}>`, "@Pi").replaceAll(`<@!${botId}>`, "@Pi").trim();
		const links: string[] = [];
		message.attachments.forEach((attachment, index) => {
			if (attachment.size <= MAX_ATTACHMENT && files.length < MAX_FILES)
				files.push({
					url: attachment.url,
					name: attachment.name,
					size: attachment.size,
					key: `discord:${message.id}:${index}`,
					ref: message.id,
				});
			else links.push(`[attachment ${attachment.name} (${attachment.size} bytes): ${attachment.url}]`);
		});
		return `${message.author.name}: ${[text, ...links].filter(Boolean).join("\n")}`;
	});
	return { text: [header, ...lines].join("\n"), files };
}

/** `text` in pieces of at most `limit` characters, split at a line break where possible, else at a space. */
export function chunkText(text: string, limit = MESSAGE_LIMIT): string[] {
	const chunks: string[] = [];
	let rest = text.trim();
	while (rest.length > limit) {
		let cut = rest.lastIndexOf("\n", limit);
		if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
		if (cut < limit / 2) cut = limit;
		chunks.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
	}
	if (rest) chunks.push(rest);
	return chunks;
}
