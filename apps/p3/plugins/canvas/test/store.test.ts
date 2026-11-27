// The canvas store (`CanvasStore`) on its own: a board's shapes keep the order they were added in, also after a reload
// of the plugin (a new store object) with the wall clock gone back; `drop` removes one board's shapes only and marks it
// gone, so a later add is refused; a board holds `MAX_SHAPES` at most, an add past it refused with its message, and
// removing or clearing makes room again; and a store version 1 wrote (7093618af, authors as text keys) opened by this
// version (decision 125): `person:<id>`, `agent:<session>` and `server` read as the things plugin's `Caller`, a key of
// none of those forms as the Pi itself, its shapes counted once by the first add (also one already past `MAX_SHAPES`:
// the refused add stores the count), and a shape drawn after the update stores its author as written. A two-version
// restart is not possible in-tree: a stand-in of the older plugin writes the old rows.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	arr,
	BACKGROUND_CONTEXT as context,
	defineFacet,
	defineTable,
	int,
	json,
	local,
	method,
	obj,
	opt,
	str,
} from "@earendil-works/p3/v1";
import { type KindServer, kindServer, refused } from "../../things/test/kind-server.ts";
import { world } from "../../things/test/world.ts";
import { type Canvas, CanvasKind, MAX_SHAPES, Shape } from "../kind.ts";
import canvasServer from "../server.ts";
import { CanvasStore } from "../store.ts";

/** The canvas plugin's name. */
const PLUGIN = "@earendil-works/p3-canvas";

/** A small black box. */
const BOX: Shape = { kind: "rect", color: "#000000", x: 0, y: 0, w: 2, h: 2, fill: false };

/** A person as an author. */
const ANN = { kind: "person", person: "ann" } as const;

describe("the canvas store", () => {
	let n: KindServer<typeof Canvas>;

	beforeEach(async () => {
		const root = fileURLToPath(new URL("../", import.meta.url));
		n = await kindServer({ name: PLUGIN, root, server: canvasServer }, CanvasKind, context);
	});

	afterEach(() => n.close());

	it("keeps the order shapes were added in, across a reload even if the wall clock went backwards", async (t) => {
		const now = Date.now();
		const clock = t.mock.method(Date, "now", () => now);
		const before = await n.host.get(CanvasStore, {}, context);
		const [first] = await before.add({ canvas: "board", author: ANN, shapes: [BOX] }, context);
		await n.reload();
		const after = await n.host.get(CanvasStore, {}, context);
		clock.mock.mockImplementation(() => now - 1);
		const [second] = await after.add({ canvas: "board", author: ANN, shapes: [BOX] }, context);
		const { items } = await after.shapes.of.page({ canvas: "board" }, 10, context);
		assert.deepEqual(
			items.map(({ id }) => id),
			[first, second],
		);
	});

	it("drops one board's shapes and marks it gone: a later add is refused, other boards keep theirs", async () => {
		const store = await n.host.get(CanvasStore, {}, context);
		await store.add({ canvas: "a", author: ANN, shapes: [BOX, BOX] }, context);
		await store.add({ canvas: "b", author: ANN, shapes: [BOX] }, context);
		await store.drop({ canvas: "a" }, context);
		await store.drop({ canvas: "a" }, context);
		await assert.rejects(store.add({ canvas: "a", author: ANN, shapes: [BOX] }, context), /is gone/);
		assert.deepEqual((await store.shapes.of.page({ canvas: "a" }, 10, context)).items, []);
		assert.equal((await store.shapes.of.page({ canvas: "b" }, 10, context)).items.length, 1);
		// A cleared board is not gone: it is drawn on again.
		await store.clear({ canvas: "b" }, context);
		await store.add({ canvas: "b", author: ANN, shapes: [BOX] }, context);
		assert.equal((await store.shapes.of.page({ canvas: "b" }, 10, context)).items.length, 1);
	});

	it("holds MAX_SHAPES at most: an add past it is refused; a removal or a clear makes room", async () => {
		const store = await n.host.get(CanvasStore, {}, context);
		const add = (count: number) => store.add({ canvas: "a", author: ANN, shapes: Array(count).fill(BOX) }, context);
		for (let i = 0; i < MAX_SHAPES / 100 - 1; i++) await add(100);
		await refused(add(101), "invalid", "full");
		const [last] = await add(100);
		await refused(add(1), "invalid", "full");
		await store.remove({ canvas: "a", id: last! }, context);
		await add(1);
		await refused(add(1), "invalid", "full");
		await store.clear({ canvas: "a" }, context);
		assert.equal((await add(100)).length, 100);
		// Another board's count is its own.
		assert.equal((await store.add({ canvas: "b", author: ANN, shapes: [BOX] }, context)).length, 1);
	});
});

