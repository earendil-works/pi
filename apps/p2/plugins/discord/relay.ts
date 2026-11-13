// What happens between a Discord channel and its linked session (server): a mention by someone allowed to wake Pi, seen
// by the link's bot, delivers the messages since the link's cursor (a thread's: to its forked subagent) as one input; a
// pending reply is posted once its turn ended. Plain logic over ports, so tests run it with fake bots and sessions.
import type { SessionLock } from "@p2/app/v1";
import { type Binding, COMMANDS, type Command, type OfferedFile, type Pending, type Wake } from "./contract.ts";

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
	/**
	 * A thread's parent channel, when it was created, and a snowflake of its creation (its ID): the parent's messages up
	 * to it came before the thread.
	 */
	thread?: { parentId: string; createdAt: number; createdId: string };
	lastMessageId: string | null;
};

/** What the relay needs of Discord. */
export type DiscordPort = {
	readonly botId: string;
	channel(id: string): Promise<DiscordChannel>;
	/** The first `limit` messages after `after` (oldest first; `"0"`: from the channel's start). */
	messages(channelId: string, query: { after: string; limit: number }): Promise<DiscordMessage[]>;
	/**
	 * Posts `text` (at most 2000 characters; may be empty with files) with `files` attached (at most 10, together within
	 * `uploadLimit`), as a reply to `messageId` when given.
	 */
	reply(
		channelId: string,
		messageId: string | undefined,
		text: string,
		files?: readonly { name: string; data: Uint8Array }[],
	): Promise<void>;
	/** The bytes one message's attachments may have in `channelId` (its server's limit). */
	uploadLimit(channelId: string): Promise<number>;
	typing(channelId: string): Promise<void>;
};

export type TurnState =
	| { state: "pending" }
	| { state: "answered"; text: string; files: OfferedFile[]; answer: number }
	| { state: "stopped" }
	| { state: "unanswered"; reason: string; files: OfferedFile[] };

