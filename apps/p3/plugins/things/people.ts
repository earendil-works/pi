// Who is who (data model F, decisions 68, 102, 110): persons with the owner flag, global groups with their own
// managers (the group's own tick: changing its members needs it, no workspace tick is enough, scenario 18), and who is
// in which group from which source. The tables, and the writes on persons and groups the store runs inside its
// transactions (`PeopleWrites`); what goes with a source when it goes is the store's cleanup (`store.ts`).

import {
	bool,
	type Ctx,
	defineColumns,
	defineTable,
	eq,
	evolveTable,
	int,
	invalid,
	json,
	type P3Principal,
	query,
	type StoreSelf,
	str,
	type TableOf,
	type Tx,
} from "@earendil-works/p3/v1";
import type { Touched } from "./access.ts";
import { ManagedBy, managedByKey, Party, partyKey, type Source, Source as SourceSchema, sourceKey } from "./contract.ts";
import { SignIns } from "../sign-in/contract.ts";
import { messages } from "./messages.ts";

/** A person's id and name, joined to their memberships' rows (a group's members, with names). */
export const PersonColumns = defineColumns("things.person-columns", {
	columns: { person: str(), name: str() },
	key: ["person"],
});

/** Every person as slice 1 wrote them (the base of the history). */
const PersonsV1 = defineTable("things.persons", {
	version: 1,
	columns: {
		person: str(),
		name: str(),
		owner: int(),
		madeBy: json(SourceSchema, { version: 1 }),
	},
	key: ["person"],
	indexes: { by_owner: ["owner"] },
});

/**
 * Every person: name, the owner flag (1: an owner; an index column, so an int), who made them. By name (the picker);
 * by maker (the persons a source made go with it when nothing else is left of them).
 */
export const Persons = evolveTable(
	PersonsV1,
	(t) =>
		t
			.add("madeByKey", str({ default: "" }))
			.rows((row) => ({ madeByKey: sourceKey(row.madeBy) }))
			.index("by_name", ["name"])
			.index("by_maker", ["madeByKey"]),
	{ exposes: PersonColumns },
);

/** A group's id and whether it is outside, joined to its members' rows. */
export const GroupColumns = defineColumns("things.group-columns", {
	columns: { group: str(), outside: bool() },
	key: ["group"],
});

/** Every group: name, who changes its members, whether it is outside. By manager (its cleanup). */
export const Groups = defineTable("things.groups", {
	version: 1,
	columns: {
		group: str(),
		name: str(),
		managedBy: json(ManagedBy, { version: 1 }),
		managedByKey: str(),
		outside: bool(),
	},
	key: ["group"],
	indexes: { by_manager: ["managedByKey"] },
	exposes: GroupColumns,
});

/** A person in a group, as one source put them there (two sources: two rows). By person; by source. */
export const GroupMembers = defineTable("things.group-members", {
	version: 1,
	columns: { group: str(), person: str(), source: json(SourceSchema, { version: 1 }), sourceKey: str() },
	key: ["group", "person", "sourceKey"],
	indexes: { by_person: ["person"], by_source: ["sourceKey"] },
});


/** Who has a group's own tick (decision 68): its maker, then whom they name. By party: a removed person's. */
export const GroupManagers = defineTable("things.group-managers", {
	version: 1,
	columns: { group: str(), partyKey: str(), party: json(Party, { version: 1 }) },
	key: ["group", "partyKey"],
	indexes: { by_party: ["partyKey"] },
});

/**
 * An invite link (R39), kept hashed: whose secret it is, into which workspace as what, until when, how often, into
 * which group too, and who made it (the persons it makes are theirs). By expiry: the ones gone are swept.
 */
export const Invites = defineTable("things.invites", {
	version: 1,
	columns: {
		invite: str(),
		hash: str(),
		workspace: str(),
		as: str(),
		name: str(),
		expires: int(),
		several: bool(),
		group: str(),
		by: json(SourceSchema, { version: 1 }),
		byKey: str(),
	},
	key: ["invite"],
	indexes: { by_expiry: ["expires"], by_maker: ["byKey"] },
});

/** A removed person whose sign-ins have not ended yet: written in the commit that removed them, ended after it. */
export const SignOuts = defineTable("things.sign-outs", {
	version: 1,
	columns: { person: str() },
	key: ["person"],
});

/** The people tables, as the store's factory opened them. */
export type PeopleTables = {
	readonly persons: TableOf<typeof Persons>;
	readonly groups: TableOf<typeof Groups>;
	readonly groupMembers: TableOf<typeof GroupMembers>;
	readonly groupManagers: TableOf<typeof GroupManagers>;
	readonly invites: TableOf<typeof Invites>;
	readonly signOuts: TableOf<typeof SignOuts>;
};

/** The people tables, opened on `self` (the store's factory). */
export function openPeopleTables(self: StoreSelf<P3Principal>): PeopleTables {
	return {
		persons: self.table(Persons),
		groups: self.table(Groups),
		groupMembers: self.table(GroupMembers),
		groupManagers: self.table(GroupManagers),
		invites: self.table(Invites),
		signOuts: self.table(SignOuts),
	};
}

/** The writes on persons and groups inside a store transaction: each says whom it touched; none checks a caller. */
export class PeopleWrites {
	readonly #t: PeopleTables;

	constructor(t: PeopleTables) {
		this.#t = t;
	}

