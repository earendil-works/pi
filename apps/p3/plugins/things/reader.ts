// How the access index reads the things store: one workspace's entries (5 reads) and one person's (2), through the
// store's named queries, each set read whole, its grant rows' ticks at their kind's ticks version now (item 105,
// `migration.ts`): `readerOf`, with the kinds as the index looks them up (`lookupOf`).

import { type Context, type NamedQuery, type Reference, reportError, type TableItem } from "@earendil-works/p3/v1";
import type { Reader } from "./access.ts";
import type { ThingsStore } from "./contract.server.ts";
import { itemKey, partyKey, RESERVED, sourceKey } from "./contract.ts";
import type { KindInfo } from "./kind.ts";
import { ticksNow } from "./migration.ts";
import { audienceOf, type GrantEntry, type KindsLookup, type PersonEntries, type WorkspaceEntries } from "./rules.ts";

/** The kinds as the store reads them: the rules' lookup, and each kind's data. */
export type Kinds = KindsLookup & { info(kind: string): KindInfo | undefined };

/** The kinds of `table` as `Kinds`: each kind's ticks by name with whom they are for, and its ticks version. */
export function lookupOf(table: ReadonlyMap<string, TableItem<KindInfo>>): Kinds {
	const ticks = new Map(
		[...table].map(([kind, { value }]) => [kind, new Map(value.ticks.map((tick) => [tick.name, tick.for]))]),
	);
	return {
		tickFor: (kind, tick) => ticks.get(kind)?.get(tick),
		ticksOf: (kind) => [...(ticks.get(kind)?.keys() ?? [])],
		ticksVersionOf: (kind) => table.get(kind)?.value.ticksVersion ?? 0,
		info: (kind) => table.get(kind)?.value,
	};
}

/** The named queries the index reads through: the store's own, or a reference's. */
export type Read = Pick<
	Reference<typeof ThingsStore>,
	"workspaces" | "links" | "workspaceMembers" | "switches" | "grants" | "persons" | "groupMembers"
>;

/**
 * How the index reads through `q`, the kinds now from `kinds`. Rows of a grant its kind cannot read are reported once
 * each for the life of `reported` (the store object's).
 */
export function readerOf(q: Read, kinds: () => Kinds, reported: Set<string>): Reader {
	return {
		workspace: async (id, ctx) => {
			const [row] = await readAll(q.workspaces.one, { workspace: id }, ctx);
			if (row === undefined) return undefined;
			const links = await readAll(q.links.here, { workspace: id }, ctx);
			const members = await readAll(q.workspaceMembers.here, { workspace: id }, ctx);
			const switches = await readAll(q.switches.here, { workspace: id }, ctx);
			const grants = await readAll(q.grants.here, { workspace: id }, ctx);
			return {
				parent: row.parent,
				showsThings: row.showsThings,
				showsPeople: row.showsPeople,
				links: new Map(links.map(({ thing, of }) => [thing, of])),
				members: new Set(members.map(({ party }) => partyKey(party))),
				switches: new Map(switches.map(({ item, shown }) => [itemKey(item), shown])),
				grants: grantEntries(grants, kinds(), reported, ctx),
			} satisfies WorkspaceEntries;
		},
		person: async (id, ctx) => {
			const [row] = await readAll(q.persons.one, { person: id }, ctx);
			const members = await readAll(q.groupMembers.ofPerson, { person: id }, ctx);
			const groups = new Map(members.map(({ group, outside }) => [partyKey({ kind: "group", group }), outside]));
			return {
				owner: row?.owner === true,
				groups: [...groups].map(([party, outside]) => ({ party, outside })),
			} satisfies PersonEntries;
		},
	};
}

/** How many rows one read of an access set takes; a set is read whole, page after page. */
const PAGE = 1000;

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

/** A grant row as a read item. */
type GrantItem = Awaited<ReturnType<Read["grants"]["here"]["page"]>>["items"][number];

/**
 * The grant rows `grants` as the rules read them, each tick at its kind's ticks version now. A row at the kind's
 * version, of a reserved tick (`OPEN`: no kind's, never migrated) or of a kind no plugin registers (its ticks count
 * for nothing, R3) reads as written; older rows migrate, those of one thing, party, source, `gives` value and version
 * together (`ticksNow`). Rows that cannot be read are reported once and fail closed: giving rows give nothing, and
 * withheld rows withhold every tick of the kind from their party (a refused row never hands a tick back).
 */
function grantEntries(
	grants: readonly GrantItem[],
	kinds: Kinds,
	reported: Set<string>,
	context: Context,
): GrantEntry[] {
	const entries: GrantEntry[] = [];
	const older = new Map<string, GrantItem[]>();
	for (const grant of grants) {
		const info = kinds.info(grant.kind);
		if (info === undefined || grant.ticksVersion === info.ticksVersion || grant.tick.startsWith(RESERVED)) {
			entries.push(entryOf(grant, grant.tick));
			continue;
		}
		// The key of the rows that migrate together (a Map key: built once per row).
		const key = `${grant.thing}\n${partyKey(grant.party)}\n${sourceKey(grant.source)}\n${grant.gives}\n${grant.ticksVersion}`;
		const rows = older.get(key);
		if (rows === undefined) older.set(key, [grant]);
		else rows.push(grant);
	}
	for (const [key, rows] of older) {
		const first = rows[0]!;
		try {
			const now = ticksNow(
				kinds.info(first.kind)!,
				rows.map(({ tick }) => tick),
				first.ticksVersion,
			);
			for (const tick of now) entries.push(entryOf(first, tick));
		} catch (error) {
			const report = `${first.workspace}\n${key}`;
			if (!reported.has(report)) {
				reported.add(report);
				reportError(`things: a grant on ${first.thing} in ${first.workspace} counts for nothing`, error, context);
			}
			if (!first.gives) for (const tick of kinds.ticksOf(first.kind)) entries.push(entryOf(first, tick));
		}
	}
	return entries;
}

/** `grant`'s row read as `tick`. */
function entryOf({ thing, party, gives }: GrantItem, tick: string): GrantEntry {
	return { thing, party: partyKey(party), audience: audienceOf(party.kind), tick, gives };
}
