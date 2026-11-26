// The canvas plugin on the server (`testPlugin`, beside the things plugin's server facet): the kind (registered with
// the things plugin, made by anyone; its shapes dropped when the canvas goes with its last link), the one admission (a
// person put in and the session's agent get Draw by the kind's default grants; Moderate is given to people only; a
// changed grant rebinds a held canvas live; nobody else is admitted), shapes keyed by the canvas's id (the same
// drawing in every workspace it is linked in), authors as the admission says, removing one's own shapes and, with
// Moderate, anyone's and clearing; the list with `more`; and motion as events, per workspace.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	isChordError,
	type P3Principal,
	type Reference,
	until,
} from "@earendil-works/p3/v1";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { eventually, within } from "../../../test/until.ts";
import { ThingsStore } from "../../things/contract.server.ts";
import type { Party, Source } from "../../things/contract.ts";
import thingsServer from "../../things/server.ts";
import { Canvas, CanvasKind, type Motion, type Shape } from "../contract.ts";
import { CanvasStore } from "../store.ts";

/** A person's principal. */
type Person = Extract<P3Principal, { kind: "person" }>;

/** `Canvas` as a test holds it. */
type CanvasRef = Reference<typeof Canvas>;

/** A short red stroke. */
const STROKE: Shape = { kind: "line", color: "#cf222e", width: 6, points: [10, 10, 20, 20, 30, 10] };

/** A blue box. */
const BOX: Shape = { kind: "rect", color: "#0969da", x: 100, y: 100, w: 50, h: 40, fill: false };

/** The canvas plugin: the source of its kind's default grants. */
const CANVAS_PLUGIN: Source = { kind: "plugin", plugin: "@earendil-works/p3-canvas" };

/** Who sets things up in the tests. */
const BY: Source = { kind: "plugin", plugin: "test" };

let t: TestedPlugin<P3Principal>;
let things: Reference<typeof ThingsStore>;
let pi: string;

beforeEach(async () => {
	t = await testPlugin(
		fileURLToPath(new URL("../", import.meta.url)),
		{ kind: "server", stubs: [{ name: "@earendil-works/p3-things", facet: thingsServer }] },
		context,
	);
	things = await t.host.get(ThingsStore, {}, context);
	pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
});

afterEach(() => t.close(context));

/** Makes person `name`, put into `workspace`; their principal. */
async function person(name: string, workspace = pi): Promise<Person> {
	const id = await things.createPerson({ name, madeBy: BY }, context);
	await things.putParty({ workspace, party: { kind: "person", person: id }, source: BY }, context);
	return { kind: "person", id, name };
}

/** A workspace under Pi with session `session`'s agent put in (as a session's will be). */
async function workspace(session: string): Promise<string> {
	const id = await things.createWorkspace({ kind: "things.workspace", name: session, parent: pi, by: BY }, context);
	await things.putParty({ workspace: id, party: { kind: "agent", session }, source: BY }, context);
	return id;
}

/** Makes a canvas named `name` in `where`, by the test (no maker's grant). */
const canvasIn = (where: string, name = "") =>
	things.create({ kind: CanvasKind.name, name, workspace: where, by: BY }, context);

/** Gives `party` the ticks `ticks` on `thing` where it is linked, `where`. */
const grant = (where: string, thing: string, party: Party, ticks: string[]) =>
	things.setGrants(
		{ source: BY, grants: [{ workspace: where, thing, party, gives: true, ticks, takenAway: [] }] },
		context,
	);

/** Runs `fn` with `principal`'s canvas `thing` held in `where`. */
function holding<T>(
	principal: P3Principal,
	where: string,
	thing: string,
	fn: (canvas: CanvasRef, ctx: Ctx<P3Principal>) => Promise<T>,
) {
	return t.root(
		async (ctx) => fn(await ctx.get(Canvas, { workspace: where, thing }, { readyTimeout: 500 }), ctx),
		context,
		{ principal },
	);
}

/** What `principal` is granted on canvas `thing` in `where`. */
const grantedTo = (principal: P3Principal, where: string, thing: string) =>
	holding(principal, where, thing, async (canvas) => [...canvas.granted].sort());

