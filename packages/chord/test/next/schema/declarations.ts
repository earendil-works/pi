// The declarations of the schema switch's proofs (TypeBox to pi-schema): one of every schema helper and option in a
// contract, persisted documents, tables with defaults, an optional and a `json(...)` column, an evolved table and a
// persisted job. Their fingerprints were recorded with the TypeBox helpers; the stored data in `stored/` was written
// by that code (`write-stored.ts`).

import {
	arr,
	bool,
	bytes,
	hostKind,
	int,
	keyed,
	lit,
	local,
	map,
	method,
	nul,
	num,
	obj,
	oneOf,
	opt,
	remote,
	str,
	union,
	unknown,
} from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { defineJob } from "../../../src/next/jobs/index.ts";
import { defineTable, evolveTable, json } from "../../../src/next/store/index.ts";

/** A schema with every helper and option a declaration can use. */
export const everything = obj({
	name: str({ min: 1, max: 40, pattern: "^[a-z ]+$" }),
	nick: str({ default: "x" }),
	age: int({ min: 0, max: 150 }),
	count: int({ default: 0 }),
	score: num({ min: 0, max: 100 }),
	ratio: num({ default: 0.5 }),
	active: bool(),
	verified: bool({ default: false }),
	role: oneOf("admin", "user", "guest"),
	level: oneOf(1, 2, 3),
	kind: lit("person"),
	one: lit(1),
	yes: lit(true),
	tags: arr(str(), { min: 0, max: 5 }),
	points: arr(int()),
	extra: map(int()),
	note: opt(str()),
	nothing: nul(),
	choice: union([str(), int(), obj({ deep: arr(obj({ x: num() })) })]),
	nested: obj({ inner: opt(obj({ v: str() })) }),
});

/** A local contract with state, keyed state and methods of every argument shape. */
export const Everything = local("fixture.switch.everything", {
	version: 1,
	params: { id: str(), shard: int() },
	members: {
		profile: everything,
		notes: keyed(obj({ body: str() })),
		plain: method(),
		args: method(obj({ a: str(), b: opt(int()), any: unknown() })),
		result: method(undefined, arr(str())),
		both: method(obj({ when: int({ min: 0 }) }), union([lit("ok"), obj({ error: str() })])),
		blob: method(obj({ data: bytes({ max: 1024 }) }), bytes()),
	},
});

const Server = hostKind("fixture.switch.server", { region: str() });

/** A remote contract with variants and a host address. */
export const Account = remote("fixture.switch.account", {
	version: 1,
	params: { user: str({ min: 1 }) },
	hostAddress: () => Server({ region: "eu" }),
	variants: {
		owner: { state: { balance: num() }, methods: { pay: method(obj({ amount: num({ min: 0 }) }), bool()) } },
		guest: { state: { balance: num() } },
	},
});

/** A persisted singleton document of `everything`. */
export const Profile = defineState("fixture.switch.profile", {
	schema: everything,
	version: 1,
	initial: () => ({
		name: "ada",
		nick: "x",
		age: 36,
		count: 0,
		score: 1,
		ratio: 0.5,
		active: true,
		verified: false,
		role: "admin" as const,
		level: 1 as const,
		kind: "person" as const,
		one: 1 as const,
		yes: true as const,
		tags: [],
		points: [],
		extra: {},
		nothing: null,
		choice: "a",
		nested: {},
	}),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 2,
});

/** A persisted keyed document. */
export const Notes = defineState("fixture.switch.notes", {
	schema: obj({ body: str(), tags: opt(arr(str())) }),
	version: 1,
	initial: () => ({ body: "" }),
	keyed: true,
	persist: true,
	checkpointWhen: () => false,
});

/** A table with defaults, an optional column and a `json(...)` column. */
export const Rows = defineTable("fixture.switch.rows", {
	version: 1,
	columns: {
		id: str(),
		n: int({ default: 0 }),
		flag: bool({ default: false }),
		label: opt(str()),
		data: json(obj({ a: int(), b: opt(arr(str())) }), { version: 1 }),
		maybe: opt(json(map(num()), { version: 1 })),
	},
	key: ["id"],
	indexes: { by_n: ["n", "id"] },
});

/** A table evolved over three versions: a rename, an added column with a default, a json column, a drop. */
export const EditsV1 = defineTable("fixture.switch.edits", {
	version: 1,
	columns: { id: str(), file: str(), at: int() },
	key: ["id"],
});

export const EditsV2 = evolveTable(EditsV1, (t) =>
	t
		.rename("file", "path")
		.add("dir", str({ default: "" }))
		.rows((row) => ({ dir: row.path.slice(0, row.path.lastIndexOf("/")) })),
);

export const EditsV3 = evolveTable(EditsV2, (t) => t.drop("dir").index("by_path", ["path", "at"]));

/** A persisted job with a state document. */
export const ImportState = defineState("fixture.switch.import.state", {
	schema: obj({ done: int() }),
	version: 1,
	initial: () => ({ done: 0 }),
	persist: true,
	checkpointWhen: () => false,
});

export const ImportJob = defineJob("fixture.switch.import", {
	version: 1,
	args: obj({ path: str() }),
	result: obj({ count: int() }),
	state: ImportState,
	persist: { resume: "rerun" },
});

/** The object owning the persisted documents and the tables (a local type with empty params, as tables need). */
export const Owner = local("fixture.switch.owner", {
	version: 1,
	params: {},
	members: {
		profile: everything,
		write: method(obj({ id: str(), body: str() })),
		read: method(str(), str()),
		dump: method(obj({}), unknown()),
	},
});
