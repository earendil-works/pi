// The things store (`ThingsStore`): the only writer of the things plugin's tables (data model F: on disk only what
// people set), their named queries, every write, and the access index in memory (`access.ts`), which its object
// owns, reads through the same named queries (`reader.ts`), and hands admissions through `AccessHandles`. Every write
// is one transaction, run one at a time with the index's loads, and followed by the index before the write answers,
// so a caller's next admission sees it. The kinds' create and delete hooks around a thing's life are `lifecycle.ts`'s.

import {
	and,
	arr,
	bool,
	type ColumnRefs,
	type Columns,
	type Condition,
	type Context,
	defineColumns,
	defineTable,
	eq,
	type FacetHost,
	int,
	invalid,
	json,
	type P3Principal,
	query,
	type RowOf,
	type StoreSelf,
	str,
	type Table,
	type TableDefinition,
	type TableItem,
	type TableOf,
	type Tx,
} from "@earendil-works/p3/v1";
import { AccessIndex, type Touched } from "./access.ts";
import { AccessHandles, type GrantInput, ThingHooks, ThingsStore } from "./contract.server.ts";
import {
	Item,
	itemKey,
	ManagedBy,
	managedByKey,
	Party,
	partyKey,
	type Source,
	Source as SourceSchema,
	sourceKey,
} from "./contract.ts";
import { type KindInfo, ThingKinds } from "./kind.ts";
import { Lifecycle, Pending } from "./lifecycle.ts";
import { messages } from "./messages.ts";
import { type Kinds, lookupOf, readerOf } from "./reader.ts";
import { audienceOf, isFor } from "./rules.ts";

/** The kind of Pi until the workspace kinds come (ERNDL-1143). */
const WORKSPACE_KIND = "things.workspace";

/** A thing's id and kind, joined to its grants (the kind their ticks are of). */
const ThingColumns = defineColumns("things.thing-columns", { columns: { thing: str(), kind: str() }, key: ["thing"] });

/** Every thing, a workspace too: its kind, name, who made it and when. */
const Things = defineTable("things.things", {
	version: 1,
	columns: {
		thing: str(),
		kind: str(),
		name: str(),
		madeBy: json(SourceSchema, { version: 1 }),
		madeByKey: str(),
		madeAt: int(),
	},
	key: ["thing"],
	exposes: ThingColumns,
});

/**
 * The tree: each workspace's parent (`""`: Pi, the root) and its two defaults. Children by parent.
 */
const Workspaces = defineTable("things.workspaces", {
	version: 1,
	columns: {
		workspace: str(),
		parent: str(),
		showsThings: bool(),
		showsPeople: bool(),
	},
	key: ["workspace"],
	indexes: { children: ["parent", "workspace"] },
});

/** A thing linked into a workspace, with its kind (no second read for it). By thing: where it is linked. */
const Links = defineTable("things.links", {
	version: 1,
	columns: { workspace: str(), thing: str(), of: str() },
	key: ["workspace", "thing"],
	indexes: { by_thing: ["thing"] },
});

/** A party put into a workspace, and who did it. By party; by source (its cleanup). */
const WorkspaceMembers = defineTable("things.workspace_members", {
	version: 1,
	columns: {
		workspace: str(),
		partyKey: str(),
		party: json(Party, { version: 1 }),
		source: json(SourceSchema, { version: 1 }),
		sourceKey: str(),
	},
	key: ["workspace", "partyKey"],
	indexes: { by_party: ["partyKey"], by_source: ["sourceKey"] },
});

/** A thing or party from above, shown or hidden in a workspace by hand. By item: a deleted thing's switches. */
const Switches = defineTable("things.switches", {
	version: 1,
	columns: { workspace: str(), itemKey: str(), item: json(Item, { version: 1 }), shown: bool() },
	key: ["workspace", "itemKey"],
	indexes: { by_item: ["itemKey"] },
});

/**
 * One source's grant on a thing for a party, written in a workspace: whether it gives, its ticks, its take-aways, and
 * the kind's ticks version they were written at (item 105). By source (its cleanup), by party (a deleted group's), by thing (a
 * deleted thing's, wherever written).
 */
