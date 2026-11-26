// The sessions plugin on the server: the store of the sessions, their members and things (`store.ts`), the access
// answer every session object admits with (`access.ts`), the waker (`waker.ts`), what a session has, linked and from
// whom it follows (`follow.ts`), a session's things as its writers manage them and a person's own things
// (`things.ts`), a worker's facts (`facts.ts`) and its agent's things (`agent-things.ts`), and the objects of its
// other audiences: the owner's `Sessions` (what the owner adds is the owner's person's; a session they make follows
// them), a screen's `SessionsList` (the owner's every session of an app, a person's their memberships'), and a page's
// `SessionInfo`.

import {
	type Admission,
	type AdmitSelf,
	admitOwner,
	admitSession,
	allow,
	constant,
	defineFacet,
	deny,
	forbidden,
	forward,
	keyedEntries,
	type Member,
	type P3Principal,
	type Self,
	SessionInfo,
	type SessionRow,
	Sessions,
	SessionsList,
	type Watchable,
} from "@earendil-works/p3/v1";
import { PeopleStore, SessionsStore, ThingKinds } from "@earendil-works/p3/v1/server";
import { serveAccess } from "./access.ts";
import { serveAgentThings } from "./agent-things.ts";
import { serveFacts } from "./facts.ts";
import { SessionHas, serveHas } from "./follow.ts";
import { currentOptions, type StoredOptions, unset } from "./options.ts";
import { optionsForOf, serveStore } from "./store.ts";
import { mustBeContent, serveThings } from "./things.ts";
import { serveWaker } from "./waker.ts";

/** How many sessions a page of a list holds. */
const PAGE = 50;

/**
 * How many things, members and options of a session, and groups of a person, a view reads at most: read whole, a
 * session or a person with more fails the member that shows them (closed and visible, never a part of them).
 */
const READ_WHOLE = 1000;

export default defineFacet((host) => {
	serveStore(host);
	serveAccess(host);
	serveWaker(host);
	serveHas(host);
	serveThings(host);
	serveFacts(host);
	serveAgentThings(host);

	host.serve(ThingKinds, {
		compose: (table, { report }) => keyedEntries(table, (entry) => ({ [entry.kind.name]: entry }), report),
	});

	host.serve(
		Sessions,
		(_params, principal, _admitted, self) => {
			// Admitted as the owner: a person.
			if (principal.kind !== "person") throw forbidden("sessions: the owner's");
			const store = self.get(SessionsStore, {});
			const kinds = self.registry(ThingKinds);
			// What the owner adds is the owner's person's; a session they make follows them unless they say otherwise.
			const by = { kind: "person", id: principal.id } as const;
			return forward(store, Sessions, {
				create: ({ follows, ...args }, ctx) => {
					// A page makes content only, owned by nobody; other things are server code's (`SessionsStore`).
					for (const use of args.things ?? []) {
						if (use.use !== "new") continue;
						mustBeContent(kinds.value, use.kind);
						if (use.owner !== undefined && use.owner.kind !== "none") {
							throw forbidden("sessions: a session's new things belong to nobody");
						}
					}
					return store.create({ ...args, by, follows: follows === undefined ? by : follows }, ctx);
				},
				follow: (args, ctx) => store.follow({ ...args, by }, ctx),
			});
		},
		{ admit: admitOwner },
	);

	host.serve(
		SessionsList,
		({ app, set }, principal, { every }, self) => {
			const store = self.get(SessionsStore, {});
			if (every) {
				const list = self.list("sessions", [[store.sessions[set], { app }]], { first: PAGE });
				return { list: list.value, more: (ctx) => list.more(ctx) };
			}
			// Admitted: a person (`admitList`).
			if (principal.kind !== "person") throw forbidden("sessions: persons'");
			const person = principal.id;
			const groups = self.liveQuery(self.get(PeopleStore, {}).groups.ofPerson, { person }, { first: READ_WHOLE });
			// Their groups count only when read whole (fails closed: the list shows their direct memberships then).
			const args = self.derive([groups], ([{ rows, more }]) => ({
				app,
				members: [`person:${person}`, ...(more ? [] : rows.map(({ id }) => `group:${id}`))],
			}));
			const list = self.list("memberships", [[store.memberships[set], args]], { first: PAGE });
			return { list: onceEach(list.value, self), more: (ctx) => list.more(ctx) };
		},
		{ admit: admitList },
	);

	host.serve(
		SessionInfo,
		({ session }, _principal, { access }, self) => {
			const store = self.get(SessionsStore, {});
			// The session's row, and what it has: linked, and from whom it follows.
			const { session: found, things } = self.get(SessionHas, { session });
			// Every option set in the session (each thing's default and its overrides), read whole.
			const set = self.liveQuery(store.options.inSession, { session }, { first: READ_WHOLE });
			const members = self.liveQuery(store.members.of, { session }, { first: READ_WHOLE });
			const kinds = self.registry(ThingKinds);
			// The members' names, read by key and following the members: a rename shows, nothing walks the people.
			const people = self.get(PeopleStore, {});
			const idsOf = (kind: Member["kind"]) =>
				self.derive([members], ([{ rows }]) => rows.filter((m) => m.kind === kind).map(({ id }) => id));
			// Whom it follows (a person or a group), for its name.
			const followsOf = (kind: Member["kind"]) =>
				self.derive([found], ([row]) => (row?.follows?.kind === kind ? [row.follows.id] : []));
			// The persons and groups: the members, whom it follows, the things' owners and whoever linked a thing
			// (members or not).
			const personIds = self.derive(
				[idsOf("person"), followsOf("person"), things],
				([ofMembers, followed, rows]) => ({
					ids: unique([
						...ofMembers,
						...followed,
						...rows.flatMap(({ by, owner }) => [
							...(by.kind === "person" ? [by.id] : []),
							...(owner.kind === "person" ? [owner.id] : []),
						]),
					]),
				}),
			);
			const groupIds = self.derive([idsOf("group"), followsOf("group"), things], ([ofMembers, followed, rows]) => ({
				ids: unique([
					...ofMembers,
					...followed,
					...rows.flatMap(({ owner }) => (owner.kind === "group" ? [owner.id] : [])),
				]),
			}));
			const persons = self.liveQuery(people.persons.ofIds, personIds, { first: READ_WHOLE });
			const groups = self.liveQuery(people.groups.ofIds, groupIds, { first: READ_WHOLE });
			const names = self.derive([persons, groups], ([ofPersons, ofGroups]) =>
				namesOf(ofPersons.rows, ofGroups.rows),
			);
			return {
				// Admitted: the session exists (its access is none otherwise).
				session: self.derive([found], ([row]) => row ?? fail(`no session ${session}`)),
				access: constant(access),
				// One who left shows their id, as a member does.
				followsName: self.derive([found, names], ([row, named]) =>
					row === null || row.follows === null ? "" : nameOf(named, row.follows),
				),
				things: self.derive([things, set, kinds, names], ([of, written, table, named]) => {
					if (written.more) fail(`session ${session} has more than ${READ_WHOLE} options`);
					const byThing = Map.groupBy(written.rows, (row) => row.thing);
					return of.map(({ thing, kind, name, owner, by }) => {
						const entry = table.get(kind)?.value;
						const read = (row: StoredOptions) => currentOptions(entry, row)?.options ?? null;
						const rows = byThing.get(thing) ?? [];
						const everyone = rows.find((row) => row.for === "everyone");
						const overrides = rows
							.filter((row) => row.for !== "everyone")
							.map((row) => ({ for: optionsForOf(row.for), options: read(row) }));
						// The kind's title; its name while no plugin serves it.
						const title = entry?.title ?? kind;
						return {
							thing,
							kind,
							name,
							owner,
							// The owner's and the linker's names now; one who left shows their id.
							ownerName: owner.kind === "person" || owner.kind === "group" ? nameOf(named, owner) : "",
							by,
							byName: by.kind === "person" ? nameOf(named, by) : "",
							// None set (a followed thing): its kind's initial.
							options: everyone === undefined ? (unset(entry)?.options ?? null) : read(everyone),
							overrides,
							title,
						};
					});
				}),
				members: self.derive([members, persons, groups, names], ([{ rows, more }, ofPersons, ofGroups, named]) => {
					if (more || ofPersons.more || ofGroups.more)
						fail(`session ${session} has more than ${READ_WHOLE} members`);
					// A member whose person or group is gone (until its row goes too) shows its id.
					return rows.map((member) => ({ ...member, name: nameOf(named, member) }));
				}),
			};
		},
		{ admit: admitSession() },
	);
});

