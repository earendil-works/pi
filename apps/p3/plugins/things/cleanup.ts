// The cleanup when a source goes (one policy, people.md §7), in the commit of the write that removes it: what the
// source wrote, the groups it manages with all that names them, and the persons it made of whom nothing is left
// (their sign-ins end right after the commit); a person's, a group's and a removed workspace's own. A transaction
// reads the committed rows, never its own deletes: which persons go is decided once at the write's end (`settle`),
// with everything the write retires (`Retiring`: sources, things, groups, workspaces) counted as gone.

import {
	type ColumnRefs,
	type Columns,
	type Condition,
	eq,
	inArray,
	invalid,
	query,
	type RowOf,
	type str,
	type Table,
	type TableDefinition,
	type Tx,
} from "@earendil-works/p3/v1";
import type { Touched } from "./access.ts";
import { managedByKey, partyKey, sourceKey } from "./contract.ts";
import { GroupManagers, GroupMembers, Groups, Persons } from "./people.ts";
import { type Changes, Grants, type Retiring, Switches, type Tables, Things, WorkspaceMembers } from "./tables.ts";

/** The cleanup's writes inside a store transaction: each says what it touched; none checks a caller. */
export class Cleanup {
	readonly #t: Tables;

	constructor(t: Tables) {
		this.#t = t;
	}

	/**
	 * The cleanup when a source goes (one policy, one commit): (1) what the source with key `key` wrote (grants, group
	 * members, workspace members); (2) the groups it manages, with all that names them, whoever wrote it; (3) the
	 * persons it made of whom nothing is left, decided at the write's end (`settle`: their sign-ins end after the
	 * commit).
	 */
	async deleteEverythingFrom(tx: Tx, touched: Changes, key: string): Promise<null> {
		const t = this.#t;
		await deleteTold(tx, t.grants, Grants, (r) => eq(r.sourceKey, key), touched.workspaces, "workspace");
		await deleteTold(tx, t.groupMembers, GroupMembers, (r) => eq(r.sourceKey, key), touched.persons, "person");
		await deleteTold(
			tx,
			t.workspaceMembers,
			WorkspaceMembers,
			(r) => eq(r.sourceKey, key),
			touched.workspaces,
			"workspace",
		);
		// The source's invite links go with it: none may make a person for a source that is gone.
		tx.deleteWhere(t.invites, (r) => eq(r.byKey, key));
		await this.#removeManaged(tx, touched, key);
		// Members and groups went: who is where may have changed in every workspace it touched.
		for (const workspace of touched.workspaces) touched.presence.add(workspace);
		touched.retiring.sources.add(key);
		return null;
	}

