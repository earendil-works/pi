// The things store (`ThingsStore`): the only writer of the things plugin's tables (data model F: on disk only what
// people set), their named queries, every write, and the access index in memory (`access.ts`), which its object
// owns, reads through the same named queries, and hands admissions through `AccessHandles`. Every write is one
// transaction; afterwards the index re-reads what it touched before the write answers, so a caller's next admission
// sees it. A kind's `create` hook runs after the commit that made its thing (a throw deletes the thing again), its
// `delete` hook as a persisted job of the commit that removed it (a crash reruns it at the next start).

import {
	and,
	arr,
	bool,
	type Context,
	type Ctx,
	defineColumns,
	defineJob,
	defineTable,
	eq,
	type FacetHost,
	inArray,
	int,
	invalid,
	json,
	type NamedQuery,
	nul,
	obj,
	opt,
	type P3Principal,
	prefix,
	query,
	reportError,
	type StoreSelf,
	str,
	type TableItem,
	type TableOf,
	type Tx,
	withAbortSignal,
} from "@earendil-works/p3/v1";
import { AccessIndex, type Reader, type Touched } from "./access.ts";
import { AccessHandles, type GrantInput, type ThingHook, ThingHooks, ThingsStore } from "./contract.server.ts";
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
import { messages } from "./messages.ts";
import type { Audience, GrantEntry, KindsLookup, PersonEntries, WorkspaceEntries } from "./rules.ts";

/** The kind of workspaces until the workspace kinds come (ERNDL-1143): Pi's and every one `createWorkspace` makes here. */
export const WORKSPACE_KIND = "things.workspace";

/** A thing's id and kind, joined to its grants (the kind their ticks are of). */
const ThingColumns = defineColumns("things.thing-columns", { columns: { thing: str(), kind: str() }, key: ["thing"] });

/** Every thing, a workspace too: its kind, name, own default view, who made it and when. By maker; by kind. */
const Things = defineTable("things.things", {
	version: 1,
	columns: {
		thing: str(),
		kind: str(),
		name: str(),
		view: opt(str()),
		madeBy: json(SourceSchema, { version: 1 }),
		madeByKey: str(),
		madeAt: int(),
	},
	key: ["thing"],
	indexes: { by_maker: ["madeByKey"], by_kind: ["kind"] },
	exposes: ThingColumns,
});

/**
 * The tree: each workspace's parent (`""`: Pi, the root), its two defaults, and its path (the root first, itself last;
 * as text, each id followed by `/`, for prefix searches). Children by parent; a subtree by path.
 */
const Workspaces = defineTable("things.workspaces", {
	version: 1,
	columns: {
		workspace: str(),
		parent: str(),
		showsThings: bool(),
		showsPeople: bool(),
		path: json(arr(str()), { version: 1 }),
		pathText: str(),
	},
	key: ["workspace"],
	indexes: { children: ["parent", "workspace"], under: ["pathText"] },
});

/** A thing linked into a workspace, with its kind (no second read for it). By thing: where it is linked. */
const Links = defineTable("things.links", {
	version: 1,
	columns: { workspace: str(), thing: str(), of: str() },
	key: ["workspace", "thing"],
	indexes: { by_thing: ["thing"] },
});

/** A party put into a workspace, and who did it. By party; by source (its cleanup). */
const Members = defineTable("things.members", {
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
 * the kind's version they were written at (item 91). By source (its cleanup), by party (a deleted group's), by thing (a
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
		version: int(),
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
	indexes: { by_name: ["name"], by_owner: ["owner"], by_maker: ["madeByKey"] },
});

/** A group's id and whether it is outside, joined to the memberships. */
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

/** The parties with a group's own tick (decision 68): read by the people flows only, never by the index. */
const GroupManagers = defineTable("things.group_managers", {
	version: 1,
	columns: { group: str(), partyKey: str(), party: json(Party, { version: 1 }) },
	key: ["group", "partyKey"],
});