/** Whether `promise` rejects with a ChordError of `code`. */
async function refused(promise: Promise<unknown>, code = "forbidden"): Promise<void> {
	await assert.rejects(promise, (error: unknown) => isChordError(error) && error.code === code);
}

describe("the kind", () => {
	it("is registered with the things plugin; a canvas is named by its thing, else Canvas, and follows a rename", async () => {
		const ann = await person("Ann");
		const named = await canvasIn(pi, "Sketches");
		const unnamed = await canvasIn(pi);
		assert.equal(await holding(ann, pi, named, async (canvas) => canvas.name.value), "Sketches");
		await holding(ann, pi, unnamed, async (canvas, ctx) => {
			assert.equal(canvas.name.value, "Canvas");
			await things.rename({ thing: unnamed, name: "Ideas" }, context);
			await until(canvas.name, (name) => name === "Ideas", within("the new name", ctx));
		});
	});

	it("drops a canvas's shapes when it goes with its last link, and only its", async () => {
		const ann = await person("Ann");
		const [board, other] = [await canvasIn(pi), await canvasIn(pi)];
		await holding(ann, pi, board, (canvas, ctx) => canvas.add!({ shapes: [STROKE, BOX] }, ctx));
		await holding(ann, pi, other, (canvas, ctx) => canvas.add!({ shapes: [BOX] }, ctx));
		await things.unlink({ workspace: pi, thing: board }, context);
		const stored = async (canvas: string) =>
			(await (await t.host.get(CanvasStore, {}, context)).shapes.of.page({ canvas }, 10, context)).items;
		await eventually(
			() => stored(board),
			(rows) => rows.length === 0,
			2000,
		);
		assert.equal((await stored(other)).length, 1);
	});
});

describe("who may do what on a canvas", () => {
	it("gives a person put in and the session's agent Draw; Moderate only to people; nobody outside anything", async () => {
		const s1 = await workspace("s1");
		const ann = await person("Ann", s1);
		const board = await canvasIn(s1);
		const agent: P3Principal = { kind: "worker", session: "s1" };
		assert.deepEqual(await grantedTo(ann, s1, board), ["add", "export", "remove"]);
		assert.deepEqual(await grantedTo(agent, s1, board), ["add", "export", "remove"]);
		await grant(s1, board, { kind: "person", person: ann.id }, ["draw", "moderate"]);
		assert.deepEqual(await grantedTo(ann, s1, board), ["add", "clear", "export", "remove", "removeAny"]);
		await refused(grant(s1, board, { kind: "agents" }, ["moderate"]), "invalid");
		await refused(grantedTo({ kind: "worker", session: "s2" }, s1, board));
		const dana = await things.createPerson({ name: "Dana", madeBy: BY }, context);
		await refused(grantedTo({ kind: "person", id: dana, name: "Dana" }, s1, board));
	});

	it("a flag tick given on its own grants its flag alone: Export without Draw", async () => {
		const s1 = await workspace("s1");
		const bo = await person("Bo", s1);
		const board = await canvasIn(s1);
		// Everyone's Draw taken from Bo, Export given to him (one grant row: a grant with a take-away).
		await things.setGrants(
			{
				source: BY,
				grants: [
					{
						workspace: s1,
						thing: board,
						party: { kind: "person", person: bo.id },
						gives: true,
						ticks: ["export"],
						takenAway: ["draw"],
					},
				],
			},
			context,
		);
		await holding(bo, s1, board, async (canvas) => {
			assert.ok(canvas.granted.has("export"));
			assert.equal(canvas.add, undefined);
			assert.deepEqual([...canvas.granted], ["export"]);
		});
	});

	it("follows a change of the grants live, on the same hold: Draw taken from everyone leaves a viewer", async () => {
		const ann = await person("Ann");
		const board = await canvasIn(pi);
		await holding(ann, pi, board, async (canvas, ctx) => {
			assert.ok(canvas.add !== undefined);
			await things.setGrants(
				{
					source: CANVAS_PLUGIN,
					grants: [
						{ workspace: pi, thing: board, party: { kind: "everyone" }, gives: true, ticks: [], takenAway: [] },
					],
				},
				context,
			);
			await until(
				canvas.state,
				(state) => state.kind === "live" && canvas.add === undefined,
				within("the viewer", ctx),
			);
			// A viewer's pointer travels without a draft.
			await canvas.point({ x: 1, y: 2, draft: STROKE }, ctx);
			await things.removeParty({ workspace: pi, party: { kind: "person", person: ann.id } }, context);
			await until(
				canvas.state,
				(state) => state.kind === "failed" && state.cause.kind === "denied",
				within("Ann denied", ctx),
			);
		});
	});
});