const Grants = defineTable("things.grants", {
	version: 1,
	columns: {
		workspace: str(),
		thing: str(),
		partyKey: str(),
		party: json(Party, { version: 1 }),
		source: json(SourceSchema, { version: 1 }),
		sourceKey: str(),
		gives: bool(),
		ticks: json(arr(str()), { version: 1 }),
		takenAway: json(arr(str()), { version: 1 }),
		ticksVersion: int(),
	},
	key: ["workspace", "thing", "partyKey", "sourceKey"],
	indexes: { by_source: ["sourceKey"], by_party: ["partyKey"], by_thing: ["thing"] },
});

/** Every person: name, the owner flag (1: an owner; an index column, so an int), who made them. */
const Persons = defineTable("things.persons", {
	version: 1,
	columns: {
		person: str(),
		name: str(),
		owner: int(),
		madeBy: json(SourceSchema, { version: 1 }),
		madeByKey: str(),
	},
	key: ["person"],
	indexes: { by_owner: ["owner"] },
});

/** A group's id and whether it is outside, joined to its members' rows. */
const GroupColumns = defineColumns("things.group-columns", {
	columns: { group: str(), outside: bool() },
	key: ["group"],
});

/** Every group: name, who changes its members, whether it is outside. By manager (its cleanup). */
const Groups = defineTable("things.groups", {
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
const GroupMembers = defineTable("things.group_members", {
	version: 1,
	columns: { group: str(), person: str(), source: json(SourceSchema, { version: 1 }), sourceKey: str() },
	key: ["group", "person", "sourceKey"],
	indexes: { by_person: ["person"], by_source: ["sourceKey"] },
});

/** Serves `ThingsStore` on `host`. */
export function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(ThingsStore, (_params, self) => {
		const t = {
			things: self.table(Things),
			workspaces: self.table(Workspaces),
			links: self.table(Links),
			workspaceMembers: self.table(WorkspaceMembers),
			switches: self.table(Switches),
			grants: self.table(Grants),
			persons: self.table(Persons),
			groups: self.table(Groups),
			groupMembers: self.table(GroupMembers),
		};
		const pending = self.table(Pending);
		const kinds = self.registry(ThingKinds);
		const hooks = self.registry(ThingHooks);
		const q = namedQueries(self, t);
		let lookup: Kinds | undefined;
		const kindsNow = () => {
			lookup ??= lookupOf(kinds.value);
			return lookup;
		};
		// The grants a kind cannot read, reported once each for this object's life.
		const reported = new Set<string>();
		let index: AccessIndex | undefined;
		// Opened before the store goes live: Pi exists from the first start on, once; the index works under the
		// attempt's own context. Closed with the attempt: its watchers attach to the next attempt's index.
		self.open(
			async (ctx) => {
				await self.tx((tx) => ensurePi(tx, t), ctx);
				index = new AccessIndex(readerOf(q, kindsNow, reported), kindsNow, ctx);
				return index;
			},
			(opened) => opened.close(),
		);
		// Only `open` and `attach` reach admissions: writes and the index's other operations stay the store's.
		self.contribute(AccessHandles, {
			get open() {
				return index?.open === true;
			},
			attach: async (workspace, caller, observer, ctx) => index?.attach(workspace, caller, observer, ctx),
		});
		/**
		 * One write: its transaction under `ctx`, one at a time with the index's work (`AccessIndex.commit`), which follows
		 * it before the write answers; the things it removed then have their kind's delete hook run.
		 */
		const write = async <R>(fn: (tx: Tx, changes: Changes) => Promise<R>, ctx: Context): Promise<R> => {
			const retired: Retired[] = [];
			// The store is live while it writes, so its index opened.
			const result = await index!.commit((touched) => self.tx((tx) => fn(tx, { ...touched, retired }), ctx));
			for (const { thing, kind } of retired) lifecycle.retire(thing, kind);
			return result;
		};
		const writes = new Writes({ ...t, pending }, () => kinds.value);
		const lifecycle = new Lifecycle({
			table: pending,
			write: (fn, ctx) => write((tx) => fn(tx), ctx),
			pending: (ctx) =>
				self.tx(async (tx) => {
					const rows = [];
					// The whole table: what waits for a delete hook is few rows, read at the start and when the hooks change.
					for await (const row of tx.rows(pending, query(Pending))) rows.push(row);
					return rows;
				}, ctx),
			hooks: () => hooks.value,
		});
		self.onLive((ctx) => lifecycle.serve(ctx));
		// A plugin loaded, reloaded or removed: ticks expand and migrate anew, every loaded workspace is read again; a
		// kind's hooks back, its waiting deletes run.
		self.on(kinds, async () => {
			lookup = undefined;
			await index?.kindsChanged();
		});
		self.on(hooks, () => lifecycle.resume());
		return {
			...q,
			create: async (args, ctx) => {
				const thing = crypto.randomUUID();
				// The kind prepares what is in it first, under the new id (item 34): a hook that throws leaves nothing, as no
				// row names the thing yet. A crash between the hook and the commit leaves the kind's content under an id
				// nobody knows (accepted: nothing can reach it).
				await hooks.value.get(args.kind)?.value.create?.(thing, args.input, ctx);
				try {
					await write((tx, changes) => writes.make(tx, changes, { ...args, thing }), ctx);
				} catch (error) {
					await lifecycle.undo(thing, args.kind);
					throw error;
				}
				return thing;
			},
			link: (args, ctx) => write((tx, touched) => writes.link(tx, touched, args), ctx),
			unlink: (args, ctx) => write((tx, touched) => writes.unlink(tx, touched, args), ctx),
			rename: ({ thing, name }, ctx) => write(async (tx) => writes.rename(tx, thing, name), ctx),
			createWorkspace: (args, ctx) => write((tx, touched) => writes.workspace(tx, touched, args), ctx),
			setSwitch: (args, ctx) => write((tx, touched) => writes.setSwitch(tx, touched, args), ctx),
			setDefaults: (args, ctx) => write((tx, touched) => writes.setDefaults(tx, touched, args), ctx),
			setGrants: (args, ctx) => write((tx, touched) => writes.setGrants(tx, touched, args), ctx),
			putParty: (args, ctx) => write((tx, touched) => writes.putParty(tx, touched, args), ctx),
			removeParty: ({ workspace, party }, ctx) =>
				write(async (tx, touched) => {
					tx.delete(t.workspaceMembers, { workspace, partyKey: partyKey(party) });
					touched.workspaces.add(workspace);
					return null;
				}, ctx),
			createPerson: ({ name, madeBy }, ctx) =>
				write(async (tx) => {
					const person = crypto.randomUUID();
					tx.put(t.persons, { person, name, owner: 0, madeBy, madeByKey: sourceKey(madeBy) });
					return person;
				}, ctx),
			setOwner: (args, ctx) => write((tx, touched) => writes.setOwner(tx, touched, args), ctx),
			makeGroup: ({ name, managedBy, outside }, ctx) =>
				write(async (tx) => {
					const group = crypto.randomUUID();
					tx.put(t.groups, { group, name, managedBy, managedByKey: managedByKey(managedBy), outside });
					return group;
				}, ctx),
			addToGroup: ({ group, person, source }, ctx) =>
				write(async (tx, touched) => {
					tx.put(t.groupMembers, { group, person, source, sourceKey: sourceKey(source) });
					touched.persons.add(person);
					return null;
				}, ctx),
			removeFromGroup: ({ group, person, source }, ctx) =>
				write(async (tx, touched) => {
					tx.delete(t.groupMembers, { group, person, sourceKey: sourceKey(source) });
					touched.persons.add(person);
					return null;
				}, ctx),
			deleteEverythingFrom: ({ source }, ctx) =>
				write((tx, touched) => writes.deleteEverythingFrom(tx, touched, sourceKey(source)), ctx),
		};
	});
}

/** What a write tells besides what it touched: the things it removed (their delete hooks run after the commit). */
type Changes = Touched & { readonly retired: Retired[] };

/** A thing removed, and its kind. */
type Retired = { readonly thing: string; readonly kind: string };

/** The store's tables, as its factory declared them. */
type Tables = {
	readonly things: TableOf<typeof Things>;
	readonly workspaces: TableOf<typeof Workspaces>;
	readonly links: TableOf<typeof Links>;
	readonly workspaceMembers: TableOf<typeof WorkspaceMembers>;
	readonly switches: TableOf<typeof Switches>;
	readonly grants: TableOf<typeof Grants>;
	readonly persons: TableOf<typeof Persons>;
	readonly groups: TableOf<typeof Groups>;
	readonly groupMembers: TableOf<typeof GroupMembers>;
};

/** Every named query of the store, each with the index its condition and order search. */
function namedQueries(self: StoreSelf<P3Principal>, t: Tables) {
	return {
		things: self.queries(
			t.things,
			{ map: ({ thing, kind, name, madeBy, madeAt }) => ({ thing, kind, name, madeBy, madeAt }) },
			{
				// The key.
				one: ({ thing }: { thing: string }) => query(Things).where((r) => eq(r.thing, thing)),
			},
		),
		workspaces: self.queries(
			t.workspaces,
			{
				map: ({ workspace, parent, showsThings, showsPeople }) => ({ workspace, parent, showsThings, showsPeople }),
			},
			{
				// The key.
				one: ({ workspace }: { workspace: string }) => query(Workspaces).where((w) => eq(w.workspace, workspace)),
				// Index `children`: `parent` fixed, in the order of the key.
				children: ({ parent }: { parent: string }) =>
					query(Workspaces)
						.where((w) => eq(w.parent, parent))
						.orderBy((w) => w.workspace, "asc"),
			},
		),
		links: self.queries(
			t.links,
			{ map: ({ workspace, thing, of }) => ({ workspace, thing, of }) },
			{
				// The key's prefix.
				here: ({ workspace }: { workspace: string }) => query(Links).where((l) => eq(l.workspace, workspace)),
			},
		),
		workspaceMembers: self.queries(
			t.workspaceMembers,
			{ map: ({ workspace, party, source }) => ({ workspace, party, source }) },
			{
				// The key's prefix.
				here: ({ workspace }: { workspace: string }) =>
					query(WorkspaceMembers).where((m) => eq(m.workspace, workspace)),
			},
		),
		switches: self.queries(
			t.switches,
			{ map: ({ workspace, item, shown }) => ({ workspace, item, shown }) },
			{
				// The key's prefix.
				here: ({ workspace }: { workspace: string }) => query(Switches).where((w) => eq(w.workspace, workspace)),
			},
		),
		grants: self.queries(
			t.grants,
			{
				map: ({ workspace, thing, party, source, gives, ticks, takenAway, ticksVersion }, partner) => ({
					workspace,
					thing,
					// The joined set is `ThingColumns`: its `kind` is a string.
					kind: partner.kind as string,
					ticksVersion,
					party,
					source,
					gives,
					ticks,
					takenAway,
				}),
			},
			{
				// The key's prefix; each joined with its thing by key (its kind).
				here: ({ workspace }: { workspace: string }) =>
					query(Grants)
						.where((g) => eq(g.workspace, workspace))
						.join(ThingColumns, (g) => ({ thing: g.thing })),
			},
		),
		persons: self.queries(
			t.persons,
			{ map: ({ person, name, owner, madeBy }) => ({ person, name, owner: owner === 1, madeBy }) },
			{
				// The key.
				one: ({ person }: { person: string }) => query(Persons).where((p) => eq(p.person, person)),
			},
		),
		groupMembers: self.queries(
			t.groupMembers,
			{
				// The joined set is `GroupColumns`: its `outside` is a boolean.
				map: ({ group, person, source }, partner) => ({ group, person, source, outside: partner.outside === true }),
			},
			{
				// Index `by_person`, then the key; each joined with its group by key (a member of no group: none).
				ofPerson: ({ person }: { person: string }) =>
					query(GroupMembers)
						.where((m) => eq(m.person, person))
						.join(GroupColumns, (m) => ({ group: m.group })),
			},
		),
	};
}

/** Makes Pi, the root workspace, unless it exists. */
async function ensurePi(tx: Tx, t: Tables): Promise<null> {
	const roots = query(Workspaces).where((w) => eq(w.parent, ""));
	if ((await tx.page(t.workspaces, roots, 1)).items.length > 0) return null;
	const by: Source = { kind: "plugin", plugin: "@earendil-works/p3-things" };
	putWorkspace(tx, t, { kind: WORKSPACE_KIND, name: "Pi", by, showsPeople: true }, "");
	return null;
}

/** Puts a new workspace's thing row and line under `parent` (`""`: the root); answers its id. */
function putWorkspace(
	tx: Tx,
	t: Tables,
	{ kind, name, by, showsPeople }: { kind: string; name: string; by: Source; showsPeople: boolean },
	parent: string,
): string {
	const workspace = crypto.randomUUID();
	tx.put(t.things, { thing: workspace, kind, name, madeBy: by, madeByKey: sourceKey(by), madeAt: Date.now() });
	tx.put(t.workspaces, {
		workspace,
		parent,
		showsThings: true,
		showsPeople,
	});
	return workspace;
}

/** The party a maker's grant names (item 90): a person, or a session's agent; none for a thing, a provider, a plugin. */
function makerParty(by: Source): Party | undefined {
	switch (by.kind) {
		case "person":
			return { kind: "person", person: by.person };
		case "agent":
			return { kind: "agent", session: by.session };
		default:
			return undefined;
	}
}

/** Deletes `table`'s rows matching `where`, each one's `column` (its workspace, its person: a text) added to `told` first. */
async function deleteTold<C extends Columns, K extends readonly string[]>(
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

/** The store's writes inside a transaction: each says what it touched; none checks a caller (server code). */
class Writes {
	readonly #t: Tables & { readonly pending: TableOf<typeof Pending> };
	readonly #kinds: () => ReadonlyMap<string, TableItem<KindInfo>>;

	constructor(
		t: Tables & { readonly pending: TableOf<typeof Pending> },
		kinds: () => ReadonlyMap<string, TableItem<KindInfo>>,
	) {
		this.#t = t;
		this.#kinds = kinds;
	}

	/** Thing `thing` of `kind` linked in `workspace`: its row, the link with the default grants, every tick for its maker. */
	async make(
		tx: Tx,
		touched: Touched,
		{
			thing,
			kind,
			name,
			workspace,
			by,
		}: { thing: string; kind: string; name: string; workspace: string; by: Source },
	): Promise<null> {
		const item = this.#kind(kind);
		await this.#mustBeWorkspace(tx, workspace);
		tx.put(this.#t.things, { thing, kind, name, madeBy: by, madeByKey: sourceKey(by), madeAt: Date.now() });
		this.#linked(tx, workspace, thing, item);
		const maker = makerParty(by);
		if (maker !== undefined) {
			const ticks = item.value.ticks
				.filter((tick) => isFor(tick.for, audienceOf(maker.kind)))
				.map((tick) => tick.name);
			this.#grant(tx, workspace, thing, maker, by, { gives: true, ticks, takenAway: [] }, item.value.ticksVersion);
		}
		touched.workspaces.add(workspace);
		return null;
	}

	/** Links `thing` into `workspace` with its kind's default grants (once; a kind of `workspaces: "one"` once at all). */
	async link(tx: Tx, touched: Touched, { workspace, thing }: { workspace: string; thing: string }): Promise<null> {
		const row = await tx.get(this.#t.things, { thing });
		if (row === undefined) throw invalid("args", `things: no thing ${thing}`);
		const item = this.#kind(row.kind);
		await this.#mustBeWorkspace(tx, workspace);
		if ((await tx.get(this.#t.links, { workspace, thing })) !== undefined) return null;
		const elsewhere = await tx.page(
			this.#t.links,
			query(Links).where((l) => eq(l.thing, thing)),
			1,
		);
		if (item.value.workspaces === "one" && elsewhere.items.length > 0) {
			throw invalid("args", `things: a ${row.kind} is linked in one workspace only`);
		}
		this.#linked(tx, workspace, thing, item);
		touched.workspaces.add(workspace);
		return null;
	}

	/** Unlinks `thing` and what `workspace` wrote for it (R15); with its last link the thing goes. */
	async unlink(tx: Tx, touched: Changes, { workspace, thing }: { workspace: string; thing: string }): Promise<null> {
		const link = await tx.get(this.#t.links, { workspace, thing });
		if (link === undefined) return null;
		tx.deleteWhere(this.#t.grants, (g) => and(eq(g.workspace, workspace), eq(g.thing, thing)));
		tx.delete(this.#t.links, { workspace, thing });
		touched.workspaces.add(workspace);
		const links = await tx.page(
			this.#t.links,
			query(Links).where((l) => eq(l.thing, thing)),
			2,
		);
		if (links.items.every((other) => other.workspace === workspace))
			await this.removeThing(tx, touched, thing, link.of);
		return null;
	}

	/**
	 * Removes `thing`: its links, grants and switches wherever written, its row; its kind's `delete` hook is pending
	 * (`lifecycle.ts`), and runs after the commit.
	 */
	async removeThing(tx: Tx, touched: Changes, thing: string, kind: string): Promise<null> {
		const t = this.#t;
		const item = itemKey({ kind: "thing", thing });
		await deleteTold(tx, t.links, Links, (l) => eq(l.thing, thing), touched.workspaces, "workspace");
		await deleteTold(tx, t.grants, Grants, (g) => eq(g.thing, thing), touched.workspaces, "workspace");
		await deleteTold(tx, t.switches, Switches, (w) => eq(w.itemKey, item), touched.workspaces, "workspace");
		tx.delete(this.#t.things, { thing });
		tx.put(this.#t.pending, { thing, kind });
		touched.retired.push({ thing, kind });
		return null;
	}

	/** Changes a thing's name (no access changes: nothing touched). */
	async rename(tx: Tx, thing: string, name: string): Promise<null> {
		if ((await tx.get(this.#t.things, { thing })) === undefined) throw invalid("args", `things: no thing ${thing}`);
		tx.update(this.#t.things, { thing }, { name });
		return null;
	}

	/** A workspace of `kind` under `parent`: its thing row and its line. */
	async workspace(
		tx: Tx,
		touched: Touched,
		args: { kind: string; name: string; parent: string; by: Source; showsPeople?: boolean },
	): Promise<string> {
		await this.#mustBeWorkspace(tx, args.parent);
		const workspace = putWorkspace(tx, this.#t, { ...args, showsPeople: args.showsPeople ?? true }, args.parent);
		touched.workspaces.add(workspace);
		return workspace;
	}

	/** Sets or removes (`shown` left out) the switch for `item` in `workspace`. */
	async setSwitch(
		tx: Tx,
		touched: Touched,
		{ workspace, item, shown }: { workspace: string; item: Item; shown?: boolean },
	): Promise<null> {
		await this.#mustBeWorkspace(tx, workspace);
		if (shown === undefined) tx.delete(this.#t.switches, { workspace, itemKey: itemKey(item) });
		else tx.put(this.#t.switches, { workspace, itemKey: itemKey(item), item, shown });
		touched.workspaces.add(workspace);
		return null;
	}

	/** Sets a workspace's defaults for things and people from above. */
	async setDefaults(
		tx: Tx,
		touched: Touched,
		{ workspace, showsThings, showsPeople }: { workspace: string; showsThings?: boolean; showsPeople?: boolean },
	): Promise<null> {
		await this.#mustBeWorkspace(tx, workspace);
		tx.update(
			this.#t.workspaces,
			{ workspace },
			{
				...(showsThings === undefined ? {} : { showsThings }),
				...(showsPeople === undefined ? {} : { showsPeople }),
			},
		);
		touched.workspaces.add(workspace);
		return null;
	}

	/**
	 * Writes `source`'s grants: each at its kind's version now; one that neither gives nor takes away is removed. A
	 * giving grant only where the thing is linked (R15), every tick one its kind has, given only to whom it is for (R2).
	 */
	async setGrants(
		tx: Tx,
		touched: Touched,
		{ source, grants }: { source: Source; grants: GrantInput[] },
	): Promise<null> {
		for (const grant of grants) {
			const { workspace, thing, party, gives, ticks, takenAway } = grant;
			const link = await tx.get(this.#t.links, { workspace, thing });
			if (gives && link === undefined) {
				throw invalid("args", `things: ${thing} is not linked in ${workspace}: ticks are given where it is`, {
					message: messages.message("belowLink", workspace),
				});
			}
			const kind = link?.of ?? (await tx.get(this.#t.things, { thing }))?.kind;
			if (kind === undefined) throw invalid("args", `things: no thing ${thing}`);
			const info = this.#kind(kind).value;
			for (const tick of [...ticks, ...takenAway]) {
				if (!info.ticks.some(({ name }) => name === tick))
					throw invalid("args", `things: ${kind} has no tick ${tick}`);
			}
			for (const tick of ticks) {
				if (!isFor(info.ticks.find(({ name }) => name === tick)!.for, audienceOf(party.kind))) {
					throw invalid("args", `things: ${tick} of ${kind} cannot be given to ${partyKey(party)}`, {
						message: messages.message("tickNotFor", tick, partyKey(party)),
					});
				}
			}
			if (!gives && takenAway.length === 0) {
				tx.delete(this.#t.grants, { workspace, thing, partyKey: partyKey(party), sourceKey: sourceKey(source) });
			} else this.#grant(tx, workspace, thing, party, source, { gives, ticks, takenAway }, info.ticksVersion);
			touched.workspaces.add(workspace);
		}
		return null;
	}

	/** Puts a person, a group or a session's agent into a workspace. */
	async putParty(
		tx: Tx,
		touched: Touched,
		{ workspace, party, source }: { workspace: string; party: Party; source: Source },
	): Promise<null> {
		if (party.kind === "everyone" || party.kind === "agents") {
			throw invalid("args", `things: ${party.kind} is no party one puts in`);
		}
		await this.#mustBeWorkspace(tx, workspace);
		tx.put(this.#t.workspaceMembers, {
			workspace,
			partyKey: partyKey(party),
			party,
			source,
			sourceKey: sourceKey(source),
		});
		touched.workspaces.add(workspace);
		return null;
	}

	/** Gives or takes the owner flag; the last owner keeps it. */
	async setOwner(tx: Tx, touched: Touched, { person, owner }: { person: string; owner: boolean }): Promise<null> {
		const row = await tx.get(this.#t.persons, { person });
		if (row === undefined) throw invalid("args", `things: no person ${person}`);
		if (!owner && row.owner === 1) {
			const owners = await tx.page(
				this.#t.persons,
				query(Persons).where((p) => eq(p.owner, 1)),
				2,
			);
			if (owners.items.length < 2) {
				throw invalid("args", "things: a Pi needs at least one owner", { message: messages.message("lastOwner") });
			}
		}
		tx.update(this.#t.persons, { person }, { owner: owner ? 1 : 0 });
		touched.persons.add(person);
		return null;
	}

	/**
	 * Removes what the source with key `key` wrote (grants, group members, workspace members) and the groups it manages, with every
	 * member of them, every workspace entry and grant naming them, whoever wrote it.
	 */
	async deleteEverythingFrom(tx: Tx, touched: Touched, key: string): Promise<null> {
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
		for await (const { group } of tx.rows(
			t.groups,
			query(Groups).where((g) => eq(g.managedByKey, key)),
		)) {
			await this.#removeGroup(tx, touched, group);
		}
		return null;
	}

	/** Removes `group`: its members, every workspace entry and grant naming it, its row. */
	async #removeGroup(tx: Tx, touched: Touched, group: string): Promise<void> {
		const t = this.#t;
		const party = partyKey({ kind: "group", group });
		await deleteTold(tx, t.groupMembers, GroupMembers, (r) => eq(r.group, group), touched.persons, "person");
		await deleteTold(
			tx,
			t.workspaceMembers,
			WorkspaceMembers,
			(r) => eq(r.partyKey, party),
			touched.workspaces,
			"workspace",
		);
		await deleteTold(tx, t.grants, Grants, (r) => eq(r.partyKey, party), touched.workspaces, "workspace");
		tx.delete(t.groups, { group });
	}

	/** The link of `thing` in `workspace`, with its kind's default grants (source: the kind's plugin). */
	#linked(tx: Tx, workspace: string, thing: string, item: TableItem<KindInfo>): void {
		const { name, defaultGrants, ticksVersion } = item.value;
		tx.put(this.#t.links, { workspace, thing, of: name });
		const source: Source = { kind: "plugin", plugin: item.plugin };
		const parties = [
			[{ kind: "everyone" }, defaultGrants.everyone],
			[{ kind: "agents" }, defaultGrants.agents],
		] as const;
		for (const [party, ticks] of parties) {
			if (ticks !== undefined)
				this.#grant(tx, workspace, thing, party, source, { gives: true, ticks, takenAway: [] }, ticksVersion);
		}
	}

	/** Puts one grant, its ticks written at the kind's ticks version `ticksVersion` (item 105). */
	#grant(
		tx: Tx,
		workspace: string,
		thing: string,
		party: Party,
		source: Source,
		{ gives, ticks, takenAway }: { gives: boolean; ticks: readonly string[]; takenAway: readonly string[] },
		ticksVersion: number,
	): void {
		tx.put(this.#t.grants, {
			workspace,
			thing,
			partyKey: partyKey(party),
			party,
			source,
			sourceKey: sourceKey(source),
			gives,
			ticks: [...ticks],
			takenAway: [...takenAway],
			ticksVersion,
		});
	}

	/** Kind `kind` as registered; `invalid` for one no plugin registers. */
	#kind(kind: string): TableItem<KindInfo> {
		const item = this.#kinds().get(kind);
		if (item === undefined) throw invalid("args", `things: no kind ${kind}`);
		return item;
	}

	/** Throws (`invalid`) unless `workspace` exists, as `tx` sees it. */
	async #mustBeWorkspace(tx: Tx, workspace: string): Promise<void> {
		if ((await tx.get(this.#t.workspaces, { workspace })) === undefined) {
			throw invalid("args", `things: no workspace ${workspace}`);
		}
	}
}
