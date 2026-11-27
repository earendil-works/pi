// The things store's own tables (data model F: on disk only what people set): things and the workspace tree, links,
// who is put in where, switches and grant rows (item 112), with the indexes their named queries and writes search; the
// people tables are `people.ts`'s. What a write tells besides what it touched (`Changes`).

import { arr, bool, defineColumns, defineTable, int, json, str, type TableOf } from "@earendil-works/p3/v1";
import type { Touched } from "./access.ts";
import { Item, Party, Source as SourceSchema } from "./contract.ts";
import type { Pending } from "./lifecycle.ts";
import type { PeopleTables } from "./people.ts";
import type { Gone, Removing } from "./removal.ts";

/**
 * A thing's id, kind and name, joined to its grants (the kind their ticks are of) and to a workspace's line (its kind
 * and name).
 */
export const ThingColumns = defineColumns("things.thing-columns", {
	columns: { thing: str(), kind: str(), name: str() },
	key: ["thing"],
});

/** Every thing, a workspace too: its kind, name, own default view (`""`: none), who made it and when. */
export const Things = defineTable("things.things", {
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
export const Workspaces = defineTable("things.workspaces", {
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
export const Links = defineTable("things.links", {
	version: 1,
	columns: { workspace: str(), thing: str(), of: str() },
	key: ["workspace", "thing"],
	indexes: { by_thing: ["thing"] },
});

/** A party put into a workspace, and who did it. By party; by source (its cleanup). */
export const WorkspaceMembers = defineTable("things.workspace-members", {
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
export const Switches = defineTable("things.switches", {
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
export const Grants = defineTable("things.grants", {
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

/**
 * What a write tells besides what it touched: the things it removed (their delete hooks run after the commit), the
 * persons it removed (their sign-ins end after it), and what it retires for its cleanup (`Retiring`).
 */
export type Changes = Touched & {
	readonly retired: Retired[];
	readonly signedOut: string[];
	readonly retiring: Retiring;
};

/**
 * What one write retires, for its cleanup's last step (`Cleanup.settle`): the sources that went (the persons they made
 * are decided then), and the things, groups and cleared workspaces whose rows go too. The write's own reads still see
 * those rows: the survival check counts them as gone.
 */
export type Retiring = {
	readonly sources: Set<string>;
	readonly things: Set<string>;
	readonly groups: Set<string>;
	readonly workspaces: Set<string>;
};

/** A thing removed, and its kind. */
export type Retired = { readonly thing: string; readonly kind: string };

/** The store's tables, as its factory declared them. */
export type Tables = PeopleTables & {
	readonly things: TableOf<typeof Things>;
	readonly workspaces: TableOf<typeof Workspaces>;
	readonly links: TableOf<typeof Links>;
	readonly workspaceMembers: TableOf<typeof WorkspaceMembers>;
	readonly switches: TableOf<typeof Switches>;
	readonly grants: TableOf<typeof Grants>;
};

/** The tables the writes write: the store's, and the lifecycle's and the removal's. */
export type WriteTables = Tables & {
	readonly pending: TableOf<typeof Pending>;
	readonly removing: TableOf<typeof Removing>;
	readonly gone: TableOf<typeof Gone>;
};
