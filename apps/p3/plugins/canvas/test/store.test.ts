// The canvas store (`CanvasStore`) on its own: a canvas's shapes keep the order they were added in, also after a
// reload of the plugin (a new store object) with the wall clock gone back (Sol, round 1).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/p3/v1";
import { world } from "../../things/test/world.ts";
import type { Shape } from "../contract.ts";
import canvas from "../server.ts";
import { CanvasStore } from "../store.ts";

describe("the order of a canvas's shapes", () => {
	it("is the order they were added in, across a reload even if the wall clock went backwards", async (t) => {
		const now = Date.now();
		const clock = t.mock.method(Date, "now", () => now);
		const plugin = "@earendil-works/p3-canvas";
		const w = await world(context, [{ name: plugin, facet: canvas }]);
		const shape: Shape = { kind: "rect", color: "#000000", x: 0, y: 0, w: 2, h: 2, fill: false };
		try {
			const before = await w.host.get(CanvasStore, {}, context);
			const [first] = await before.add({ canvas: "board", author: "test", shapes: [shape] }, context);
			await w.reload(plugin, context);
			const after = await w.host.get(CanvasStore, {}, context);
			clock.mock.mockImplementation(() => now - 1);
			const [second] = await after.add({ canvas: "board", author: "test", shapes: [shape] }, context);
			const { items } = await after.shapes.of.page({ canvas: "board" }, 10, context);
			assert.deepEqual(
				items.map(({ id }) => id),
				[first, second],
			);
		} finally {
			await w.close(context);
		}
	});
});
