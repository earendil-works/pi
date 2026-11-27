// The canvas kind's harness part, as the worker facet contributes it to `ThingHarnessParts`, given the boards an
// agent holds (real references, held as the session's worker on a server with the things plugin, `kindServer`): it
// offers `canvas_list` and `canvas_read` always and `canvas_draw` while one board gives Draw; `canvas_list` names each
// board with its id, its name ("" while it has none) and whether the agent may draw there; `canvas_read` answers a
// page as JSON and reads now, so the agent's own reference keeps its pages however often it reads; `canvas_draw`
// draws through the held reference and answers the ids, refused naming the board where Draw is not given (also when
// it was taken back after the tools were offered) and for an id that is no board of the agent's.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type Ctx, BACKGROUND_CONTEXT as context, isChordError, type P3Principal, until } from "@earendil-works/p3/v1";
import { within } from "../../../test/until.ts";
import { type HarnessExtension, type HeldThing, ThingHarnessParts } from "../../things/contract.worker.ts";
import { type KindServer, kindServer, runTool, toolNames } from "../../things/test/kind-server.ts";
import { type Canvas, CanvasKind, type Shape } from "../kind.ts";
import canvasServer from "../server.ts";

/** The canvas plugin's root. */
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The session's agent as a party: Draw withheld from it by name applies by every route (item 106). */
const AGENT_PARTY = { kind: "agent", session: "s1" } as const;

/** A black box. */
const RECT: Shape = { kind: "rect", color: "#000000", x: 0, y: 0, w: 10, h: 10, fill: false };

let n: KindServer<typeof Canvas>;
let s1: string;

beforeEach(async () => {
	n = await kindServer({ name: "@earendil-works/p3-canvas", root: ROOT, server: canvasServer }, CanvasKind, context);
	s1 = await n.workspace("s1");
});

afterEach(() => n.close());

/** Runs `fn` with s1's agent holding boards `things` there: the part's extension for them, and the held things. */
const giving = <T>(
	things: readonly string[],
	fn: (extension: HarnessExtension, ctx: Ctx<P3Principal>, held: readonly HeldThing<typeof Canvas>[]) => Promise<T>,
) => n.giving({ session: "s1", workspace: s1 }, things, fn);

/** Whether `promise` rejects with a ChordError of `code` whose text matches `text`. */
const rejects = (promise: Promise<unknown>, code: string, text: RegExp) =>
	assert.rejects(promise, (error: unknown) => isChordError(error) && error.code === code && text.test(error.message));

describe("the canvas kind's harness part", () => {
	it("is the worker facet's one part, for the canvas kind", async () => {
		assert.deepEqual(
			(await n.worker("s1")).contributions(ThingHarnessParts).map(({ value }) => value.kind.name),
			[CanvasKind.name],
		);
	});

	it("offers canvas_draw while one board gives Draw, and lists which", async () => {
		const [plan, sketch] = [await n.thingIn(s1, "Plan"), await n.thingIn(s1)];
		await n.tick(s1, plan, AGENT_PARTY, "draw", false);
		await giving([plan, sketch], async (extension) => {
			assert.deepEqual(toolNames(extension), ["canvas_draw", "canvas_list", "canvas_read"]);
			assert.deepEqual(JSON.parse(await runTool(extension, "canvas_list", {}, context)), [
				{ id: plan, name: "Plan", draw: false },
				{ id: sketch, name: "", draw: true },
			]);
		});
		await giving([plan], async (extension) => assert.deepEqual(toolNames(extension), ["canvas_list", "canvas_read"]));
	});

	it("draws through the held reference and reads as JSON a page at a time; the agent's hold stays", async () => {
		const board = await n.thingIn(s1, "Plan");
		const ann = await n.person("Ann", s1);
		await n.holding(ann, s1, board, async (canvas, ctx) => {
			for (let i = 0; i < 5; i++) await canvas.add!({ shapes: Array(100).fill(RECT) }, ctx);
		});
		await giving([board], async (extension, ctx, [held]) => {
			const drawn = JSON.parse(await runTool(extension, "canvas_draw", { canvas: board, shapes: [RECT] }, context));
			assert.equal(drawn.ids.length, 1);
			await until(held!.ref.shapes, (list) => list.moreAfter, within("more than a page", ctx));
			const holds = held!.ref.shapes.value.rows.length;
			const read = async (after?: string) =>
				JSON.parse(
					await runTool(
						extension,
						"canvas_read",
						{ canvas: board, ...(after === undefined ? {} : { after }) },
						context,
					),
				);
			const first = await read();
			assert.deepEqual(first.rows[0].author, { kind: "person", person: ann.id });
			const second = await read(first.next);
			assert.deepEqual([first.rows.length, second.rows.length, second.next], [500, 1, undefined]);
			assert.deepEqual(second.rows[0], { id: drawn.ids[0], author: { kind: "agent", session: "s1" }, shape: RECT });
			assert.equal((await read()).rows.length, 500);
			assert.deepEqual([holds, held!.ref.shapes.value.rows.length], [500, 500]);
		});
	});

	it("refuses to draw where Draw is not given, also when taken back after offering, naming the board", async () => {
		const [plan, sketch] = [await n.thingIn(s1, "Plan"), await n.thingIn(s1, "Sketch")];
		await n.tick(s1, plan, AGENT_PARTY, "draw", false);
		await giving([plan, sketch], async (extension, ctx, held) => {
			await rejects(
				runTool(extension, "canvas_draw", { canvas: plan, shapes: [RECT] }, context),
				"forbidden",
				/may not draw on the canvas "Plan"/,
			);
			await n.tick(s1, sketch, AGENT_PARTY, "draw", false);
			const { ref } = held[1]!;
			await until(ref.state, () => ref.add === undefined, within("Draw taken back", ctx));
			await rejects(
				runTool(extension, "canvas_draw", { canvas: sketch, shapes: [RECT] }, context),
				"forbidden",
				/may not draw on the canvas "Sketch"/,
			);
		});
	});

	it("refuses an id that is no board of the agent's", async () => {
		const plan = await n.thingIn(s1, "Plan");
		const elsewhere = await n.thingIn(n.pi, "Elsewhere");
		await giving([plan], async (extension) => {
			for (const canvas of ["b9", elsewhere]) {
				await rejects(runTool(extension, "canvas_read", { canvas }, context), "invalid", /no canvas/);
				await rejects(
					runTool(extension, "canvas_draw", { canvas, shapes: [RECT] }, context),
					"invalid",
					/no canvas/,
				);
			}
		});
	});
});
