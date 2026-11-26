// A session's own facts for its worker (`SessionFacts`): its row, its things (linked, and from whom it follows) with
// the options the agent gets, its report of what the agent does, and the content it may make. The agent works for
// everyone who writes in its session, so it makes only content, owned by nobody (`creation: "content"`), and it never
// gives a thing an owner or sets options.

import { type FacetHost, forbidden, type P3Principal, SessionFacts } from "@earendil-works/p3/v1";
import { SessionsStore, ThingKinds } from "@earendil-works/p3/v1/server";
import { SessionHas } from "./follow.ts";
import { currentOptions, unset } from "./options.ts";
import { contentKinds, mustBeContent } from "./things.ts";

/** How many options of a session the facts read: more fail the member that shows them. */
const READ_WHOLE = 1000;

/** The agent as who linked a thing. */
const AGENT = { kind: "agent" } as const;

/** Serves `SessionFacts` on `host`. */
export function serveFacts(host: FacetHost<P3Principal>): void {
	host.serve(SessionFacts, (_params, principal, self) => {
		if (principal.kind !== "worker") throw forbidden("sessions: a session's worker only");
		const session = principal.session;
		const store = self.get(SessionsStore, {});
		const { session: row, things: has } = self.get(SessionHas, { session });
		const defaults = self.liveQuery(store.options.ofSession, { session, for: "everyone" }, { first: READ_WHOLE });
		const agent = self.liveQuery(store.options.ofSession, { session, for: "agent" }, { first: READ_WHOLE });
		const kinds = self.registry(ThingKinds);
		const things = self.derive([has, defaults, agent, kinds], ([of, everyone, own, table]) => {
			if (everyone.more || own.more) fail(`session ${session} has more than ${READ_WHOLE} options`);
			const stored = new Map([...everyone.rows, ...own.rows].map((row) => [row.thing, row]));
			return of.map(({ thing, kind, name }) => {
				const row = stored.get(thing);
				const entry = table.get(kind)?.value;
				// None set (a followed thing): its kind's initial. Nothing for options no installed kind reads now:
				// the harness gives such a thing nothing.
				const current = row === undefined ? unset(entry) : currentOptions(entry, row);
				if (current !== undefined) return { thing, kind, name, ...current };
				return { thing, kind, name, version: row?.version ?? 0, options: null };
			});
		});
		return {
			variant: "worker",
			members: {
				session: row,
				things,
				kinds: self.derive([kinds], ([table]) => contentKinds(table)),
				report: ({ state }, ctx) => store.report({ session, state }, ctx),
				create: async ({ kind, name }, ctx) => {
					mustBeContent(kinds.value, kind);
					const owner = { kind: "none" } as const;
					return store.createThing(
						{ kind, ...(name === undefined ? {} : { name }), owner, session, by: AGENT },
						ctx,
					);
				},
			},
		};
	});
}

/** Fails the member being computed: a read that cannot be shown whole. */
function fail(why: string): never {
	throw new Error(`sessions: ${why}`);
}
