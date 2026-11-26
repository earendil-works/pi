// What the Manage people picker offers (decision 110, R18): the parties present in the workspace it is used in, and in
// every workspace where the caller is present, inheritance and hides included (read through the access index), never
// the whole directory but to the owner. Anyone else comes by an invite link. Persons and groups only: everyone here and the agents are
// no one to put in.

import type { Context, Reference } from "@earendil-works/p3/v1";
import type { AccessIndex } from "./access.ts";
import type { ThingsStore } from "./contract.server.ts";
import { type Party, partyKey } from "./contract.ts";
import { type Read, readAll } from "./reader.ts";

/**
 * The party keys of the persons and groups `person` is offered in `workspace` (none given: a group's page): an owner
 * every person and group (an owner skips presence, decision 78); anyone else what is present in the workspace and in
 * every workspace they are present in. Those are the workspaces a party of theirs is put in (their person, their
 * groups) and every one below them, where presence comes down unless a switch hides it (decision 106).
 */
export async function offeredTo(
	q: Pick<Read, "groupMembers" | "workspaceMembers" | "workspaces"> & {
		readonly persons: Reference<typeof ThingsStore>["persons"];
		readonly groups: Reference<typeof ThingsStore>["groups"];
	},
	index: AccessIndex,
	{ workspace, person }: { readonly workspace?: string; readonly person: string },
	context: Context,
): Promise<ReadonlySet<string>> {
	const [me] = (await q.persons.one.page({ person }, 1, context)).items;
	if (me?.owner === true) return everyone(q, context);
	const own = partyKey({ kind: "person", person });
	const groups = (await readAll(q.groupMembers.ofPerson, { person }, context)).map(({ group }) =>
		partyKey({ kind: "group", group }),
	);
	const candidates = new Set<string>();
	for (const party of [own, ...groups]) {
		for (const entry of await readAll(q.workspaceMembers.where, { partyKey: party }, context)) {
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
	const offered = new Set<string>();
	for (const party of await index.offered(workspace, candidates, person, context)) {
		if (party.startsWith("person/") || party.startsWith("group/")) offered.add(party);
	}
	return offered;
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
 * The persons and groups of `offered` (party keys) whose name has `text` in it (any case), with their names, by name.
 */
export async function namesOf(
	q: Pick<Read, "persons"> & { readonly groups: Reference<typeof ThingsStore>["groups"] },
	offered: ReadonlySet<string>,
	text: string,
	context: Context,
): Promise<{ party: Party; name: string }[]> {
	const persons: string[] = [];
	const groups: string[] = [];
	for (const key of offered) {
		if (key.startsWith("person/")) persons.push(key.slice("person/".length));
		else groups.push(key.slice("group/".length));
	}
	const found: { party: Party; name: string }[] = [];
	for (const { person, name } of await readAll(q.persons.ofIds, { persons }, context)) {
		found.push({ party: { kind: "person", person }, name });
	}
	for (const { group, name } of await readAll(q.groups.ofIds, { groups }, context)) {
		found.push({ party: { kind: "group", group }, name });
	}
	const wanted = text.toLowerCase();
	return found.filter(({ name }) => name.toLowerCase().includes(wanted)).sort((a, b) => a.name.localeCompare(b.name));
}
