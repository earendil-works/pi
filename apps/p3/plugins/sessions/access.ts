// Who may work in a session, and which options apply to them: the sessions plugin's answer, the one every session
// object's admission reads (`SessionAccess`, `ThingAccess`). One `SessionStanding` per session and caller holds what
// both derive from: the caller's access and whose options apply to them, in order. Everything is live: a member
// removed, a person leaving a group, an archive, a person removed change the answer in the commit's flush.

import {
	type Access,
	arr,
	callerKey,
	constant,
	type FacetHost,
	forbidden,
	type JsonValue,
	lit,
	local,
	obj,
	oneOf,
	type P3Principal,
	type Self,
	SessionAccess,
	str,
	ThingAccess,
	union,
	type Watchable,
} from "@earendil-works/p3/v1";
import { PeopleStore, SessionsStore, ThingKinds } from "@earendil-works/p3/v1/server";
import { type CurrentOptions, currentOptions } from "./options.ts";
import { keyOf } from "./store.ts";

/**
 * Caller `caller`'s standing in session `session`: none, or their access and whose options apply to them, first
 * first (`person:<id>`, their groups in the session's member order, `agent`, then `everyone`).
 */
const SessionStanding = local("sessions.standing", {
	version: 1,
	params: { session: str(), caller: str() },
	members: {
		standing: union([obj({ access: lit("none") }), obj({ access: oneOf("read", "write"), options: arr(str()) })]),
	},
});

/**
 * How many of a person's groups, and of a session's members and of a thing's options, a standing reads at most. A
 * set that decides access is read whole: one with more rows fails closed (a person's groups grant nothing, a session
 * with more members admits no person, a thing with more options gives nobody any).
 */
const READ_WHOLE = 1000;

/** Serves `SessionStanding`, `SessionAccess` and `ThingAccess` on `host`. */
export function serveAccess(host: FacetHost<P3Principal>): void {
	host.serve(SessionStanding, ({ session, caller }, self) => ({ standing: standingOf(session, caller, self) }));

	host.serve(SessionAccess, ({ session, caller }, principal, self) => {
		mayAsk(principal, session, caller);
		const { standing } = self.get(SessionStanding, { session, caller });
		return { variant: "answer", members: { access: self.derive([standing], ([found]) => found.access) } };
	});

	host.serve(ThingAccess, ({ session, thing, caller }, principal, self) => {
		mayAsk(principal, session, caller);
		const { standing } = self.get(SessionStanding, { session, caller });
		const store = self.get(SessionsStore, {});
		const found = self.liveQuery(store.things.one, { session, thing }, { first: 1 });
		const set = self.liveQuery(store.options.of, { session, thing }, { first: READ_WHOLE });
		const kinds = self.registry(ThingKinds);
		const answer = self.derive(
			[standing, found, set, kinds],
			([
				theirs,
				{
					rows: [row],
				},
				written,
				table,
			]) => {
				if (theirs.access === "none" || row === undefined || written.more) return { access: "none" as const };
				const by = new Map(written.rows.map((options) => [options.for, options]));
				// Every thing has its `everyone` options, and `everyone` ends every standing's list.
				const applies = by.get(theirs.options.find((key) => by.has(key))!)!;
				// Options stored at another version stay as stored (JSON, as written) when no migration reads them:
				// `admitThing` then denies.
				const answered: CurrentOptions = currentOptions(table.get(row.kind)?.value, applies) ?? {
					version: applies.version,
					options: applies.options as JsonValue,
				};
				return { access: theirs.access, kind: row.kind, ref: row.ref, ...answered };
			},
		);
		return { variant: "answer", members: { answer } };
	});
}

/**
 * Refuses `principal` an answer about `caller` in `session` (`forbidden`): the server asks about anyone, a worker
 * about anyone in its own session (its objects' admissions ask for their callers), anyone else about themselves.
 */
function mayAsk(principal: P3Principal, session: string, caller: string): void {
	if (principal.kind === "server") return;
	if (principal.kind === "worker" ? principal.session === session : callerKey(principal) === caller) return;
	throw forbidden("sessions: an answer about the caller only");
}

/** The standing of `caller` in `session`, read live through `self`. */
function standingOf(session: string, caller: string, self: Self<P3Principal>): Watchable<Standing> {
	const store = self.get(SessionsStore, {});
	const found = self.liveQuery(store.sessions.one, { id: session }, { first: 1 });
	if (caller === "owner" || caller === "server") {
		return self.derive(
			[found],
			([
				{
					rows: [row],
				},
			]) =>
				// The server's waker reaches no archived session; the owner reaches every session.
				row === undefined || (caller === "server" && row.archivedAt !== null) ? NONE : EVERYONE_WRITES,
		);
	}
	if (caller === `worker:${session}`) return constant(AGENT);
	if (!caller.startsWith("person:")) return constant(NONE);
	const person = caller.slice("person:".length);
	const people = self.get(PeopleStore, {});
	const persons = self.liveQuery(people.persons.one, { id: person }, { first: 1 });
	const groups = self.liveQuery(people.groups.ofPerson, { person }, { first: READ_WHOLE });
	const members = self.liveQuery(store.members.of, { session }, { first: READ_WHOLE });
	return self.derive(
		[found, persons, groups, members],
		([
			{
				rows: [row],
			},
			them,
			theirs,
			all,
		]) => {
			if (row === undefined || row.archivedAt !== null || them.rows.length === 0 || all.more) return NONE;
			const own = new Set([caller, ...(theirs.more ? [] : theirs.rows.map(({ id }) => `group:${id}`))]);
			const matching = all.rows.filter((member) => own.has(keyOf(member)));
			if (matching.length === 0) return NONE;
			const access: Access = matching.some((member) => member.access === "write") ? "write" : "read";
			const groupsInOrder = matching.filter(({ kind }) => kind === "group").map(keyOf);
			return { access, options: [caller, ...groupsInOrder, "everyone"] } satisfies Standing;
		},
	);
}

/** A caller's standing in a session (see `SessionStanding`). */
type Standing = { access: "none" } | { access: Access; options: string[] };

/** No access. */
const NONE: Standing = { access: "none" };

/** The owner's and the server's standing: write, the session's default options. */
const EVERYONE_WRITES: Standing = { access: "write", options: ["everyone"] };

/** A session's own worker: write, the agent's options, else the default. */
const AGENT: Standing = { access: "write", options: ["agent", "everyone"] };
