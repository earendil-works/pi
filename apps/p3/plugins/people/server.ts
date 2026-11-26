// The people plugin on the server: the persons and groups (`PeopleStore`, three tables), who the caller is (`Me`),
// the owner's persons (`People`, `PeopleList`) and the invite links that make a person and sign their first browser in
// (`invites.ts`). Removing a person removes them from every group and ends their sign-ins at once.

import {
	and,
	type Ctx,
	callerKey,
	constant,
	contribute,
	defineColumns,
	defineFacet,
	defineTable,
	eq,
	forbidden,
	inArray,
	int,
	invalid,
	query,
	str,
	type Tx,
} from "@earendil-works/p3/v1";
import { ServerRuntime } from "@earendil-works/p3/v1/server";
import { SignIns } from "../sign-in/contract.ts";
import { type OwnerSeed, OwnerSeeds } from "../things/contract.server.ts";
import { PeopleStore } from "./contract.server.ts";
import { admitOwner, Me, OwnerAccess, People, PeopleList } from "./contract.ts";
import { Invites, serveInviteRoutes } from "./invites.ts";

/** The persons' columns, a set so a group's members can be joined with their person. */
const PersonColumns = defineColumns("people.person-columns", {
	// `owner`: 1 for the owner's person, else 0 (an index column, so an int).
	columns: { id: str(), name: str(), owner: int() },
	key: ["id"],
});

/** Every person, by id; by name for the owner's list; by the owner flag for the owner's person. */
const Persons = defineTable("people.persons", {
	version: 1,
	columns: { ...PersonColumns.columns },
	key: ["id"],
	indexes: { by_name: ["name"], by_owner: ["owner"] },
	exposes: PersonColumns,
});

/** The groups' columns, a set so a person's memberships can be joined with their group. */
const GroupColumns = defineColumns("people.group-columns", {
	columns: { id: str(), app: str(), name: str() },
	key: ["id"],
});

/** Every group, by id; by app and name for an app's list and for `group`'s lookup. */
const Groups = defineTable("people.groups", {
	version: 1,
	columns: { ...GroupColumns.columns },
	key: ["id"],
	indexes: { of_app: ["app", "name"] },
	exposes: GroupColumns,
});

/** Who is in which group: one row per group and person; by person for their groups. */
const GroupMembers = defineTable("people.group-members", {
	version: 1,
	columns: { group: str(), person: str() },
	key: ["group", "person"],
	indexes: { of_person: ["person"] },
});

/** How many persons a page of the owner's list holds. */
const PAGE = 50;

