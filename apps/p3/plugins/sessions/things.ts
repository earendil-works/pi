// Things as people manage them: `SessionThings`, a session's things for its writers (make content here, link an owned
// one, unlink, give an owner, rename, delete, set options; on what the session has, linked or from whom it follows),
// `MyThings`, the things a person manages outside sessions (their own, their groups', the Pi's for the owner; making
// a thing of a kind people make, "in all my sessions"), and `ThingUses`, the sessions a thing is in. Who manages a
// thing is one rule (`manages`): the owner any; a person their own and their groups'; the Pi's only the owner;
// nobody's any writer of a session that uses it. How a kind's things come to exist is the kind's (`creation`):
// content in sessions, a person's in My things, a plugin's in server code only. The store checks no caller: every
// check is here, read live (a person's owner flag and groups through liveQueries, the thing at the call).

import {
	type Admission,
	type AdmitSelf,
	admitSession,
	allow,
	type Ctx,
	constant,
	deny,
	type FacetHost,
	forbidden,
	invalid,
	MyThings,
	type P3Principal,
	SESSION_THINGS_WRITES,
	type Self,
	type SessionThing,
	SessionThings,
	type Thing,
	type ThingKeeper,
	type ThingOwner,
	ThingUses,
	type Watchable,
} from "@earendil-works/p3/v1";
import {
	PeopleStore,
	SessionsStore,
	type ThingCreation,
	type ThingKindEntry,
	ThingKinds,
} from "@earendil-works/p3/v1/server";
import { SessionHas } from "./follow.ts";
import { ownerKey } from "./store.ts";

/** How many of a person's groups are read: more fail closed (their groups give them nothing to manage or make for). */
const READ_WHOLE = 1000;

/** How many things or uses a page of a list holds. */
const PAGE = 50;