/** A person in a group, as one source put them there (two sources: two rows). By person; by source. */
const Memberships = defineTable("things.memberships", {
	version: 1,
	columns: { group: str(), person: str(), source: json(SourceSchema, { version: 1 }), sourceKey: str() },
	key: ["group", "person", "sourceKey"],
	indexes: { by_person: ["person"], by_source: ["sourceKey"] },
});

/** A deleted thing's `delete` hook, run after the commit that deleted it, again after a crash. */
const Retire = defineJob("things.retire", {
	version: 1,
	args: obj({ thing: str(), kind: str() }),
	result: nul(),
	persist: { resume: "rerun" },
});

/** How many rows one read of an access set takes; a set is read whole, page after page. */
const PAGE = 1000;

/** Serves `ThingsStore` on `host`. */
export function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(ThingsStore, (_params, self) => {
		const t = {
			things: self.table(Things),
			workspaces: self.table(Workspaces),
			links: self.table(Links),
			members: self.table(Members),
			switches: self.table(Switches),
			grants: self.table(Grants),
			persons: self.table(Persons),
			groups: self.table(Groups),
			managers: self.table(GroupManagers),
			memberships: self.table(Memberships),
		};
		const kinds = self.registry(ThingKinds);
		const hooks = self.registry(ThingHooks);
		const q = namedQueries(self, t);
		let lookup: Kinds | undefined;
		const kindsNow = () => {
			lookup ??= lookupOf(kinds.value);
			return lookup;
		};
		const index = new AccessIndex(readerOf(q, kindsNow), kindsNow);
		// Only `open` and `attach` reach admissions: writes and the index's other operations stay the store's.
		self.contribute(AccessHandles, {
			get open() {
				return index.open;
			},
			attach: (workspace, caller, observer, ctx) => index.attach(workspace, caller, observer, ctx),
		});
		// The attempt's context: the host's telemetry, which the index's work after a write counts on (a caller's
		// context may have none).
		let attempt: Context | undefined;
		// Opened before the store goes live: Pi exists from the first start on, once. Closed with the attempt: the
		// index's watchers attach to the next attempt's.
		self.open(
			(ctx) => {
				attempt = ctx;
				return self.tx(async (tx) => ensurePi(tx, t), ctx);
			},
			() => index.close(),
		);
		// A plugin loaded, reloaded or removed: ticks expand and migrate anew, every loaded workspace is read again.
		self.on(kinds, async (_call, ctx) => {
			lookup = undefined;
			await index.kindsChanged(ctx);
		});
		const retire = self.job(Retire, {
			run: async ({ thing, kind }, ctx) => {
				await hooks.value.get(kind)?.value.delete?.(thing, ctx);
				return null;
			},
		});
		/** One transaction, then the index follows what it touched; answers what `fn` answers. */
		const write = async <R>(fn: (tx: Tx, touched: Touched) => Promise<R>, ctx: Context): Promise<R> => {
			const touched: Touched = { workspaces: new Set(), persons: new Set() };
			const result = await self.tx((tx) => fn(tx, touched), ctx);
			const signal = ctx.abortSignal;
			// The write is live, so its attempt opened.
			await index.changed(touched, signal === undefined ? attempt! : withAbortSignal(signal, attempt!));
			return result;
		};
		const writes = new Writes(
			t,
			() => kinds.value,
			(tx, thing, kind) => void tx.start(retire, { thing, kind }),
		);
		return {
			...q,
			create: async (args, ctx) => {
				const thing = await write((tx, touched) => writes.make(tx, touched, args), ctx);
				await created(thing, args.kind, args.input, hooks.value, ctx).catch(async (error: unknown) => {
					await write((tx, touched) => writes.removeThing(tx, touched, thing, args.kind), ctx);
					throw error;
				});
				return thing;
			},
			ensure: ({ kind, name, workspace, plugin }, ctx) =>
				write(async (tx, touched) => {
					const by: Source = { kind: "plugin", plugin };
					const made = query(Things).where((r) => and(eq(r.madeByKey, sourceKey(by)), eq(r.kind, kind)));
					const [found] = (await tx.page(t.things, made, 1)).items;
					return found?.thing ?? writes.make(tx, touched, { kind, name, workspace, by });
				}, ctx),
			link: (args, ctx) => write((tx, touched) => writes.link(tx, touched, args), ctx),
			unlink: (args, ctx) => write((tx, touched) => writes.unlink(tx, touched, args), ctx),
			rename: ({ thing, name }, ctx) => write(async (tx) => writes.update(tx, thing, { name }), ctx),
			setView: ({ thing, view }, ctx) => write(async (tx) => writes.update(tx, thing, { view }), ctx),
			createWorkspace: (args, ctx) => write((tx, touched) => writes.workspace(tx, touched, args), ctx),
			setSwitch: (args, ctx) => write((tx, touched) => writes.setSwitch(tx, touched, args), ctx),
			setDefaults: (args, ctx) => write((tx, touched) => writes.setDefaults(tx, touched, args), ctx),
			setGrants: (args, ctx) => write((tx, touched) => writes.setGrants(tx, touched, args), ctx),
			putParty: (args, ctx) => write((tx, touched) => writes.putParty(tx, touched, args), ctx),
			removeParty: ({ workspace, party }, ctx) =>
				write(async (tx, touched) => {
					tx.delete(t.members, { workspace, partyKey: partyKey(party) });
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
					tx.put(t.memberships, { group, person, source, sourceKey: sourceKey(source) });
					touched.persons.add(person);
					return null;
				}, ctx),
			removeFromGroup: ({ group, person, source }, ctx) =>
				write(async (tx, touched) => {
					tx.delete(t.memberships, { group, person, sourceKey: sourceKey(source) });
					touched.persons.add(person);
					return null;
				}, ctx),
			setGroupManagers: ({ group, parties }, ctx) =>
				write(async (tx) => {
					tx.deleteWhere(t.managers, (m) => eq(m.group, group));
					for (const party of parties) tx.put(t.managers, { group, partyKey: partyKey(party), party });
					return null;
				}, ctx),
			deleteEverythingFrom: ({ source }, ctx) =>
				write((tx, touched) => writes.deleteEverythingFrom(tx, touched, sourceKey(source)), ctx),
		};
	});
}

