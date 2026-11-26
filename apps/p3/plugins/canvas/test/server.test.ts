// The canvas plugin on the server (`testPlugin`, beside the real sessions, people, environments, apps, coding and
// sign-in facets): the kind (content, which a writer makes in a session; its shapes dropped when it goes), the
// admission (a viewer: who reads, or writes with options that say no draw; a drawer; the agent by its own options; a
// removed member denied live; nobody outside), shapes keyed by the canvas's id, so the same canvas linked into two
// sessions shows the same drawing while who may draw stays each session's, authors as `Me` says, removing and
// clearing, the list with `more`, and motion as events: everyone on the canvas in the session sees a pointer move
// with the shape being drawn, a viewer's pointer without a draft, nothing of another canvas or another session.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	isChordError,
	type Member,
	type OptionsFor,
	type P3Principal,
	type Reference,
	SESSION_THINGS_WRITES,
	SessionThings,
	THIS_DEVICE,
	until,
	type With,
} from "@earendil-works/p3/v1";
import { PeopleStore, SessionsStore } from "@earendil-works/p3/v1/server";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { assertGranted } from "../../../test/granted.ts";
import { eventually, within } from "../../../test/until.ts";
import appsServer from "../../apps/server.ts";
import codingServer from "../../coding/server.ts";
import environmentsServer from "../../environments/server.ts";
import peopleServer from "../../people/server.ts";
import sessionsServer from "../../sessions/server.ts";
import signInServer from "../../sign-in/server.ts";
import { CANVAS_DRAWS, Canvas, CanvasKind, type Motion, type Shape } from "../contract.ts";
import { CanvasStore } from "../store.ts";

/** Where the tests' sessions work. */
const HERE = { environment: THIS_DEVICE, folder: "/tmp/p3-canvas-test" };

/** A person's principal. */
type Person = Extract<P3Principal, { kind: "person" }>;

/** `Canvas` as a test holds it. */
type CanvasRef = Reference<typeof Canvas>;

/** `SessionThings`' writer, as a test holds it. */
type Writer = With<Reference<typeof SessionThings>, (typeof SESSION_THINGS_WRITES)[number]>;

/** A short red stroke. */
const STROKE: Shape = { kind: "line", color: "#cf222e", width: 6, points: [10, 10, 20, 20, 30, 10] };

/** A blue box. */
const BOX: Shape = { kind: "rect", color: "#0969da", x: 100, y: 100, w: 50, h: 40, fill: false };

let t: TestedPlugin<P3Principal>;

/** The owner's person in this test's Pi. */
let OWNER: Person;

beforeEach(async () => {
	t = await testPlugin(
		fileURLToPath(new URL("../", import.meta.url)),
		{
			kind: "server",
			stubs: [
				{ name: "@earendil-works/p3-apps", facet: appsServer },
				{ name: "@earendil-works/p3-coding", facet: codingServer },
				{ name: "@earendil-works/p3-environments", facet: environmentsServer },
				{ name: "@earendil-works/p3-people", facet: peopleServer },
				{ name: "@earendil-works/p3-sessions", facet: sessionsServer },
				{ name: "@earendil-works/p3-sign-in", facet: signInServer },
			],
		},
		context,
	);
	const [owner] = await t.root(
		async (ctx) => (await (await ctx.get(PeopleStore, {})).persons.owner.page({}, 1, ctx)).items,
		context,
	);
	OWNER = { kind: "person", id: owner!.id, name: owner!.name };
});

afterEach(() => t.close(context));

/** Makes person `name`; their principal. */
async function person(name: string): Promise<Person> {
	const id = await t.root(async (ctx) => (await ctx.get(PeopleStore, {})).createPerson({ name }, ctx), context);
	return { kind: "person", id, name };
}

/** Makes a coding session with `members`, following nobody; its id. */
function session(members: Member[]): Promise<string> {
	return t.root(
		async (ctx) =>
			(await ctx.get(SessionsStore, {})).create({ app: "coding", location: HERE, members, follows: null }, ctx),
		context,
	);
}

/** Runs `fn` with `principal`'s `SessionThings` writer of session `id`. */
function managing<T>(principal: P3Principal, id: string, fn: (things: Writer, ctx: Ctx<P3Principal>) => Promise<T>) {
	return t.root(
		async (ctx) => {
			const things = await ctx.get(SessionThings, { session: id });
			assertGranted(things, ...SESSION_THINGS_WRITES);
			return fn(things, ctx);
		},
		context,
		{ principal },
	);
}

/** `principal` makes a canvas (named `name`) in session `id`; its id. */
function canvasIn(principal: P3Principal, id: string, name?: string): Promise<string> {
	return managing(principal, id, (things, ctx) =>
		things.create({ kind: CanvasKind.name, ...(name === undefined ? {} : { name }) }, ctx),
	);
}

