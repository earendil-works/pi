// The session kind on the server (`SessionKind`, decision 13): its object, one per session and caller, admitted by the
// caller's answer on the session workspace (the things plugin's one admission): the row for everyone let in, and what
// Manage gives (rename, archive, restore, the model). Its create hook, run before the workspace's commit, writes the
// row (where it works; the model of the defaults that apply) and answers what the defaults say of the new workspace:
// shared (everyone here Read and Send) or private (no grant for everyone, people from above hidden), and the view it
// opens with (decision 93, item 74). Its delete hook drops the row with the workspace.

import type { FacetHost, P3Principal, Self, Watchable } from "@earendil-works/p3/v1";
import { type CreateAnswer, ThingsStore } from "../things/contract.server.ts";
import { serveThing } from "../things/serve.ts";
import { SessionsStore } from "./contract.server.ts";
import { SessionKind, type SessionRow } from "./contract.ts";
import { nearestDefaults } from "./defaults.ts";

/** Serves the session kind on `host`. */
export function serveSessionKind(host: FacetHost<P3Principal>): void {
	serveThing(host, SessionKind, {
		implement: ({ thing: session }, _admitted, self) => {
			const store = self.get(SessionsStore, {});
			const things = self.get(ThingsStore, {});
			return {
				row: self.derive([sessionRow(session, self)], ([row]) => row ?? missing(session)),
				rename: async ({ title }, ctx) => {
					await things.rename({ thing: session, name: title }, ctx);
					return null;
				},
				archive: async (ctx) => {
					await store.archive({ session }, ctx);
					// What kinds keep for the session (its terminals) goes; its things stay for a restore.
					await things.workspaceGone({ workspace: session }, ctx);
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
		create: async ({ thing: session, input, by, workspace }, ctx) => {
			const defaults = await nearestDefaults(workspace, by, ctx);
			const row = { id: session, ...input, model: defaults.model };
			await (await ctx.get(SessionsStore, {})).insert(row, ctx);
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

/** A private session's default grants: the kind's, with no grant for everyone (decision 93). */
const PRIVATE = { ...SessionKind.info.defaultGrants, everyone: [] };

/**
 * Session `session` as lists and its worker see it, live: its row in this plugin's store, its thing's name (the title)
 * and its line's parent; `null` while any is missing (a session the server does not know).
 */
export function sessionRow(session: string, self: Self<P3Principal>): Watchable<SessionRow | null> {
	const record = self.liveQuery(self.get(SessionsStore, {}).sessions.one, { id: session }, { first: 1 });
	const things = self.get(ThingsStore, {});
	const named = self.liveQuery(things.things.one, { thing: session }, { first: 1 });
	const line = self.liveQuery(things.workspaces.one, { workspace: session }, { first: 1 });
	return self.derive(
		[record, named, line],
		([
			{
				rows: [row],
			},
			{
				rows: [thing],
			},
			{
				rows: [placed],
			},
		]) =>
			row === undefined || thing === undefined || placed === undefined
				? null
				: { ...row, parent: placed.parent, title: thing.name },
	);
}

/** Fails the row of a session the server does not know (a held session object whose workspace went). */
function missing(session: string): never {
	throw new Error(`sessions: no session ${session}`);
}
