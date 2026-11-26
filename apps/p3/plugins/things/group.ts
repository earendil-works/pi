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
import { GroupPresence, ThingsStore } from "./contract.server.ts";
import { Group, partyKey, type Source } from "./contract.ts";
import { messages } from "./messages.ts";
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
const DENIED: Decision = deny("things: this group is not present for you", messages.message("notGiven"));

/** How many rows a caller's groups are read with: whole, or the admission fails closed (no group counts then). */
const EVERY = 10_000;

/** How many members one page of `members` holds. */
const PAGE = 100;

/** Serves `Group` on `host`, and `GroupPresence`, what its admission asks of a caller it is no member of. */
export function serveGroup(host: FacetHost<P3Principal>): void {
	host.serve(
		Group,
		({ group }, principal, _admitted, self) => {
			const store = self.get(ThingsStore, {});
			const info = self.liveQuery(store.groups.one, { group }, { first: 1 });
			const members = self.list("members", [[store.groupMembersNamed.ofGroup, { group }]], { first: PAGE });
			const managers = self.liveQuery(store.groupManagers.of, { group }, { first: EVERY });
			const by: Source = principal.kind === "person" ? { kind: "person", person: principal.id } : THINGS;
			return {
				info: self.derive([info], ([{ rows }]) => {
					const row = rows[0];
					return row === undefined
						? { group, name: "", outside: false, managedBy: { kind: "people" as const } }
						: { group: row.group, name: row.name, outside: row.outside, managedBy: row.managedBy };
				}),
				members: self.derive([members.value], ([{ rows, moreAfter }]) => ({
					rows: rows.map(({ person, name, source }) => ({ person, name, source })),
					moreAfter,
				})),
				more: (ctx) => members.more(ctx),
				managers: self.derive([managers], ([{ rows }]) => rows.map(({ party }) => party)),
				addMember: async ({ person }, ctx) => {
					// The picker's rule (R18): a person present where the caller is present (the owner: anyone). Server
					// code checks no caller.
					if (principal.kind === "person") {
						const party = { kind: "person", person } as const;
						if (!(await store.offers({ person: principal.id, party }, ctx))) {
							throw invalid("args", "things: this person is not present where you are", {
								message: messages.message("notOffered"),
							});
						}
					}
					await store.addToGroup({ group, person, source: by }, ctx);
					return null;
				},
				removeMember: ({ person }, ctx) => store.removeMember({ group, person }, ctx),
				rename: ({ name }, ctx) => store.renameGroup({ group, name }, ctx),
				setManagers: ({ parties }, ctx) => store.setGroupManagers({ group, parties }, ctx),
				remove: (ctx) => store.removeGroup({ group }, ctx),
			};
		},
		{ admit: admitGroup },
	);
	host.serve(GroupPresence, ({ group, person }, self) => {
		const store = self.get(ThingsStore, {});
		return {
			present: self.follow<boolean>(async (_observer, ctx) => ({
				value: await store.offers({ person, party: { kind: "group", group } }, ctx),
				detach: () => {},
			})),
		};
	});
}

/**
 * The group's admission: the server every call; a person every call with the group's own tick or the owner flag
 * (a group people manage only); its info and members as a member, a manager, an owner, or one the group is present
 * for; anyone else denied. Membership and the tick are keyed reads; the caller's groups are read whole, or no group
 * of theirs counts (fail closed).
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
	const me = self.liveQuery(store.persons.one, { person }, { first: 1 });
	const member = self.liveQuery(store.groupMembers.of, { group, person }, { first: 1 });
	const mine = self.liveQuery(store.groupMembers.ofPerson, { person }, { first: EVERY });
	const keys = self.derive([mine], ([{ rows, more }]) => ({
		group,
		partyKeys: [
			partyKey({ kind: "person", person }),
			...(more ? [] : rows.map(({ group: of }) => partyKey({ kind: "group", group: of }))),
		],
	}));
	const manages = self.liveQuery(store.groupManagers.among, keys, { first: 1 });
	const present = self.get(GroupPresence, { group, person }).present;
	return self.derive([row, me, member, manages, present], ([found, own, membership, tick, here]) => {
		const managedBy = found.rows[0]?.managedBy;
		if (managedBy === undefined) return DENIED;
		const manager = tick.rows.length > 0;
		const owner = own.rows[0]?.owner === true;
		if ((manager || owner) && managedBy.kind === "people") return MANAGES;
		return manager || owner || membership.rows.length > 0 || here ? SEES : DENIED;
	});
}
