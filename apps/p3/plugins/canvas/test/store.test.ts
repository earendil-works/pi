// The canvas store (`CanvasStore`) on its own: a board's shapes keep the order they were added in, also after a reload
// of the plugin (a new store object) with the wall clock gone back; `drop` removes one board's shapes only and marks it
// gone, so a later add is refused; and a store version 1 wrote (7093618af, authors as text keys) opened by this
// version (decision 125): `person:<id>`, `agent:<session>` and `server` read as the things plugin's `Caller`, a key of
// none of those forms as the Pi itself, and a shape drawn after the update stores its author as written. A two-version
// restart is not possible in-tree: a stand-in of the older plugin writes the old rows.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
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
	str,
} from "@earendil-works/p3/v1";
import { kindServer } from "../../things/test/kind-server.ts";
import { world } from "../../things/test/world.ts";
import { CanvasKind, Shape } from "../kind.ts";
import canvasServer from "../server.ts";
import { CanvasStore } from "../store.ts";

/** The canvas plugin's name. */
const PLUGIN = "@earendil-works/p3-canvas";

/** A small black box. */
const BOX: Shape = { kind: "rect", color: "#000000", x: 0, y: 0, w: 2, h: 2, fill: false };

/** A person as an author. */
const ANN = { kind: "person", person: "ann" } as const;

describe("the canvas store", () => {
	it("keeps the order shapes were added in, across a reload even if the wall clock went backwards", async (t) => {
		const root = fileURLToPath(new URL("../", import.meta.url));
		const n = await kindServer({ name: PLUGIN, root, server: canvasServer }, CanvasKind, context);
		try {
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
		} finally {
			await n.close();
		}
	});

	it("drops one board's shapes and marks it gone: a later add is refused, other boards keep theirs", async () => {
		const root = fileURLToPath(new URL("../", import.meta.url));
		const n = await kindServer({ name: PLUGIN, root, server: canvasServer }, CanvasKind, context);
		try {
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
		} finally {
			await n.close();
		}
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
	members: { put: method(obj({ canvas: str(), authors: arr(str()) })) },
});

/** The canvas plugin as version 1 served it, enough to write its rows: one box per author, in order. */
const older = defineFacet((host) => {
	host.serve(OldStore, (_params, self) => {
		const shapes = self.table(OldShapes);
		return {
			put: ({ canvas, authors }, ctx) =>
				self.tx(async (tx) => {
					authors.forEach((author, seq) => {
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
				assert.deepEqual(now.errors, []);
			} finally {
				await now.close(context);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
