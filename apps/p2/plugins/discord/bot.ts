// One Discord bot (server, part of `DiscordStore`'s fleet): a discord.js client logged in with one of the owner's
// tokens, its status (identity and servers, live), and the messages it receives handed to its owner; behind
// `DiscordPort`, what the relay uses (tests give it a fake).
import {
	ChannelType,
	Client,
	Events,
	GatewayIntentBits,
	GuildPremiumTier,
	type Message,
	Partials,
	type TextBasedChannel,
} from "discord.js";
import type { BotStatus, ServerDetails } from "./contract.ts";
import type { DiscordChannel, DiscordMessage, DiscordPort } from "./relay.ts";

/** The bot's permissions in the invite: view channels, send (also in threads), embed links, attach files, history. */
const PERMISSIONS = (1n << 10n) | (1n << 11n) | (1n << 14n) | (1n << 15n) | (1n << 16n) | (1n << 38n);

/** What a bot hands its fleet: a message it received, or that it (re)connected and may have missed some. */
export type BotEvent = { kind: "message"; message: DiscordMessage } | { kind: "ready" };

/** How long a bot that could not reach Discord waits before it tries again (a refused token or intent never does). */
const RETRY_MS = 60_000;

export class Bot implements DiscordPort {
	client: Client | undefined;
	status: BotStatus = { state: "connecting" };
	readonly #listeners = new Set<() => void>();
	readonly #onEvent: (event: BotEvent) => void;
	#generation = 0;
	#retry: ReturnType<typeof setTimeout> | undefined;

