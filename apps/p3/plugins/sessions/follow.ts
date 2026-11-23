// What a session has: its links, and the things it has from whom it follows. A session that follows a person or a
// group has, live, every thing of that party that is "in all my sessions" (`everywhere`; a person who is the owner
// brings the Pi's too), while that party writes in the session: the owner writes every session (an archived one
// too), a person or a group through a write membership. One `SessionHas` per session holds it with the session's
// row, so every reader of a session's things (its info, its worker's facts, the thing access answer, its writers'
// things) reads them once. A thing both linked and followed counts once, as linked.

import {
	arr,
	type FacetHost,
	local,
	type Member,
	nul,
	type P3Principal,
	type Party,
	SessionRow,
	SessionThing,
	str,
	union,
} from "@earendil-works/p3/v1";
import { PeopleStore, SessionsStore } from "@earendil-works/p3/v1/server";

/** Session `session`'s row (`null`: none), and its things: its links in their order, then what it has from whom it follows. */
export const SessionHas = local("sessions.has", {
	version: 1,
	params: { session: str() },
	members: { session: union([SessionRow, nul()]), things: arr(SessionThing) },
});

/** How many of a session's links, members and followed things, and a person's groups, are read: more fail closed. */
const READ_WHOLE = 1000;

/** Serves `SessionHas` on `host`. */
export function serveHas(host: FacetHost<P3Principal>): void {
	host.serve(SessionHas, ({ session }, self) => {
		const store = self.get(SessionsStore, {});
		const people = self.get(PeopleStore, {});
		const found = self.liveQuery(store.sessions.one, { id: session }, { first: 1 });
		const links = self.liveQuery(store.links.of, { session }, { first: READ_WHOLE });
		const members = self.liveQuery(store.members.of, { session }, { first: READ_WHOLE });
		// The followed person (none for a group or nobody): their owner flag and their groups, following the row.
		const person = self.derive([found], ([{ rows }]) => {
			const follows = rows[0]?.follows;
			return follows?.kind === "person" ? follows.id : "";
		});
		const who = self.liveQuery(
			people.persons.one,
			self.derive([person], ([id]) => ({ id })),
			{ first: 1 },
		);
		const groups = self.liveQuery(
			people.groups.ofPerson,
			self.derive([person], ([id]) => ({ person: id })),
			{ first: READ_WHOLE },
		);
		const owners = self.derive([found, who, groups, members], ([{ rows }, them, theirs, all]) => {
			const row = rows[0];
			if (row === undefined || all.more) return { owners: [] as string[] };
			return {
				owners: followedOwners(row.follows, {
					archived: row.archivedAt !== null,
					isOwner: them.rows[0]?.owner === true,
					// Their groups count only when read whole (fails closed).
					groups: theirs.more ? [] : theirs.rows.map(({ id }) => id),
					members: all.rows,
				}),
			};
		});
		const followed = self.liveQuery(store.things.everywhere, owners, { first: READ_WHOLE });
		const things = self.derive([links, followed], ([linked, from]) => {
			if (linked.more || from.more)
				throw new Error(`sessions: session ${session} has more than ${READ_WHOLE} things`);
			const ids = new Set(linked.rows.map(({ thing }) => thing));
			return [
				...linked.rows,
				...from.rows
					.filter(({ id }) => !ids.has(id))
					.map(({ id, kind, name, owner }) => ({ session, thing: id, kind, name, owner, by: FOLLOWED })),
			];
		});
		return { session: self.derive([found], ([{ rows }]) => rows[0] ?? null), things };
	});
}

/** How a followed thing is the session's. */
const FOLLOWED = { kind: "followed" } as const;

/**
 * The owners' keys (`person:<id>`, `group:<id>`, `pi`) whose "in all my sessions" things a session following `party`
 * has: none while the party does not write in it. A person who is the owner writes every session and brings the Pi's
 * things too; another person writes as a write membership says (theirs, or a group's of theirs: `groups`), never in
 * an archived session; a group through a write membership of its own.
 */
export function followedOwners(
	party: Party | null,
	session: {
		readonly archived: boolean;
		readonly isOwner: boolean;
		readonly groups: readonly string[];
		readonly members: readonly Member[];
	},
): string[] {
	if (party === null) return [];
	const writes = (key: string) =>
		session.members.some((member) => member.access === "write" && `${member.kind}:${member.id}` === key);
	const key = `${party.kind}:${party.id}`;
	if (party.kind === "group") return !session.archived && writes(key) ? [key] : [];
	if (session.isOwner) return [key, "pi"];
	if (session.archived) return [];
	return writes(key) || session.groups.some((group) => writes(`group:${group}`)) ? [key] : [];
}
