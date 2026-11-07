// The owner's Discord bots (server, a native of `DiscordStore`): their tokens in `<data>/discord.json` (0600), one
// connected `Bot` each, their views, and what they all receive in one queue (oldest first) for the store's routine.
import { randomBytes } from "node:crypto";
import { chmod, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { optionalText } from "@p2/app/v1/node";
import { Bot, type BotEvent } from "./bot.ts";
import type { BotView } from "./contract.ts";

/** discord.json: each bot's token by p2's ID for it. */
type BotsFile = { bots: Record<string, { token: string; addedAt: number }> };

/** The ID the one bot of the first release (`{ "token": … }`) gets; its links name it too (server.ts migrates them). */
export const FIRST_BOT = "bot1";

/** What a bot of the fleet received (a message, or its (re)connection), and which bot. */
export type Received = { bot: string; event: BotEvent };

export class Fleet {
	readonly #path: string;
	#file: BotsFile;
	readonly #bots = new Map<string, Bot>();
	readonly #listeners = new Set<() => void>();
	readonly #queue: Received[] = [];
	readonly #waiters = new Set<() => void>();

	private constructor(path: string, file: BotsFile) {
		this.#path = path;
		this.#file = file;
	}

	/** The fleet of `dataDir`'s discord.json, each bot connecting in the background. */
	static async open(dataDir: string): Promise<Fleet> {
		const path = join(dataDir, "discord.json");
		const { file, migrated } = parseBots(await optionalText(path));
		const fleet = new Fleet(path, file);
		if (migrated) await fleet.#save();
		for (const [id, { token }] of Object.entries(file.bots)) void fleet.#start(id).connect(token);
		return fleet;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#changed(): void {
		for (const listener of [...this.#listeners]) listener();
	}

	/** Every bot with its status, oldest first. */
	views(): BotView[] {
		return Object.entries(this.#file.bots)
			.sort(([, a], [, b]) => a.addedAt - b.addedAt)
			.map(([id]) => ({ id, status: this.#bots.get(id)?.status ?? { state: "connecting" as const } }));
	}

	/** Bot `id` while it is connected. */
	connected(id: string): Bot | undefined {
		const bot = this.#bots.get(id);
		return bot?.client?.isReady() ? bot : undefined;
	}

	/** Connects a new bot with `token` and keeps it once Discord accepted it: its ID. */
	async add(token: string): Promise<string> {
		const id = `b${randomBytes(4).toString("hex")}`;
		const bot = this.#candidate(id);
		const status = await bot.connect(token);
		if (status.state !== "connected") {
			await bot.close();
			throw new Error(status.state === "error" ? status.error : "Discord did not answer");
		}
		const same = this.views().find(
			(view) => view.status.state === "connected" && view.status.applicationId === status.applicationId,
		);
		if (same) {
			await bot.close();
			throw new Error(`${status.user} is added already`);
		}
		this.#adopt(id, bot);
		this.#file.bots[id] = { token, addedAt: Date.now() };
		await this.#save();
		this.#changed();
		return id;
	}

	/** Connects bot `id` with a new token of the same Discord application, kept once Discord accepted it. */
	async setToken(id: string, token: string): Promise<void> {
		const current = this.#bots.get(id);
		if (!current || !this.#file.bots[id]) throw new Error("No such bot");
		const bot = this.#candidate(id);
		const status = await bot.connect(token);
		if (status.state !== "connected") {
			await bot.close();
			throw new Error(status.state === "error" ? status.error : "Discord did not answer");
		}
		if (current.status.state === "connected" && current.status.applicationId !== status.applicationId) {
			await bot.close();
			throw new Error(`This token is for ${status.user}, another bot: add it as a new bot`);
		}
		await current.close();
		this.#adopt(id, bot);
		this.#file.bots[id] = { token, addedAt: this.#file.bots[id].addedAt };
		await this.#save();
		this.#changed();
	}

	/** Disconnects and forgets bot `id`. */
	async remove(id: string): Promise<void> {
		await this.#bots.get(id)?.close();
		this.#bots.delete(id);
		delete this.#file.bots[id];
		await this.#save();
		this.#changed();
	}

	/** The next received event, or undefined when `signal` aborts. */
	async next(signal: AbortSignal): Promise<Received | undefined> {
		while (!signal.aborted) {
			const received = this.#queue.shift();
			if (received) return received;
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

	async close(): Promise<void> {
		await Promise.all([...this.#bots.values()].map((bot) => bot.close()));
		this.#bots.clear();
	}

	/** A bot `id` that is not one of the fleet's yet (a token being tried); it delivers messages once adopted. */
	#candidate(id: string): Bot {
		const bot: Bot = new Bot((event) => {
			if (this.#bots.get(id) === bot) this.#push({ bot: id, event });
		});
		return bot;
	}

	/** Makes `bot` the fleet's bot `id`; one connected already (a new token) catches up at once. */
	#adopt(id: string, bot: Bot): void {
		this.#bots.set(id, bot);
		bot.subscribe(() => this.#changed());
		if (bot.client?.isReady()) this.#push({ bot: id, event: { kind: "ready" } });
	}

	#push(received: Received): void {
		this.#queue.push(received);
		for (const wake of [...this.#waiters]) wake();
	}

	#start(id: string): Bot {
		const bot = this.#candidate(id);
		this.#adopt(id, bot);
		return bot;
	}

	async #save(): Promise<void> {
		const temporary = `${this.#path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(this.#file, null, "\t")}\n`, { mode: 0o600 });
		await chmod(temporary, 0o600);
		await rename(temporary, this.#path);
	}
}

/**
 * discord.json (a trust boundary: the owner may edit it): the bots, and whether it was the first release's
 * `{ "token": … }` (that bot becomes `FIRST_BOT`). Unreadable: no bots, said in the log.
 */
function parseBots(text: string | undefined): { file: BotsFile; migrated: boolean } {
	if (!text?.trim()) return { file: { bots: {} }, migrated: false };
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		console.error("p2 discord: discord.json is not valid JSON; no bots run");
		return { file: { bots: {} }, migrated: false };
	}
	if (!value || typeof value !== "object") return { file: { bots: {} }, migrated: false };
	if ("token" in value && typeof value.token === "string" && value.token)
		return { file: { bots: { [FIRST_BOT]: { token: value.token, addedAt: 0 } } }, migrated: true };
	const bots: BotsFile["bots"] = {};
	const listed = "bots" in value && value.bots && typeof value.bots === "object" ? value.bots : {};
	for (const [id, entry] of Object.entries(listed))
		if (entry && typeof entry === "object" && typeof entry.token === "string" && entry.token)
			bots[id] = { token: entry.token, addedAt: typeof entry.addedAt === "number" ? entry.addedAt : 0 };
	return { file: { bots }, migrated: false };
}