	/** A bot that hands what it receives (never its own messages) and each (re)connection to `onEvent`. */
	constructor(onEvent: (event: BotEvent) => void) {
		this.#onEvent = onEvent;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#set(status: BotStatus): void {
		this.status = status;
		for (const listener of [...this.#listeners]) listener();
	}

	/**
	 * Connects with `token`, replacing a connection: its status once Discord accepted or refused it. A failure to reach
	 * Discord is tried again every minute (the status says why meanwhile).
	 */
	async connect(token: string): Promise<BotStatus> {
		const generation = ++this.#generation;
		clearTimeout(this.#retry);
		const previous = this.client;
		this.client = undefined;
		if (previous) await previous.destroy().catch(() => {});
		this.#set({ state: "connecting" });
		const client = new Client({
			intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
			partials: [Partials.Channel],
		});
		client.on(Events.MessageCreate, (message) => {
			if (generation !== this.#generation || message.author.id === client.user?.id) return;
			this.#onEvent({ kind: "message", message: messageOf(message, client.user?.id ?? "") });
		});
		const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
		const refresh = () => {
			if (generation === this.#generation && client.isReady()) this.#set(connected(client));
		};
		// A new gateway session after the first (a resumed one replays what it missed): messages may have been missed.
		client.on(Events.ShardReady, () => {
			if (generation === this.#generation && this.client === client) this.#onEvent({ kind: "ready" });
		});
		client.on(Events.GuildCreate, refresh);
		client.on(Events.GuildDelete, refresh);
		client.on(Events.Error, (error) => console.error("p2 discord:", error.message));
		try {
			await client.login(token);
			await Promise.race([
				ready,
				new Promise((_, reject) => setTimeout(() => reject(new Error("Discord did not get ready")), 30_000)),
			]);
			await client.application?.fetch();
		} catch (error) {
			await client.destroy().catch(() => {});
			if (generation !== this.#generation) return this.status;
			const message = error instanceof Error ? error.message : String(error);
			const refused = refusal(message);
			if (!refused) this.#retry = setTimeout(() => void this.connect(token), RETRY_MS);
			this.#set({ state: "error", error: refused ?? `Could not reach Discord: ${message}` });
			return this.status;
		}
		if (generation !== this.#generation) {
			await client.destroy().catch(() => {});
			return this.status;
		}
		this.client = client;
		if (client.isReady()) this.#set(connected(client));
		this.#onEvent({ kind: "ready" });
		return this.status;
	}

	#client(): Client<true> {
		if (!this.client?.isReady()) throw new Error("The Discord bot is not connected");
		return this.client;
	}

	get botId(): string {
		return this.#client().user.id;
	}

	async channel(id: string): Promise<DiscordChannel> {
		const channel = await this.#client().channels.fetch(id);
		if (!channel || !channel.isTextBased() || channel.isDMBased()) throw new Error(`No text channel ${id}`);
		return {
			id: channel.id,
			name: channel.name,
			guildId: channel.guildId,
			guildName: channel.guild.name,
			...(channel.isThread()
				? {
						thread: {
							parentId: channel.parentId ?? "",
							createdAt: channel.createdTimestamp ?? Date.now(),
							createdId: channel.id,
						},
					}
				: {}),
			lastMessageId: channel.lastMessageId,
		};
	}

	async messages(channelId: string, query: { after: string; limit: number }): Promise<DiscordMessage[]> {
		const channel = await this.#text(channelId);
		const found = await channel.messages.fetch({ after: query.after, limit: query.limit, cache: false });
		const botId = this.botId;
		return [...found.values()]
			.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
			.map((message) => messageOf(message, botId));
	}

	async reply(
		channelId: string,
		messageId: string | undefined,
		text: string,
		files: readonly { name: string; data: Uint8Array }[] = [],
	): Promise<void> {
		const channel = await this.#text(channelId);
		if (!("send" in channel)) throw new Error("The channel takes no messages");
		// discord.js uploads attachments as a multipart request.
		await channel.send({
			...(text ? { content: text } : {}),
			...(files.length
				? { files: files.map((file) => ({ attachment: Buffer.from(file.data), name: file.name })) }
				: {}),
			...(messageId ? { reply: { messageReference: messageId, failIfNotExists: false } } : {}),
			allowedMentions: { parse: [] },
		});
	}

	async uploadLimit(channelId: string): Promise<number> {
		const channel = await this.#text(channelId);
		const tier = "guild" in channel ? channel.guild.premiumTier : GuildPremiumTier.None;
		// Discord's per-message upload limit by the server's boost level.
		return (tier === GuildPremiumTier.Tier3 ? 100 : tier === GuildPremiumTier.Tier2 ? 50 : 10) * 1024 * 1024;
	}

	async typing(channelId: string): Promise<void> {
		const channel = await this.#text(channelId);
		if ("sendTyping" in channel) await channel.sendTyping();
	}

	/** Server `guildId`'s text channels and roles (without @everyone), by name. */
	async server(guildId: string): Promise<ServerDetails> {
		const guild = await this.#client().guilds.fetch(guildId);
		const [channels, roles] = await Promise.all([guild.channels.fetch(), guild.roles.fetch()]);
		return {
			channels: [...channels.values()]
				.flatMap((channel) =>
					channel && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)
						? [{ id: channel.id, name: channel.name }]
						: [],
				)
				.sort((a, b) => a.name.localeCompare(b.name)),
			roles: [...roles.values()]
				.filter((role) => role.id !== guild.id && !role.managed)
				.map((role) => ({ id: role.id, name: role.name }))
				.sort((a, b) => a.name.localeCompare(b.name)),
		};
	}

	async #text(id: string): Promise<TextBasedChannel> {
		const channel = await this.#client().channels.fetch(id);
		if (!channel?.isTextBased()) throw new Error(`No text channel ${id}`);
		return channel;
	}

	async close(): Promise<void> {
		this.#generation++;
		clearTimeout(this.#retry);
		await this.client?.destroy().catch(() => {});
		this.client = undefined;
	}
}

function connected(client: Client<true>): BotStatus {
	const applicationId = client.application.id;
	return {
		state: "connected",
		user: client.user.tag,
		applicationId,
		...(client.user.avatar ? { avatarUrl: client.user.displayAvatarURL({ size: 64 }) } : {}),
		inviteUrl: `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot&permissions=${PERMISSIONS}`,
		guilds: [...client.guilds.cache.values()].map((guild) => ({ id: guild.id, name: guild.name })),
	};
}

/** Why Discord refused a login, in the owner's words; undefined for other failures (worth trying again). */
function refusal(message: string): string | undefined {
	if (message.includes("disallowed intents"))
		return 'Discord refused the Message Content intent: turn on "Message Content Intent" under Bot in the Discord Developer Portal, then connect again.';
	if (message.includes("invalid token") || message.includes("TokenInvalid")) return "Discord refused the token.";
	return undefined;
}

/**
 * A discord.js message as the relay reads it. A mention of the bot's own role (Discord offers it beside the bot's
 * user when typing `@name`) counts as a mention of the bot, written as one.
 */
function messageOf(message: Message, botId: string): DiscordMessage {
	const role = message.guild?.members.me?.roles.botRole?.id;
	const byRole = role !== undefined && message.mentions.roles.has(role);
	return {
		id: message.id,
		channelId: message.channelId,
		author: {
			id: message.author.id,
			name: message.member?.displayName ?? message.author.globalName ?? message.author.username,
			bot: message.author.bot,
		},
		roles: message.member ? [...message.member.roles.cache.keys()] : [],
		text: byRole ? message.content.replaceAll(`<@&${role}>`, `<@${botId}>`) : message.content,
		mentionsBot: botId !== "" && (byRole || message.mentions.users.has(botId)),
		attachments: [...message.attachments.values()].map((attachment) => ({
			name: attachment.name,
			url: attachment.url,
			size: attachment.size,
		})),
	};
}