/** The store's tables, as its factory declared them. */
type Tables = {
	readonly things: TableOf<typeof Things>;
	readonly workspaces: TableOf<typeof Workspaces>;
	readonly links: TableOf<typeof Links>;
	readonly members: TableOf<typeof Members>;
	readonly switches: TableOf<typeof Switches>;
	readonly grants: TableOf<typeof Grants>;
	readonly persons: TableOf<typeof Persons>;
	readonly groups: TableOf<typeof Groups>;
	readonly managers: TableOf<typeof GroupManagers>;
	readonly memberships: TableOf<typeof Memberships>;
};

/** Every named query of the store, each with the index its condition and order search. */
function namedQueries(self: StoreSelf<P3Principal>, t: Tables) {
	return {
		things: self.queries(
			t.things,
			{ map: ({ thing, kind, name, view, madeBy, madeAt }) => ({ thing, kind, name, view, madeBy, madeAt }) },
			{
				// The key.
				one: ({ thing }: { thing: string }) => query(Things).where((r) => eq(r.thing, thing)),
				// The key, IN.
				ofIds: ({ things }: { things: string[] }) => query(Things).where((r) => inArray(r.thing, things)),
				// Index `by_maker`, then the key.
				madeBy: ({ sourceKey: key }: { sourceKey: string }) => query(Things).where((r) => eq(r.madeByKey, key)),
				// Index `by_kind`, then the key.
				ofKind: ({ kind }: { kind: string }) => query(Things).where((r) => eq(r.kind, kind)),
			},
		),
		workspaces: self.queries(
			t.workspaces,
			{
				map: ({ workspace, parent, showsThings, showsPeople, path }) => ({
					workspace,
					parent,
					showsThings,
					showsPeople,
					path,
				}),
			},
			{
				// The key.
				one: ({ workspace }: { workspace: string }) => query(Workspaces).where((w) => eq(w.workspace, workspace)),
				// Index `children`: `parent` fixed, in the order of the key.
				children: ({ parent }: { parent: string }) =>
					query(Workspaces)
						.where((w) => eq(w.parent, parent))
						.orderBy((w) => w.workspace, "asc"),
				// Index `under`: the subtree whose path text starts with `pathPrefix`, in path order.
				under: ({ pathPrefix }: { pathPrefix: string }) =>
					query(Workspaces)
						.where((w) => prefix(w.pathText, pathPrefix))
						.orderBy((w) => w.pathText, "asc"),
			},
		),
		links: self.queries(
			t.links,
			{ map: ({ workspace, thing, of }) => ({ workspace, thing, of }) },
			{
				// The key's prefix.
				here: ({ workspace }: { workspace: string }) => query(Links).where((l) => eq(l.workspace, workspace)),
				// Index `by_thing`, then the key.
				where: ({ thing }: { thing: string }) => query(Links).where((l) => eq(l.thing, thing)),
			},
		),
		members: self.queries(
			t.members,
			{ map: ({ workspace, party, source }) => ({ workspace, party, source }) },
			{
				// The key's prefix.
				here: ({ workspace }: { workspace: string }) => query(Members).where((m) => eq(m.workspace, workspace)),
				// Index `by_party`, then the key.
				where: ({ partyKey: key }: { partyKey: string }) => query(Members).where((m) => eq(m.partyKey, key)),
				// The key, IN on both its columns (a page of children and the caller's parties).
				ofParties: ({ workspaces, partyKeys }: { workspaces: string[]; partyKeys: string[] }) =>
					query(Members).where((m) => and(inArray(m.workspace, workspaces), inArray(m.partyKey, partyKeys))),
			},
		),
		switches: self.queries(
			t.switches,
			{ map: ({ workspace, item, shown }) => ({ workspace, item, shown }) },
			{
				// The key's prefix.
				here: ({ workspace }: { workspace: string }) => query(Switches).where((s) => eq(s.workspace, workspace)),
				// The key, IN on both its columns.
				ofItems: ({ workspaces, itemKeys }: { workspaces: string[]; itemKeys: string[] }) =>
					query(Switches).where((s) => and(inArray(s.workspace, workspaces), inArray(s.itemKey, itemKeys))),
			},
		),
		grants: self.queries(
			t.grants,
			{
				map: ({ workspace, thing, party, source, gives, ticks, takenAway, version }, partner) => ({
					workspace,
					thing,
					// The joined set is `ThingColumns`: its `kind` is a string.
					kind: partner.kind as string,
					version,
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
				// The key's prefix.
				of: ({ workspace, thing }: { workspace: string; thing: string }) =>
					query(Grants)
						.where((g) => and(eq(g.workspace, workspace), eq(g.thing, thing)))
						.join(ThingColumns, (g) => ({ thing: g.thing })),
				// Index `by_party`, then the key.
				ofParty: ({ partyKey: key }: { partyKey: string }) =>
					query(Grants)
						.where((g) => eq(g.partyKey, key))
						.join(ThingColumns, (g) => ({ thing: g.thing })),
				// Index `by_thing`, then the key.
				ofThing: ({ thing }: { thing: string }) =>
					query(Grants)
						.where((g) => eq(g.thing, thing))
						.join(ThingColumns, (g) => ({ thing: g.thing })),
			},
		),
		persons: self.queries(
			t.persons,
			{ map: ({ person, name, owner, madeBy }) => ({ person, name, owner: owner === 1, madeBy }) },
			{
				// The key.
				one: ({ person }: { person: string }) => query(Persons).where((p) => eq(p.person, person)),
				// The key, IN.
				ofIds: ({ persons }: { persons: string[] }) => query(Persons).where((p) => inArray(p.person, persons)),
				// Index `by_owner`: the persons whose flag is set, then the key.
				owners: (_args: Record<never, never>) => query(Persons).where((p) => eq(p.owner, 1)),
			},
		),
		groups: self.queries(
			t.groups,
			{ map: ({ group, name, managedBy, outside }) => ({ group, name, managedBy, outside }) },
			{
				// The key.
				one: ({ group }: { group: string }) => query(Groups).where((g) => eq(g.group, group)),
				// The key, IN.
				ofIds: ({ groups }: { groups: string[] }) => query(Groups).where((g) => inArray(g.group, groups)),
			},
		),
		groupManagers: self.queries(
			t.managers,
			{ map: ({ group, party }) => ({ group, party }) },
			{
				// The key's prefix.
				of: ({ group }: { group: string }) => query(GroupManagers).where((m) => eq(m.group, group)),
			},
		),
		memberships: self.queries(
			t.memberships,
			{
				// The joined set is `GroupColumns`: its `outside` is a boolean.
				map: ({ group, person, source }, partner) => ({ group, person, source, outside: partner.outside === true }),
			},
			{
				// Index `by_person`, then the key; each joined with its group by key (a membership of no group: none).
				ofPerson: ({ person }: { person: string }) =>
					query(Memberships)
						.where((m) => eq(m.person, person))
						.join(GroupColumns, (m) => ({ group: m.group })),
				// The key's prefix.
				ofGroup: ({ group }: { group: string }) =>
					query(Memberships)
						.where((m) => eq(m.group, group))
						.join(GroupColumns, (m) => ({ group: m.group })),
			},
		),
	};
}

/** The store's named queries. */
type Queries = ReturnType<typeof namedQueries>;

/** The kinds as the store reads them: the rules' lookup, and each kind's data. */
type Kinds = KindsLookup & { info(kind: string): KindInfo | undefined };

/** The kinds of `table` as `Kinds`: each kind's ticks by name with whom they are for. */
function lookupOf(table: ReadonlyMap<string, TableItem<KindInfo>>): Kinds {
	const ticks = new Map(
		[...table].map(([kind, { value }]) => [kind, new Map(value.ticks.map((tick) => [tick.name, tick.for]))]),
	);
	return {
		tickFor: (kind, tick) => ticks.get(kind)?.get(tick),
		ticksOf: (kind) => [...(ticks.get(kind)?.keys() ?? [])],
		info: (kind) => table.get(kind)?.value,
	};
}

/** How the index reads: a workspace's entries (5 reads), a person's (2), each set read whole. */
function readerOf(q: Queries, kinds: () => Kinds): Reader {
	return {
		workspace: async (id, ctx) => {
			const [row] = await readAll(q.workspaces.one, { workspace: id }, ctx);
			if (row === undefined) return undefined;
			const links = await readAll(q.links.here, { workspace: id }, ctx);
			const members = await readAll(q.members.here, { workspace: id }, ctx);
			const switches = await readAll(q.switches.here, { workspace: id }, ctx);
			const grants = await readAll(q.grants.here, { workspace: id }, ctx);
			const hides = switches.filter(
				({ item, shown }) => !shown && item.kind === "party" && item.party.kind === "person",
			);
			return {
				parent: row.parent,
				showsThings: row.showsThings,
				showsPeople: row.showsPeople,
				links: new Map(links.map(({ thing, of }) => [thing, of])),
				members: new Set(members.map(({ party }) => partyKey(party))),
				switches: new Map(switches.map(({ item, shown }) => [itemKey(item), shown])),
				hides: new Set(hides.map(({ item }) => itemKey(item))),
				grants: grants.flatMap((grant) => grantEntry(grant, kinds(), ctx)),
			} satisfies WorkspaceEntries;
		},
		person: async (id, ctx) => {
			const [row] = await readAll(q.persons.one, { person: id }, ctx);
			const memberships = await readAll(q.memberships.ofPerson, { person: id }, ctx);
			const groups = new Map(memberships.map(({ group, outside }) => [partyKey({ kind: "group", group }), outside]));
			return {
				owner: row?.owner === true,
				groups: [...groups].map(([party, outside]) => ({ party, outside })),
			} satisfies PersonEntries;
		},
	};
}

/** Every item of `named` for `args`, page after page (a set that decides access is read whole), each page counted. */
async function readAll<T, A>(named: NamedQuery<T, A>, args: A, context: Context): Promise<T[]> {
	const items: T[] = [];
	let after: string | undefined;
	do {
		const page = await named.page(args, PAGE, context, after === undefined ? {} : { after });
		context.telemetry.metrics?.counter("things.access.reads").add(1);
		items.push(...page.items);
		after = page.next;
	} while (after !== undefined);
	return items;
}

/** A grant as a read item. */
type GrantItem = Awaited<ReturnType<Queries["grants"]["here"]["page"]>>["items"][number];

/**
 * A grant as the rules read it, its ticks at its kind's version now (item 91): one written at an older version is
 * migrated by the kind's `migrateTicks`; one the kind cannot read (no migrate, or a newer version) counts for nothing
 * and is reported. A kind no plugin registers: as written (its ticks count for nothing, R3).
 */
function grantEntry(grant: GrantItem, kinds: Kinds, context: Context): GrantEntry[] {
	const { thing, party, gives, ticks, takenAway, version, kind } = grant;
	const audience: Audience = party.kind === "agents" || party.kind === "agent" ? "agents" : "people";
	const entry = { thing, party: partyKey(party), audience, gives };
	const info = kinds.info(kind);
	if (info === undefined || info.version === version) return [{ ...entry, ticks, takenAway }];
	if (version < info.version && info.migrateTicks !== undefined) {
		return [{ ...entry, ticks: info.migrateTicks(ticks, version), takenAway: info.migrateTicks(takenAway, version) }];
	}
	reportError(
		`things: a grant on ${thing} in ${grant.workspace}`,
		`written at ${kind} version ${version}, which version ${info.version} cannot read: it counts for nothing`,
		context,
	);
	return [];
}

/** Makes Pi, the root workspace, unless it exists. */
async function ensurePi(tx: Tx, t: Tables): Promise<null> {
	const roots = query(Workspaces).where((w) => eq(w.parent, ""));
	if ((await tx.page(t.workspaces, roots, 1)).items.length > 0) return null;
	const workspace = crypto.randomUUID();
	const madeBy: Source = { kind: "plugin", plugin: "@earendil-works/p3-things" };
	tx.put(t.things, {
		thing: workspace,
		kind: WORKSPACE_KIND,
		name: "Pi",
		madeBy,
		madeByKey: sourceKey(madeBy),
		madeAt: Date.now(),
	});
	tx.put(t.workspaces, {
		workspace,
		parent: "",
		showsThings: true,
		showsPeople: true,
		path: [workspace],
		pathText: `${workspace}/`,
	});
	return null;
}

/** Runs kind `kind`'s `create` hook for a new thing. */
async function created(
	thing: string,
	kind: string,
	input: unknown,
	hooks: ReadonlyMap<string, TableItem<ThingHook>>,
	ctx: Ctx<P3Principal>,
): Promise<void> {
	await hooks.get(kind)?.value.create?.(thing, input, ctx);
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

/** Whether a tick for `forWhom` may be given to `party` (R2). */
function isFor(forWhom: "agents" | "people" | "all", party: Party): boolean {
	if (forWhom === "all") return true;
	return (party.kind === "agents" || party.kind === "agent" ? "agents" : "people") === forWhom;
}

/** The store's writes inside a transaction: each says what it touched; none checks a caller (server code). */
class Writes {
	readonly #t: Tables;
	readonly #kinds: () => ReadonlyMap<string, TableItem<KindInfo>>;
	readonly #retire: (tx: Tx, thing: string, kind: string) => void;

	constructor(
		t: Tables,
		kinds: () => ReadonlyMap<string, TableItem<KindInfo>>,
		retire: (tx: Tx, thing: string, kind: string) => void,
	) {
		this.#t = t;
		this.#kinds = kinds;
		this.#retire = retire;
	}

	/** A thing of `kind` linked in `workspace`: its row, the link with the default grants, every tick for its maker. */
	async make(
		tx: Tx,
		touched: Touched,
		{ kind, name, workspace, by }: { kind: string; name: string; workspace: string; by: Source },
	): Promise<string> {
		const item = this.#kind(kind);
		await this.#mustBeWorkspace(tx, workspace);
		const thing = crypto.randomUUID();
		tx.put(this.#t.things, { thing, kind, name, madeBy: by, madeByKey: sourceKey(by), madeAt: Date.now() });
		this.#linked(tx, workspace, thing, item);
		const maker = makerParty(by);
		if (maker !== undefined) {
			const ticks = item.value.ticks.filter((tick) => isFor(tick.for, maker)).map((tick) => tick.name);
			this.#grant(tx, workspace, thing, maker, by, { gives: true, ticks, takenAway: [] }, item.value.version);
		}
		touched.workspaces.add(workspace);
		return thing;
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
	async unlink(tx: Tx, touched: Touched, { workspace, thing }: { workspace: string; thing: string }): Promise<null> {
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

	/** Removes `thing`: its links, grants and switches wherever written, its row; its kind's `delete` hook follows. */
	async removeThing(tx: Tx, touched: Touched, thing: string, kind: string): Promise<null> {
		for await (const link of tx.rows(
			this.#t.links,
			query(Links).where((l) => eq(l.thing, thing)),
		)) {
			touched.workspaces.add(link.workspace);
		}
		for await (const grant of tx.rows(
			this.#t.grants,
			query(Grants).where((g) => eq(g.thing, thing)),
		)) {
			touched.workspaces.add(grant.workspace);
		}
		const item = itemKey({ kind: "thing", thing });
		for await (const s of tx.rows(
			this.#t.switches,
			query(Switches).where((s) => eq(s.itemKey, item)),
		)) {
			touched.workspaces.add(s.workspace);
		}
		tx.deleteWhere(this.#t.links, (l) => eq(l.thing, thing));
		tx.deleteWhere(this.#t.grants, (g) => eq(g.thing, thing));
		tx.deleteWhere(this.#t.switches, (s) => eq(s.itemKey, item));
		tx.delete(this.#t.things, { thing });
		this.#retire(tx, thing, kind);
		return null;
	}

	/** Changes a thing's name or view (no access changes: nothing touched). */
	async update(tx: Tx, thing: string, set: { name: string } | { view: string | undefined }): Promise<null> {
		if ((await tx.get(this.#t.things, { thing })) === undefined) throw invalid("args", `things: no thing ${thing}`);
		tx.update(this.#t.things, { thing }, set);
		return null;
	}

	/** A workspace of `kind` under `parent`: its thing row and its line, with its path. */
	async workspace(
		tx: Tx,
		touched: Touched,
		args: { kind: string; name: string; parent: string; by: Source; showsPeople?: boolean },
	): Promise<string> {
		const parent = await tx.get(this.#t.workspaces, { workspace: args.parent });
		if (parent === undefined) throw invalid("args", `things: no workspace ${args.parent}`);
		const workspace = crypto.randomUUID();
		const { kind, name, by } = args;
		tx.put(this.#t.things, {
			thing: workspace,
			kind,
			name,
			madeBy: by,
			madeByKey: sourceKey(by),
			madeAt: Date.now(),
		});
		tx.put(this.#t.workspaces, {
			workspace,
			parent: args.parent,
			showsThings: true,
			showsPeople: args.showsPeople ?? true,
			path: [...parent.path, workspace],
			pathText: `${parent.pathText}${workspace}/`,
		});
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
				if (!isFor(info.ticks.find(({ name }) => name === tick)!.for, party)) {
					throw invalid("args", `things: ${tick} of ${kind} cannot be given to ${partyKey(party)}`, {
						message: messages.message("tickNotFor", tick, partyKey(party)),
					});
				}
			}
			if (!gives && takenAway.length === 0) {
				tx.delete(this.#t.grants, { workspace, thing, partyKey: partyKey(party), sourceKey: sourceKey(source) });
			} else this.#grant(tx, workspace, thing, party, source, { gives, ticks, takenAway }, info.version);
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
		tx.put(this.#t.members, { workspace, partyKey: partyKey(party), party, source, sourceKey: sourceKey(source) });
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
	 * Removes what the source with key `key` wrote (grants, memberships, members) and the groups it manages, with every
	 * membership in them, every `members` entry and grant naming them, whoever wrote it, and their managers.
	 */
	async deleteEverythingFrom(tx: Tx, touched: Touched, key: string): Promise<null> {
		const t = this.#t;
		for await (const g of tx.rows(
			t.grants,
			query(Grants).where((r) => eq(r.sourceKey, key)),
		)) {
			touched.workspaces.add(g.workspace);
		}
		for await (const m of tx.rows(
			t.memberships,
			query(Memberships).where((r) => eq(r.sourceKey, key)),
		)) {
			touched.persons.add(m.person);
		}
		for await (const m of tx.rows(
			t.members,
			query(Members).where((r) => eq(r.sourceKey, key)),
		)) {
			touched.workspaces.add(m.workspace);
		}
		tx.deleteWhere(t.grants, (r) => eq(r.sourceKey, key));
		tx.deleteWhere(t.memberships, (r) => eq(r.sourceKey, key));
		tx.deleteWhere(t.members, (r) => eq(r.sourceKey, key));
		for await (const { group } of tx.rows(
			t.groups,
			query(Groups).where((g) => eq(g.managedByKey, key)),
		)) {
			await this.#removeGroup(tx, touched, group);
		}
		return null;
	}

	/** Removes `group`: its memberships, every entry and grant naming it, its managers, its row. */
	async #removeGroup(tx: Tx, touched: Touched, group: string): Promise<void> {
		const t = this.#t;
		const party = partyKey({ kind: "group", group });
		for await (const m of tx.rows(
			t.memberships,
			query(Memberships).where((r) => eq(r.group, group)),
		)) {
			touched.persons.add(m.person);
		}
		for await (const m of tx.rows(
			t.members,
			query(Members).where((r) => eq(r.partyKey, party)),
		)) {
			touched.workspaces.add(m.workspace);
		}
		for await (const g of tx.rows(
			t.grants,
			query(Grants).where((r) => eq(r.partyKey, party)),
		)) {
			touched.workspaces.add(g.workspace);
		}
		tx.deleteWhere(t.memberships, (r) => eq(r.group, group));
		tx.deleteWhere(t.members, (r) => eq(r.partyKey, party));
		tx.deleteWhere(t.grants, (r) => eq(r.partyKey, party));
		tx.deleteWhere(t.managers, (r) => eq(r.group, group));
		tx.delete(t.groups, { group });
	}

	/** The link of `thing` in `workspace`, with its kind's default grants (source: the kind's plugin). */
	#linked(tx: Tx, workspace: string, thing: string, item: TableItem<KindInfo>): void {
		const { name, defaultGrants, version } = item.value;
		tx.put(this.#t.links, { workspace, thing, of: name });
		const source: Source = { kind: "plugin", plugin: item.plugin };
		const parties = [
			[{ kind: "everyone" }, defaultGrants.everyone],
			[{ kind: "agents" }, defaultGrants.agents],
		] as const;
		for (const [party, ticks] of parties) {
			if (ticks !== undefined)
				this.#grant(tx, workspace, thing, party, source, { gives: true, ticks, takenAway: [] }, version);
		}
	}

	/** Puts one grant at kind version `version`. */
	#grant(
		tx: Tx,
		workspace: string,
		thing: string,
		party: Party,
		source: Source,
		{ gives, ticks, takenAway }: { gives: boolean; ticks: readonly string[]; takenAway: readonly string[] },
		version: number,
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
			version,
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
