// The session kind on the server (`SessionKind`, decision 13): its object, one per session and caller, admitted by the
// caller's answer on the session workspace (the things plugin's one admission): the row for everyone let in, and what
// Manage gives (its detail, where its moved conversations work; archive, restore, the model, moving a conversation).
// Its create hook, run before the workspace's commit, writes the row (where it works: a machine its maker may use in
// the parent, R41, else none; the model of the defaults that apply) and answers what the defaults say of the new
// workspace:
// shared (the kind's own default grants: everyone here Read and Send) or private (no grant for everyone, people from
// above hidden), and the view it opens with (decision 93, item 74). Its delete hook drops the row with the workspace.
// Archiving changes the row only (one commit): what kinds keep for the session stays until it is unlinked.

import {
	type Ctx,
	type FacetHost,
	invalid,
	type P3Principal,
	type Self,
	Session,
	until,
	type Watchable,
} from "@earendil-works/p3/v1";
import { checkMachine, machineAvailable } from "../environments/contract.server.ts";
import { MACHINE_KIND } from "../environments/contract.ts";
import { type CreateAnswer, OneThing, ThingsStore } from "../things/contract.server.ts";
import { type Caller, callerKeyOf, type Source } from "../things/contract.ts";
import { serveThing } from "../things/serve.ts";
import { SessionsStore } from "./contract.server.ts";
import type { Location, SessionRow } from "./contract.ts";
import { nearestDefaults } from "./defaults.ts";
import { SessionKind } from "./kind.ts";

/**
 * A private session's default grants: the kind's, with no entry for everyone (decision 93). An empty list would be a
 * grant of `@open`, and a person's choice for everyone in the add dialog is left out with it (Astra, round 1).
 */
const PRIVATE = { agents: SessionKind.info.defaultGrants.agents, guests: SessionKind.info.defaultGrants.guests };

/** Serves the session kind on `host`. */
export function serveSessionKind(host: FacetHost<P3Principal>): void {
	serveThing(host, SessionKind, {
		implement: ({ thing: session }, { caller }, self) => {
			const store = self.get(SessionsStore, {});
			return {
				row: self.derive([sessionRow(session, self)], ([row]) => row ?? missing(session)),
				detail: () => store.moved.at(Session({ id: session })),
				archive: async (ctx) => {
					await store.archive({ session }, ctx);
					return null;
				},
				restore: async (ctx) => {
					await store.restore({ session }, ctx);
					return null;
				},
				setModel: async ({ model }, ctx) => {
					await store.setModel({ session, model }, ctx);
					return null;
				},
				moveLocation: async (moved, ctx) => {
					if (moved.location !== null) await mayUse(session, moved.location.machine, caller, ctx);
					await store.moveLocation({ session, ...moved }, ctx);
					return null;
				},
			};
		},
		create: async ({ thing: session, input, workspace, by }, ctx) => {
			const defaults = await nearestDefaults(workspace, ctx);
			const location = await startsAt(input.location, defaults.location, workspace, makerOf(by), ctx);
			await (await ctx.get(SessionsStore, {})).insert({ id: session, location, model: defaults.model }, ctx);
			return {
				...(defaults.shared ? {} : { defaultGrants: PRIVATE, showsPeople: false }),
				...(defaults.opensWith === null ? {} : { view: defaults.opensWith }),
			} satisfies CreateAnswer;
		},
		delete: async (session, ctx) => {
			await (await ctx.get(SessionsStore, {})).remove({ session }, ctx);
		},
	});
}

/** Session `session`'s row as its holders and its worker see it, live (`null`: a session the server does not know). */
export function sessionRow(session: string, self: Self<P3Principal>): Watchable<SessionRow | null> {
	const found = self.liveQuery(self.get(SessionsStore, {}).sessions.one, { id: session }, { first: 1 });
	return self.derive([found], ([{ rows }]) => rows[0] ?? null);
}

/**
 * Where a session made in `parent` by `maker` starts (R41): the location given, refused unless the maker may use its
 * machine there (`checkMachine`, the machine kind's rule); none given, the nearest defaults' location (`preset`, with a
 * folder) if the maker may use its machine there; else (or `null` given: its own folder, as the new-session step asks
 * with an empty folder) this device's machine in a folder of its own (`undefined`, the
 * store's default) if the maker may use it there, else nowhere (`null`: its agent has no environment until a
 * conversation is moved).
 */
async function startsAt(
	given: Location | null | undefined,
	preset: Location | null,
	parent: string,
	maker: Caller,
	ctx: Ctx<P3Principal>,
): Promise<Location | null | undefined> {
	// A default location with no folder names only what the new-session step offers first: the session's own folder.
	const defaulted = given === undefined && preset !== null && preset.folder !== "" ? preset : undefined;
	if (maker.kind === "server") return given === null ? undefined : (given ?? defaulted);
	const things = await ctx.get(ThingsStore, {});
	const answerOn = async (machine: string) =>
		(await things.answerOf({ workspace: parent, thing: machine, caller: callerKeyOf(maker) }, ctx)) ?? undefined;
	if (given !== undefined && given !== null) {
		checkMachine(given.machine, maker, await answerOn(given.machine));
		return given;
	}
	if (defaulted !== undefined && machineAvailable(maker, await answerOn(defaulted.machine))) return defaulted;
	const device = await until((await ctx.get(OneThing, { kind: MACHINE_KIND })).thing, (id) => id !== "", ctx);
	return machineAvailable(maker, await answerOn(device)) ? undefined : null;
}

/** Who makes a thing, as a caller: a person or a session's agent; anything else (a plugin, a share) is server code. */
function makerOf(by: Source): Caller {
	switch (by.kind) {
		case "person":
			return { kind: "person", person: by.person };
		case "agent":
			return { kind: "agent", session: by.session };
		case "thing":
		case "identity":
		case "plugin":
			return { kind: "server" };
	}
}

/**
 * Throws unless person `caller` may use `machine` in the session's workspace (`checkMachine`, the machine kind's rule;
 * R41): a person moves the agent only to a machine available to them there. The server is no party (it may); an agent
 * has no Manage (`for: "people"`). Whether it is a machine the agents have Work on is the store's check.
 */
async function mayUse(session: string, machine: string, caller: Caller, ctx: Ctx<P3Principal>): Promise<void> {
	if (caller.kind !== "person") return;
	const things = await ctx.get(ThingsStore, {});
	const answer = await things.answerOf({ workspace: session, thing: machine, caller: callerKeyOf(caller) }, ctx);
	checkMachine(machine, caller, answer ?? undefined);
}

/** Fails the row of a session the server does not know (a held session object whose workspace went). */
function missing(session: string): never {
	throw invalid("args", `sessions: no session ${session}`);
}