	/** Makes a person (no owner flag), made by `madeBy`; answers their id. */
	createPerson(tx: Tx, { name, madeBy }: { name: string; madeBy: Source }): string {
		const person = crypto.randomUUID();
		tx.put(this.#t.persons, { person, name, owner: 0, madeBy, madeByKey: sourceKey(madeBy) });
		return person;
	}

	/** The owner's person, made once, at the store's first start (named after the machine's user). */
	async ensureOwner(tx: Tx, name: string): Promise<void> {
		const owners = await tx.page(
			this.#t.persons,
			query(Persons).where((p) => eq(p.owner, 1)),
			1,
		);
		if (owners.items.length > 0) return;
		const by: Source = { kind: "plugin", plugin: "@earendil-works/p3-things" };
		tx.put(this.#t.persons, { person: crypto.randomUUID(), name, owner: 1, madeBy: by, madeByKey: sourceKey(by) });
	}

	/** Renames person `person`. */
	async renamePerson(tx: Tx, person: string, name: string): Promise<void> {
		await this.#mustBePerson(tx, person);
		tx.update(this.#t.persons, { person }, { name });
	}

	/** Gives or takes the owner flag; the last owner keeps it. */
	async setOwner(tx: Tx, touched: Touched, { person, owner }: { person: string; owner: boolean }): Promise<void> {
		const row = await tx.get(this.#t.persons, { person });
		if (row === undefined) throw invalid("args", `things: no person ${person}`);
		if (!owner && row.owner === 1 && !(await this.#anotherOwner(tx))) {
			throw invalid("args", "things: a Pi needs at least one owner", { message: messages.message("lastOwner") });
		}
		tx.update(this.#t.persons, { person }, { owner: owner ? 1 : 0 });
		touched.persons.add(person);
	}

	/**
	 * Makes a group managed by `managedBy`, outside or not; `managers` get its own tick (its maker, for a group people
	 * manage). Answers its id.
	 */
	makeGroup(
		tx: Tx,
		{ name, managedBy, outside, managers }: { name: string; managedBy: ManagedBy; outside: boolean; managers: Party[] },
	): string {
		const group = crypto.randomUUID();
		tx.put(this.#t.groups, { group, name, managedBy, managedByKey: managedByKey(managedBy), outside });
		for (const party of managers) tx.put(this.#t.groupManagers, { group, partyKey: partyKey(party), party });
		return group;
	}

	/** Renames group `group`. */
	async renameGroup(tx: Tx, group: string, name: string): Promise<void> {
		await this.#mustBeGroup(tx, group);
		tx.update(this.#t.groups, { group }, { name });
	}

	/** Replaces who has group `group`'s own tick with `parties` (none: only server code changes it then). */
	async setGroupManagers(tx: Tx, group: string, parties: readonly Party[]): Promise<void> {
		await this.#mustBeGroup(tx, group);
		tx.deleteWhere(this.#t.groupManagers, (m) => eq(m.group, group));
		for (const party of parties) tx.put(this.#t.groupManagers, { group, partyKey: partyKey(party), party });
	}

	/** Puts `person` into `group` as `source` did (a second source: a second row). */
	async addToGroup(
		tx: Tx,
		touched: Touched,
		{ group, person, source }: { group: string; person: string; source: Source },
	): Promise<void> {
		await this.#mustBeGroup(tx, group);
		await this.#mustBePerson(tx, person);
		tx.put(this.#t.groupMembers, { group, person, source, sourceKey: sourceKey(source) });
		touched.persons.add(person);
	}

	/** Takes `source`'s row of `person` in `group` away (another source's row keeps them in). */
	removeFromGroup(
		tx: Tx,
		touched: Touched,
		{ group, person, source }: { group: string; person: string; source: Source },
	): void {
		tx.delete(this.#t.groupMembers, { group, person, sourceKey: sourceKey(source) });
		touched.persons.add(person);
	}

	/** Whether a person other than one being asked about has the owner flag (at least two owners). */
	async #anotherOwner(tx: Tx): Promise<boolean> {
		const owners = await tx.page(
			this.#t.persons,
			query(Persons).where((p) => eq(p.owner, 1)),
			2,
		);
		return owners.items.length > 1;
	}

	/** Throws (`invalid`) unless person `person` exists. */
	async #mustBePerson(tx: Tx, person: string): Promise<void> {
		if ((await tx.get(this.#t.persons, { person })) === undefined) throw invalid("args", `things: no person ${person}`);
	}

	/** Throws (`invalid`) unless group `group` exists. */
	async #mustBeGroup(tx: Tx, group: string): Promise<void> {
		if ((await tx.get(this.#t.groups, { group })) === undefined) throw invalid("args", `things: no group ${group}`);
	}
}

/** The owner's person's first name: their OS user's (`user`), capitalised (the owner renames it later). */
export function ownerName(user: string): string {
	return user === "" ? "Owner" : `${user[0]!.toUpperCase()}${user.slice(1)}`;
}

/** Ends every sign-in of the persons `persons` (they were removed): each one's open links close at once. */
export async function endSignIns(persons: readonly string[], ctx: Ctx<P3Principal>): Promise<void> {
	const gone = new Set(persons);
	const signIns = await ctx.get(SignIns, {});
	for (const signIn of signIns.list.value) {
		if (signIn.principal.kind === "person" && gone.has(signIn.principal.id)) await signIns.revoke(signIn.id, ctx);
	}
}