/** A session with Ann (writes), Ben (reads) and Cleo (writes), and two canvases the owner made there. */
async function setup() {
	const ann = await person("Ann");
	const ben = await person("Ben");
	const cleo = await person("Cleo");
	const id = await session([
		{ kind: "person", id: ann.id, access: "write" },
		{ kind: "person", id: ben.id, access: "read" },
		{ kind: "person", id: cleo.id, access: "write" },
	]);
	return { ann, ben, cleo, id, board: await canvasIn(OWNER, id, "Plan"), other: await canvasIn(OWNER, id) };
}

/** Sets the options of canvas `thing` in session `id` for `forWhom`, as the owner. */
function setOptions(id: string, thing: string, forWhom: OptionsFor, draw: boolean): Promise<null> {
	return managing(OWNER, id, (things, ctx) => things.setOptions({ thing, for: forWhom, options: { draw } }, ctx));
}

/** Runs `fn` with `principal`'s `Canvas` of canvas `thing` in session `id`. */
function holding<T>(
	principal: P3Principal,
	id: string,
	thing: string,
	fn: (canvas: CanvasRef, ctx: Ctx<P3Principal>) => Promise<T>,
) {
	return t.root(async (ctx) => fn(await ctx.get(Canvas, { session: id, thing }), ctx), context, { principal });
}

/** The drawer of `canvas`, failing the test for a viewer. */
function drawerOf(canvas: CanvasRef) {
	assertGranted(canvas, ...CANVAS_DRAWS);
	return canvas;
}

/** `canvas`' variant now (a reference's variant changes with its admission). */
function variantOf(canvas: CanvasRef): string {
	return canvas.granted.has("add") ? "drawer" : "viewer";
}

/** The variant `principal` gets of canvas `thing` in session `id`. */
function variant(principal: P3Principal, id: string, thing: string): Promise<string> {
	return holding(principal, id, thing, async (canvas) => (canvas.granted.has("add") ? "drawer" : "viewer"));
}

/** The shapes of canvas `thing` as `principal` sees them in session `id`. */
function shapesOf(principal: P3Principal, id: string, thing: string) {
	return holding(principal, id, thing, async (canvas) => canvas.shapes.value.rows);
}

/** Whether `promise` rejects with a ChordError of `code`. */
async function refused(promise: Promise<unknown>, code = "forbidden"): Promise<void> {
	await assert.rejects(promise, (error: unknown) => isChordError(error) && error.code === code);
}

/** Whether `principal` is refused canvas `thing` in session `id`. */
function denied(principal: P3Principal, id: string, thing: string): Promise<void> {
	return refused(
		t.root(async (ctx) => ctx.get(Canvas, { session: id, thing }, { readyTimeout: 500 }), context, { principal }),
	);
}

describe("the kind", () => {
	it("is content: a writer makes a canvas in a session, named by its thing, else Canvas", async () => {
		const ann = await person("Ann");
		const id = await session([{ kind: "person", id: ann.id, access: "write" }]);
		const kinds = await managing(ann, id, async (things) => things.kinds.value);
		assert.deepEqual(
			kinds.filter(({ kind }) => kind === CanvasKind.name),
			[{ kind: CanvasKind.name, title: "Canvas" }],
		);
		const named = await canvasIn(ann, id, "Sketches");
		const unnamed = await canvasIn(ann, id);
		assert.equal(await holding(ann, id, named, async (canvas) => canvas.name.value), "Sketches");
		assert.equal(await holding(ann, id, unnamed, async (canvas) => canvas.name.value), "Canvas");
		// Renamed, the same everywhere: the view follows.
		await holding(ann, id, unnamed, async (canvas, ctx) => {
			await managing(ann, id, (things, inner) => things.rename({ thing: unnamed, name: "Ideas" }, inner));
			await until(canvas.name, (name) => name === "Ideas", within("the new name", ctx));
		});
	});

	it("drops a canvas's shapes when the canvas goes with its last link, and only its", async () => {
		const { id, board, other } = await setup();
		await holding(OWNER, id, board, (canvas, ctx) => drawerOf(canvas).add({ shapes: [STROKE, BOX] }, ctx));
		await holding(OWNER, id, other, (canvas, ctx) => drawerOf(canvas).add({ shapes: [BOX] }, ctx));
		await managing(OWNER, id, (things, ctx) => things.remove({ thing: board }, ctx));
		const stored = (canvas: string) =>
			t.root(
				async (ctx) => (await (await ctx.get(CanvasStore, {})).shapes.of.page({ canvas }, 10, ctx)).items,
				context,
			);
		await eventually(
			() => stored(board),
			(rows) => rows.length === 0,
			2000,
		);
		assert.equal((await stored(other)).length, 1);
	});
});