/** What the relay needs of a session (its worker's `DiscordIngress`, the catalog). */
export type SessionPort = {
	/** Whether the session exists, is not archived and works in a sandbox; why not otherwise. */
	usable(session: string): Promise<string | undefined>;
	lock(session: string): SessionLock | null;
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
	/** `length` bytes (at most 4 MiB) of offered file `id` from `offset`. */
	read(session: string, id: string, offset: number, length: number): Promise<Uint8Array>;
	/** Runs channel command `command` on `conversation` (default: the main one): the reply's text. */
	command(session: string, input: { conversation?: number; command: Command }): Promise<{ text: string }>;
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
	/** Channels and threads with deliveries under way (how many), and their bots: "typing" from the first moment. */
	readonly #delivering = new Map<string, { bot: string; count: number }>();
	/** Per channel or thread, the turns bots started in a row since a person last wrote there (in memory). */
	readonly #botStreaks = new Map<string, { turns: number; noticed: boolean }>();
	/** Answers posted lately (session and entry): a run's other inputs, settled later, post nothing. */
	readonly #posted: string[] = [];
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
	 * thread of one), delivers. Other bots count as people, within the loop guard; the bot's own messages never count.
	 */
	async onMessage(bot: string, message: DiscordMessage): Promise<void> {
		const port = this.#port(bot);
		if (message.author.id === port.botId) return;
		// A person's message, mention or not, ends the bots' streak where it was written.
		if (!message.author.bot) this.#personWrote(message.channelId);
		if (!message.mentionsBot) return;
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
		// A command runs now, never behind the delivery under way (a stop must reach the running turn).
		const command = commandOf(message.text, port.botId);
		if (command) await this.#command(binding, thread, message, command);
		else if (this.#botTurnAllowed(port, message)) await this.deliver(binding.channelId, message, thread);
	}

	/** A person wrote in `target` (a channel or thread): bots may wake Pi there again. */
	#personWrote(target: string): void {
		this.#botStreaks.delete(target);
	}

	/**
	 * Whether `message` may start a turn: a person's always; a bot's while fewer than `MAX_BOT_TURNS` turns in a row
	 * there were started by bots (two bots mentioning each other would otherwise talk forever). The first one refused
	 * gets a short notice; the streak ends when a person writes.
	 */
	#botTurnAllowed(port: DiscordPort, message: DiscordMessage): boolean {
		if (!message.author.bot) return true;
		const target = message.channelId;
		const streak = this.#botStreaks.get(target) ?? { turns: 0, noticed: false };
		this.#botStreaks.set(target, streak);
		if (streak.turns < MAX_BOT_TURNS) {
			streak.turns++;
			return true;
		}
		console.error(
			`p2 discord: not answering ${message.author.name} in ${target}: ${MAX_BOT_TURNS} bot-started turns in a row`,
		);
		if (!streak.noticed) {
			streak.noticed = true;
			void port
				.reply(
					target,
					message.id,
					`Not answering more bots here until a person writes (${MAX_BOT_TURNS} bot turns in a row).`,
				)
				.catch(() => {});
		}
		return false;
	}

	/** Runs channel command `command` of `message` on the channel's main conversation or the thread's subagent. */
	async #command(
		binding: Binding,
		thread: DiscordChannel | undefined,
		message: DiscordMessage,
		command: Command,
	): Promise<void> {
		const port = this.#port(binding.botId);
		const where = thread?.id ?? binding.channelId;
		const refusal = await this.#sessions.usable(binding.session);
		if (refusal) return port.reply(where, message.id, `Pi is not listening here right now: ${refusal}`);
		const conversation = thread ? binding.threads[thread.id]?.conversation : undefined;
		if (thread && conversation === undefined)
			return port.reply(
				where,
				message.id,
				command === "stop" ? "Nothing is running." : "This thread has no agent yet: mention the bot to start one.",
			);
		let text: string;
		try {
			({ text } = await this.#sessions.command(binding.session, {
				...(conversation === undefined ? {} : { conversation }),
				command,
			}));
		} catch (error) {
			text = `Could not reach Pi: ${error instanceof Error ? error.message : String(error)}`;
		}
		await port.reply(where, message.id, text);
	}

	/** Whether `message` is a channel command of `binding` (never delivered to the agent, nor caught up on). */
	#isCommand(binding: Binding, message: DiscordMessage, botId: string): boolean {
		return (
			message.mentionsBot &&
			mayWake(binding.wake, message.author.id, message.roles) &&
			commandOf(message.text, botId) !== undefined
		);
	}

	/**
	 * Delivers the batch ending at `trigger` to the binding's session (a thread's subagent for a message in a thread),
	 * then advances the cursor and records the pending reply. A session that cannot take it gets a notice instead. One
	 * delivery at a time per channel or thread: a later one starts from the cursor the earlier one left.
	 */
	async deliver(channelId: string, trigger: DiscordMessage, thread: DiscordChannel | undefined): Promise<void> {
		const target = thread?.id ?? channelId;
		// "Typing" at once, before the wait for an earlier delivery and the history's pages: `typing()` refreshes it
		// until the delivery ends, then the pending reply keeps it on.
		const stopTyping = this.#typingWhile(channelId, target, trigger);
		const run = (this.#lanes.get(target) ?? Promise.resolve()).then(() => this.#deliver(channelId, trigger, thread));
		// The lane goes on whether this delivery failed or not; the caller still learns it failed.
		const lane = run.catch(() => {});
		this.#lanes.set(target, lane);
		try {
			await run;
		} finally {
			if (this.#lanes.get(target) === lane) this.#lanes.delete(target);
			stopTyping();
		}
	}

	/** Shows "typing" in `target` while a delivery of `trigger` is under way (none for one delivered already): its end. */
	#typingWhile(channelId: string, target: string, trigger: DiscordMessage): () => void {
		const binding = this.#state.value().bindings[channelId];
		const cursor = target === channelId ? binding?.cursor : binding?.threads[target]?.cursor;
		if (!binding || (cursor && BigInt(trigger.id) <= BigInt(cursor))) return () => {};
		const bot = binding.botId;
		const active = this.#delivering.get(target) ?? { bot, count: 0 };
		active.count++;
		this.#delivering.set(target, active);
		void this.#discord(bot)
			?.typing(target)
			.catch(() => {});
		return () => {
			active.count--;
			if (active.count === 0 && this.#delivering.get(target) === active) this.#delivering.delete(target);
		};
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
		// Everything since the cursor, page by page; only the newest BATCH_CAP go into the input. A thread's first
		// batch starts with what its channel said after the channel's cursor until the thread was made: its subagent
		// is forked from before that and never saw it (the channel's cursor stays: the main agent gets it too).
		const window = new BatchWindow(BATCH_CAP);
		const before = thread?.thread && cursor === null ? thread.thread.createdId : undefined;
		if (before !== undefined)
			for await (const message of history(port, channelId, binding.cursor, before))
				if (message.author.id !== port.botId && !this.#isCommand(binding, message, port.botId))
					window.add("channel", message);
		for await (const message of history(port, where, cursor, trigger.id))
			if (message.author.id !== port.botId && !this.#isCommand(binding, message, port.botId))
				window.add("here", message);
		if (!window.has(trigger.id)) window.add("here", trigger);
		const plural = (count: number) => `${count} message${count === 1 ? "" : "s"}`;
		const left = window.omitted
			? `; the ${window.omitted} earliest are left out, the newest ${window.kept} follow`
			: "";
		const channelName = `#${binding.channelName}`;
		const header = !thread
			? `[Discord ${channelName} (${binding.guildName}): ${plural(window.total)} since the last delivery${left}]`
			: before === undefined
				? `[Discord thread "${thread.name}" in ${channelName} (${binding.guildName}): ${plural(window.total)} since the last delivery${left}]`
				: `[Discord thread "${thread.name}" in ${channelName} (${binding.guildName}), its first delivery: ${window.count("channel") ? `${plural(window.count("channel"))} of ${channelName} before the thread, then ` : ""}${plural(window.count("here"))} of the thread${left}]`;
		const batch = batchOf(
			window.sections({
				channel: `[${channelName}, before the thread]`,
				here: before !== undefined && window.count("channel") ? "[The thread]" : undefined,
			}),
			port.botId,
			header,
		);
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
					messages: window.total,
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
					for await (const message of history(port, place.id, place.cursor)) {
						if (message.author.id === port.botId) continue;
						if (!message.author.bot) this.#personWrote(place.id);
						// A missed command is stale: it neither runs nor triggers a delivery.
						if (
							message.mentionsBot &&
							mayWake(binding.wake, message.author.id, message.roles) &&
							!this.#isCommand(binding, message, port.botId)
						)
							newest = message;
					}
					if (!newest || !this.#botTurnAllowed(port, newest)) continue;
					const thread = place.thread ? await port.channel(place.id) : undefined;
					await this.deliver(binding.channelId, newest, thread);
				} catch (error) {
					// A channel or thread that went away (or a session that cannot take it) skips only itself.
					console.error("p2 discord: catching up failed:", error instanceof Error ? error.message : error);
				}
			}
		}
	}

	/**
	 * Posts the replies of the turns that ended (`sessions`: only those, when given); answers split at 2000. Inputs
	 * steered into one turn share its answer: it is posted once, as the reply to the newest of their mentions, with the
	 * files of the whole turn; the others' replies go without a post.
	 */
	async checkPending(sessions?: ReadonlySet<string>): Promise<void> {
		const now = Date.now();
		const settled: { pending: Pending; turn: TurnState }[] = [];
		try {
			for (const pending of Object.values(this.#state.value().pending)) {
				if ((sessions && !sessions.has(pending.session)) || this.#checking.has(pending.messageId)) continue;
				// A bot that is not connected (or was removed) keeps its replies until it is, or they time out.
				if (!this.#discord(pending.botId) && now - pending.since < PENDING_TIMEOUT_MS) continue;
				this.#checking.add(pending.messageId);
				const turn = await this.#settled(pending, now);
				if (turn) settled.push({ pending, turn });
				else this.#checking.delete(pending.messageId);
			}
			const runs = new Map<string, { pending: Pending; turn: TurnState }[]>();
			for (const entry of settled) {
				const key =
					entry.turn.state === "answered"
						? `${entry.pending.session}:${entry.turn.answer}`
						: entry.pending.messageId;
				runs.set(key, [...(runs.get(key) ?? []), entry]);
			}
			for (const [key, run] of runs) await this.#post(key, run);
		} finally {
			for (const { pending } of settled) this.#checking.delete(pending.messageId);
		}
	}

	/** Pending reply `pending`'s turn once it ended (timed out: unanswered), else undefined. */
	async #settled(pending: Pending, now: number): Promise<TurnState | undefined> {
		let turn: TurnState;
		try {
			turn = await this.#sessions.turn(pending.session, pending.submissionId);
		} catch (error) {
			console.error("p2 discord: reading a turn failed:", error instanceof Error ? error.message : error);
			if (now - pending.since < PENDING_TIMEOUT_MS) return undefined;
			return { state: "unanswered", reason: "the session did not answer in time.", files: [] };
		}
		if (turn.state !== "pending") return turn;
		if (now - pending.since < PENDING_TIMEOUT_MS) return undefined;
		return { state: "unanswered", reason: "the session did not answer in time.", files: [] };
	}

	/** Posts one run's reply (`run`: its pending replies, all settled) to the newest mention, then drops them all. */
	async #post(key: string, run: readonly { pending: Pending; turn: TurnState }[]): Promise<void> {
		const ordered = [...run].sort((a, b) => (BigInt(a.pending.messageId) < BigInt(b.pending.messageId) ? -1 : 1));
		const newest = ordered.at(-1);
		try {
			// A stopped turn posts nothing (the stop command answered already), nor does an answer posted before (an
			// input of its run settled after the others were checked).
			const turn = newest?.turn;
			if (newest && (turn?.state === "answered" || turn?.state === "unanswered") && !this.#posted.includes(key)) {
				const port = this.#discord(newest.pending.botId);
				if (!port) throw new Error("its bot is not connected");
				// The oldest input's span covers the whole turn; files are listed once each.
				const files = new Map<string, OfferedFile>();
				for (const { turn } of ordered)
					if (turn.state !== "stopped" && turn.state !== "pending")
						for (const file of turn.files) files.set(file.id, file);
				await this.#reply(port, newest.pending, { ...turn, files: [...files.values()] });
				if (turn.state === "answered") this.#remember(key);
			}
		} catch (error) {
			// A channel that went away: the reply is dropped, as Discord has nowhere to show it.
			console.error("p2 discord: posting a reply failed:", error instanceof Error ? error.message : error);
		}
		await this.#state.change((draft) => {
			for (const { pending } of run) delete draft.pending[pending.messageId];
		});
	}

	#remember(key: string): void {
		this.#posted.push(key);
		if (this.#posted.length > REMEMBERED_ANSWERS) this.#posted.shift();
	}

	/**
	 * Posts a finished turn's reply: its text split at 2000 characters, the first part replying to the waking message,
	 * and the files the turn offered attached (at most 10 a message, together within the server's limit; larger ones
	 * named only), the first ones on the last text part.
	 */
	async #reply(
		port: DiscordPort,
		pending: Pending,
		turn: Extract<TurnState, { state: "answered" | "unanswered" }>,
	): Promise<void> {
		let text = turn.state === "answered" ? turn.text : `(No answer: ${turn.reason})`;
		const limit = turn.files.length ? await port.uploadLimit(pending.replyChannelId) : 0;
		const tooLarge = turn.files.filter((file) => file.size > limit);
		if (tooLarge.length)
			text += `${text ? "\n\n" : ""}Too large for Discord: ${tooLarge.map((file) => `${file.name} (${megabytes(file.size)})`).join(", ")}`;
		const groups = attachmentGroups(
			turn.files.filter((file) => file.size <= limit),
			limit,
		);
		const posts: { text: string; files: OfferedFile[] }[] = chunkText(text).map((chunk) => ({
			text: chunk,
			files: [],
		}));
		for (const [index, group] of groups.entries()) {
			const last = posts.at(-1);
			if (index === 0 && last) last.files = group;
			else posts.push({ text: "", files: group });
		}
		for (const [index, post] of posts.entries()) {
			const files: { name: string; data: Uint8Array }[] = [];
			for (const file of post.files) {
				try {
					files.push({ name: file.name, data: await this.#readFile(pending.session, file) });
				} catch (error) {
					console.error(
						`p2 discord: reading ${file.name} failed:`,
						error instanceof Error ? error.message : error,
					);
				}
			}
			if (!post.text && !files.length) continue;
			await port.reply(pending.replyChannelId, index === 0 ? pending.messageId : undefined, post.text, files);
		}
	}

	/** Offered file `file` of `session`, whole. */
	async #readFile(session: string, file: OfferedFile): Promise<Uint8Array> {
		const parts: Uint8Array[] = [];
		for (let offset = 0; offset < file.size; ) {
			const part = await this.#sessions.read(session, file.id, offset, Math.min(READ_CHUNK, file.size - offset));
			if (!part.length) break;
			parts.push(part);
			offset += part.length;
		}
		return Buffer.concat(parts);
	}

	/**
	 * Refreshes "Pi is typing" (Discord shows it about 10 s; call it every 8 s) where a delivery is under way or a reply
	 * is pending, queued or not: it ends with the delivery's failure, or when the reply is posted, stopped or failed.
	 */
	async typing(): Promise<void> {
		const channels = new Map<string, string>();
		for (const [target, { bot }] of this.#delivering) channels.set(target, bot);
		for (const pending of Object.values(this.#state.value().pending))
			channels.set(pending.replyChannelId, pending.botId);
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

/**
 * The channel command `text` is, if it is one: with the bot's mentions removed, exactly a command (any case, an
 * optional leading slash).
 */
export function commandOf(text: string, botId: string): Command | undefined {
	const rest = text
		.replaceAll(`<@${botId}>`, "")
		.replaceAll(`<@!${botId}>`, "")
		.trim()
		.toLowerCase()
		.replace(/^\//, "");
	return COMMANDS.find((command) => command === rest);
}

/** Turns bots may start in a row in one channel or thread before a person writes there. */
export const MAX_BOT_TURNS = 3;
/** Answers kept in mind as posted, to post a run's answer once however its inputs settle. */
const REMEMBERED_ANSWERS = 200;

/** Bytes one read of an offered file asks for. */
const READ_CHUNK = 4 * 1024 * 1024;
/** Attachments one Discord message carries at most. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** `files` (each within `limit`) in order, in groups of at most 10 whose sizes add up to at most `limit`. */
export function attachmentGroups<T extends { size: number }>(files: readonly T[], limit: number): T[][] {
	const groups: T[][] = [];
	let bytes = 0;
	for (const file of files) {
		const last = groups.at(-1);
		if (last && last.length < MAX_ATTACHMENTS_PER_MESSAGE && bytes + file.size <= limit) {
			last.push(file);
			bytes += file.size;
		} else {
			groups.push([file]);
			bytes = file.size;
		}
	}
	return groups;
}

function megabytes(size: number): string {
	return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Whether the author of a message may wake Pi in its binding. */
export function mayWake(wake: Wake, author: string, roles: readonly string[]): boolean {
	return wake.anyone || wake.users.includes(author) || roles.some((role) => wake.roles.includes(role));
}

/** Where a batch's message comes from: the place mentioned in, or (a thread's first batch) its parent channel. */
type Part = "channel" | "here";

/** The newest `cap` messages of a batch in order, by part, and how many there were in all. */
class BatchWindow {
	readonly #cap: number;
	readonly #entries: { part: Part; message: DiscordMessage }[] = [];
	readonly #counts: Record<Part, number> = { channel: 0, here: 0 };

	constructor(cap: number) {
		this.#cap = cap;
	}

	add(part: Part, message: DiscordMessage): void {
		this.#counts[part]++;
		this.#entries.push({ part, message });
		if (this.#entries.length > this.#cap) this.#entries.shift();
	}

	has(id: string): boolean {
		return this.#entries.some((entry) => entry.message.id === id);
	}

	/** Messages of `part`, kept or not. */
	count(part: Part): number {
		return this.#counts[part];
	}

	get total(): number {
		return this.#counts.channel + this.#counts.here;
	}

	get kept(): number {
		return this.#entries.length;
	}

	get omitted(): number {
		return this.total - this.kept;
	}

	/** The kept messages in runs of one part, each titled as `titles` says (none: untitled). */
	sections(titles: Record<Part, string | undefined>): { title?: string; messages: DiscordMessage[] }[] {
		const sections: { part: Part; messages: DiscordMessage[] }[] = [];
		for (const { part, message } of this.#entries) {
			const last = sections.at(-1);
			if (last?.part === part) last.messages.push(message);
			else sections.push({ part, messages: [message] });
		}
		return sections.map(({ part, messages }) => {
			const title = titles[part];
			return title === undefined ? { messages } : { title, messages };
		});
	}
}

/**
 * A batch's text: under the header, each section's title (if any), then one `Name (<@id>): text` line (or paragraph) per
 * message, bots marked `Name (bot, <@id>)`, oldest first, the bot's mention written `@Pi`, and attachments too large to download listed as links. The
 * attachments to download, keyed by message and position.
 */
export function batchOf(
	sections: readonly { title?: string; messages: readonly DiscordMessage[] }[],
	botId: string,
	header: string,
): { text: string; files: { url: string; name: string; size: number; key: string; ref: string }[] } {
	const files: { url: string; name: string; size: number; key: string; ref: string }[] = [];
	const line = (message: DiscordMessage) => {
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
		const who = `${message.author.bot ? "bot, " : ""}<@${message.author.id}>`;
		return `${message.author.name} (${who}): ${[text, ...links].filter(Boolean).join("\n")}`;
	};
	const lines = sections.flatMap(({ title, messages }) => [
		...(title === undefined ? [] : [title]),
		...messages.map(line),
	]);
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
