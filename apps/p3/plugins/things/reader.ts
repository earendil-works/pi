// How the access index reads the things store: one workspace's entries (5 reads) and one person's (2), through the
// store's named queries, each set read whole; and how a grant's ticks read at its kind's version now (item 91, open
// item 27): `readerOf`, with the kinds as the index looks them up (`lookupOf`).

import { type Context, type NamedQuery, type Reference, reportError, type TableItem } from "@earendil-works/p3/v1";
import type { Reader } from "./access.ts";
import type { ThingsStore } from "./contract.server.ts";
import { itemKey, partyKey, sourceKey } from "./contract.ts";
import type { KindInfo } from "./kind.ts";
import { audienceOf, type GrantEntry, type KindsLookup, type PersonEntries, type WorkspaceEntries } from "./rules.ts";

/** The kinds as the store reads them: the rules' lookup, and each kind's data. */
export type Kinds = KindsLookup & { info(kind: string): KindInfo | undefined };

/** The kinds of `table` as `Kinds`: each kind's ticks by name with whom they are for. */
export function lookupOf(table: ReadonlyMap<string, TableItem<KindInfo>>): Kinds {
	const ticks = new Map(
		[...table].map(([kind, { value }]) => [kind, new Map(value.ticks.map((tick) => [tick.name, tick.for]))]),
	);
	return {
		tickFor: (kind, tick) => ticks.get(kind)?.get(tick),
		ticksOf: (kind) => [...(ticks.get(kind)?.keys() ?? [])],
		info: (kind) => table.get(kind)?.value,
	};
}

/** The named queries the index reads through: the store's own, or a reference's. */
export type Read = Pick<
	Reference<typeof ThingsStore>,
	"workspaces" | "links" | "workspaceMembers" | "switches" | "grants" | "persons" | "groupMembers"
>;

/**
 * How the index reads through `q`, the kinds now from `kinds`. A grant its kind cannot read is reported once per grant
 * and version for the life of `reported` (the store object's).
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
				grants: grants.flatMap((grant) => grantEntry(grant, kinds(), reported, ctx)),
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

/** A grant as a read item. */
type GrantItem = Awaited<ReturnType<Read["grants"]["here"]["page"]>>["items"][number];

/** A grant as the rules read it (see `ticksNow`); none when its kind cannot read it, reported once. */
function grantEntry(grant: GrantItem, kinds: Kinds, reported: Set<string>, context: Context): GrantEntry[] {
	const { thing, party, gives, kind, version } = grant;
	const now = ticksNow(grant, kinds.info(kind));
	if (now !== undefined) return [{ thing, party: partyKey(party), audience: audienceOf(party.kind), gives, ...now }];
	const key = `${grant.workspace}\n${thing}\n${partyKey(party)}\n${sourceKey(grant.source)}\n${version}`;
	if (!reported.has(key)) {
		reported.add(key);
		reportError(
			`things: a grant on ${thing} in ${grant.workspace}`,
			`written at ${kind} version ${version}, newer than the kind's ${kinds.info(kind)?.version}: it counts for nothing`,
			context,
		);
	}
	return [];
}

/**
 * A grant's ticks at its kind's version now (item 91): as written at the same version, and for a kind no plugin
 * registers (its ticks count for nothing, R3); migrated by the kind's `migrateTicks` from an older version; without
 * one, read as written (open item 27, recommended: unknown names are ignored by the rules). `undefined` for a version
 * newer than the kind's (the plugin went back): it counts for nothing.
 */
function ticksNow(
	{ ticks, takenAway, version }: GrantItem,
	info: KindInfo | undefined,
): { ticks: string[]; takenAway: string[] } | undefined {
	if (info === undefined || info.version === version) return { ticks, takenAway };
	if (version > info.version) return undefined;
	const migrate = info.migrateTicks;
	return migrate === undefined
		? { ticks, takenAway }
		: { ticks: migrate(ticks, version), takenAway: migrate(takenAway, version) };
}