/** The shapes table as version 1 defined it (7093618af), copied: what Pis stored before authors were `Caller`s. */
const OldShapes = defineTable("canvas.shapes", {
	version: 1,
	columns: { canvas: str(), id: str(), seq: int(), author: str(), shape: json(Shape, { version: 1 }) },
	key: ["canvas", "id"],
	indexes: { by_order: ["canvas", "seq"] },
});

/** Its owner, by name (a table's stored name is its owner's and its own). */
const OldStore = local("canvas.store", {
	version: 1,
	params: {},
	members: { put: method(obj({ canvas: str(), authors: arr(str()), from: opt(int()) })) },
});

/** The canvas plugin as version 1 served it, enough to write its rows: one box per author, in order from `from`. */
const older = defineFacet((host) => {
	host.serve(OldStore, (_params, self) => {
		const shapes = self.table(OldShapes);
		return {
			put: ({ canvas, authors, from = 0 }, ctx) =>
				self.tx(async (tx) => {
					authors.forEach((author, at) => {
						const seq = from + at;
						tx.put(shapes, { canvas, id: `s${seq}`, seq, author, shape: BOX });
					});
					return null;
				}, ctx),
		};
	});
});

describe("a store version 1 wrote (decision 125)", () => {
	it("opens: text keys read as callers, an unknown one as the Pi; a shape drawn now keeps its author", async () => {
		const dir = await mkdtemp(join(tmpdir(), "p3-canvas-"));
		const path = join(dir, "old.sqlite");
		try {
			const old = await world(context, [{ name: PLUGIN, facet: older }], path);
			await (await old.host.get(OldStore, {}, context)).put(
				{ canvas: "b1", authors: ["person:ann", "agent:s1", "server", "test"] },
				context,
			);
			await old.close(context);
			const now = await world(context, [{ name: PLUGIN, facet: canvasServer }], path);
			try {
				const store = await now.host.get(CanvasStore, {}, context);
				const read = async () => (await store.shapes.of.page({ canvas: "b1" }, 10, context)).items;
				assert.deepEqual(
					(await read()).map(({ id, author }) => [id, author]),
					[
						["s0", ANN],
						["s1", { kind: "agent", session: "s1" }],
						["s2", { kind: "server" }],
						["s3", { kind: "server" }],
					],
				);
				await store.add({ canvas: "b1", author: { kind: "agent", session: "s2" }, shapes: [BOX] }, context);
				assert.deepEqual((await read()).at(-1)?.author, { kind: "agent", session: "s2" });
				// The old shapes were counted by that first add: four, and the one drawn now.
				await refused(
					store.add({ canvas: "b1", author: ANN, shapes: Array(MAX_SHAPES - 4).fill(BOX) }, context),
					"invalid",
					"full",
				);
				assert.deepEqual(now.errors, []);
			} finally {
				await now.close(context);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("counts a board already past MAX_SHAPES once: its first refused add stores the count (Astra, round 2)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "p3-canvas-"));
		const path = join(dir, "old.sqlite");
		try {
			const old = await world(context, [{ name: PLUGIN, facet: older }], path);
			const put = await old.host.get(OldStore, {}, context);
			for (let i = 0; i < 101; i++) {
				// 10,100 shapes of 101 authors' keys, each batch its own ids.
				await put.put({ canvas: "big", authors: Array(100).fill(`person:p${i}`), from: i * 100 }, context);
			}
			await old.close(context);
			const now = await world(context, [{ name: PLUGIN, facet: canvasServer }], path);
			try {
				const store = await now.host.get(CanvasStore, {}, context);
				const add = () => store.add({ canvas: "big", author: ANN, shapes: [BOX] }, context);
				await refused(add(), "invalid", "full");
				assert.equal(storedCount(path, "big"), MAX_SHAPES + 100);
				await refused(add(), "invalid", "full");
				assert.equal(
					(await store.shapes.of.page({ canvas: "big" }, MAX_SHAPES + 200, context)).items.length,
					10_100,
				);
			} finally {
				await now.close(context);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

/** Board `canvas`'s count as the file at `path` has it now (`undefined`: no row). */
function storedCount(path: string, canvas: string): unknown {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		return database.prepare(`SELECT shapes FROM "canvas.store:canvas.boards" WHERE canvas = ?`).get(canvas)?.shapes;
	} finally {
		database.close();
	}
}
