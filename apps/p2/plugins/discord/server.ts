// The discord plugin's server facet: the owner's bots (fleet.ts, tokens in `<data>/discord.json`), the links of
// sessions to channels with their cursors, threads and pending replies (persisted), the relay between them (relay.ts),
// and the owner's `Discord` view. Linking moves the session into a sandbox and locks it to the picked resources;
// unlinking lifts the lock.
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
import { Catalog, SessionLocks, SessionMoves } from "../sessions/contract.ts";
import { StatusStore } from "../status/contract.ts";
import { BindingSchema, Discord, DiscordIngress, DiscordStore, PendingSchema } from "./contract.ts";
import { FIRST_BOT, Fleet } from "./fleet.ts";
import { Relay, type RelayState, type SessionPort } from "./relay.ts";

const State = defineState("p2.discord-bindings", {
	schema: obj({ bindings: record(BindingSchema), pending: record(PendingSchema) }),
	// 2: several bots; links and pending replies name theirs (the first release's one bot is `FIRST_BOT`).
	version: 2,
	initial: () => ({ bindings: {}, pending: {} }),
	migrate: (old, from) => {
		if (from !== 1) throw new Error(`Unknown p2.discord-bindings version ${from}`);
		const value = old as { bindings: Record<string, object>; pending: Record<string, object> };
		const named = (entries: Record<string, object>) =>
			Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, { ...entry, botId: FIRST_BOT }]));
		return { bindings: named(value.bindings), pending: named(value.pending) } as never;
	},
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
		const moves = self.get(SessionMoves, {});
		const statuses = self.get(StatusStore, {});
		const state = self.state(State);
		const dataDir = () => server.info.value.dataDir;
		const fleet = self.open(
			() => Fleet.open(dataDir()),
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
		const relay = new Relay((bot) => fleet.value.connected(bot), sessions, {
			// The state's drafts are the same JSON as the relay's plain records.
			value: () => state.value as RelayState,
			change: (update) => state.change((draft) => update(draft as RelayState), during()),
		});
		self.onLive(async (ctx) => {
			live = ctx;
			// Messages one at a time, in the order the bots received them.
			for (;;) {
				const received = await fleet.value.next(signalOf(ctx));
				if (!received) return;
				await relay
					.onMessage(received.bot, received.message)
					.catch((error: unknown) => console.error("p2 discord:", errorText(error)));
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
		const connected = (bot: string) => {
			const found = fleet.value.connected(bot);
			if (!found) throw new Error("The Discord bot is not connected");
			return found;
		};
		/** Drops `session`'s link and lifts its lock. */
		const unlink = async (session: string, ctx: Ctx): Promise<void> => {
			await state.change((draft) => {
				for (const [channel, binding] of Object.entries(draft.bindings))
					if (binding.session === session) delete draft.bindings[channel];
			}, ctx);
			await locks.set({ session, lock: null }, ctx);
		};
		return {
			bots: followNative(
				self,
				(changed) => fleet.value.subscribe(changed),
				() => fleet.value.views(),
			),
			bindings: deriveTyped(self, [state], ([value]) =>
				Object.values(value.bindings).sort((a, b) => a.createdAt - b.createdAt),
			),
			addBot: async ({ token }) => ({ id: await fleet.value.add(token) }),
			setBotToken: async ({ bot, token }) => {
				await fleet.value.setToken(bot, token);
				return null;
			},
			removeBot: async ({ bot }, ctx) => {
				for (const binding of Object.values(state.value.bindings))
					if (binding.botId === bot) await unlink(binding.session, ctx);
				await fleet.value.remove(bot);
				return null;
			},
			server: ({ bot, guild }) => connected(bot).server(guild),
			mcpServers: async () => {
				const text = await optionalText(join(dataDir(), "mcp.json"));
				return text ? mcpServerNames(text) : [];
			},
			link: async ({ session, bot, guild, channel: channelId, wake, sandbox, lock }, ctx) => {
				const bindings = Object.values(state.value.bindings);
				if (bindings.some((binding) => binding.session === session))
					throw new Error("This session is linked already: unlink it first");
				if (state.value.bindings[channelId]) throw new Error("This channel is linked to another session");
				const config = envs.configs.value[sandbox];
				if (config?.type !== "gondolin") throw new Error(`No sandbox ${sandbox}`);
				const row = catalog.sessions.value.find((entry) => entry.id === session);
				if (!row || row.archivedAt !== null) throw new Error("No such session");
				const channel = await connected(bot).channel(channelId);
				if (channel.thread || channel.guildId !== guild) throw new Error("Pick a channel of the server");
				// As the owner's Relocate: the session works in the sandbox from now on, and cannot leave it.
				if (row.env !== sandbox) {
					const cwd = config.mounts?.[0]?.guest ?? "/root";
					const { refused } = await moves.relocate({ id: session, cwd, env: sandbox }, ctx);
					if (refused) throw new Error(`The session could not move into ${sandbox}: ${refused}`);
				}
				await locks.set({ session, lock }, ctx);
				await state.change((draft) => {
					draft.bindings[channelId] = {
						botId: bot,
						channelId,
						channelName: channel.name,
						guildId: channel.guildId,
						guildName: channel.guildName,
						session,
						wake,
						// The first mention delivers what comes after linking.
						cursor: channel.lastMessageId,
						threads: {},
						createdAt: Date.now(),
					};
				}, ctx);
				return null;
			},
			unlink: async ({ session }, ctx) => {
				await unlink(session, ctx);
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
				bots: store.bots,
				bindings: store.bindings,
				addBot: (args, ctx) => store.addBot(args, ctx),
				setBotToken: (args, ctx) => store.setBotToken(args, ctx),
				removeBot: (args, ctx) => store.removeBot(args, ctx),
				server: (args, ctx) => store.server(args, ctx),
				mcpServers: (ctx) => store.mcpServers(ctx),
				link: (args, ctx) => store.link(args, ctx),
				unlink: (args, ctx) => store.unlink(args, ctx),
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