/** Serves `SessionThings`, `MyThings` and `ThingUses` on `host`. */
export function serveThings(host: FacetHost<P3Principal>): void {
	host.serve(
		SessionThings,
		({ session }, principal, _admitted, self) => {
			// A person (only persons read a session; a session's worker manages through `SessionFacts`); a reader is
			// granted none of it.
			if (principal.kind !== "person") throw forbidden("sessions: persons manage a session's things");
			const me = followPerson(principal.id, self);
			const store = self.get(SessionsStore, {});
			const by = { kind: "person", id: principal.id } as const;
			const kinds = self.registry(ThingKinds);
			// What the session has: linked, or from whom it follows (read at each call: it changes live).
			const has = self.get(SessionHas, { session }).things;
			/** Thing `thing`, which the session has and the caller manages (`forbidden` otherwise). */
			const ours = (thing: string): SessionThing => {
				const found = has.value.find((each) => each.thing === thing);
				if (found === undefined) throw invalid("args", `sessions: session ${session} has no thing ${thing}`);
				if (!manages(me.value(), found.owner, true)) throw forbidden("sessions: a thing someone else manages");
				return found;
			};
			return {
				kinds: () => self.derive([kinds], ([table]) => contentKinds(table)),
				owners: () => self.derive([me.watched], () => keepersOf(me.value())),
				create: async (thing, ctx) => {
					mustBeContent(kinds.value, thing.kind);
					return store.createThing({ ...thing, owner: NOBODY, session, by }, ctx);
				},
				add: async ({ thing, options }, ctx) => {
					const [found] = (await store.things.one.page({ id: thing }, 1, ctx)).items;
					if (found === undefined) throw invalid("args", `sessions: no thing ${thing}`);
					// What nobody owns stays with the sessions that use it: only its manager there links it on.
					if (!manages(me.value(), found.owner, false)) throw forbidden("sessions: a thing someone else manages");
					return store.addThing({ session, thing, by, ...(options === undefined ? {} : { options }) }, ctx);
				},
				remove: async ({ thing }, ctx) => {
					if (ours(thing).by.kind === "followed") {
						throw invalid("args", "sessions: it comes from whom the session follows");
					}
					return store.removeThing({ session, thing }, ctx);
				},
				keep: async ({ thing, owner }, ctx) => {
					ours(thing);
					mayKeepFor(me.value(), owner);
					return store.keepThing({ thing, owner }, ctx);
				},
				rename: async ({ thing, name }, ctx) => {
					ours(thing);
					return store.renameThing({ thing, name }, ctx);
				},
				delete: async ({ thing }, ctx) => {
					ours(thing);
					return store.deleteThing({ thing }, ctx);
				},
				setOptions: async (args, ctx) => {
					ours(args.thing);
					return store.setOptions({ session, ...args }, ctx);
				},
			};
		},
		{ admit: admitSession(SESSION_THINGS_WRITES) },
	);

	host.serve(MyThings, ({ prefix }, principal, self) => {
		if (principal.kind !== "person") throw forbidden("sessions: a person's things");
		const me = followPerson(principal.id, self);
		const store = self.get(SessionsStore, {});
		const kinds = self.registry(ThingKinds);
		const args = self.derive([me.watched], () => ({ owners: ownedBy(me.value()), prefix }));
		const list = self.list("things", [[store.things.owned, args]], { first: PAGE });
		/** Thing `thing`, which the caller manages (`forbidden` otherwise). */
		const managed = async (thing: string, ctx: Ctx<P3Principal>): Promise<Thing> => {
			const [found] = (await store.things.one.page({ id: thing }, 1, ctx)).items;
			if (found === undefined) throw invalid("args", `sessions: no thing ${thing}`);
			if (!manages(me.value(), found.owner, false)) throw forbidden("sessions: a thing someone else manages");
			return found;
		};
		return {
			// Each with its kind's title; the kind's name while no plugin serves it.
			list: self.derive([list.value, kinds], ([{ rows, moreAfter }, table]) => ({
				rows: rows.map((thing) => ({ ...thing, title: table.get(thing.kind)?.value.title ?? thing.kind })),
				moreAfter,
			})),
			kinds: self.derive([kinds], ([table]) => kindsOf(table, "person")),
			owners: self.derive([me.watched], () => keepersOf(me.value())),
			more: (ctx) => list.more(ctx),
			create: async ({ kind, owner, ...thing }, ctx) => {
				if (creationOf(kinds.value, kind) !== "person") {
					throw forbidden(`sessions: a thing of ${kind} is not made by a person`);
				}
				mayKeepFor(me.value(), owner);
				return store.createThing({ ...thing, kind, owner }, ctx);
			},
			setEverywhere: async ({ thing, everywhere }, ctx) => {
				await managed(thing, ctx);
				return store.setEverywhere({ thing, everywhere }, ctx);
			},
			rename: async ({ thing, name }, ctx) => {
				await managed(thing, ctx);
				return store.renameThing({ thing, name }, ctx);
			},
			keep: async ({ thing, owner }, ctx) => {
				await managed(thing, ctx);
				mayKeepFor(me.value(), owner);
				return store.keepThing({ thing, owner }, ctx);
			},
			delete: async ({ thing }, ctx) => {
				await managed(thing, ctx);
				return store.deleteThing({ thing }, ctx);
			},
		};
	});

	host.serve(
		ThingUses,
		({ thing }, _principal, _admitted, self) => {
			const list = self.list("uses", [[self.get(SessionsStore, {}).links.ofThing, { thing }]], { first: PAGE });
			const uses = self.derive([list.value], ([{ rows, moreAfter }]) => ({
				rows: rows.map(({ session, by }) => ({ session, by })),
				moreAfter,
			}));
			return { list: uses, more: (ctx) => list.more(ctx) };
		},
		{ admit: admitManager },
	);
}

/** A person as the rule needs them: their id, whether they are the owner, and the groups they are in (id, name). */
type Person = {
	readonly id: string;
	readonly name: string;
	readonly owner: boolean;
	readonly groups: readonly { readonly id: string; readonly name: string }[];
};

/** Person `id` followed live through `self`: `value()` now, and `watched`, which changes with it. */
function followPerson(id: string, self: Self<P3Principal> | AdmitSelf) {
	const people = self.get(PeopleStore, {});
	const row = self.liveQuery(people.persons.one, { id }, { first: 1 });
	const groups = self.liveQuery(people.groups.ofPerson, { person: id }, { first: READ_WHOLE });
	const watched = self.derive([row, groups], ([{ rows }, theirs]) => ({
		id,
		name: rows[0]?.name ?? id,
		owner: rows[0]?.owner === true,
		// Their groups count only when read whole (fails closed).
		groups: theirs.more ? [] : theirs.rows.map(({ id: group, name }) => ({ id: group, name })),
	}));
	return { watched, value: (): Person => watched.value };
}

