// What the Manage people picker offers (decision 110, R18): the parties present in the workspace it is used in, and in
// every workspace where the caller is present, inheritance and hides included (read through the access index), never
// the whole directory but to the owner. Anyone else comes by an invite link. Persons, groups and named agents: everyone
// here and the agents are no one to put in.

import type { Context, Reference } from "@earendil-works/p3/v1";
import type { Offered } from "./access.ts";
import type { ThingsStore } from "./contract.server.ts";
import { type Caller, type Party, partyKey, partyOf } from "./contract.ts";
import { type Read, readAll } from "./reader.ts";

/** What the picker reads of the store. */
export type PickerReads = Pick<Read, "groupMembers" | "workspaceMembers" | "workspaces"> & {
	readonly persons: Reference<typeof ThingsStore>["persons"];
	readonly groups: Reference<typeof ThingsStore>["groups"];
};

/**
 * The party keys of the persons, groups and named agents `caller` is offered in `workspace` (none given: a group's
 * page): an owner every person and group (an owner skips presence, decision 78); anyone else what is present in the
 * workspace and in every workspace they are present in (`whereFrom`).
 */
export async function offeredTo(
	q: PickerReads,
	offered: Offered,
	{ workspace, caller }: { readonly workspace?: string; readonly caller: Caller },
	context: Context,
): Promise<ReadonlySet<string>> {
	if (caller.kind === "person" && (await isOwner(q, caller.person, context))) return everyone(q, context);
	const at = await whereFrom(q, caller, context);
	const parties = new Set<string>();
	for (const party of await offered(workspace, at, caller, context)) if (NAMED.test(party)) parties.add(party);
	return parties;
}

/**
 * Whether the picker offers `caller` the party `party` in `workspace`: an owner anyone who exists (read by key), anyone
 * else as `offeredTo` says. What `putParty` and `addMember` check, in the operation of their write.
 */
export async function offers(
	q: PickerReads,
	offered: Offered,
	{ workspace, caller, party }: { readonly workspace?: string; readonly caller: Caller; readonly party: Party },
	context: Context,
): Promise<boolean> {
	if (caller.kind === "person" && (await isOwner(q, caller.person, context))) {
		switch (party.kind) {
			case "person":
				return (await q.persons.one.page({ person: party.person }, 1, context)).items.length > 0;
			case "group":
				return (await q.groups.one.page({ group: party.group }, 1, context)).items.length > 0;
			default:
				return true;
		}
	}
	return (await offeredTo(q, offered, { ...(workspace === undefined ? {} : { workspace }), caller }, context)).has(
		partyKey(party),
	);
}

/**
 * The workspaces `caller` may be present in: those a party of theirs is put in (their person and groups, or their
 * agent) and every one below them, where presence comes down unless a switch hides it (decision 106). The index then
 * keeps those where they count as present.
 */
export async function whereFrom(q: PickerReads, caller: Caller, context: Context): Promise<ReadonlySet<string>> {
	const keys: string[] = [];
	if (caller.kind === "person") {
		keys.push(partyKey({ kind: "person", person: caller.person }));
		for (const { group } of await readAll(q.groupMembers.ofPerson, { person: caller.person }, context)) {
			keys.push(partyKey({ kind: "group", group }));
		}
	} else if (caller.kind === "agent") keys.push(partyKey({ kind: "agent", session: caller.session }));
	const candidates = new Set<string>();
	for (const key of keys) {
		for (const entry of await readAll(q.workspaceMembers.where, { partyKey: key }, context)) {
			candidates.add(entry.workspace);
		}
	}
	for (const at of [...candidates]) {
		const [row] = (await q.workspaces.one.page({ workspace: at }, 1, context)).items;
		if (row === undefined) continue;
		for (const below of await readAll(q.workspaces.under, { pathPrefix: row.pathText }, context)) {
			candidates.add(below.workspace);
		}
	}
	return candidates;
}

/** The party keys the picker offers: persons, groups, named agents (never everyone here or the agents). */
const NAMED = /^(person|group|agent)\//;

/** Whether person `person` has the owner flag. */
async function isOwner(q: PickerReads, person: string, context: Context): Promise<boolean> {
	return (await q.persons.one.page({ person }, 1, context)).items[0]?.owner === true;
}

/** Every person and group (what the owner is offered). */
async function everyone(
	q: {
		readonly persons: Reference<typeof ThingsStore>["persons"];
		readonly groups: Reference<typeof ThingsStore>["groups"];
	},
	context: Context,
): Promise<ReadonlySet<string>> {
	const offered = new Set<string>();
	for (const { person } of await readAll(q.persons.all, {}, context))
		offered.add(partyKey({ kind: "person", person }));
	for (const { group } of await readAll(q.groups.all, {}, context)) offered.add(partyKey({ kind: "group", group }));
	return offered;
}

/**
 * The persons, groups and named agents of `offered` (party keys) whose name has `text` in it (any case), with their
 * names (an agent's: its session's), by name.
 */
export async function namesOf(
	q: Pick<Read, "persons"> & {
		readonly groups: Reference<typeof ThingsStore>["groups"];
		readonly things: Reference<typeof ThingsStore>["things"];
	},
	offered: ReadonlySet<string>,
	text: string,
	context: Context,
): Promise<{ party: Party; name: string }[]> {
	const persons: string[] = [];
	const groups: string[] = [];
	const sessions: string[] = [];
	for (const key of offered) {
		const party = partyOf(key);
		if (party.kind === "person") persons.push(party.person);
		else if (party.kind === "group") groups.push(party.group);
		else if (party.kind === "agent") sessions.push(party.session);
	}
	const found: { party: Party; name: string }[] = [];
	for (const { person, name } of await readAll(q.persons.ofIds, { persons }, context)) {
		found.push({ party: { kind: "person", person }, name });
	}
	for (const { group, name } of await readAll(q.groups.ofIds, { groups }, context)) {
		found.push({ party: { kind: "group", group }, name });
	}
	for (const { thing, name } of await readAll(q.things.ofIds, { things: sessions }, context)) {
		found.push({ party: { kind: "agent", session: thing }, name });
	}
	const wanted = text.toLowerCase();
	return found.filter(({ name }) => name.toLowerCase().includes(wanted)).sort((a, b) => a.name.localeCompare(b.name));
}
