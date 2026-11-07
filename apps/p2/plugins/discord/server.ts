// The discord plugin's server facet: the bot (its token in `<data>/discord.json`, 0600), the bindings of channels to
// sessions with their cursors, threads and pending replies (persisted), the relay between them (relay.ts), and the
// owner's `Discord` view. A session listens only while it works in a sandbox; binding it locks it to the picked
// resources, and unbinding its last channel lifts the lock.
import { chmod, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { obj } from "@earendil-works/pi-schema";
import {
	BACKGROUND_CONTEXT,
	type Ctx,
	defineFacet,
	defineState,
	deriveTyped,
	followNative,
	forbidden,
	isOwner,
	type Ref,
	record,
	signalOf,
	sleep,
} from "@p2/app/v1";
import { optionalText, stripJsonComments } from "@p2/app/v1/node";
import { Server, serverOf } from "@p2/app/v1/server";
import { EnvService } from "../envs/contract.ts";
import { isSandbox } from "../envs/schema.ts";
import { Catalog, SessionLocks } from "../sessions/contract.ts";
import { StatusStore } from "../status/contract.ts";
import { Bot } from "./bot.ts";
import { BindingSchema, Discord, DiscordIngress, DiscordStore, PendingSchema } from "./contract.ts";
import { Relay, type RelayState, type SessionPort } from "./relay.ts";

const State = defineState("p2.discord-bindings", {
	schema: obj({ bindings: record(BindingSchema), pending: record(PendingSchema) }),
	version: 1,
	initial: () => ({ bindings: {}, pending: {} }),
	persist: true,
	checkpointWhen: () => true,
});

/** How often "typing" is sent while a reply is pending, and every how many of those pending turns are checked anyway. */
const TYPING_MS = 8_000;
const CHECK_EVERY = 2;

export default defineFacet((host) => {
	host.serve(DiscordStore, (_params, self) => {
		const server = self.get(Server, {});
		const catalog = self.get(Catalog, {});
		const envs = self.get(EnvService, {});
		const locks = self.get(SessionLocks, {});
		const statuses = self.get(StatusStore, {});
		const state = self.state(State);
		const dataDir = () => server.info.value.dataDir;
		const bot = self.open(
			async () => {
				const opened = new Bot();
				// Connecting runs in the background: a refused token shows in the status, never fails the store.
				void opened.connect(await readToken(join(dataDir(), "discord.json")));
				return opened;
			},
			(opened) => opened.close(),
		);
		/** The context of the store's live loop: replies, deliveries and state changes run under it. */
		let live: Ctx | undefined;
		const during = (): Ctx => {
			if (!live) throw new Error("The Discord store is not live");
			return live;
		};
		const usable = async (session: string): Promise<string | undefined> => {
			const row = catalog.sessions.value.find((entry) => entry.id === session);
			if (!row) return "its p2 session is gone.";
			if (row.archivedAt !== null) return "its p2 session is archived.";
			if (!row.env || !isSandbox(envs.configs.value, row.env)) return "its p2 session does not work in a sandbox.";
			return undefined;
		};
		const natives = serverOf(self);
		/** One call of session `session`'s worker (started if needed) as the server, in a scope of its own. */
		const ingress = <T>(
			session: string,
			call: (worker: Ref<typeof DiscordIngress>, ctx: Ctx) => Promise<T>,
		): Promise<T> =>
			// A root scope releases the worker's reference when the call ends; the live routine's would keep them all.
			natives().root(async (ctx) => call(await ctx.get(DiscordIngress, { session }), ctx), BACKGROUND_CONTEXT);
		const sessions: SessionPort = {
			usable,
			lock: (session) => locks.locks.value[session] ?? null,
			working: (session) => (statuses.statuses.value[session]?.tasks ?? 0) > 0,
			deliver: (session, input) => ingress(session, (worker, ctx) => worker.deliver(input, ctx)),
			turn: (session, submissionId) => ingress(session, (worker, ctx) => worker.turn({ submissionId }, ctx)),
			thread: (session, name, before) => ingress(session, (worker, ctx) => worker.thread({ name, before }, ctx)),
		};
		const relay = new Relay(() => (bot.value.client?.isReady() ? bot.value : undefined), sessions, {
			// The state's drafts are the same JSON as the relay's plain records.
			value: () => state.value as RelayState,
			change: (update) => state.change((draft) => update(draft as RelayState), during()),
		});
		self.onLive(async (ctx) => {
			live = ctx;
			// Messages one at a time, in the order Discord sent them.
			for (;;) {
				const message = await bot.value.next(signalOf(ctx));
				if (!message) return;
				await relay.onMessage(message).catch((error: unknown) => console.error("p2 discord:", errorText(error)));
			}
		});
		self.onLive(async (ctx) => {
			for (let tick = 1; !signalOf(ctx).aborted; tick++) {
				await sleep(TYPING_MS, ctx);
				if (!Object.keys(state.value.pending).length) continue;
				await relay.typing();
				if (tick % CHECK_EVERY === 0) await relay.checkPending().catch(() => {});
			}
		});
		// A session's status changed: its turn may have ended.
		let seen: Record<string, string> = {};
		self.on(statuses.statuses, async ({ value }) => {
			const changed = new Set<string>();
			const next: Record<string, string> = {};
			for (const [session, status] of Object.entries(value)) {
				next[session] = `${status.running} ${status.tasks} ${status.busy.join(",")}`;
				if (next[session] !== seen[session]) changed.add(session);
			}
			seen = next;
			if (live && changed.size && Object.keys(state.value.pending).length)
				await relay.checkPending(changed).catch((error: unknown) => console.error("p2 discord:", errorText(error)));
		});
		/** Lifts `session`'s lock once no channel is bound to it. */
		const unlockUnbound = async (session: string, ctx: Ctx): Promise<void> => {
			if (!Object.values(state.value.bindings).some((other) => other.session === session))
				await locks.set({ session, lock: null }, ctx);
		};
		const connected = () => {
			const client = bot.value.client;
			if (!client?.isReady()) throw new Error("The Discord bot is not connected");
			return bot.value;
		};
		return {
			status: followNative(
				self,
				(changed) => bot.value.subscribe(changed),
				() => bot.value.status,
			),
			bindings: deriveTyped(self, [state], ([value]) =>
				Object.values(value.bindings).sort((a, b) => a.createdAt - b.createdAt),
			),
			setToken: async ({ token }) => {
				await writeToken(join(dataDir(), "discord.json"), token);
				void bot.value.connect(token ?? undefined);
				return null;
			},
			channels: () => connected().channels(),
			mcpServers: async () => {
				const text = await optionalText(join(dataDir(), "mcp.json"));
				return text ? mcpServerNames(text) : [];
			},
			bind: async ({ channelId, session, wake, from, lock }, ctx) => {
				const channel = await connected().channel(channelId);
				if (channel.thread) throw new Error("Bind the channel; its threads follow it");
				const refusal = await usable(session);
				if (refusal) throw new Error(`Cannot bind: ${refusal.replace(/^its /, "the ")}`);
				const previous = state.value.bindings[channelId]?.session;
				await locks.set({ session, lock }, ctx);
				await state.change((draft) => {
					draft.bindings[channelId] = {
						channelId,
						channelName: channel.name,
						guildId: channel.guildId,
						guildName: channel.guildName,
						session,
						wake,
						cursor: from === "now" ? channel.lastMessageId : null,
						threads: {},
						createdAt: Date.now(),
					};
				}, ctx);
				if (previous && previous !== session) await unlockUnbound(previous, ctx);
				return null;
			},
			setWake: async ({ channelId, wake }, ctx) => {
				await state.change((draft) => {
					const binding = draft.bindings[channelId];
					if (!binding) throw new Error("This channel is not bound");
					binding.wake = wake;
				}, ctx);
				return null;
			},
			unbind: async ({ channelId }, ctx) => {
				const binding = state.value.bindings[channelId];
				if (!binding) return null;
				await state.change((draft) => {
					delete draft.bindings[channelId];
				}, ctx);
				await unlockUnbound(binding.session, ctx);
				return null;
			},
			deliverNow: async ({ channelId }) => {
				connected();
				await relay.deliverNow(channelId);
				return null;
			},
		};
	});

	host.serve(Discord, (_params, principal, self) => {
		if (!isOwner(principal)) throw forbidden("Discord is the owner's");
		const store = self.get(DiscordStore, {});
		return {
			variant: "owner",
			members: {
				status: store.status,
				bindings: store.bindings,
				setToken: (args, ctx) => store.setToken(args, ctx),
				channels: (ctx) => store.channels(ctx),
				mcpServers: (ctx) => store.mcpServers(ctx),
				bind: (args, ctx) => store.bind(args, ctx),
				setWake: (args, ctx) => store.setWake(args, ctx),
				unbind: (args, ctx) => store.unbind(args, ctx),
				deliverNow: (args, ctx) => store.deliverNow(args, ctx),
			},
		};
	});
});

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The server names of `mcp.json` (a trust boundary: the owner's file; the MCP plugin reports what is wrong in it). */
function mcpServerNames(text: string): string[] {
	try {
		const value: unknown = JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, "")));
		const servers = value && typeof value === "object" && "mcpServers" in value ? value.mcpServers : undefined;
		return servers && typeof servers === "object" ? Object.keys(servers).sort() : [];
	} catch {
		return [];
	}
}

/** The bot token from `discord.json` (`{ "token": "…" }`, a trust boundary: the owner may edit it), if any. */
async function readToken(path: string): Promise<string | undefined> {
	const text = await optionalText(path);
	if (!text?.trim()) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		console.error("p2 discord: discord.json is not valid JSON; the bot stays off");
		return undefined;
	}
	return value && typeof value === "object" && "token" in value && typeof value.token === "string" && value.token
		? value.token
		: undefined;
}

/** Writes `discord.json` (0600): the token, or none. */
async function writeToken(path: string, token: string | null): Promise<void> {
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(token ? { token } : {}, null, "\t")}\n`, { mode: 0o600 });
	await chmod(temporary, 0o600);
	await rename(temporary, path);
}
