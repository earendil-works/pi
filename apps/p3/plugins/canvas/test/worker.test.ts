// The canvas plugin on a session's worker (`testPlugin`): the session's `canvas.board` things give the agent
// `canvas_list` and `canvas_read` always and `canvas_draw` when it may draw on at least one board; `canvas_list` names
// each board with its id and whether the agent may draw there; `canvas_draw` on a board without `draw`, or on an id
// that is no board of the session, is refused naming it before anything reaches the server. That the tools reach the
// board through the agent's `call` and the server admits the agent by its own options is the end to end test's
// (`e2e.test.ts`) and the server's (`server.test.ts`).

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, type P3Principal } from "@earendil-works/p3/v1";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { type Extension, ThingExtensions } from "@earendil-works/p3/v1/worker";
import { CanvasKind } from "../contract.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The agent, whose `call` a case never reaches. */
const AGENT = { session: "s", call: () => Promise.reject(new Error("no call")) };

/** A board of the session: its id, its name, and the agent's `draw`. */
function board(thing: string, name: string, draw: boolean) {
	return { thing, name, options: { draw } };
}

/** Runs tool `name` of `extension` with `args`; its output's text. */
async function run(extension: Extension, name: string, args: object): Promise<string> {
	const tool = extension.tools?.find((each) => each.name === name);
	assert.ok(tool !== undefined, name);
	// The canvas tools use neither Durable's execution API nor arguments beyond their schema's.
	const result = await tool.execute(args as never, {} as never, context);
	// A park has no output: the canvas tools never park.
	return (result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("the agent's tools for the session's boards", () => {
	let t: TestedPlugin<P3Principal>;

	beforeEach(async () => {
		t = await testPlugin(ROOT, { kind: "worker", session: "s" }, context);
	});

	afterEach(() => t.close(context));

	/** What the canvas kind gives `boards`. */
	function gift(...boards: ReturnType<typeof board>[]): Extension {
		const [entry] = t.contributions(ThingExtensions);
		assert.equal(entry?.value.kind.name, CanvasKind.name);
		const extension = entry.value.give(boards, AGENT).extension;
		assert.ok(extension !== undefined);
		return extension;
	}

	it("are canvas_list and canvas_read, and canvas_draw when one board allows drawing", () => {
		const names = (extension: Extension) => extension.tools?.map((tool) => tool.name).toSorted();
		assert.deepEqual(names(gift(board("b1", "Plan", true))), ["canvas_draw", "canvas_list", "canvas_read"]);
		assert.deepEqual(names(gift(board("b1", "Plan", false))), ["canvas_list", "canvas_read"]);
		assert.deepEqual(names(gift(board("b1", "Plan", false), board("b2", "Sketches", true))), [
			"canvas_draw",
			"canvas_list",
			"canvas_read",
		]);
	});

	it("lists the boards by id and name, with whether the agent may draw there", async () => {
		const extension = gift(board("b1", "Plan", false), board("b2", "Sketches", true));
		assert.deepEqual(JSON.parse(await run(extension, "canvas_list", {})), [
			{ id: "b1", name: "Plan", draw: false },
			{ id: "b2", name: "Sketches", draw: true },
		]);
	});

	it("refuses to draw on a board without draw, and on an id that is no board, naming it", async () => {
		const extension = gift(board("b1", "Plan", false), board("b2", "Sketches", true));
		const shapes = [{ kind: "rect", color: "#000000", x: 0, y: 0, w: 10, h: 10, fill: false }];
		await assert.rejects(
			run(extension, "canvas_draw", { canvas: "b1", shapes }),
			/may not draw on the canvas "Plan" \(b1\)/,
		);
		await assert.rejects(run(extension, "canvas_draw", { canvas: "b9", shapes }), /no canvas "b9"/);
		await assert.rejects(run(extension, "canvas_read", { canvas: "b9" }), /no canvas "b9"/);
	});
});