/**
 * `list` with each session once: a person in a session directly and through a group has two memberships of it, so
 * the memberships' list shows it twice, adjacent (same order columns). A loaded page may show fewer distinct
 * sessions than its size; `more` still reaches every one.
 */
function onceEach(
	list: Watchable<{ rows: SessionRow[]; moreAfter: boolean }>,
	self: Self<P3Principal>,
): Watchable<{ rows: SessionRow[]; moreAfter: boolean }> {
	return self.derive([list], ([{ rows, moreAfter }]) => {
		const seen = new Set<string>();
		return { rows: rows.filter(({ id }) => !seen.has(id) && seen.add(id) !== undefined), moreAfter };
	});
}

/** Each of `ids` once, in the order first met. */
function unique(ids: readonly string[]): string[] {
	return [...new Set(ids)];
}

/** The names of persons and groups by key (`person:<id>`, `group:<id>`). */
function namesOf(
	persons: readonly { readonly id: string; readonly name: string }[],
	groups: readonly { readonly id: string; readonly name: string }[],
): Record<string, string> {
	return Object.fromEntries([
		...persons.map(({ id, name }) => [`person:${id}`, name]),
		...groups.map(({ id, name }) => [`group:${id}`, name]),
	]);
}

/** The name of `party` in `names` (`namesOf`); its id while it has none (a person or group that is gone). */
function nameOf(
	names: Readonly<Record<string, string>>,
	party: { readonly kind: string; readonly id: string },
): string {
	return names[`${party.kind}:${party.id}`] ?? party.id;
}

/** Fails the member being computed: a read that cannot be shown whole. */
function fail(why: string): never {
	throw new Error(`sessions: ${why}`);
}

/**
 * The admission of `SessionsList`: a person's list, of every session of the app for the owner (their row's flag,
 * live), of their own for anyone else; the server and workers have no list.
 */
function admitList(
	_params: unknown,
	principal: P3Principal,
	self: AdmitSelf,
): Watchable<Admission<{ every: boolean }>> {
	if (principal.kind !== "person") return constant(deny("sessions: persons' lists"));
	const found = self.liveQuery(self.get(PeopleStore, {}).persons.one, { id: principal.id }, { first: 1 });
	// A person the Pi does not know (any more) is no member of anything: their list is empty.
	return self.derive([found], ([{ rows }]) => allow({ every: rows[0]?.owner === true }));
}
