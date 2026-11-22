// The sessions plugin on the server: the store of the sessions, their members and things (`store.ts`), the access
// answer every session object admits with (`access.ts`), the waker (`waker.ts`), what writers bring of their own
// (`bring.ts`), and the objects of its audiences: the owner's `Sessions` (what the owner adds is the owner's), the
// kinds of things the owner may add (`ThingKindCatalog`, from `ThingKinds`, served here), a screen's `SessionsList`
// (the owner's every session of an app, a person's their memberships'), a page's `SessionInfo`, and each worker's
// `SessionFacts` (its row, its things with the agent's options, its report).

import {
	admitSession,
	constant,
	defineFacet,
	forbidden,
	forward,
	keyedEntries,
	type Member,
	type P3Principal,
	type Self,
	SessionFacts,
	SessionInfo,
	type SessionRow,
	Sessions,
	SessionsList,
	ThingKindCatalog,
	type Watchable,
} from "@earendil-works/p3/v1";
import { PeopleStore, SessionsStore, ThingKinds } from "@earendil-works/p3/v1/server";
import { serveAccess } from "./access.ts";
import { serveBring } from "./bring.ts";
import { currentOptions, type StoredOptions } from "./options.ts";
import { optionsForOf, serveStore } from "./store.ts";
import { serveWaker } from "./waker.ts";

/** How many sessions a page of a list holds. */
const PAGE = 50;

/**
 * How many things, members and options of a session, and groups of a person, a view reads at most: read whole, a
 * session or a person with more fails the member that shows them (closed and visible, never a part of them).
 */
const READ_WHOLE = 1000;

/** The owner as a bringer of things. */
const OWNER = { kind: "owner" } as const;

