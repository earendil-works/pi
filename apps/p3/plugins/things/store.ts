// The things store (`ThingsStore`): the only writer of the things plugin's tables (data model F: on disk only what
// people set), their named queries, every write, and the access index in memory (`access.ts`), which its object
// owns, reads through the same named queries (`reader.ts`), and hands admissions through `AccessHandles`. Every write
// is one transaction, run one at a time with the index's loads, and followed by the index before the write answers,
// so a caller's next admission sees it; the index and the writes see the kinds as one snapshot, installed in the
// index's queue. A kind's seeded thing (`serveThing`'s `one`) is made here, in Pi, at the start and again whenever it
// is deleted. The kinds' delete hooks around a thing's life are `lifecycle.ts`'s.

import {
	and,
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
import { ServerRuntime } from "@earendil-works/p3/v1/server";
import { AccessIndex, type Touched } from "./access.ts";
import { AccessHandles, type GrantInput, ThingHooks, ThingsStore } from "./contract.server.ts";
import {
	Item,
	itemKey,
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
import { type KindInfo, ThingKinds } from "./kind.ts";
import { Lifecycle, Pending } from "./lifecycle.ts";
import { messages } from "./messages.ts";
import { ticksNow } from "./migration.ts";
import {
	endSignIns,
	GroupColumns,
	GroupManagers,
	GroupMembers,
	Groups,
	openPeopleTables,
	ownerName,
	type PeopleTables,
	PeopleWrites,
	PersonColumns,
	Persons,
	SignOuts,
} from "./people.ts";
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
	// A plugin's one thing of a kind (`ensure`).
	indexes: { by_maker: ["madeByKey", "kind"] },
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
			...openPeopleTables(self),
		};
		const pending = self.table(Pending);
		const kinds = self.registry(ThingKinds);
		const hooks = self.registry(ThingHooks);
		const q = namedQueries(self, t);
		const people = new PeopleWrites(t);
		const runtime = self.registry(ServerRuntime);
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
				await self.tx(async (tx) => {
					await people.ensureOwner(tx, ownerName(runtime.value.machine.user));
					return ensurePi(tx, t);
				}, ctx);
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
		 * One write: its transaction under `ctx`, one at a time with the index's work (`AccessIndex.commit`), which
		 * follows it before the write answers; the things it removed then have their kind's delete hook run, and a
		 * removed seeded thing is made again at once.
		 */
		const write = async <R>(fn: (tx: Tx, changes: Changes) => Promise<R>, ctx: Context): Promise<R> => {
			const retired: Retired[] = [];
			const signedOut: string[] = [];
			// The store is live while it writes, so its index opened.
			const result = await index!.commit((touched) =>
				self.tx((tx) => fn(tx, { ...touched, retired, signedOut }), ctx),
			);
			if (signedOut.length > 0 && live !== undefined) void signOut(signedOut, live);
			for (const { thing, kind } of retired) {
				lifecycle.retire(thing, kind);
				if (hooks.value.get(kind)?.value.one !== undefined && live !== undefined) {
					// Made again under the store's own context; a failure is reported (the next start seeds it).
					const own = live;
					seedKind(kind, own).catch((error) =>
						reportError(`things: the seeded thing of ${kind}, made again`, error, own),
					);
				}
			}
			return result;
		};
		const writes = new Writes({ ...t, pending }, kindTable);
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
			commit: (tx: Tx, changes: Changes, thing: string) => Promise<string>,
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
			await create?.(thing, args.input, args.by, ctx);
			let made: string;
			try {
				made = await write((tx, changes) => commit(tx, changes, thing), ctx);
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
		/**
		 * Ends the sign-ins of the removed persons `persons` (their rows in `things.sign-outs`, written in the commit
		 * that removed them), then drops the rows; a failure is reported, and the next start tries again.
		 */
		const signOut = async (persons: readonly string[], ctx: Ctx<P3Principal>): Promise<void> => {
			try {
				await endSignIns(persons, ctx);
				await self.tx(async (tx) => {
					for (const person of persons) tx.delete(t.signOuts, { person });
					return null;
				}, ctx);
			} catch (error) {
				reportError("things: the sign-ins of removed persons; tried again at the next start", error, ctx);
			}
		};
		self.onLive(async (ctx) => {
			live = ctx;
			const left = await self.tx(async (tx) => {
				const persons = [];
				// The whole table: removed persons whose sign-ins are still to end are few, read at the start only.
				for await (const { person } of tx.rows(t.signOuts, query(SignOuts))) persons.push(person);
				return persons;
			}, ctx);
			if (left.length > 0) void signOut(left, ctx);
			await Promise.all([lifecycle.serve(ctx), seed(ctx)]);
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
			if (live !== undefined) await seed(live);
		});
		return {
			...q,
			create: async (args, ctx) =>
				make(
					args,
					async (tx, changes, thing) => {
						await writes.make(tx, changes, { ...args, thing });
						return thing;
					},
					ctx,
				),
			ensure: ({ kind }, ctx) => seedKind(kind, ctx),
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
			createPerson: (args, ctx) => write(async (tx) => people.createPerson(tx, args), ctx),
			renamePerson: ({ person, name }, ctx) =>
				write(async (tx) => {
					await people.renamePerson(tx, person, name);
					return null;
				}, ctx),
			setOwner: (args, ctx) =>
				write(async (tx, touched) => {
					await people.setOwner(tx, touched, args);
					return null;
				}, ctx),
			removePerson: ({ person }, ctx) => write((tx, touched) => writes.removePerson(tx, touched, person), ctx),
			makeGroup: (args, ctx) => write(async (tx) => people.makeGroup(tx, { ...args, managers: [] }), ctx),
			renameGroup: ({ group, name }, ctx) =>
				write(async (tx) => {
					await people.renameGroup(tx, group, name);
					return null;
				}, ctx),
			setGroupManagers: ({ group, parties }, ctx) =>
				write(async (tx) => {
					await people.setGroupManagers(tx, group, parties);
					return null;
				}, ctx),
			removeGroup: ({ group }, ctx) => write((tx, touched) => writes.removeGroup(tx, touched, group), ctx),
			addToGroup: (args, ctx) =>
				write(async (tx, touched) => {
					await people.addToGroup(tx, touched, args);
					return null;
				}, ctx),
			removeFromGroup: (args, ctx) =>
				write(async (tx, touched) => {
					people.removeFromGroup(tx, touched, args);
					return null;
				}, ctx),
			deleteEverythingFrom: ({ source }, ctx) =>
				write((tx, touched) => writes.deleteEverythingFrom(tx, touched, sourceKey(source)), ctx),
		};
	});
}