	/**
	 * Step 3 of the cleanup, once at the end of a write: of the persons the sources it retired made, those of whom
	 * nothing is left once it commits go (their sign-ins end after the commit). Decided last, so what the write retires
	 * after a source (a second thing of a cleared workspace, its Guests group) counts as gone too.
	 */
	async settle(tx: Tx, touched: Changes): Promise<void> {
		const { sources } = touched.retiring;
		if (sources.size === 0) return;
		const made = [];
		for await (const { person, owner } of rowsNaming(tx, this.#t.persons, Persons, (p) => p.madeByKey, [
			...sources,
		])) {
			if (owner === 0) made.push(person);
		}
		if (made.length === 0) return;
		const left = await this.somethingLeftOf(tx, made, touched.retiring);
		// Nothing else names them: only their row and what hangs off it go (no read needed for the rest).
		for (const person of made) if (!left.has(person)) this.#forget(tx, touched, person);
	}

	/**
	 * What goes with removed workspace `workspace` of what it manages: its own groups (its Guests group, with their
	 * memberships and every row naming them) and its invite links; what is written there counts as gone for the
	 * write's cleanup.
	 */
	async retireWorkspace(tx: Tx, touched: Changes, workspace: string): Promise<void> {
		tx.deleteWhere(this.#t.invites, (r) => eq(r.workspace, workspace));
		await this.#removeManaged(tx, touched, managedByKey({ kind: "workspace", workspace }));
		touched.retiring.workspaces.add(workspace);
	}

	/** Removes every group the source or workspace with key `key` manages (index `by_manager`). */
	async #removeManaged(tx: Tx, touched: Changes, key: string): Promise<void> {
		const managed = [];
		for await (const { group } of tx.rows(
			this.#t.groups,
			query(Groups).where((g) => eq(g.managedByKey, key)),
		)) {
			managed.push(group);
		}
		for (const group of managed) await this.removeGroup(tx, touched, group);
	}

	/** Removes `group`: its members, its managers, every workspace entry and grant naming it, its row. */
	async removeGroup(tx: Tx, touched: Changes, group: string): Promise<null> {
		const t = this.#t;
		touched.retiring.groups.add(group);
		await deleteTold(tx, t.groupMembers, GroupMembers, (r) => eq(r.group, group), touched.persons, "person");
		await this.#unname(tx, touched, partyKey({ kind: "group", group }));
		// Its own managers, and its rows as a manager of other groups; links that would put people into it.
		tx.deleteWhere(t.groupManagers, (m) => eq(m.group, group));
		tx.deleteWhere(t.groupManagers, (m) => eq(m.partyKey, partyKey({ kind: "group", group })));
		tx.deleteWhere(t.invites, (r) => eq(r.group, group));
		tx.delete(t.groups, { group });
		return null;
	}

	/**
	 * Removes person `person` (never one with the owner flag: it is taken first): what they wrote and made (the cleanup
	 * of their source), everything naming them, their invite links, their row; their sign-ins end after the commit.
	 */
	async removePerson(tx: Tx, touched: Changes, person: string): Promise<null> {
		const row = await tx.get(this.#t.persons, { person });
		if (row === undefined) throw invalid("args", `things: no person ${person}`);
		if (row.owner === 1) throw invalid("args", "things: an owner is removed once the owner flag is taken");
		await this.deleteEverythingFrom(tx, touched, sourceKey({ kind: "person", person }));
		await this.#dropPerson(tx, touched, person);
		return null;
	}

	/**
	 * Of `persons`, those of whom something is left once the write commits: a membership, entry, grant or manager row
	 * naming them or theirs, or a person or thing they made, but the rows the write deletes (`retiring`: the rows of
	 * the sources it retired, of the groups it removes, on the things it removes, in the workspaces it clears, and those
	 * things themselves). A transaction's reads see the committed rows, not its own deletes, so those are left out by
	 * what they are. Seven reads for all of them (each an index search, IN).
	 */
	async somethingLeftOf(tx: Tx, persons: readonly string[], retiring: Retiring): Promise<ReadonlySet<string>> {
		const t = this.#t;
		const parties = persons.map((person) => partyKey({ kind: "person", person }));
		const owns = persons.map((person) => sourceKey({ kind: "person", person }));
		// Party and source keys of a person are the same text (`person/<id>`): one map back to the person.
		const personOf = new Map(persons.map((person) => [partyKey({ kind: "person", person }), person]));
		const { sources, things: retired, groups: removed, workspaces } = retiring;
		const groups = new Set([...removed].map((group) => partyKey({ kind: "group", group })));
		const gone = (row: {
			sourceKey: string;
			group?: string;
			partyKey?: string;
			thing?: string;
			workspace?: string;
		}) =>
			sources.has(row.sourceKey) ||
			(row.group !== undefined && removed.has(row.group)) ||
			(row.partyKey !== undefined && groups.has(row.partyKey)) ||
			(row.thing !== undefined && retired.has(row.thing)) ||
			(row.workspace !== undefined && workspaces.has(row.workspace));
		const left = new Set<string>();
		for await (const row of rowsNaming(tx, t.groupMembers, GroupMembers, (r) => r.person, persons)) {
			if (!gone(row)) left.add(row.person);
		}
		const byParty = [
			rowsNaming(tx, t.workspaceMembers, WorkspaceMembers, (r) => r.partyKey, parties),
			rowsNaming(tx, t.grants, Grants, (r) => r.partyKey, parties),
		];
		for (const rows of byParty) for await (const row of rows) if (!gone(row)) left.add(personOf.get(row.partyKey)!);
		const bySource = [
			rowsNaming(tx, t.grants, Grants, (r) => r.sourceKey, owns),
			rowsNaming(tx, t.groupMembers, GroupMembers, (r) => r.sourceKey, owns),
			rowsNaming(tx, t.workspaceMembers, WorkspaceMembers, (r) => r.sourceKey, owns),
		];
		for (const rows of bySource) for await (const row of rows) if (!gone(row)) left.add(personOf.get(row.sourceKey)!);
		for await (const row of rowsNaming(tx, t.groupManagers, GroupManagers, (r) => r.partyKey, parties)) {
			if (!removed.has(row.group)) left.add(personOf.get(row.partyKey)!);
		}
		// A person or thing they made names them as its maker: they stay, unless the thing goes in this write (a person
		// they made does not: they would be a source retired, and so not among these). Index `by_maker` of things is
		// (madeByKey, kind): the order follows it, so nothing sorts.
		const things = query(Things)
			.where((r) => inArray(r.madeByKey, owns))
			.orderBy((r) => r.madeByKey, "asc")
			.orderBy((r) => r.kind, "asc");
		for await (const row of rowsNaming(tx, t.persons, Persons, (r) => r.madeByKey, owns))
			left.add(personOf.get(row.madeByKey)!);
		for await (const row of tx.rows(t.things, things))
			if (!retired.has(row.thing)) left.add(personOf.get(row.madeByKey)!);
		return left;
	}

	/**
	 * Drops `person` and everything naming them (memberships, entries, grants, manager rows, switches), their invite
	 * links and their row (`#forget`).
	 */
	async #dropPerson(tx: Tx, touched: Changes, person: string): Promise<void> {
		const t = this.#t;
		const party = partyKey({ kind: "person", person });
		await deleteTold(tx, t.groupMembers, GroupMembers, (r) => eq(r.person, person), touched.persons, "person");
		await this.#unname(tx, touched, party);
		tx.deleteWhere(t.groupManagers, (r) => eq(r.partyKey, party));
		this.#forget(tx, touched, person);
	}

	/** Deletes every workspace entry, grant and switch naming the party with key `party`, whoever wrote it. */
	async #unname(tx: Tx, touched: Touched, party: string): Promise<void> {
		const t = this.#t;
		const { workspaces } = touched;
		await deleteTold(tx, t.workspaceMembers, WorkspaceMembers, (r) => eq(r.partyKey, party), workspaces, "workspace");
		await deleteTold(tx, t.grants, Grants, (r) => eq(r.partyKey, party), workspaces, "workspace");
		await deleteTold(tx, t.switches, Switches, (r) => eq(r.itemKey, party), workspaces, "workspace");
		// Who is where changed wherever the party was put in or switched.
		for (const workspace of workspaces) touched.presence.add(workspace);
		touched.members.add(party);
	}

	/**
	 * Drops `person`'s row, the switches and invite links that name them or are theirs, and writes their sign-out (their
	 * sign-ins end after the commit). The switches change nobody's answer: a person no longer present counts nowhere.
	 */
	#forget(tx: Tx, touched: Changes, person: string): void {
		const t = this.#t;
		const party = partyKey({ kind: "person", person });
		tx.deleteWhere(t.switches, (r) => eq(r.itemKey, party));
		tx.deleteWhere(t.invites, (r) => eq(r.byKey, sourceKey({ kind: "person", person })));
		tx.delete(t.persons, { person });
		tx.put(t.signOuts, { person });
		touched.persons.add(person);
		touched.signedOut.push(person);
	}
}

/**
 * Deletes `table`'s rows matching `where`, each one's `column` (its workspace, its person: a text) added to `told`
 * first.
 */
export async function deleteTold<C extends Columns, K extends readonly string[]>(
	tx: Tx,
	table: Table<C, K>,
	definition: TableDefinition<C, K>,
	where: (row: ColumnRefs<C>) => Condition,
	told: Set<string>,
	column: keyof RowOf<C>,
): Promise<void> {
	for await (const row of tx.rows(table, query(definition).where(where))) told.add(String(row[column]));
	tx.deleteWhere(table, where);
}

/** A text column of a table, as a query's callbacks name it. */
type TextRef = ColumnRefs<{ text: ReturnType<typeof str> }>["text"];

/** `table`'s rows whose `column` is one of `values`: an index search (IN), in that column's order (no sort). */
function rowsNaming<C extends Columns, K extends readonly string[]>(
	tx: Tx,
	table: Table<C, K>,
	definition: TableDefinition<C, K>,
	column: (row: ColumnRefs<C>) => TextRef,
	values: readonly string[],
) {
	const naming = query(definition).where((row) => inArray(column(row), values));
	return tx.rows(table, naming.orderBy(column, "asc"));
}
