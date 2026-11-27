// The session kind on the server (`SessionKind`, decision 13): its object, one per session and caller, admitted by the
// caller's answer on the session workspace (the things plugin's one admission): the row for everyone let in, and what
// Manage gives (archive, restore, the model). Its create hook, run before the workspace's commit, writes the row
// (where it works; the model of the defaults that apply) and answers what the defaults say of the new workspace:
// shared (the kind's own default grants: everyone here Read and Send) or private (no grant for everyone, people from
// above hidden), and the view it opens with (decision 93, item 74). Its delete hook drops the row with the workspace.
// Archiving changes the row only (one commit): what kinds keep for the session stays until it is unlinked.

import {
	type Ctx,
	callerKey,
	type FacetHost,
	invalid,
	type P3Principal,
	type Self,
	type Watchable,
} from "@earendil-works/p3/v1";
import { type CreateAnswer, ThingsStore } from "../things/contract.server.ts";
import type { Source } from "../things/contract.ts";
import { serveThing } from "../things/serve.ts";
import { SessionsStore } from "./contract.server.ts";
import type { SessionRow } from "./contract.ts";
import { nearestDefaults } from "./defaults.ts";
import { SessionKind } from "./kind.ts";
import { messages } from "./messages.ts";

/**
 * A private session's default grants: the kind's, with no entry for everyone (decision 93). An empty list would be a
 * grant of `@open`, and a person's choice for everyone in the add dialog is left out with it (Astra, round 1).
 */
const PRIVATE = { agents: SessionKind.info.defaultGrants.agents, guests: SessionKind.info.defaultGrants.guests };

/** Serves the session kind on `host`. */
export function serveSessionKind(host: FacetHost<P3Principal>): void {
	serveThing(host, SessionKind, {
		implement: ({ thing: session }, _admitted, self) => {
			const store = self.get(SessionsStore, {});
			return {
				row: self.derive([sessionRow(session, self)], ([row]) => row ?? missing(session)),
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
			};
		},
		create: async ({ thing: session, input, workspace, by }, ctx) => {
			if (input.location !== undefined) await mayWorkOn(input.location.environment, workspace, by, ctx);
			const defaults = await nearestDefaults(workspace, ctx);
			await (await ctx.get(SessionsStore, {})).insert({ id: session, ...input, model: defaults.model }, ctx);
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

/**
 * Refuses a location on machine `machine` that the maker `by` (a person or an agent) is not let in on in `workspace`,
 * where the session is made: their session could not show it to them (Opus, round 5). A plugin makes where it says.
 */
async function mayWorkOn(machine: string, workspace: string, by: Source, ctx: Ctx<P3Principal>): Promise<void> {
	if (by.kind !== "person" && by.kind !== "agent") return;
	const caller =
		by.kind === "person"
			? callerKey({ kind: "person", id: by.person, name: "" })
			: callerKey({ kind: "worker", session: by.session });
	const answer = await (await ctx.get(ThingsStore, {})).answerOf({ workspace, thing: machine, caller }, ctx);
	if (answer === null) {
		throw invalid("args", `sessions: no machine ${machine} here`, {
			message: messages.message("noMachine", machine),
		});
	}
}

/** Session `session`'s row as its holders and its worker see it, live (`null`: a session the server does not know). */
export function sessionRow(session: string, self: Self<P3Principal>): Watchable<SessionRow | null> {
	const found = self.liveQuery(self.get(SessionsStore, {}).sessions.one, { id: session }, { first: 1 });
	return self.derive([found], ([{ rows }]) => rows[0] ?? null);
}

/** Fails the row of a session the server does not know (a held session object whose workspace went). */
function missing(session: string): never {
	throw invalid("args", `sessions: no session ${session}`);
}
