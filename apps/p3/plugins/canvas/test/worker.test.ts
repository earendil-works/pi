// The canvas plugin on a session's worker (`testPlugin`): its harness part gives the agent `canvas_list` and
// `canvas_read` always and `canvas_draw` when it may draw on at least one board it holds; `canvas_list` names each
// board with its id, its name and whether the agent may draw there; `canvas_draw` draws through the held reference,
// and is refused naming the board where Draw is not granted, and on an id that is no board held, before anything
// reaches the server. That the server admits the agent by its own grants is the server's test (`server.test.ts`).

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { constant, BACKGROUND_CONTEXT as context, type P3Principal } from "@earendil-works/p3/v1";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import type { HarnessExtension as Extension, HeldThing } from "../../things/contract.worker.ts";
import { held, partOf, runTool as run, SESSION } from "../../things/test/part.ts";
import { CanvasKind, type Shape } from "../contract.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** A held board: its id, its name, and whether Draw is granted; `drawn` records what its `add` got. */
function board(thing: string, name: string, draw: boolean, drawn: Shape[][] = []): HeldThing {
	if (!draw) return held(thing, [], { name: constant(name) });
	const add = async ({ shapes }: { shapes: Shape[] }) => {
		drawn.push(shapes);
		return shapes.map((_, at) => `${thing}-${at}`);
	};
	return held(thing, ["add", "remove", "export"], { name: constant(name), add });
}

const RECT: Shape = { kind: "rect", color: "#000000", x: 0, y: 0, w: 10, h: 10, fill: false };

describe("the agent's tools for the boards it holds", () => {
	let t: TestedPlugin<P3Principal>;

	beforeEach(async () => {
		t = await testPlugin(ROOT, { kind: "worker", session: "s" }, context);
	});

	afterEach(() => t.close(context));

	/** What the canvas part gives `boards`. */
	function given(...boards: HeldThing[]): Extension {
		const extension = partOf(t, CanvasKind)(boards, SESSION).extension;
		assert.ok(extension !== undefined);
		return extension;
	}

	it("are canvas_list and canvas_read, and canvas_draw when Draw is granted on one board", () => {
		const names = (extension: Extension) => extension.tools?.map((tool) => tool.name).toSorted();
		assert.deepEqual(names(given(board("b1", "Plan", true))), ["canvas_draw", "canvas_list", "canvas_read"]);
		assert.deepEqual(names(given(board("b1", "Plan", false))), ["canvas_list", "canvas_read"]);
		assert.deepEqual(names(given(board("b1", "Plan", false), board("b2", "Sketches", true))), [
			"canvas_draw",
			"canvas_list",
			"canvas_read",
		]);
	});

	it("lists the boards by id and name, with whether the agent may draw there", async () => {
		const extension = given(board("b1", "Plan", false), board("b2", "Sketches", true));
		assert.deepEqual(JSON.parse(await run(extension, "canvas_list", {})), [
			{ id: "b1", name: "Plan", draw: false },
			{ id: "b2", name: "Sketches", draw: true },
		]);
	});

	it("draws through the held reference", async () => {
		const drawn: Shape[][] = [];
		const extension = given(board("b1", "Plan", true, drawn));
		assert.equal(await run(extension, "canvas_draw", { canvas: "b1", shapes: [RECT] }), "drew 1 shape(s): b1-0");
		assert.deepEqual(drawn, [[RECT]]);
	});

	it("refuses to draw on a board without Draw, and on an id that is no board, naming it", async () => {
		const extension = given(board("b1", "Plan", false), board("b2", "Sketches", true));
		await assert.rejects(
			run(extension, "canvas_draw", { canvas: "b1", shapes: [RECT] }),
			/may not draw on the canvas "Plan" \(b1\)/,
		);
		await assert.rejects(run(extension, "canvas_draw", { canvas: "b9", shapes: [RECT] }), /no canvas "b9"/);
		await assert.rejects(run(extension, "canvas_read", { canvas: "b9" }), /no canvas "b9"/);
	});
});
