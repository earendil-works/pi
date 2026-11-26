// The things store (`ThingsStore`): the only writer of the things plugin's tables (data model F: on disk only what
// people set), their named queries, every write, and the access index in memory (`access.ts`), which its object
// owns, reads through the same named queries (`reader.ts`), and hands admissions through `AccessHandles`. Every write
// is one transaction, run one at a time with the index's loads, and followed by the index before the write answers,
// so a caller's next admission sees it; the index and the writes see the kinds as one snapshot, installed in the
// index's queue. A kind's seeded thing (`serveThing`'s `one`) is made here, in Pi, at the start and again whenever it
// is deleted. The kinds' delete hooks around a thing's life are `lifecycle.ts`'s.

import {
	and,
	arr,
	bool,
	type ColumnRefs,
	type Columns,
	type Condition,
	type Context,
	type Ctx,
	checkValue,
	defineColumns,
	defineTable,
	eq,
	type FacetHost,
	inArray,
	int,
	invalid,
	json,
	type P3Principal,
	prefix,
	query,
	type RowOf,
	reportError,
	type StoreSelf,
	str,
	type Table,
	type TableDefinition,
	type TableItem,
	type TableOf,
	type Tx,
} from "@earendil-works/p3/v1";
import { AccessIndex, type Touched } from "./access.ts";
import { callerOfKey } from "./admission.ts";
import { AccessHandles, type CreateAnswer, type GrantInput, ThingHooks, ThingsStore } from "./contract.server.ts";
import {
	Item,
	itemKey,
	kindOfMakeTick,
	MAKE_ANY,
	ManagedBy,
	managedByKey,
	OPEN,
	Party,
	partyKey,
	RESERVED,
	type Source,
	Source as SourceSchema,
	sourceKey,
} from "./contract.ts";
import { type DefaultGrants, type KindInfo, ThingKinds, type TickFor } from "./kind.ts";
import { Lifecycle, Pending } from "./lifecycle.ts";
import { messages } from "./messages.ts";
import { ticksNow } from "./migration.ts";
import { type Kinds, lookupOf, readerOf } from "./reader.ts";
import { Gone, Removal, Removing } from "./removal.ts";
import { audienceOf, isFor } from "./rules.ts";
import type { DefaultsChoice } from "./workspace.ts";
import { THINGS_PLUGIN, WorkspaceKind } from "./workspaces.ts";

/**
 * A thing's id, kind and name, joined to its grants (the kind their ticks are of) and to a workspace's line (its kind
 * and name).
 */
const ThingColumns = defineColumns("things.thing-columns", {
	columns: { thing: str(), kind: str(), name: str() },
	key: ["thing"],
});

/** Every thing, a workspace too: its kind, name, own default view (`""`: none), who made it and when. */
const Things = defineTable("things.things", {
	version: 1,
	columns: {
		thing: str(),
		kind: str(),
		name: str(),
		view: str(),
		madeBy: json(SourceSchema, { version: 1 }),
		madeByKey: str(),
		madeAt: int(),
	},
	key: ["thing"],
	// A plugin's one thing of a kind (`ensure`).
	indexes: { by_maker: ["madeByKey", "kind"] },
	exposes: ThingColumns,
});

/**
 * The tree: each workspace's parent (`""`: Pi, the root), its two defaults, and its path from the root (itself last),
 * also as text (each id and a `/`): children by parent, a subtree by the text's prefix (decision 107).
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
const WorkspaceMembers = defineTable("things.workspace-members", {
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
 * One row of a grant (item 112): one source's tick on a thing for a party, written in a workspace, given or withheld,
 * at the kind's ticks version it was written at (item 105). By source (its cleanup), by party (a deleted group's), by
 * thing (a deleted thing's, wherever written).
 */