describe("who may do what on a canvas", () => {
	it("gives a reader and a writer whose options say no draw the viewer, writers and the owner the drawer", async () => {
		const { ann, ben, cleo, id, board } = await setup();
		await setOptions(id, board, { kind: "person", id: cleo.id }, false);
		assert.equal(await variant(ann, id, board), "drawer");
		assert.equal(await variant(OWNER, id, board), "drawer");
		assert.equal(await variant(ben, id, board), "viewer");
		assert.equal(await variant(cleo, id, board), "viewer");
		// The default turned to no draw: Ann, without options of her own, looks only, at once.
		await holding(ann, id, board, async (canvas, ctx) => {
			assert.equal(canvas.granted.has("add") ? "drawer" : "viewer", "drawer");
			await setOptions(id, board, { kind: "everyone" }, false);
			await until(
				canvas.state,
				(state) => state.kind === "live" && variantOf(canvas) === "viewer",
				within("the viewer", ctx),
			);
		});
	});

	it("gives the agent the drawer or the viewer as its own options say, and no other session's worker anything", async () => {
		const { id, board } = await setup();
		const agent: P3Principal = { kind: "worker", session: id };
		assert.equal(await variant(agent, id, board), "drawer");
		await setOptions(id, board, { kind: "agent" }, false);
		assert.equal(await variant(agent, id, board), "viewer");
		// The members' default is unchanged.
		assert.equal(await variant(OWNER, id, board), "drawer");
		await denied({ kind: "worker", session: "other" }, id, board);
	});

	it("denies a member the moment they are removed, a person outside, and a canvas the session does not have", async () => {
		const { ben, id, board } = await setup();
		await denied(await person("Dana"), id, board);
		const elsewhere = await canvasIn(OWNER, await session([]));
		await denied(OWNER, id, elsewhere);
		await denied(OWNER, id, "no-such-thing");
		await holding(ben, id, board, async (canvas, ctx) => {
			assert.equal(canvas.granted.has("add") ? "drawer" : "viewer", "viewer");
			await t.root(
				async (server) =>
					(await server.get(SessionsStore, {})).removeMember(
						{ session: id, party: { kind: "person", id: ben.id } },
						server,
					),
				context,
			);
			await until(
				canvas.state,
				(state) => state.kind === "failed" && state.cause.kind === "denied",
				within("Ben denied", ctx),
			);
		});
	});
});