/**
 * Whether `person` manages a thing of `owner`: the owner any; a person their own and their groups'; the Pi's only the
 * owner; nobody's any writer of a session that uses it (`linkedHere`: the caller writes a session it is linked to).
 */
function manages(person: Person, owner: ThingOwner, linkedHere: boolean): boolean {
	if (person.owner) return true;
	switch (owner.kind) {
		case "person":
			return owner.id === person.id;
		case "group":
			return person.groups.some(({ id }) => id === owner.id);
		case "pi":
			return false;
		case "none":
			return linkedHere;
	}
}

/** Throws (`forbidden`) unless `person` may give a thing (or make one) for `owner`: themselves, their groups, the Pi for the owner. */
function mayKeepFor(person: Person, owner: ThingKeeper): void {
	if (!keepersOf(person).some((choice) => ownerKey(choice.owner) === ownerKey(owner))) {
		throw forbidden("sessions: not whom you may give things");
	}
}

/** Whom `person` may give things (or make them for, in My things), with names: themselves, their groups, the Pi for the owner. */
function keepersOf(person: Person): { owner: ThingKeeper; name: string }[] {
	return [
		{ owner: { kind: "person", id: person.id }, name: person.name },
		...person.groups.map(({ id, name }) => ({ owner: { kind: "group", id } as const, name })),
		...(person.owner ? [{ owner: { kind: "pi" } as const, name: "" }] : []),
	];
}

/** The owners' keys whose things `person` manages outside sessions: themselves, their groups, the Pi for the owner. */
function ownedBy(person: Person): string[] {
	return [`person:${person.id}`, ...person.groups.map(({ id }) => `group:${id}`), ...(person.owner ? ["pi"] : [])];
}

/** The kinds of `table` whose things come to exist by `creation`, by title. */
function kindsOf(table: Kinds, creation: ThingCreation): { kind: string; title: string }[] {
	return [...table.values()]
		.filter(({ value }) => (value.creation ?? "plugin") === creation)
		.map(({ value }) => ({ kind: value.kind.name, title: value.title }))
		.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
}

/** The kinds of content (`creation: "content"`): the only ones made inside a session, by a writer or the agent. */
export function contentKinds(table: Kinds): { kind: string; title: string }[] {
	return kindsOf(table, "content");
}

/** How things of kind `kind` come to exist (`plugin` when it says nothing); `invalid` for a kind not installed. */
function creationOf(table: Kinds, kind: string): ThingCreation {
	const entry = table.get(kind)?.value;
	if (entry === undefined) throw invalid("args", `sessions: no kind of thing ${kind}`);
	return entry.creation ?? "plugin";
}

/** Throws (`forbidden`) unless `kind` is a kind of content: what a session's writers and its agent make there. */
export function mustBeContent(table: Kinds, kind: string): void {
	if (creationOf(table, kind) !== "content") throw forbidden(`sessions: a thing of ${kind} is not made in a session`);
}

/** The kinds of things, as `ThingKinds` composes them. */
type Kinds = ReadonlyMap<string, { readonly value: ThingKindEntry }>;

/** Nobody: whom a session's content belongs to. */
const NOBODY: ThingOwner = { kind: "none" };

/** The admission of `ThingUses`: allowed while the caller manages the thing (as `manages` decides outside sessions). */
function admitManager(
	params: { readonly thing: string },
	principal: P3Principal,
	self: AdmitSelf,
): Watchable<Admission<Record<string, never>>> {
	if (principal.kind !== "person") return constant(deny("sessions: a person's things"));
	const me = followPerson(principal.id, self);
	const found = self.liveQuery(self.get(SessionsStore, {}).things.one, { id: params.thing }, { first: 1 });
	return self.derive([me.watched, found], ([person, { rows }]) =>
		rows[0] !== undefined && manages(person, rows[0].owner, false) ? allow({}) : deny("sessions: not your thing"),
	);
}