export default defineFacet((host) => {
	serveStore(host);
	serveAccess(host);
	serveWaker(host);
	serveBring(host);

	host.serve(ThingKinds, {
		compose: (table, { report }) => keyedEntries(table, (entry) => ({ [entry.kind.name]: entry }), report),
	});

	host.serve(ThingKindCatalog, (_params, principal, self) => {
		if (principal.kind !== "owner") throw forbidden("sessions: the owner's");
		const kinds = self.derive([self.registry(ThingKinds)], ([table]) =>
			// A kind with records is brought by whose records they are (`BringThings`), never added with `{ kind }`.
			[...table.values()]
				.filter(({ value }) => value.records === undefined)
				.map(({ value }) => ({ kind: value.kind.name, title: value.title }))
				.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)),
		);
		return { variant: "owner", members: { kinds } };
	});

	host.serve(Sessions, (_params, principal, self) => {
		if (principal.kind !== "owner") throw forbidden("sessions: the owner's");
		const store = self.get(SessionsStore, {});
		// What the owner adds is the owner's.
		return forward(store, Sessions, "owner", {
			create: (args, ctx) => store.create({ ...args, by: OWNER }, ctx),
			addThing: (args, ctx) => store.addThing({ ...args, by: OWNER }, ctx),
		});
	});

	host.serve(SessionsList, ({ app, set }, principal, self) => {
		const store = self.get(SessionsStore, {});
		if (principal.kind === "owner") {
			const list = self.list("sessions", [[store.sessions[set], { app }]], { first: PAGE });
			return { variant: "sessions", members: { list: list.value, more: (ctx) => list.more(ctx) } };
		}
		if (principal.kind !== "person") throw forbidden("sessions: the owner's and persons'");
		const person = principal.id;
		const groups = self.liveQuery(self.get(PeopleStore, {}).groups.ofPerson, { person }, { first: READ_WHOLE });
		// Their groups count only when read whole (fails closed: the list shows their direct memberships then).
		const args = self.derive([groups], ([{ rows, more }]) => ({
			app,
			members: [`person:${person}`, ...(more ? [] : rows.map(({ id }) => `group:${id}`))],
		}));
		const list = self.list("memberships", [[store.memberships[set], args]], { first: PAGE });
		return { variant: "sessions", members: { list: onceEach(list.value, self), more: (ctx) => list.more(ctx) } };
	});

	host.serve(
		SessionInfo,
		({ session }, _principal, { access }, self) => {
			const store = self.get(SessionsStore, {});
			const found = self.liveQuery(store.sessions.one, { id: session }, { first: 1 });
			const things = self.liveQuery(store.things.of, { session }, { first: READ_WHOLE });
			// Every option set in the session (each thing's default and its overrides), read whole.
			const set = self.liveQuery(store.options.inSession, { session }, { first: READ_WHOLE });
			const members = self.liveQuery(store.members.of, { session }, { first: READ_WHOLE });
			const kinds = self.registry(ThingKinds);
			// The members' names, read by key and following the members: a rename shows, nothing walks the people.
			const people = self.get(PeopleStore, {});
			const idsOf = (kind: Member["kind"]) =>
				self.derive([members], ([{ rows }]) => ({ ids: rows.filter((m) => m.kind === kind).map(({ id }) => id) }));
			const persons = self.liveQuery(people.persons.ofIds, idsOf("person"), { first: READ_WHOLE });
			const groups = self.liveQuery(people.groups.ofIds, idsOf("group"), { first: READ_WHOLE });
			return {
				variant: "info",
				members: {
					// Admitted: the session exists (its access is none otherwise).
					session: self.derive([found], ([{ rows }]) => rows[0] ?? fail(`no session ${session}`)),
					access: constant(access),
					things: self.derive([things, set, kinds], ([of, written, table]) => {
						if (of.more || written.more) fail(`session ${session} has more than ${READ_WHOLE} things or options`);
						const byThing = Map.groupBy(written.rows, (row) => row.thing);
						return of.rows.map(({ thing, kind, ref, by }) => {
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
								ref,
								by,
								options: everyone === undefined ? null : read(everyone),
								overrides,
								title,
							};
						});
					}),
					members: self.derive([members, persons, groups], ([{ rows, more }, ofPersons, ofGroups]) => {
						if (more) fail(`session ${session} has more than ${READ_WHOLE} members`);
						const names = new Map([
							...ofPersons.rows.map(({ id, name }) => [`person:${id}`, name] as const),
							...ofGroups.rows.map(({ id, name }) => [`group:${id}`, name] as const),
						]);
						// A member whose person or group is gone (until its row goes too) shows its id.
						return rows.map((member) => ({
							...member,
							name: names.get(`${member.kind}:${member.id}`) ?? member.id,
						}));
					}),
				},
			};
		},
		{ admit: admitSession },
	);

	host.serve(SessionFacts, (_params, principal, self) => {
		if (principal.kind !== "worker") throw forbidden("sessions: a session's worker only");
		const session = principal.session;
		const store = self.get(SessionsStore, {});
		const found = self.liveQuery(store.sessions.one, { id: session }, { first: 1 });
		const things = self.liveQuery(store.things.of, { session }, { first: READ_WHOLE });
		const defaults = self.liveQuery(store.options.ofSession, { session, for: "everyone" }, { first: READ_WHOLE });
		const agent = self.liveQuery(store.options.ofSession, { session, for: "agent" }, { first: READ_WHOLE });
		const kinds = self.registry(ThingKinds);
		const agentThings = self.derive([things, defaults, agent, kinds], ([of, everyone, own, table]) => {
			if (of.more || everyone.more || own.more) fail(`session ${session} has more than ${READ_WHOLE} things`);
			const stored = new Map([...everyone.rows, ...own.rows].map((row) => [row.thing, row]));
			return of.rows.map(({ thing, kind, ref }) => {
				const row = stored.get(thing)!;
				// Nothing for options no installed kind reads now: the harness gives such a thing nothing.
				const current = currentOptions(table.get(kind)?.value, row);
				return current === undefined
					? { thing, kind, ref, version: row.version, options: null }
					: { thing, kind, ref, ...current };
			});
		});
		return {
			variant: "worker",
			members: {
				session: self.derive([found], ([{ rows }]) => rows[0] ?? null),
				things: agentThings,
				report: ({ state }, ctx) => store.report({ session, state }, ctx),
			},
		};
	});
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

/** Fails the member being computed: a read that cannot be shown whole. */
function fail(why: string): never {
	throw new Error(`sessions: ${why}`);
}
