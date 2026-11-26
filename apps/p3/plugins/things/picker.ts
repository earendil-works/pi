// What the Manage people picker offers (decision 110, R18): the parties present in the workspace it is used in, and in
// every workspace where the caller is present as themself or through a group (read through the access index), never
// the whole directory. Anyone else comes by an invite link. Persons and groups only: everyone here and the agents are
// no one to put in.

import type { Context, Reference } from "@earendil-works/p3/v1";
import type { AccessIndex } from "./access.ts";
import type { ThingsStore } from "./contract.server.ts";
import { type Party, partyKey } from "./contract.ts";
import { type Read, readAll } from "./reader.ts";

/** The party keys of the persons and groups `person` is offered in `workspace`. */
export async function offeredTo(
	q: Pick<Read, "groupMembers" | "workspaceMembers">,
	index: AccessIndex,
	{ workspace, person }: { readonly workspace: string; readonly person: string },
	context: Context,
): Promise<ReadonlySet<string>> {
	const own = partyKey({ kind: "person", person });
	const groups = (await readAll(q.groupMembers.ofPerson, { person }, context)).map(({ group }) =>
		partyKey({ kind: "group", group }),
	);
	// Where the caller is put in, themself or through a group: their presence reaches there (and below, shown). No
	// workspace (`""`: a group's page) offers what is present where the caller is.
	const where = new Set(workspace === "" ? [] : [workspace]);
	for (const party of [own, ...groups]) {
		for (const entry of await readAll(q.workspaceMembers.where, { partyKey: party }, context)) {
			where.add(entry.workspace);
		}
	}
	// A party put in somewhere is present there (no switch hides what is put in where the switch is).
	const offered = new Set<string>();
	for (const party of await index.parties(where, context)) {
		if (party.startsWith("person/") || party.startsWith("group/")) offered.add(party);
	}
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