const Grants = defineTable("things.grants", {
	version: 1,
	columns: {
		workspace: str(),
		thing: str(),
		partyKey: str(),
		party: json(Party, { version: 1 }),
		tick: str(),
		gives: bool(),
		ticksVersion: int(),
		source: json(SourceSchema, { version: 1 }),
		sourceKey: str(),
	},
	key: ["workspace", "thing", "partyKey", "tick", "sourceKey"],
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
const GroupMembers = defineTable("things.group-members", {
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
		const removing = self.table(Removing);
		const gone = self.table(Gone);
		const kinds = self.registry(ThingKinds);
		const hooks = self.registry(ThingHooks);
		const q = namedQueries(self, t);
		// The kinds as the store's index and writes see them: one snapshot, installed inside the index's queue when the
		// registry changes (`kindsChanged`), so an operation never mixes two generations of a kind.
		let installed: ReadonlyMap<string, TableItem<KindInfo>> | undefined;
		let lookup: Kinds | undefined;
		const kindTable = () => {
			installed ??= kinds.value;
			return installed;
		};
		const kindsNow = () => {
			lookup ??= lookupOf(kindTable());
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
			answer: async (workspace, thing, caller, ctx) => index?.answer(workspace, thing, caller, ctx),
		});
		/**
		 * One write: its transaction under `ctx`, one at a time with the index's work (`AccessIndex.commit`), which
		 * follows it before the write answers; the things it removed then have their kind's delete hook run, and a
		 * removed seeded thing is made again at once.
		 */
		const write = async <R>(fn: (tx: Tx, changes: Changes) => Promise<R>, ctx: Context): Promise<R> => {
			const retired: Retired[] = [];
			// The store is live while it writes, so its index opened.
			const result = await index!.commit((touched) => self.tx((tx) => fn(tx, { ...touched, retired }), ctx));
			for (const { thing, kind } of retired) {
				lifecycle.retire(thing, kind);
				if (hooks.value.get(kind)?.value.one !== undefined && live !== undefined) void seedKind(kind, live);
			}
			return result;
		};
		const writes = new Writes({ ...t, pending, removing, gone }, kindTable);
		const removal = new Removal({
			removing,
			gone,
			read: (fn, ctx) => self.tx(fn, ctx),
			under: (tx, pathPrefix) => writes.under(tx, pathPrefix),
			clear: async (workspace, removed, ctx) => {
				await write(async (tx, changes) => {
					await writes.clear(tx, changes, workspace);
					if (removed) tx.delete(removing, { workspace });
					return null;
				}, ctx);
			},
			hooks: () => hooks.value,
		});
		const lifecycle = new Lifecycle({
			table: pending,
			write: (fn, ctx) => write((tx) => fn(tx), ctx),
			pending: (ctx) =>
				self.tx(async (tx) => {
					const rows = [];
					// The whole table: what waits for a delete hook is few rows, read at the start and when the hooks
					// change.
					for await (const row of tx.rows(pending, query(Pending))) rows.push(row);
					return rows;
				}, ctx),
			hooks: () => hooks.value,
		});
		/**
		 * Makes a thing through the create path: the kind's create hook first, under the new id, then one commit (item
		 * 34); `commit` writes it and answers the id that stands (another one's, for a seeded thing made meanwhile).
		 * What the hook prepared for an id that does not stand is cleared durably (`lifecycle.undo`).
		 */
		const make = async (
			args: { kind: string; name: string; workspace: string; by: Source; input?: unknown },
			commit: (tx: Tx, changes: Changes, thing: string, answer: CreateAnswer | undefined) => Promise<string>,
			ctx: Ctx<P3Principal>,
		): Promise<string> => {
			// A trust boundary of the kind's: its input, given or not, is checked against the schema it declared, read
			// from the registry the hook is read from (a kind's plugin reloading: one generation, never the index's).
			const schema = kinds.value.get(args.kind)?.value.input;
			if (schema === undefined) {
				if (args.input !== undefined) throw invalid("args", `things: ${args.kind} takes no input`);
			} else {
				const failed = checkValue(schema, args.input);
				if (failed !== undefined) throw invalid("args", `things: input of ${args.kind}: ${failed}`);
			}
			const thing = crypto.randomUUID();
			// A hook that throws leaves nothing, as no row names the thing yet. A crash between the hook and the commit
			// leaves the kind's content under an id nobody knows (accepted: nothing can reach it).
			const create = hooks.value.get(args.kind)?.value.create;
			const answer = (await create?.(thing, args.input, args.by, ctx)) ?? undefined;
			let made: string;
			try {
				made = await write((tx, changes) => commit(tx, changes, thing, answer), ctx);
			} catch (error) {
				// Only a hook that ran prepared anything to clear.
				if (create !== undefined) await lifecycle.undo(thing, args.kind, ctx);
				throw error;
			}
			if (made !== thing && create !== undefined) await lifecycle.undo(thing, args.kind, ctx);
			return made;
		};
		/** The seeded things being made, by kind: one at a time per kind, a second ask waits for the first. */
		const seeding = new Map<string, Promise<string>>();
		/**
		 * Kind `kind`'s seeded thing (`serveThing`'s `one`): the one its plugin made, else one made in Pi through the
		 * create path; `invalid` for a kind that asks for none.
		 */
		const seedKind = (kind: string, ctx: Ctx<P3Principal>): Promise<string> => {
			const running = seeding.get(kind);
			if (running !== undefined) return running;
			const seeded = (async () => {
				const entry = hooks.value.get(kind);
				if (entry?.value.one === undefined) throw invalid("args", `things: ${kind} has no seeded thing`);
				const by: Source = { kind: "plugin", plugin: entry.plugin };
				const found = await self.tx((tx) => writes.one(tx, kind, by), ctx);
				if (found !== undefined) return found;
				const workspace = (await self.tx((tx) => rootOf(tx, t), ctx))!;
				const args = { kind, name: entry.value.one.name, workspace, by };
				return make(args, (tx, changes, thing) => writes.makeOne(tx, changes, { ...args, thing }), ctx);
			})();
			seeding.set(kind, seeded);
			void seeded.then(
				() => seeding.delete(kind),
				() => seeding.delete(kind),
			);
			return seeded;
		};
		/**
		 * Every kind that asks for a seeded thing has it, once its kind is registered: at the start, and when the
		 * registries change. A failure is reported; the next start, or the registries changing, tries again.
		 */
		const seed = async (ctx: Ctx<P3Principal>): Promise<void> => {
			for (const [kind, { value }] of hooks.value) {
				if (value.one === undefined || !kinds.value.has(kind)) continue;
				try {
					await seedKind(kind, ctx);
				} catch (error) {
					reportError(`things: the seeded thing of ${kind}`, error, ctx);
				}
			}
		};
		// The store's own context while it is live: what seeding after a registry change runs under.
		let live: Ctx<P3Principal> | undefined;
		// The lifecycle serves first: a seed that must undo a hook's work needs it (an undo waits for it to serve).
		self.onLive(async (ctx) => {
			live = ctx;
			await Promise.all([lifecycle.serve(ctx), removal.serve(ctx), seed(ctx)]);
		});
		// A plugin loaded, reloaded or removed: the new kinds are installed in the index's queue, ticks expand and
		// migrate anew, every loaded workspace is read again; a kind's hooks back, its waiting deletes run.
		self.on(kinds, async () => {
			const snapshot = kinds.value;
			const install = () => {
				installed = snapshot;
				lookup = undefined;
			};
			if (index === undefined) install();
			else await index.kindsChanged(install);
			if (live !== undefined) await seed(live);
		});
		self.on(hooks, async () => {
			await lifecycle.resume();
			await removal.resume();
			if (live !== undefined) await seed(live);
		});
		return {
			...q,
			create: async ({ defaults, ...args }, ctx) =>
				make(
					args,
					async (tx, changes, thing) => {
						await writes.make(tx, changes, { ...args, thing, ...(defaults === undefined ? {} : { defaults }) });
						return thing;
					},
					ctx,
				),
			createWorkspace: async ({ parent, defaults, showsPeople, ...args }, ctx) =>
				make(
					{ ...args, workspace: parent },
					async (tx, changes, thing, answer) => {
						await writes.workspace(tx, changes, {
							...args,
							thing,
							parent,
							showsPeople: answer?.showsPeople ?? showsPeople ?? true,
							defaultGrants: answer?.defaultGrants,
							defaults,
						});
						return thing;
					},
					ctx,
				),
			configure: async ({ thing, name, view, settings }, ctx) => {
				const row = (await q.things.one.page({ thing }, 1, ctx)).items[0];
				if (row === undefined) throw invalid("args", `things: no thing ${thing}`);
				// A trust boundary of the kind's: settings named by its `settings`, each checked against its member's schema.
				const checked = settings === undefined ? undefined : settingsOf(kinds.value.get(row.kind), settings);
				const configure = hooks.value.get(row.kind)?.value.configure;
				if (checked !== undefined && configure === undefined) {
					throw invalid("args", `things: ${row.kind} has no settings to configure`);
				}
				if (name !== undefined || view !== undefined)
					await write(async (tx) => writes.configure(tx, thing, name, view), ctx);
				if (checked !== undefined) await configure!(thing, checked, ctx);
				return null;
			},
			removeWorkspace: async ({ workspace }, ctx) => {
				const pathText = await write((tx, touched) => writes.cut(tx, touched, workspace), ctx);
				if (pathText !== undefined) removal.removed(workspace, pathText);
				return null;
			},
			workspaceGone: async ({ workspace }, ctx) => {
				await write(async (tx) => {
					tx.put(gone, { workspace });
					return null;
				}, ctx);
				removal.tell(workspace);
				return null;
			},
			setTick: (args, ctx) => write((tx, touched) => writes.setTick(tx, touched, args), ctx),
			answerOf: async ({ workspace, thing, caller }, ctx) =>
				(await index!.answer(workspace, thing, callerOfKey(caller), ctx)) ?? null,
			ensure: ({ kind }, ctx) => seedKind(kind, ctx),
			link: (args, ctx) => write((tx, touched) => writes.link(tx, touched, args), ctx),
			unlink: (args, ctx) => write((tx, touched) => writes.unlink(tx, touched, args), ctx),
			rename: ({ thing, name }, ctx) => write(async (tx) => writes.configure(tx, thing, name, undefined), ctx),
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
					tx.put(t.persons, { person, name, owner: 0, madeBy });
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

/** The tables the writes write: the store's, and the lifecycle's and the removal's. */
type WriteTables = Tables & {
	readonly pending: TableOf<typeof Pending>;
	readonly removing: TableOf<typeof Removing>;
	readonly gone: TableOf<typeof Gone>;
};

/** Every named query of the store, each with the index its condition and order search. */
function namedQueries(self: StoreSelf<P3Principal>, t: Tables) {
	return {
		things: self.queries(
			t.things,
			{
				map: ({ thing, kind, name, view, madeBy, madeAt }) => ({ thing, kind, name, view, madeBy, madeAt }),
			},
			{
				// The key.
				one: ({ thing }: { thing: string }) => query(Things).where((r) => eq(r.thing, thing)),
				// The key, IN: the things of a list (their kinds and names).
				ofIds: ({ things }: { things: string[] }) => query(Things).where((r) => inArray(r.thing, things)),
				// Index `by_maker`: what a source made of a kind (a seeded thing: `OneThing`).
				ofMaker: ({ sourceKey, kind }: { sourceKey: string; kind: string }) =>
					query(Things).where((r) => and(eq(r.madeByKey, sourceKey), eq(r.kind, kind))),
			},
		),
		workspaces: self.queries(
			t.workspaces,
			{
				// The joined set is `ThingColumns`: its `kind` and `name` are strings (a line whose thing is gone: "").
				map: ({ workspace, parent, showsThings, showsPeople, path, pathText }, partner) => ({
					workspace,
					kind: (partner.kind as string | undefined) ?? "",
					name: (partner.name as string | undefined) ?? "",
					parent,
					showsThings,
					showsPeople,
					path,
					pathText,
				}),
			},
			{
				// The key; joined with its thing by key (its kind and name).
				one: ({ workspace }: { workspace: string }) =>
					query(Workspaces)
						.where((w) => eq(w.workspace, workspace))
						.join(ThingColumns, (w) => ({ thing: w.workspace })),
				// Index `children`: `parent` fixed, in the order of the key.
				children: ({ parent }: { parent: string }) =>
					query(Workspaces)
						.where((w) => eq(w.parent, parent))
						.orderBy((w) => w.workspace, "asc")
						.join(ThingColumns, (w) => ({ thing: w.workspace })),
				// Index `under`: the workspaces whose path text starts with `pathPrefix` (a subtree), in its order.
				under: ({ pathPrefix }: { pathPrefix: string }) =>
					query(Workspaces)
						.where((w) => prefix(w.pathText, pathPrefix))
						.orderBy((w) => w.pathText, "asc")
						.join(ThingColumns, (w) => ({ thing: w.workspace })),
			},
		),
		links: self.queries(
			t.links,
			{ map: ({ workspace, thing, of }) => ({ workspace, thing, of }) },
			{
				// The key's prefix.
				here: ({ workspace }: { workspace: string }) => query(Links).where((l) => eq(l.workspace, workspace)),
				// Index `by_thing`: where a thing is linked.
				where: ({ thing }: { thing: string }) => query(Links).where((l) => eq(l.thing, thing)),
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
				map: ({ workspace, thing, party, source, tick, gives, ticksVersion }, partner) => ({
					workspace,
					thing,
					// The joined set is `ThingColumns`: its `kind` is a string.
					kind: partner.kind as string,
					ticksVersion,
					party,
					source,
					tick,
					gives,
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
				// The key, IN: the persons of a list (the notes plugin reads its notes' authors' names with it).
				ofIds: ({ persons }: { persons: string[] }) => query(Persons).where((p) => inArray(p.person, persons)),
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
	if ((await rootOf(tx, t)) !== undefined) return null;
	const by: Source = { kind: "plugin", plugin: "@earendil-works/p3-things" };
	putWorkspace(
		tx,
		t,
		{ workspace: crypto.randomUUID(), kind: WorkspaceKind.name, name: "Pi", by, showsPeople: true },
		undefined,
	);
	return null;
}

/** Pi, the root workspace (none only before the store first opened). */
async function rootOf(tx: Tx, t: Tables): Promise<string | undefined> {
	const roots = query(Workspaces).where((w) => eq(w.parent, ""));
	return (await tx.page(t.workspaces, roots, 1)).items[0]?.workspace;
}

/** Puts a new workspace's thing row and line under `parent` (`undefined`: the root), its path the parent's and itself. */
function putWorkspace(
	tx: Tx,
	t: Tables,
	{
		workspace,
		kind,
		name,
		by,
		showsPeople,
	}: { workspace: string; kind: string; name: string; by: Source; showsPeople: boolean },
	parent: { readonly workspace: string; readonly path: readonly string[] } | undefined,
): void {
	tx.put(t.things, {
		thing: workspace,
		kind,
		name,
		view: "",
		madeBy: by,
		madeByKey: sourceKey(by),
		madeAt: Date.now(),
	});
	const path = [...(parent?.path ?? []), workspace];
	tx.put(t.workspaces, {
		workspace,
		parent: parent?.workspace ?? "",
		showsThings: true,
		showsPeople,
		path,
		pathText: pathTextOf(path),
	});
}

/** A path as text: each id followed by `/`, so a subtree's texts start with its root's (no id holds a `/`). */
function pathTextOf(path: readonly string[]): string {
	return path.map((id) => `${id}/`).join("");
}

/**
 * The settings `settings` (wire input) of kind `item` as its `configure` hook gets them: an object of its `settings`
 * members, each value checked against the member's schema; `invalid` for anything else.
 */
function settingsOf(item: TableItem<KindInfo> | undefined, settings: unknown): Readonly<Record<string, unknown>> {
	if (item === undefined) throw invalid("args", "things: the thing's kind is not registered");
	const { name, settingsSchemas } = item.value;
	if (typeof settings !== "object" || settings === null || Array.isArray(settings))
		throw invalid("args", `things: settings of ${name} are an object`);
	for (const [member, value] of Object.entries(settings)) {
		const schema = settingsSchemas[member];
		if (schema === undefined) throw invalid("args", `things: ${member} is no setting of ${name}`);
		const failed = checkValue(schema, value);
		if (failed !== undefined) throw invalid("args", `things: ${member} of ${name}: ${failed}`);
	}
	return settings as Record<string, unknown>;
}

/**
 * The party a maker's grant names (item 90): a person, or a session's agent; none for a thing, a provider, a plugin.
 */
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

/**
 * Deletes `table`'s rows matching `where`, each one's `column` (its workspace, its person: a text) added to `told`
 * first.
 */
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
	readonly #t: WriteTables;
	readonly #kinds: () => ReadonlyMap<string, TableItem<KindInfo>>;

	constructor(t: WriteTables, kinds: () => ReadonlyMap<string, TableItem<KindInfo>>) {
		this.#t = t;
		this.#kinds = kinds;
	}

	/**
	 * Thing `thing` of `kind` linked in `workspace`: its row, the link with the default grants, every tick for its
	 * maker.
	 */
	async make(
		tx: Tx,
		touched: Touched,
		{
			thing,
			kind,
			name,
			workspace,
			by,
			defaults,
		}: { thing: string; kind: string; name: string; workspace: string; by: Source; defaults?: DefaultsChoice },
	): Promise<null> {
		const item = this.#kind(kind);
		if (item.value.workspace !== "no") throw invalid("args", `things: a ${kind} is made with createWorkspace`);
		await this.#mustBeWorkspace(tx, workspace);
		tx.put(this.#t.things, { thing, kind, name, view: "", madeBy: by, madeByKey: sourceKey(by), madeAt: Date.now() });
		this.#linked(tx, workspace, thing, item, item.value.defaultGrants, defaults);
		this.#giveMaker(tx, workspace, thing, item, by, []);
		touched.workspaces.add(workspace);
		return null;
	}

	/**
	 * Workspace `thing` of workspace kind `kind` under `parent` (never a leaf), its kind's `create` hook already run:
	 * its thing row and line (its path the parent's and itself); its maker's every tick and `MAKE_ANY` at itself and
	 * its maker put in (items 88, 90, 115); a leaf's agent put in (`agent/<id>`: its session's agent is present there);
	 * its default grants at itself (the hook's answer's, else the kind's; those left ticked in `defaults`).
	 */
	async workspace(
		tx: Tx,
		touched: Touched,
		args: {
			thing: string;
			kind: string;
			name: string;
			parent: string;
			by: Source;
			showsPeople: boolean;
			defaultGrants: DefaultGrants | undefined;
			defaults: DefaultsChoice | undefined;
		},
	): Promise<null> {
		const { thing, kind, name, parent, by, showsPeople } = args;
		const item = this.#kind(kind);
		if (item.value.workspace === "no") throw invalid("args", `things: a ${kind} is no workspace kind`);
		const above = await tx.get(this.#t.workspaces, { workspace: parent });
		if (above === undefined) throw invalid("args", `things: no workspace ${parent}`);
		const aboveKind = (await tx.get(this.#t.things, { thing: parent }))?.kind;
		if (aboveKind !== undefined && this.#kinds().get(aboveKind)?.value.workspace === "leaf") {
			throw invalid("args", `things: ${parent} is a leaf`, { message: messages.message("leafHoldsNoWorkspaces") });
		}
		putWorkspace(tx, this.#t, { workspace: thing, kind, name, by, showsPeople }, above);
		const maker = makerParty(by);
		if (maker !== undefined) {
			this.#member(tx, thing, maker, by);
			this.#giveMaker(tx, thing, thing, item, by, [MAKE_ANY]);
		}
		if (item.value.workspace === "leaf") {
			this.#member(tx, thing, { kind: "agent", session: thing }, { kind: "plugin", plugin: THINGS_PLUGIN });
		}
		this.#defaults(tx, thing, thing, item, args.defaultGrants ?? item.value.defaultGrants, args.defaults);
		touched.workspaces.add(thing);
		return null;
	}

	/**
	 * Cuts workspace `workspace`'s line (not Pi's) and keeps its removal due (`Removing`): from this commit on its
	 * subtree gives nothing; the rest is `clear`ed in the background. Answers its path text (`undefined`: no such line).
	 */
	async cut(tx: Tx, touched: Touched, workspace: string): Promise<string | undefined> {
		const line = await tx.get(this.#t.workspaces, { workspace });
		if (line === undefined) return undefined;
		if (line.parent === "") throw invalid("args", "things: Pi is never removed");
		tx.delete(this.#t.workspaces, { workspace });
		tx.put(this.#t.removing, { workspace, pathText: line.pathText });
		touched.workspaces.add(workspace);
		return line.pathText;
	}

	/** One workspace under `pathPrefix` that still has its line (index `under`). */
	async under(tx: Tx, pathPrefix: string): Promise<string | undefined> {
		// Index `under`, in its order.
		const below = query(Workspaces)
			.where((w) => prefix(w.pathText, pathPrefix))
			.orderBy((w) => w.pathText, "asc");
		return (await tx.page(this.#t.workspaces, below, 1)).items[0]?.workspace;
	}

	/**
	 * Clears workspace `workspace` (cut, or below a cut line): its links (a thing linked nowhere else goes, with its
	 * delete hook), every grant, switch and member written there, the entries naming a leaf's agent elsewhere, its line
	 * and its thing (its kind's delete hook pending); its `Gone` row put (its kinds are told). Safe to repeat.
	 */
	async clear(tx: Tx, touched: Changes, workspace: string): Promise<void> {
		const t = this.#t;
		// Reads first: Chord refuses a `get` on a table after a `deleteWhere` on it in the same transaction.
		const row = await tx.get(t.things, { thing: workspace });
		const going = [];
		for await (const link of tx.rows(
			t.links,
			query(Links).where((l) => eq(l.workspace, workspace)),
		)) {
			const where = await tx.page(
				t.links,
				query(Links).where((l) => eq(l.thing, link.thing)),
				2,
			);
			if (where.items.every((other) => other.workspace === workspace)) going.push(link);
		}
		for (const { thing, of } of going) await this.removeThing(tx, touched, thing, of);
		tx.deleteWhere(t.links, (l) => eq(l.workspace, workspace));
		tx.deleteWhere(t.grants, (g) => eq(g.workspace, workspace));
		tx.deleteWhere(t.switches, (w) => eq(w.workspace, workspace));
		tx.deleteWhere(t.workspaceMembers, (m) => eq(m.workspace, workspace));
		const agent = partyKey({ kind: "agent", session: workspace });
		await deleteTold(
			tx,
			t.workspaceMembers,
			WorkspaceMembers,
			(m) => eq(m.partyKey, agent),
			touched.workspaces,
			"workspace",
		);
		await deleteTold(tx, t.grants, Grants, (g) => eq(g.partyKey, agent), touched.workspaces, "workspace");
		tx.delete(t.workspaces, { workspace });
		if (row !== undefined) {
			tx.delete(t.things, { thing: workspace });
			tx.put(t.pending, { thing: workspace, kind: row.kind });
			touched.retired.push({ thing: workspace, kind: row.kind });
		}
		tx.put(t.gone, { workspace });
		touched.workspaces.add(workspace);
	}

	/** The thing of `kind` that `by` made, if any (a plugin's one thing: `ensure`). */
	async one(tx: Tx, kind: string, by: Source): Promise<string | undefined> {
		const key = sourceKey(by);
		const mine = query(Things).where((r) => and(eq(r.madeByKey, key), eq(r.kind, kind)));
		return (await tx.page(this.#t.things, mine, 1)).items[0]?.thing;
	}

	/** `make`, unless `by` made a thing of `kind` meanwhile: answers the thing that stands. */
	async makeOne(
		tx: Tx,
		touched: Touched,
		args: { thing: string; kind: string; name: string; workspace: string; by: Source },
	): Promise<string> {
		const found = await this.one(tx, args.kind, args.by);
		if (found !== undefined) return found;
		await this.make(tx, touched, args);
		return args.thing;
	}

	/**
	 * Links `thing` into `workspace` with its kind's default grants (once; a kind of `workspaces: "one"` once at all),
	 * those left ticked in `defaults` (item 93). A workspace is placed by its parent, never linked.
	 */
	async link(
		tx: Tx,
		touched: Touched,
		{ workspace, thing, defaults }: { workspace: string; thing: string; defaults?: DefaultsChoice },
	): Promise<null> {
		const row = await tx.get(this.#t.things, { thing });
		if (row === undefined) throw invalid("args", `things: no thing ${thing}`);
		const item = this.#kind(row.kind);
		if (item.value.workspace !== "no")
			throw invalid("args", "things: a workspace is placed by its parent, never linked");
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
		this.#linked(tx, workspace, thing, item, item.value.defaultGrants, defaults);
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

	/** Changes a thing's name and its own default view (`""`: the kind's); no access changes: nothing touched. */
	async configure(tx: Tx, thing: string, name: string | undefined, view: string | undefined): Promise<null> {
		if ((await tx.get(this.#t.things, { thing })) === undefined) throw invalid("args", `things: no thing ${thing}`);
		tx.update(
			this.#t.things,
			{ thing },
			{ ...(name === undefined ? {} : { name }), ...(view === undefined ? {} : { view }) },
		);
		return null;
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
	 * Writes `source`'s grant rows, each at its kind's ticks version now; one without `gives` is removed, whatever its
	 * tick. A written row's tick is one its kind has or `OPEN` (no other reserved tick, item 113); a giving one only
	 * where the thing is linked (R15), given only to whom it is for (R2).
	 */
	async setGrants(
		tx: Tx,
		touched: Touched,
		{ source, grants }: { source: Source; grants: GrantInput[] },
	): Promise<null> {
		const upgraded = new Set<string>();
		for (const { workspace, thing, party, tick, gives } of grants) {
			const link = await tx.get(this.#t.links, { workspace, thing });
			// A workspace's own grants are written at itself (item 88): there it is as linked.
			const own = thing === workspace;
			if (gives === true && link === undefined && !own) {
				throw invalid("args", `things: ${thing} is not linked in ${workspace}: ticks are given where it is`, {
					message: messages.message("belowLink", workspace),
				});
			}
			const kind = link?.of ?? (await tx.get(this.#t.things, { thing }))?.kind;
			if (kind === undefined) throw invalid("args", `things: no thing ${thing}`);
			const info = this.#kind(kind).value;
			const made = kindOfMakeTick(tick);
			const declared =
				made === undefined
					? info.ticks.find(({ name }) => name === tick)
					: own && info.workspace !== "no"
						? this.#makeTick(made, tick)
						: undefined;
			// A row is removed whatever its tick (one the kind lost too); written, its tick must be the kind's, `OPEN`,
			// or on a workspace's own grants a Make tick of a registered kind (item 114).
			if (gives !== undefined && tick !== OPEN && declared === undefined) {
				throw invalid("args", `things: ${kind} has no tick ${tick}`);
			}
			if (gives === true && declared !== undefined && !isFor(declared.for, audienceOf(party.kind))) {
				throw invalid("args", `things: ${tick} of ${kind} cannot be given to ${partyKey(party)}`, {
					message: messages.message("tickNotFor", tick, partyKey(party)),
				});
			}
			const key = { workspace, thing, partyKey: partyKey(party), tick, sourceKey: sourceKey(source) };
			// The source's older rows for the party, written back at the kind's ticks version first (item 105), so the
			// edit names the ticks as they read now; once per thing and party in one write (a Map key, built once).
			const at = `${workspace}\n${thing}\n${key.partyKey}`;
			if (!upgraded.has(at)) {
				upgraded.add(at);
				await this.#upgrade(tx, key, info);
			}
			if (gives === undefined) tx.delete(this.#t.grants, key);
			else this.#grant(tx, workspace, thing, party, source, tick, gives, info.ticksVersion);
			touched.workspaces.add(workspace);
		}
		return null;
	}

	/**
	 * Writes back the rows of `key`'s source for its party on its thing in its workspace that are at an older ticks
	 * version than `info`'s, planned from the rows as they are: the named ticks of one `gives` value and version migrate
	 * together (`ticksNow`; a group of reserved ticks only, `OPEN`, never calls the migration), reserved ticks stay as
	 * they are. Every converted row goes first, then the outputs are put at the version now; where a given and a
	 * withheld output meet at one tick it stays withheld, as the index reads them (a row's key has no `gives`, so only
	 * one can stand). Rows that cannot be read now (a migration that throws, a newer version) are left as they are;
	 * an output meeting one is not put, unless it withholds what that row (giving nothing now) would give.
	 */
	async #upgrade(
		tx: Tx,
		key: { workspace: string; thing: string; partyKey: string; sourceKey: string },
		info: KindInfo,
	): Promise<void> {
		const { workspace, thing, partyKey: party, sourceKey: source } = key;
		const mine = query(Grants).where((g) =>
			and(eq(g.workspace, workspace), eq(g.thing, thing), eq(g.partyKey, party), eq(g.sourceKey, source)),
		);
		const rows = [];
		for await (const row of tx.rows(this.#t.grants, mine)) rows.push(row);
		const current = new Set(rows.filter((row) => row.ticksVersion === info.ticksVersion).map(({ tick }) => tick));
		const older = new Map<string, typeof rows>();
		for (const row of rows) {
			if (row.ticksVersion === info.ticksVersion) continue;
			const key = `${row.gives}\n${row.ticksVersion}`;
			const group = older.get(key);
			if (group === undefined) older.set(key, [row]);
			else group.push(row);
		}
		const outputs = new Map<string, (typeof rows)[number]>();
		const unreadable = new Map<string, (typeof rows)[number]>();
		for (const group of older.values()) {
			const first = group[0]!;
			const named = group.filter(({ tick }) => !tick.startsWith(RESERVED)).map(({ tick }) => tick);
			let now: readonly string[];
			try {
				now = named.length === 0 ? [] : ticksNow(info, named, first.ticksVersion);
			} catch {
				for (const row of group) unreadable.set(row.tick, row);
				continue;
			}
			const reserved = group.filter(({ tick }) => tick.startsWith(RESERVED)).map(({ tick }) => tick);
			for (const row of group)
				tx.delete(this.#t.grants, { workspace, thing, partyKey: party, tick: row.tick, sourceKey: source });
			for (const tick of [...now, ...reserved]) {
				const before = outputs.get(tick);
				if (before === undefined || (before.gives && !first.gives))
					outputs.set(tick, { ...first, tick, ticksVersion: info.ticksVersion });
			}
		}
		for (const [tick, row] of outputs) {
			// A row already at the version now beats a migrated withheld one; both exist only after a write-back
			// failed for this group earlier (its migration threw then): accepted.
			if (current.has(tick)) continue;
			const kept = unreadable.get(tick);
			if (kept !== undefined && (row.gives || !kept.gives)) continue;
			tx.put(this.#t.grants, row);
		}
	}

	/**
	 * Make tick `tick` of kind `made` (`*`: every kind) as a tick a grant may name: whom it is for, from the kind's
	 * `makers` (item 114); `undefined` for a kind that is not registered or that only its plugin makes.
	 */
	#makeTick(made: string, tick: string): { readonly name: string; readonly for: TickFor } | undefined {
		if (made === "*") return { name: tick, for: "all" };
		switch (this.#kinds().get(made)?.value.makers) {
			case "anyone":
				return { name: tick, for: "all" };
			case "people":
				return { name: tick, for: "people" };
			default:
				return undefined;
		}
	}

	/**
	 * One checkbox (item 112): every row of `party`'s `tick` on `thing` written in `workspace`, whatever its source, goes;
	 * then `source`'s one row, if `gives` says one (checked as `setGrants` checks it).
	 */
	async setTick(
		tx: Tx,
		touched: Touched,
		args: { workspace: string; thing: string; party: Party; tick: string; gives?: boolean; source: Source },
	): Promise<null> {
		const { workspace, thing, party, tick, gives, source } = args;
		const key = partyKey(party);
		tx.deleteWhere(this.#t.grants, (g) =>
			and(eq(g.workspace, workspace), eq(g.thing, thing), eq(g.partyKey, key), eq(g.tick, tick)),
		);
		touched.workspaces.add(workspace);
		if (gives === undefined) return null;
		return this.setGrants(tx, touched, { source, grants: [{ workspace, thing, party, tick, gives }] });
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
	 * Removes what the source with key `key` wrote (grants, group members, workspace members) and the groups it manages,
	 * with every member of them, every workspace entry and grant naming them, whoever wrote it.
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

	/** The link of `thing` in `workspace`, with default grants `granted` (those left ticked in `defaults`). */
	#linked(
		tx: Tx,
		workspace: string,
		thing: string,
		item: TableItem<KindInfo>,
		granted: DefaultGrants,
		defaults: DefaultsChoice | undefined,
	): void {
		tx.put(this.#t.links, { workspace, thing, of: item.value.name });
		this.#defaults(tx, workspace, thing, item, granted, defaults);
	}

	/**
	 * Default grants `granted` of `item`'s kind on `thing` in `workspace` (source: the kind's plugin, item 93), each
	 * party's only with the ticks `defaults` left ticked (`OPEN` stands for a default of none); a choice naming a tick
	 * the defaults do not is refused.
	 */
	#defaults(
		tx: Tx,
		workspace: string,
		thing: string,
		item: TableItem<KindInfo>,
		granted: DefaultGrants,
		defaults: DefaultsChoice | undefined,
	): void {
		const source: Source = { kind: "plugin", plugin: item.plugin };
		const parties = [
			[{ kind: "everyone" }, granted.everyone, defaults?.everyone],
			[{ kind: "agents" }, granted.agents, defaults?.agents],
		] as const;
		for (const [party, ticks, kept] of parties) {
			if (ticks === undefined) continue;
			const offered = ticks.length === 0 ? [OPEN] : ticks;
			for (const tick of kept ?? []) {
				if (!offered.includes(tick))
					throw invalid("args", `things: ${tick} is no default of ${item.value.name} for ${party.kind}`);
			}
			const written = kept === undefined ? offered : offered.filter((tick) => kept.includes(tick));
			for (const tick of written)
				this.#grant(tx, workspace, thing, party, source, tick, true, item.value.ticksVersion);
		}
	}

	/**
	 * Its maker's grant on a new thing (item 90): every tick of the kind for the maker's audience and `extra` (a
	 * workspace's `MAKE_ANY`), at `workspace`, the maker its source; none for a maker that is no party (a plugin).
	 */
	#giveMaker(
		tx: Tx,
		workspace: string,
		thing: string,
		item: TableItem<KindInfo>,
		by: Source,
		extra: readonly string[],
	): void {
		const maker = makerParty(by);
		if (maker === undefined) return;
		const ticks = item.value.ticks.filter((tick) => isFor(tick.for, audienceOf(maker.kind))).map((tick) => tick.name);
		this.#give(tx, workspace, thing, maker, by, [...ticks, ...extra], item.value.ticksVersion);
	}

	/** Puts `party` into `workspace` (`source` did). */
	#member(tx: Tx, workspace: string, party: Party, source: Source): void {
		tx.put(this.#t.workspaceMembers, {
			workspace,
			partyKey: partyKey(party),
			party,
			source,
			sourceKey: sourceKey(source),
		});
	}

	/** Gives `party` `ticks` (none: `OPEN`, item 113) on `thing` in `workspace`: one row each. */
	#give(
		tx: Tx,
		workspace: string,
		thing: string,
		party: Party,
		source: Source,
		ticks: readonly string[],
		ticksVersion: number,
	): void {
		for (const tick of ticks.length === 0 ? [OPEN] : ticks) {
			this.#grant(tx, workspace, thing, party, source, tick, true, ticksVersion);
		}
	}

	/** Puts one grant row, its tick written at the kind's ticks version `ticksVersion` (item 105). */
	#grant(
		tx: Tx,
		workspace: string,
		thing: string,
		party: Party,
		source: Source,
		tick: string,
		gives: boolean,
		ticksVersion: number,
	): void {
		tx.put(this.#t.grants, {
			workspace,
			thing,
			partyKey: partyKey(party),
			party,
			tick,
			gives,
			ticksVersion,
			source,
			sourceKey: sourceKey(source),
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
