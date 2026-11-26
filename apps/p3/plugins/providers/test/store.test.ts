// The logins' store (`store.ts`) on a SQLite database of the test's own: every statement it runs on its tables, the
// named query's pages and the writes' lookups alike, searches the key or the index its comment names, with no
// temporary B-tree; a finished sign-in is kept for a while only, and the next one kept drops what expired; the device
// id is made once.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, isChordError, type Reference } from "@earendil-works/p3/v1";
import { FAUX_PROVIDER, keyOf } from "../../../test/plugins/faux-login/contract.ts";
import { LoginStore } from "../contract.server.ts";
import { recording, type World, world } from "./world.ts";

/** A faux credential. */
const CREDENTIAL = { type: "api_key", key: keyOf([]) };

/** How long a finished sign-in is kept, as `store.ts` says, and a little. */
const LATER = 15 * 60_000 + 1000;

let database: DatabaseSync;
let seen: Set<string>;
let w: World;
let store: Reference<typeof LoginStore>;

beforeEach(async () => {
	seen = new Set();
	database = recording(new DatabaseSync(":memory:"), seen);
	w = await world(database, context);
	store = await w.host.get(LoginStore, {}, context);
});

afterEach(() => w.close(context));

/** Keeps a finished faux sign-in of `owner`; its id. */
const keep = (owner: string) =>
	store.keep({ owner, provider: FAUX_PROVIDER, method: "api_key", credential: CREDENTIAL }, context);

describe("the store's statements", () => {
	it("search the key or their index, never scan or sort", async () => {
		const thing = "t1";
		await store.save({ thing, provider: FAUX_PROVIDER, method: "api_key", credential: CREDENTIAL }, context);
		await store.save({ thing: "t2", provider: FAUX_PROVIDER, method: "api_key", credential: CREDENTIAL }, context);
		const first = await store.logins.one.page({ thing }, 1, context);
		assert.equal(first.items.length, 1);
		await store.authorize({ thing }, context);
		const id = await keep("person:a");
		await keep("person:b");
		await store.claim({ owner: "person:a", signIn: id }, context);
		await store.drop({ owner: "person:b", signIn: id }, context);
		await store.device({}, context);
		await store.remove({ thing }, context);
		const lookups = [...seen].filter((sql) => /^(SELECT|UPDATE|DELETE)\b/.test(sql));
		assert.ok(lookups.length > 0);
		for (const sql of lookups) {
			const plan = database
				.prepare(`EXPLAIN QUERY PLAN ${sql}`)
				.all(
					...sql
						.split("?")
						.slice(1)
						.map(() => 0),
				)
				.map((step) => String(step.detail));
			const scans = plan.filter((step) => /^SCAN /.test(step) || step.includes("TEMP B-TREE"));
			assert.deepEqual(scans, [], `${sql}: ${plan.join(" | ")}`);
		}
	});
});

describe("finished sign-ins", () => {
	it("are kept for a while: claimed later, refused; the next one kept drops them", async () => {
		const id = await keep("person:a");
		const now = Date.now;
		Date.now = () => now() + LATER;
		try {
			await assert.rejects(store.claim({ owner: "person:a", signIn: id }, context), (error: unknown) =>
				isChordError(error, "invalid"),
			);
			await keep("person:b");
		} finally {
			Date.now = now;
		}
		const rows = database.prepare(`SELECT COUNT(*) AS n FROM "providers.store:providers.sign_ins"`).get();
		assert.equal(rows?.n, 1);
	});

	it("are claimed once and dropped, by their owner only", async () => {
		const id = await keep("person:a");
		await assert.rejects(store.claim({ owner: "person:b", signIn: id }, context));
		await store.drop({ owner: "person:b", signIn: id }, context);
		const claimed = await store.claim({ owner: "person:a", signIn: id }, context);
		assert.deepEqual(claimed, { provider: FAUX_PROVIDER, method: "api_key", credential: CREDENTIAL });
		await assert.rejects(store.claim({ owner: "person:a", signIn: id }, context));
	});
});

describe("the device id", () => {
	it("is made once and the same ever after", async () => {
		const id = await store.device({}, context);
		assert.equal(await store.device({}, context), id);
		await w.reload(context);
		const again = await w.host.get(LoginStore, {}, context);
		assert.equal(await again.device({}, context), id);
	});
});