describe("a canvas's shapes", () => {
	it("are the canvas's: the same drawing in every workspace it is linked in; who may draw each link's", async () => {
		const [s1, s2] = [await workspace("s1"), await workspace("s2")];
		const ann = await person("Ann", s1);
		await things.putParty({ workspace: s2, party: { kind: "person", person: ann.id }, source: BY }, context);
		const shared = await canvasIn(s1, "Shared");
		await things.link({ workspace: s2, thing: shared, by: BY }, context);
		// In s2 everyone here may look only: the kind's default grant there replaced.
		await things.setGrants(
			{
				source: CANVAS_PLUGIN,
				grants: [
					{ workspace: s2, thing: shared, party: { kind: "everyone" }, gives: true, ticks: [], takenAway: [] },
				],
			},
			context,
		);
		const [stroke] = await holding(ann, s1, shared, (canvas, ctx) => canvas.add!({ shapes: [STROKE] }, ctx));
		await holding(ann, s2, shared, async (canvas) => {
			assert.equal(canvas.add, undefined);
			assert.equal(canvas.name.value, "Shared");
			assert.deepEqual(canvas.shapes.value.rows, [{ id: stroke, author: `person:${ann.id}`, shape: STROKE }]);
		});
	});

	it("are kept per canvas, with who drew them as the admission says", async () => {
		const s1 = await workspace("s1");
		const ann = await person("Ann", s1);
		const [board, other] = [await canvasIn(s1), await canvasIn(s1)];
		await holding(ann, s1, board, (canvas, ctx) => canvas.add!({ shapes: [STROKE] }, ctx));
		await holding({ kind: "worker", session: "s1" }, s1, board, (canvas, ctx) => canvas.add!({ shapes: [BOX] }, ctx));
		const rows = await holding(ann, s1, board, async (canvas) => canvas.shapes.value.rows);
		assert.deepEqual(
			rows.map(({ author, shape }) => [author, shape.kind]),
			[
				[`person:${ann.id}`, "line"],
				["agent:s1", "rect"],
			],
		);
		assert.deepEqual(await holding(ann, s1, other, async (canvas) => canvas.shapes.value.rows), []);
	});

	it("a drawer removes their own; with Moderate anyone's, and clears, live for every holder", async () => {
		const [ann, ben] = [await person("Ann"), await person("Ben")];
		const board = await canvasIn(pi);
		await holding(ben, pi, board, async (watching, outer) => {
			const [bens] = await watching.add!({ shapes: [BOX] }, outer);
			await holding(ann, pi, board, async (canvas, ctx) => {
				const [first, second] = await canvas.add!({ shapes: [STROKE, BOX] }, ctx);
				await until(watching.shapes, (list) => list.rows.length === 3, within("three shapes", outer));
				await canvas.remove!({ id: second! }, ctx);
				await refused(canvas.remove!({ id: bens! }, ctx), "invalid");
				assert.equal(canvas.clear, undefined);
				await grant(pi, board, { kind: "person", person: ann.id }, ["draw", "moderate"]);
				await until(canvas.state, () => canvas.clear !== undefined, within("Moderate", ctx));
				await canvas.remove!({ id: bens! }, ctx);
				await until(
					watching.shapes,
					(list) => list.rows.map((row) => row.id).join() === first,
					within("two removed", outer),
				);
				await canvas.clear!(ctx);
				await until(watching.shapes, (list) => list.rows.length === 0, within("cleared", outer));
			});
		});
	});

	it("refuses shapes outside the schema", async () => {
		const ann = await person("Ann");
		const board = await canvasIn(pi);
		await holding(ann, pi, board, async (canvas, ctx) => {
			const bad = [
				{ ...STROKE, color: "red" },
				{ ...STROKE, points: [1, 2] },
				{ kind: "circle", color: "#000000" },
			];
			for (const shape of bad) await refused(canvas.add!({ shapes: [shape as Shape] }, ctx), "invalid");
			assert.deepEqual(canvas.shapes.value.rows, []);
		});
	});

	it("loads a page of 500, oldest first, and the next with more", async () => {
		const ann = await person("Ann");
		const board = await canvasIn(pi);
		await holding(ann, pi, board, async (canvas, ctx) => {
			for (let batch = 0; batch < 6; batch++) {
				await canvas.add!(
					{ shapes: Array.from({ length: 100 }, (_, i): Shape => ({ ...BOX, x: batch * 100 + i })) },
					ctx,
				);
			}
		});
		await holding(ann, pi, board, async (canvas, ctx) => {
			assert.equal(canvas.shapes.value.rows.length, 500);
			assert.equal(canvas.shapes.value.moreAfter, true);
			await canvas.more(ctx);
			const xs = canvas.shapes.value.rows.map((row) => (row.shape.kind === "rect" ? row.shape.x : -1));
			assert.deepEqual(
				xs,
				Array.from({ length: 600 }, (_, i) => i),
			);
		});
	});
});

