// A group's object (`Group`, decision 68): held by its managers, its members and the owners; its info, members and
// managers live from the store; its calls granted by the group's own tick (`things.group-managers`: a person named,
// or a person in a group named) and by the owner flag, on a group people manage only. Adding a member asks the picker:
// only a person present where the caller is present can be added (scenario 18: Leo cannot add himself to a group
// with Manage access elsewhere unless he has the group's own tick).

import {
	type Admission,
	type AdmitSelf,
	allow,
	constant,
	deny,
	type FacetHost,
	type GrantableName,
	invalid,
	type P3Principal,
	type Watchable,
} from "@earendil-works/p3/v1";
import { ThingsStore } from "./contract.server.ts";
import { Group, partyKey, type Source } from "./contract.ts";
import { THINGS } from "./people.ts";

/** The calls the group's own tick gives. */
const CALLS = ["addMember", "removeMember", "rename", "setManagers", "remove"] as const;

/** What the group's admission decides: every call, none (its info and members only), or a denial. */
type Decision = Admission<{ readonly granted: GrantableName<typeof Group>[] }>;

/** A decision granting every call; one value, so an unchanged decision is the same. */
const MANAGES: Decision = allow({ granted: [...CALLS] });

/** A decision granting the group's info and members only. */
const SEES: Decision = allow({ granted: [] });

/** A denial for anyone the group is nothing to. */
const DENIED: Decision = deny("things: not a member or a manager of this group");

/** How many rows a set that decides access is read with: whole (a group's managers, a person's groups). */
const EVERY = 10_000;

/** Serves `Group` on `host`. */
export function serveGroup(host: FacetHost<P3Principal>): void {
	host.serve(
		Group,
		({ group }, principal, _admitted, self) => {
			const store = self.get(ThingsStore, {});
			const info = self.liveQuery(store.groups.one, { group }, { first: 1 });
			const members = self.liveQuery(store.groupMembersNamed.ofGroup, { group }, { first: EVERY });
			const managers = self.liveQuery(store.groupManagers.of, { group }, { first: EVERY });
			const by: Source = principal.kind === "person" ? { kind: "person", person: principal.id } : THINGS;
			return {
				info: self.derive([info], ([{ rows }]) => {
					const row = rows[0];
					return row === undefined
						? { group, name: "", outside: false, managedBy: { kind: "people" as const } }
						: { group: row.group, name: row.name, outside: row.outside, managedBy: row.managedBy };
				}),
				members: self.derive([members], ([{ rows }]) =>
					rows.map(({ person, name, source }) => ({ person, name, source })),
				),
				managers: self.derive([managers], ([{ rows }]) => rows.map(({ party }) => party)),
				addMember: async ({ person }, ctx) => {
					// The picker's rule (R18): a person present where the caller is present, or nobody.
					const caller = principal.kind === "person" ? principal.id : "";
					const offered = await store.offers(
						{ workspace: "", person: caller, party: { kind: "person", person } },
						ctx,
					);
					if (!offered) throw invalid("args", "things: this person is not present where you are");
					await store.addToGroup({ group, person, source: by }, ctx);
					return null;
				},
				removeMember: async ({ person }, ctx) => {
					for (const row of members.value.rows) {
						// A provider's and a share's rows are theirs to rewrite (they would come back): the rest goes.
						if (row.person === person && row.source.kind !== "identity" && row.source.kind !== "thing") {
							await store.removeFromGroup({ group, person, source: row.source }, ctx);
						}
					}
					return null;
				},
				rename: ({ name }, ctx) => store.renameGroup({ group, name }, ctx),
				setManagers: ({ parties }, ctx) => store.setGroupManagers({ group, parties }, ctx),
				remove: (ctx) => store.removeGroup({ group }, ctx),
			};
		},
		{ admit: admitGroup },
	);
}

/**
 * The group's admission: the server every call; a person every call with the group's own tick or the owner flag
 * (a group people manage only), its info and members as a member, a manager or an owner; anyone else denied.
 */
function admitGroup(
	{ group }: { readonly group: string },
	principal: P3Principal,
	self: AdmitSelf,
): Watchable<Decision> {
	if (principal.kind === "server") return constant(MANAGES);
	if (principal.kind !== "person") return constant(DENIED);
	const store = self.get(ThingsStore, {});
	const person = principal.id;
	const row = self.liveQuery(store.groups.one, { group }, { first: 1 });
	const managers = self.liveQuery(store.groupManagers.of, { group }, { first: EVERY });
	const mine = self.liveQuery(store.groupMembers.ofPerson, { person }, { first: EVERY });
	const me = self.liveQuery(store.persons.one, { person }, { first: 1 });
	return self.derive([row, managers, mine, me], ([found, named, memberships, own]) => {
		const managedBy = found.rows[0]?.managedBy;
		if (managedBy === undefined) return DENIED;
		const parties = new Set([partyKey({ kind: "person", person })]);
		for (const { group: of } of memberships.rows) parties.add(partyKey({ kind: "group", group: of }));
		const manager = named.rows.some(({ party }) => parties.has(partyKey(party)));
		const owner = own.rows[0]?.owner === true;
		if ((manager || owner) && managedBy.kind === "people") return MANAGES;
		const member = memberships.rows.some((membership) => membership.group === group);
		return manager || owner || member ? SEES : DENIED;
	});
}