/** What a write tells besides what it touched: the things it removed (their delete hooks run after the commit). */
type Changes = Touched & { readonly retired: Retired[]; readonly signedOut: string[] };

/** A thing removed, and its kind. */
type Retired = { readonly thing: string; readonly kind: string };

/** The store's tables, as its factory declared them. */
type Tables = PeopleTables & {
	readonly things: TableOf<typeof Things>;
	readonly workspaces: TableOf<typeof Workspaces>;
	readonly links: TableOf<typeof Links>;
	readonly workspaceMembers: TableOf<typeof WorkspaceMembers>;
	readonly switches: TableOf<typeof Switches>;
	readonly grants: TableOf<typeof Grants>;
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
				// Index `by_maker`: what a source made of a kind (a seeded thing: `OneThing`).
				ofMaker: ({ sourceKey, kind }: { sourceKey: string; kind: string }) =>
					query(Things).where((r) => and(eq(r.madeByKey, sourceKey), eq(r.kind, kind))),
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
				// Index `by_owner`: the persons with the owner flag (the owner link signs in as the first).
				owners: (_args: Record<never, never>) => query(Persons).where((p) => eq(p.owner, 1)),
			},
		),
		groups: self.queries(
			t.groups,
			{ map: ({ group, name, managedBy, outside }) => ({ group, name, managedBy, outside }) },
			{
				// The key.
				one: ({ group }: { group: string }) => query(Groups).where((g) => eq(g.group, group)),
			},
		),
		groupManagers: self.queries(
			t.groupManagers,
			{ map: ({ group, party }) => ({ group, party }) },
			{
				// The key's prefix.
				of: ({ group }: { group: string }) => query(GroupManagers).where((m) => eq(m.group, group)),
			},
		),
		groupMembersNamed: self.queries(
			t.groupMembers,
			{
				// The joined set is `PersonColumns`: its `name` is a string.
				map: ({ group, person, source }, partner) => ({ group, person, source, name: partner.name as string }),
			},
			{
				// The key's prefix; each joined with its person by key.
				ofGroup: ({ group }: { group: string }) =>
					query(GroupMembers)
						.where((m) => eq(m.group, group))
						.join(PersonColumns, (m) => ({ person: m.person })),
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
	putWorkspace(tx, t, { kind: WORKSPACE_KIND, name: "Pi", by, showsPeople: true }, "");
	return null;
}

/** Pi, the root workspace (none only before the store first opened). */
async function rootOf(tx: Tx, t: Tables): Promise<string | undefined> {
	const roots = query(Workspaces).where((w) => eq(w.parent, ""));
	return (await tx.page(t.workspaces, roots, 1)).items[0]?.workspace;
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
	readonly #t: Tables & { readonly pending: TableOf<typeof Pending> };
	readonly #kinds: () => ReadonlyMap<string, TableItem<KindInfo>>;

	constructor(
		t: Tables & { readonly pending: TableOf<typeof Pending> },
		kinds: () => ReadonlyMap<string, TableItem<KindInfo>>,
	) {
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
			this.#give(tx, workspace, thing, maker, by, ticks, item.value.ticksVersion);
		}
		touched.workspaces.add(workspace);
		return null;
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
	 * Links `thing` into `workspace` with its kind's default grants (once; a kind of `workspaces: "one"` once at all).
	 */
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
			if (gives === true && link === undefined) {
				throw invalid("args", `things: ${thing} is not linked in ${workspace}: ticks are given where it is`, {
					message: messages.message("belowLink", workspace),
				});
			}
			const kind = link?.of ?? (await tx.get(this.#t.things, { thing }))?.kind;
			if (kind === undefined) throw invalid("args", `things: no thing ${thing}`);
			const info = this.#kind(kind).value;
			const declared = info.ticks.find(({ name }) => name === tick);
			// A row is removed whatever its tick (one the kind lost too); written, its tick must be the kind's or `OPEN`.
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
	 * one can stand). Rows that cannot be read now (a migration that throws, a newer version) are left as they are. An
	 * output meeting a row of its tick that stays (at the version now, or one that cannot be read) is not put, unless
	 * it withholds what that row gives.
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
		const current = new Map(
			rows.filter((row) => row.ticksVersion === info.ticksVersion).map((row) => [row.tick, row]),
		);
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
			// A row of the tick there already (at the version now, or one that cannot be read) stays, unless the output
			// withholds what it gives: withheld wins, as the index reads them.
			const there = current.get(tick) ?? unreadable.get(tick);
			if (there !== undefined && (row.gives || !there.gives)) continue;
			tx.put(this.#t.grants, row);
		}
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

	/**
	 * The cleanup when a source goes (one policy, one commit): (1) what the source with key `key` wrote (grants, group
	 * members, workspace members); (2) the groups it manages, with all that names them, whoever wrote it; (3) the
	 * persons it made of whom nothing is left after that (their sign-ins end after the commit).
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
		const managed = [];
		for await (const { group } of tx.rows(
			t.groups,
			query(Groups).where((g) => eq(g.managedByKey, key)),
		)) {
			managed.push(group);
		}
		for (const group of managed) await this.removeGroup(tx, touched, group);
		const made = [];
		for await (const { person, owner } of tx.rows(
			t.persons,
			query(Persons).where((p) => eq(p.madeByKey, key)),
		)) {
			if (owner === 0) made.push(person);
		}
		for (const person of made) if (await this.#nothingLeftOf(tx, person)) await this.#dropPerson(tx, touched, person);
		return null;
	}

	/** Removes `group`: its members, its managers, every workspace entry and grant naming it, its row. */
	async removeGroup(tx: Tx, touched: Touched, group: string): Promise<null> {
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
		await deleteTold(tx, t.switches, Switches, (r) => eq(r.itemKey, party), touched.workspaces, "workspace");
		tx.deleteWhere(t.groupManagers, (m) => eq(m.group, group));
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

	/** Whether nothing is left of `person`: no membership, entry, grant or manager row names them or is theirs. */
	async #nothingLeftOf(tx: Tx, person: string): Promise<boolean> {
		const t = this.#t;
		const party = partyKey({ kind: "person", person });
		const own = sourceKey({ kind: "person", person });
		const probes = [
			tx.page(t.groupMembers, query(GroupMembers).where((r) => eq(r.person, person)), 1),
			tx.page(t.workspaceMembers, query(WorkspaceMembers).where((r) => eq(r.partyKey, party)), 1),
			tx.page(t.grants, query(Grants).where((r) => eq(r.partyKey, party)), 1),
			tx.page(t.groupManagers, query(GroupManagers).where((r) => eq(r.partyKey, party)), 1),
			tx.page(t.grants, query(Grants).where((r) => eq(r.sourceKey, own)), 1),
			tx.page(t.groupMembers, query(GroupMembers).where((r) => eq(r.sourceKey, own)), 1),
			tx.page(t.workspaceMembers, query(WorkspaceMembers).where((r) => eq(r.sourceKey, own)), 1),
		];
		for (const probe of probes) if ((await probe).items.length > 0) return false;
		return true;
	}

	/**
	 * Drops `person` and everything naming them (memberships, entries, grants, manager rows, switches), their invite
	 * links and their row; a sign-out row ends their sign-ins after the commit.
	 */
	async #dropPerson(tx: Tx, touched: Changes, person: string): Promise<void> {
		const t = this.#t;
		const party = partyKey({ kind: "person", person });
		await deleteTold(tx, t.groupMembers, GroupMembers, (r) => eq(r.person, person), touched.persons, "person");
		await deleteTold(
			tx,
			t.workspaceMembers,
			WorkspaceMembers,
			(r) => eq(r.partyKey, party),
			touched.workspaces,
			"workspace",
		);
		await deleteTold(tx, t.grants, Grants, (r) => eq(r.partyKey, party), touched.workspaces, "workspace");
		await deleteTold(tx, t.switches, Switches, (r) => eq(r.itemKey, party), touched.workspaces, "workspace");
		tx.deleteWhere(t.groupManagers, (r) => eq(r.partyKey, party));
		tx.deleteWhere(t.invites, (r) => eq(r.byKey, sourceKey({ kind: "person", person })));
		tx.delete(t.persons, { person });
		tx.put(t.signOuts, { person });
		touched.persons.add(person);
		touched.signedOut.push(person);
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
			if (ticks !== undefined) this.#give(tx, workspace, thing, party, source, ticks, ticksVersion);
		}
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
