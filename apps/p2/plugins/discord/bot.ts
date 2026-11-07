// The Discord bot (server, a native of `DiscordStore`): a discord.js client logged in with the owner's token, its
// status, and the messages it receives queued for the store's routine, behind `DiscordPort` (what the relay uses; tests
// give it a fake).
import {
	ChannelType,
	Client,
	Events,
	GatewayIntentBits,
	type Message,
	Partials,
	type TextBasedChannel,
} from "discord.js";
import type { BotStatus, Channel } from "./contract.ts";
import type { DiscordChannel, DiscordMessage, DiscordPort } from "./relay.ts";

/** The bot's permissions in the invite: view channels, send (also in threads), embed links, attach files, history. */
const PERMISSIONS = (1n << 10n) | (1n << 11n) | (1n << 14n) | (1n << 15n) | (1n << 16n) | (1n << 38n);

export class Bot implements DiscordPort {
	client: Client | undefined;
	status: BotStatus = { state: "off" };
	readonly #listeners = new Set<() => void>();
	readonly #queue: DiscordMessage[] = [];
	readonly #waiters = new Set<() => void>();
	#generation = 0;

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#set(status: BotStatus): void {
		this.status = status;
		for (const listener of [...this.#listeners]) listener();
	}

	/** Connects with `token` (undefined: disconnects), replacing a connection. */
	async connect(token: string | undefined): Promise<void> {
		const generation = ++this.#generation;
		const previous = this.client;
		this.client = undefined;
		if (previous) await previous.destroy().catch(() => {});
		if (!token) return this.#set({ state: "off" });
		this.#set({ state: "connecting" });
		const client = new Client({
			intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
			partials: [Partials.Channel],
		});
		client.on(Events.MessageCreate, (message) => {
			if (generation !== this.#generation || message.author.id === client.user?.id) return;
			this.#queue.push(messageOf(message, client.user?.id ?? ""));
			for (const wake of [...this.#waiters]) wake();
		});
		const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
		const refresh = () => {
			if (generation === this.#generation && client.isReady()) this.#set(connected(client));
		};
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
			if (generation !== this.#generation) return;
			const message = error instanceof Error ? error.message : String(error);
			return this.#set({
				state: "error",
				error: message.includes("disallowed intents")
					? 'Discord refused the Message Content intent: turn on "Message Content Intent" under Bot in the Discord Developer Portal, then connect again.'
					: message.includes("invalid token") || message.includes("TokenInvalid")
						? "Discord refused the token."
						: message,
			});
		}
		if (generation !== this.#generation) return void client.destroy();
		this.client = client;
		if (client.isReady()) this.#set(connected(client));
	}

	/** The next received message, or undefined when `signal` aborts. */
	async next(signal: AbortSignal): Promise<DiscordMessage | undefined> {
		while (!signal.aborted) {
			const message = this.#queue.shift();
			if (message) return message;
			await new Promise<void>((resolve) => {
				const wake = () => {
					this.#waiters.delete(wake);
					signal.removeEventListener("abort", wake);
					resolve();
				};
				this.#waiters.add(wake);
				signal.addEventListener("abort", wake, { once: true });
			});
		}
		return undefined;
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
				? { thread: { parentId: channel.parentId ?? "", createdAt: channel.createdTimestamp ?? Date.now() } }
				: {}),
			lastMessageId: channel.lastMessageId,
		};
	}

	async messages(channelId: string, query: { after?: string; limit: number }): Promise<DiscordMessage[]> {
		const channel = await this.#text(channelId);
		const found = await channel.messages.fetch(
			query.after ? { after: query.after, limit: query.limit } : { limit: query.limit },
		);
		const botId = this.botId;
		return [...found.values()]
			.sort((a, b) => a.createdTimestamp - b.createdTimestamp)
			.map((message) => messageOf(message, botId));
	}

	async reply(channelId: string, messageId: string | undefined, text: string): Promise<void> {
		const channel = await this.#text(channelId);
		if (!("send" in channel)) throw new Error("The channel takes no messages");
		await channel.send({
			content: text,
			...(messageId ? { reply: { messageReference: messageId, failIfNotExists: false } } : {}),
			allowedMentions: { parse: [] },
		});
	}

	async typing(channelId: string): Promise<void> {
		const channel = await this.#text(channelId);
		if ("sendTyping" in channel) await channel.sendTyping();
	}

	async channels(): Promise<Channel[]> {
		const client = this.#client();
		const channels: Channel[] = [];
		for (const guild of client.guilds.cache.values()) {
			const all = await guild.channels.fetch();
			for (const channel of all.values())
				if (channel && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement))
					channels.push({ id: channel.id, name: channel.name, guildId: guild.id, guildName: guild.name });
		}
		return channels.sort((a, b) => a.guildName.localeCompare(b.guildName) || a.name.localeCompare(b.name));
	}

	async #text(id: string): Promise<TextBasedChannel> {
		const channel = await this.#client().channels.fetch(id);
		if (!channel?.isTextBased()) throw new Error(`No text channel ${id}`);
		return channel;
	}

	async close(): Promise<void> {
		this.#generation++;
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
		inviteUrl: `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot&permissions=${PERMISSIONS}`,
		guilds: [...client.guilds.cache.values()].map((guild) => ({ id: guild.id, name: guild.name })),
	};
}

/** A discord.js message as the relay reads it. */
function messageOf(message: Message, botId: string): DiscordMessage {
	return {
		id: message.id,
		channelId: message.channelId,
		author: {
			id: message.author.id,
			name: message.member?.displayName ?? message.author.globalName ?? message.author.username,
			bot: message.author.bot,
		},
		roles: message.member ? [...message.member.roles.cache.keys()] : [],
		text: message.content,
		mentionsBot: botId !== "" && message.mentions.users.has(botId),
		attachments: [...message.attachments.values()].map((attachment) => ({
			name: attachment.name,
			url: attachment.url,
			size: attachment.size,
		})),
	};
}