export default defineFacet((host) => {
	// Facet-wide: the routes' object and `People` share them; a reload of the plugin drops the open invites.
	const invites = new Invites();

	host.serve(PeopleStore, (_params, self) => {
		const persons = self.table(Persons);
		const groups = self.table(Groups);
		const members = self.table(GroupMembers);
		/** Throws unless person `id` exists, as `tx` sees it. */
		const personMustExist = async (tx: Tx, id: string) => {
			if ((await tx.get(persons, { id })) === undefined) throw invalid("args", `people: no person ${id}`);
		};
		const runtime = self.registry(ServerRuntime);
		// Opened before the store goes live: from the first start on, the owner's person exists, once.
		// The owner's person handed to the things plugin, which makes the same person its owner: a bridge until this
		// plugin goes (ERNDL-1144 push B removes it, and this). Contributed by this object itself, so a reload ends it
		// with the object, never as a failure.
		const seed = self.writable<OwnerSeed>(null);
		self.contribute(OwnerSeeds, seed);
		self.open(
			async (ctx) => {
				const found = await self.tx(async (tx) => {
					const owner = query(Persons).where((p) => eq(p.owner, 1));
					const [row] = (await tx.page(persons, owner, 1)).items;
					if (row !== undefined) return row;
					const made = { id: crypto.randomUUID(), name: ownerName(runtime.value.machine.user), owner: 1 };
					tx.put(persons, made);
					return made;
				}, ctx);
				seed.set({ person: found.id, name: found.name });
				return null;
			},
			() => {},
		);
		const removePerson = ({ person }: { readonly person: string }, ctx: Ctx) =>
			self.tx(async (tx) => {
				const found = await tx.get(persons, { id: person });
				if (found === undefined) throw invalid("args", `people: no person ${person}`);
				if (found.owner === 1) throw invalid("args", "people: the owner's person is never removed");
				tx.delete(persons, { id: person });
				// Index `of_person`: every group of theirs, no cap (a membership left over would grant access).
				for await (const row of tx.rows(
					members,
					query(GroupMembers).where((m) => eq(m.person, person)),
				)) {
					tx.delete(members, { group: row.group, person });
				}
				return null;
			}, ctx);
		return {
			persons: self.queries(
				persons,
				{ map: ({ id, name, owner }) => ({ id, name, owner: owner === 1 }) },
				{
					// Index `by_name`, then the key.
					all: (_args: Record<never, never>) => query(Persons).orderBy((p) => p.name, "asc"),
					// The key.
					one: ({ id }: { id: string }) => query(Persons).where((p) => eq(p.id, id)),
					// Index `by_owner`: the one person whose flag is set.
					owner: (_args: Record<never, never>) => query(Persons).where((p) => eq(p.owner, 1)),
					// The key: each of `ids`, in the key's order.
					ofIds: ({ ids }: { ids: string[] }) => query(Persons).where((p) => inArray(p.id, ids)),
				},
			),
			// Two tables serve the groups' queries: the groups' own, and the memberships driving a person's.
			groups: {
				...self.queries(
					groups,
					{ map: (row) => row },
					{
						// Index `of_app`: `app` fixed, in the order of `name`, then the key.
						ofApp: ({ app }: { app: string }) =>
							query(Groups)
								.where((g) => eq(g.app, app))
								.orderBy((g) => g.name, "asc"),
						// The key.
						one: ({ id }: { id: string }) => query(Groups).where((g) => eq(g.id, id)),
						// The key: each of `ids`, in the key's order.
						ofIds: ({ ids }: { ids: string[] }) => query(Groups).where((g) => inArray(g.id, ids)),
					},
				),
				...self.queries(
					members,
					{
						map: (_row, group) => ({
							id: group.id as string,
							app: group.app as string,
							name: group.name as string,
						}),
						reads: [],
					},
					{
						// Index `of_person`: `person` fixed, in the order of `group` (the key's rest), each row joined
						// with its group by the group's key.
						ofPerson: ({ person }: { person: string }) =>
							query(GroupMembers)
								.where((m) => eq(m.person, person))
								.join(GroupColumns, (m) => ({ id: m.group }))
								.orderBy((m) => m.group, "asc"),
					},
				),
			},
			members: self.queries(
				members,
				{
					map: (_row, person) => ({
						id: person.id as string,
						name: person.name as string,
						owner: person.owner === 1,
					}),
					reads: [],
				},
				{
					// The key's prefix `group`, each row joined with its person by the person's key. Ordered by the
					// person's name, a column of the partner: SQLite sorts the group's rows.
					of: ({ group }: { group: string }) =>
						query(GroupMembers)
							.where((m) => eq(m.group, group))
							.join(PersonColumns, (m) => ({ id: m.person }))
							.orderBy((_m, person) => person.name, "asc"),
				},
			),
			createPerson: async ({ name }, ctx) => {
				const id = crypto.randomUUID();
				await self.tx(async (tx) => tx.put(persons, { id, name, owner: 0 }), ctx);
				return id;
			},
			renamePerson: ({ person, name }, ctx) =>
				self.tx(async (tx) => {
					await personMustExist(tx, person);
					tx.update(persons, { id: person }, { name });
					return null;
				}, ctx),
			removePerson: async (args, ctx) => {
				await removePerson(args, ctx);
				invites.drop(args.person);
				// Their sign-ins end with them: each one's open links close at once.
				const signIns = await ctx.get(SignIns, {});
				for (const signIn of signIns.list.value) {
					if (signIn.principal.kind === "person" && signIn.principal.id === args.person) {
						await signIns.revoke(signIn.id, ctx);
					}
				}
				return null;
			},
			group: ({ app, name }, ctx) =>
				self.tx(async (tx) => {
					// Index `of_app`: at most one group per app and name.
					const found = await tx.page(
						groups,
						query(Groups).where((g) => and(eq(g.app, app), eq(g.name, name))),
						1,
					);
					const existing = found.items[0];
					if (existing !== undefined) return existing.id;
					const id = crypto.randomUUID();
					tx.put(groups, { id, app, name });
					return id;
				}, ctx),
			addToGroup: ({ group, person }, ctx) =>
				self.tx(async (tx) => {
					if ((await tx.get(groups, { id: group })) === undefined)
						throw invalid("args", `people: no group ${group}`);
					await personMustExist(tx, person);
					tx.put(members, { group, person });
					return null;
				}, ctx),
			removeFromGroup: ({ group, person }, ctx) =>
				self.tx(async (tx) => {
					tx.delete(members, { group, person });
					return null;
				}, ctx),
		};
	});

	host.serve(Me, (_params, principal, self) => {
		if (principal.kind === "worker") {
			return { me: constant({ kind: "agent", session: principal.session }) };
		}
		if (principal.kind !== "person") throw forbidden("people: persons' and agents'");
		const found = self.liveQuery(self.get(PeopleStore, {}).persons.one, { id: principal.id }, { first: 1 });
		const { id, name } = principal;
		// Their name and owner flag now; the sign-in's name, and no owner, while the person is gone (their sign-ins end
		// with them).
		const me = self.derive(
			[found],
			([
				{
					rows: [row],
				},
			]) => ({
				kind: "person" as const,
				id,
				name: row?.name ?? name,
				owner: row?.owner ?? false,
			}),
		);
		return { me };
	});

	host.serve(OwnerAccess, ({ caller }, principal, self) => {
		// The server and workers ask about anyone, anyone else about themselves only.
		const asker = callerKey(principal);
		if (asker !== "server" && !asker.startsWith("worker:") && asker !== caller) {
			throw forbidden("people: an answer about the caller only");
		}
		if (!caller.startsWith("person:")) return { owner: constant(false) };
		const store = self.get(PeopleStore, {});
		const found = self.liveQuery(store.persons.one, { id: caller.slice("person:".length) }, { first: 1 });
		return { owner: self.derive([found], ([{ rows }]) => rows[0]?.owner === true) };
	});

	host.serve(
		People,
		(_params, _principal, _admitted, self) => {
			const store = self.get(PeopleStore, {});
			/** A fresh invite link of person `person`, which must exist and not be the owner (who has the owner link). */
			const link = async ({ person }: { readonly person: string }, ctx: Ctx): Promise<string> => {
				const [found] = (await store.persons.one.page({ id: person }, 1, ctx)).items;
				if (found === undefined) throw invalid("args", `people: no person ${person}`);
				if (found.owner) throw invalid("args", "people: the owner signs in with the owner link");
				return invites.renew(person);
			};
			return {
				invite: async ({ name }, ctx) => {
					const person = await store.createPerson({ name }, ctx);
					return { person, link: await link({ person }, ctx) };
				},
				link,
				rename: ({ person, name }, ctx) => store.renamePerson({ person, name }, ctx),
				remove: ({ person }, ctx) => store.removePerson({ person }, ctx),
			};
		},
		{ admit: admitOwner },
	);

	host.serve(
		PeopleList,
		(_params, _principal, _admitted, self) => {
			const list = self.list("people", [[self.get(PeopleStore, {}).persons.all, {}]], { first: PAGE });
			return { list: list.value, more: (ctx) => list.more(ctx) };
		},
		{ admit: admitOwner },
	);

	serveInviteRoutes(host, invites);
	// Holds the store from the start, so its owner reaches the things plugin before anyone asks for a person (the
	// bridge, ERNDL-1144 push B removes it).
	contribute(host, "people.owner-seed", (self) => void self.get(PeopleStore, {}));
});

/** The owner's person's first name: their OS user's (`user`), capitalised (the owner renames it later). */
function ownerName(user: string): string {
	return user === "" ? "Owner" : `${user[0]!.toUpperCase()}${user.slice(1)}`;
}