describe("a canvas's shapes", () => {
	it("are the canvas's: the same drawing in every session it is linked into, who may draw each session's", async () => {
		const ann = await person("Ann");
		const first = await session([{ kind: "person", id: ann.id, access: "write" }]);
		const second = await session([{ kind: "person", id: ann.id, access: "read" }]);
		const shared = await canvasIn(ann, first, "Shared");
		// Ann keeps it (it is hers now), and the owner links it into the second session, where Ann only reads.
		await managing(ann, first, (things, ctx) =>
			things.keep({ thing: shared, owner: { kind: "person", id: ann.id } }, ctx),
		);
		await t.root(
			async (ctx) => (await ctx.get(SessionsStore, {})).addThing({ session: second, thing: shared }, ctx),
			context,
		);
		const [stroke] = await holding(ann, first, shared, (canvas, ctx) =>
			drawerOf(canvas).add({ shapes: [STROKE] }, ctx),
		);
		await holding(ann, second, shared, async (canvas) => {
			assert.equal(canvas.granted.has("add") ? "drawer" : "viewer", "viewer");
			assert.equal(canvas.name.value, "Shared");
			assert.deepEqual(canvas.shapes.value.rows, [{ id: stroke, author: `person:${ann.id}`, shape: STROKE }]);
		});
		// Drawing off in the first session leaves the second's rights alone, and the other way round.
		await setOptions(first, shared, { kind: "everyone" }, false);
		assert.equal(await variant(OWNER, first, shared), "viewer");
		assert.equal(await variant(OWNER, second, shared), "drawer");
	});

	it("are kept per canvas, with who drew them as Me says", async () => {
		const { ann, id, board, other } = await setup();
		const [stroke] = await holding(ann, id, board, (canvas, ctx) => drawerOf(canvas).add({ shapes: [STROKE] }, ctx));
		await holding(OWNER, id, board, (canvas, ctx) => drawerOf(canvas).add({ shapes: [BOX] }, ctx));
		await holding({ kind: "worker", session: id }, id, board, (canvas, ctx) =>
			drawerOf(canvas).add({ shapes: [BOX] }, ctx),
		);
		const rows = await shapesOf(ann, id, board);
		assert.deepEqual(
			rows.map(({ author, shape }) => [author, shape.kind]),
			[
				[`person:${ann.id}`, "line"],
				[`person:${OWNER.id}`, "rect"],
				["agent", "rect"],
			],
		);
		assert.deepEqual(rows[0], { id: stroke, author: `person:${ann.id}`, shape: STROKE });
		assert.deepEqual(await shapesOf(ann, id, other), []);
	});

	it("are removed one by one and cleared by a drawer, live for every holder", async () => {
		const { ann, ben, id, board, other } = await setup();
		await holding(OWNER, id, other, (canvas, ctx) => drawerOf(canvas).add({ shapes: [BOX] }, ctx));
		await holding(ben, id, board, async (watching, ctx) => {
			assert.equal(watching.granted.has("add") ? "drawer" : "viewer", "viewer");
			await holding(ann, id, board, async (canvas, inner) => {
				const drawer = drawerOf(canvas);
				const [first, second, third] = await drawer.add({ shapes: [STROKE, BOX, STROKE] }, inner);
				await until(watching.shapes, (list) => list.rows.length === 3, within("three shapes", ctx));
				await drawer.remove({ id: second! }, inner);
				await until(
					watching.shapes,
					(list) => list.rows.map((row) => row.id).join() === [first, third].join(),
					within("the box removed", ctx),
				);
				await refused(drawer.remove({ id: second! }, inner), "invalid");
				await drawer.clear(inner);
				await until(watching.shapes, (list) => list.rows.length === 0, within("cleared", ctx));
			});
		});
		// Clearing one canvas leaves the other.
		assert.equal((await shapesOf(OWNER, id, other)).length, 1);
	});

	it("refuses shapes outside the schema", async () => {
		const { id, board } = await setup();
		await holding(OWNER, id, board, async (canvas, ctx) => {
			const drawer = drawerOf(canvas);
			const bad = [
				{ ...STROKE, color: "red" },
				{ ...STROKE, points: [1, 2] },
				{ kind: "circle", color: "#000000" },
				{ kind: "text", color: "#000000", x: 1, y: 1, text: "", size: 20 },
			];
			// Shapes a page could send: the schema is the trust boundary.
			for (const shape of bad) await refused(drawer.add({ shapes: [shape as Shape] }, ctx), "invalid");
			assert.deepEqual(canvas.shapes.value.rows, []);
		});
	});

	it("loads a page of 500, oldest first, and the next with more", async () => {
		const { id, board } = await setup();
		await holding(OWNER, id, board, async (canvas, ctx) => {
			const drawer = drawerOf(canvas);
			for (let batch = 0; batch < 6; batch++) {
				const shapes = Array.from({ length: 100 }, (_, i): Shape => ({ ...BOX, x: batch * 100 + i }));
				await drawer.add({ shapes }, ctx);
			}
		});
		// A new list (the rows exist before it opens): the first page, then `more`.
		await holding(OWNER, id, board, async (canvas, ctx) => {
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
	it("shows every holder in the session a pointer with the shape being drawn, a viewer's without, nothing elsewhere", async () => {
		const { ann, ben, id, board, other } = await setup();
		// The same canvas in another session: its people see nothing of this session's.
		await managing(OWNER, id, (things, ctx) => things.keep({ thing: board, owner: { kind: "pi" } }, ctx));
		const second = await session([]);
		await t.root(
			async (ctx) => (await ctx.get(SessionsStore, {})).addThing({ session: second, thing: board }, ctx),
			context,
		);
		const seen: Motion[] = [];
		const elsewhere: Motion[] = [];
		await holding(OWNER, id, other, async (away, outer) => {
			await away.motion.on(({ value }) => elsewhere.push(value), outer);
			await holding(OWNER, second, board, async (there, inner) => {
				await there.motion.on(({ value }) => elsewhere.push(value), inner);
				await holding(OWNER, id, board, async (watching, ctx) => {
					await watching.motion.on(({ value }) => seen.push(value), ctx);
					await holding(ann, id, board, async (canvas, call) => {
						await canvas.point({ x: 5, y: 6, draft: STROKE }, call);
						await canvas.leave(call);
					});
					await holding(ben, id, board, (canvas, call) => canvas.point({ x: 7, y: 8, draft: STROKE }, call));
					// Events show in no watchable: the listener's log is polled.
					await eventually(
						() => seen.length,
						(count) => count === 3,
						2000,
					);
				});
			});
		});
		assert.deepEqual(seen, [
			{ kind: "point", who: `person:${ann.id}`, name: "Ann", x: 5, y: 6, draft: STROKE },
			{ kind: "leave", who: `person:${ann.id}` },
			{ kind: "point", who: `person:${ben.id}`, name: "Ben", x: 7, y: 8, draft: null },
		]);
		assert.deepEqual(elsewhere, []);
	});
});