describe("a canvas's motion", () => {
	it("shows every holder in the workspace a pointer with its draft, a viewer's without, nothing elsewhere", async () => {
		const s1 = await workspace("s1");
		const [ann, ben] = [await person("Ann", s1), await person("Ben", s1)];
		const [board, other] = [await canvasIn(s1), await canvasIn(s1)];
		await things.link({ workspace: pi, thing: board, by: BY }, context);
		await things.putParty({ workspace: pi, party: { kind: "person", person: ann.id }, source: BY }, context);
		// Ben keeps a viewer: a take-away naming him removes everyone's Draw from him (item 106).
		await things.setGrants(
			{
				source: BY,
				grants: [
					{
						workspace: s1,
						thing: board,
						party: { kind: "person", person: ben.id },
						gives: false,
						ticks: [],
						takenAway: ["draw"],
					},
				],
			},
			context,
		);
		const seen: Motion[] = [];
		const elsewhere: Motion[] = [];
		await holding(ann, s1, other, async (away, outer) => {
			await away.motion.on(({ value }) => elsewhere.push(value), outer);
			await holding(ann, pi, board, async (there, inner) => {
				await there.motion.on(({ value }) => elsewhere.push(value), inner);
				await holding(ann, s1, board, async (watching, ctx) => {
					await watching.motion.on(({ value }) => seen.push(value), ctx);
					await holding(ann, s1, board, async (canvas, call) => {
						await canvas.point({ x: 5, y: 6, draft: STROKE }, call);
						await canvas.leave(call);
					});
					await holding(ben, s1, board, (canvas, call) => canvas.point({ x: 7, y: 8, draft: STROKE }, call));
					await holding({ kind: "worker", session: "s1" }, s1, board, (canvas, call) =>
						canvas.point({ x: 1, y: 1, draft: null }, call),
					);
					await eventually(
						() => seen.length,
						(count) => count === 4,
						2000,
					);
				});
			});
		});
		assert.deepEqual(seen, [
			{ kind: "point", who: `person:${ann.id}`, name: "Ann", x: 5, y: 6, draft: STROKE },
			{ kind: "leave", who: `person:${ann.id}` },
			{ kind: "point", who: `person:${ben.id}`, name: "Ben", x: 7, y: 8, draft: null },
			{ kind: "point", who: "agent:s1", name: "Agent", x: 1, y: 1, draft: null },
		]);
		assert.deepEqual(elsewhere, []);
	});
});
