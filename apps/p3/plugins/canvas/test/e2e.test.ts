// The canvas plugin end to end (`kindE2E`: p3's real server on a copy of the built-in plugins, clients over `/chord`
// signed in as persons): Ann and Ben are put into Pi, a board is made there, Ben's Draw withheld; both hold it open,
// Ann draws and Ben sees her shape live, drawn by her, with no drawing members of his own, and her pointer named. A
// reload of the canvas plugin (a real edit of its server facet, applied as `p3 apply` does, restarting both callers'
// objects) while both hold it keeps the shapes, both holds and Ben's motion subscription: Ann draws and points again
// and Ben sees both. The agent's tools are the worker test's (their harness part, with real references).

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, type Reference, until } from "@earendil-works/p3/v1";
import { eventually, within } from "../../../test/until.ts";
import { type KindE2E, kindE2E, restarted } from "../../things/test/kind-e2e.ts";
import { Canvas, CanvasKind, type Motion, type Shape } from "../kind.ts";

let running: KindE2E | undefined;

afterEach(async () => {
	await running?.close();
	running = undefined;
});

/** A blue box. */
const BOX: Shape = { kind: "rect", color: "#0969da", x: 100, y: 100, w: 50, h: 40, fill: false };

/** Waits until `canvas` shows `count` shapes, the last drawn by person `person`. */
async function shows(canvas: Reference<typeof Canvas>, count: number, person: string): Promise<void> {
	await until(
		canvas.shapes,
		({ rows }) => {
			const last = rows.at(-1)?.author;
			return rows.length === count && last?.kind === "person" && last.person === person;
		},
		within(`${count} shapes`, context, 10_000),
	);
}

describe("the canvas end to end", () => {
	it("shows a drawer's shape and pointer on a viewer's open board live, also across a reload of the plugin", async () => {
		const e = await kindE2E(context);
		running = e;
		const [ann, ben] = [await e.person("Ann"), await e.person("Ben")];
		const thing = await e.thingIn(CanvasKind.name, "Sketch");
		await e.ticks(thing, { kind: "person", person: ben.id }, ["draw"], false);
		const board = { workspace: e.pi, thing };
		const anns = await (await e.client(ann)).get(Canvas, board, context);
		const bens = await (await e.client(ben)).get(Canvas, board, context);
		assert.deepEqual([anns.name.value, [...anns.granted].sort()], ["Sketch", ["add", "remove"]]);
		assert.deepEqual([bens.name.value, bens.add, bens.granted.size], ["Sketch", undefined, 0]);
		const seen: Motion[] = [];
		await bens.motion.on(({ value }) => seen.push(value), context);
		await anns.add!({ shapes: [BOX] }, context);
		await shows(bens, 1, ann.id);
		await anns.point({ x: 5, y: 6, draft: null }, context);
		await eventually(
			async () => seen.some(({ kind, who }) => kind === "point" && who.kind === "person" && who.name === "Ann"),
			(found) => found,
			10_000,
		);
		const applied = await e.reload("canvas", "@earendil-works/p3-canvas");
		assert.equal(applied.stopped, undefined);
		assert.deepEqual(restarted(applied, CanvasKind.name), { changed: ["@earendil-works/p3-canvas"], restarted: 2 });
		await until(
			anns.state,
			(state) => state.kind === "live" && anns.add !== undefined,
			within("Ann live", context, 10_000),
		);
		await anns.add!({ shapes: [BOX] }, context);
		await shows(bens, 2, ann.id);
		// Ben's motion subscription delivers after the reload too.
		seen.length = 0;
		await anns.point({ x: 7, y: 8, draft: null }, context);
		await eventually(
			async () => seen.some((motion) => motion.kind === "point" && motion.x === 7),
			(found) => found,
			10_000,
		);
		assert.deepEqual(e.t.errors, []);
	});
});
