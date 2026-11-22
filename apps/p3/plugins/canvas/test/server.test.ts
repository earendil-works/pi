// The canvas plugin on the server (`testPlugin`, beside the real sessions, people, environments, apps, coding and
// sign-in facets): the kind (no records), the admission (a viewer: who reads, or writes with options that say no
// draw; a drawer; the agent by its own options; a removed member denied live; nobody outside), shapes keyed per
// session and board and carried by the session's delete, authors as `Me` says, removing and clearing, the list with
// `more`, and motion as events: everyone on the board sees a pointer move with the shape being drawn, a viewer's
// pointer without a draft, nothing of another board.

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
	Session,
	Sessions,
	THIS_DEVICE,
	ThingKindCatalog,
	thingOf,
	until,
} from "@earendil-works/p3/v1";
import { PeopleStore, SessionsStore } from "@earendil-works/p3/v1/server";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { eventually, within } from "../../../test/until.ts";
import appsServer from "../../apps/server.ts";
import codingServer from "../../coding/server.ts";
import environmentsServer from "../../environments/server.ts";
import peopleServer from "../../people/server.ts";
import sessionsServer from "../../sessions/server.ts";
import signInServer from "../../sign-in/server.ts";
import { CodingTools } from "../../tools/contract.ts";
import toolsServer from "../../tools/server.ts";
import { Canvas, CanvasKind, type Motion, type Shape } from "../contract.ts";

const OWNER: P3Principal = { kind: "owner" };

/** Where the tests' sessions work. */
const HERE = { environment: THIS_DEVICE, folder: "/tmp/p3-canvas-test" };

/** A person's principal. */
type Person = Extract<P3Principal, { kind: "person" }>;

/** `Canvas` as a test holds it. */
type CanvasRef = Reference<typeof Canvas>;

/** A short red stroke. */
const STROKE: Shape = { kind: "line", color: "#cf222e", width: 6, points: [10, 10, 20, 20, 30, 10] };

/** A blue box. */
const BOX: Shape = { kind: "rect", color: "#0969da", x: 100, y: 100, w: 50, h: 40, fill: false };

let t: TestedPlugin<P3Principal>;

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
				{ name: "@earendil-works/p3-tools", facet: toolsServer },
			],
		},
		context,
	);
});

afterEach(() => t.close(context));

/** Makes person `name`; their principal. */
async function person(name: string): Promise<Person> {
	const id = await t.root(async (ctx) => (await ctx.get(PeopleStore, {})).createPerson({ name }, ctx), context);
	return { kind: "person", id, name };
}

/** Makes a coding session with `members` and two boards; its id and the boards' things. */
async function session(members: Member[]): Promise<{ id: string; board: string; other: string }> {
	return t.root(async (ctx) => {
		const store = await ctx.get(SessionsStore, {});
		const id = await store.create({ app: "coding", location: HERE, members }, ctx);
		const board = await store.addThing({ session: id, thing: thingOf(CanvasKind) }, ctx);
		const other = await store.addThing({ session: id, thing: thingOf(CanvasKind) }, ctx);
		return { id, board, other };
	}, context);
}

/** Sets the options of board `thing` of session `id` for `forWhom`, as the owner. */
function setOptions(id: string, thing: string, forWhom: OptionsFor, draw: boolean): Promise<null> {
	return t.root(
		async (ctx) =>
			(await ctx.get(Sessions, {})).setOptions({ session: id, thing, for: forWhom, options: { draw } }, ctx),
		context,
		{ principal: OWNER },
	);
}

/** Runs `fn` with `principal`'s `Canvas` of board `thing` of session `id`. */
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
	if (canvas.variant !== "drawer") return assert.fail(`a ${canvas.variant}`);
	return canvas;
}

/** `canvas`' variant now (a reference's variant changes with its admission). */
function variantOf(canvas: CanvasRef): string {
	return canvas.variant;
}

/** The variant `principal` gets of board `thing` of session `id`. */
function variant(principal: P3Principal, id: string, thing: string): Promise<string> {
	return holding(principal, id, thing, async (canvas) => canvas.variant);
}

/** Whether `promise` rejects with a ChordError of `code`. */
async function refused(promise: Promise<unknown>, code = "forbidden"): Promise<void> {
	await assert.rejects(promise, (error: unknown) => isChordError(error) && error.code === code);
}

/** Whether `principal` is refused board `thing` of session `id`. */
function denied(principal: P3Principal, id: string, thing: string): Promise<void> {
	return refused(
		t.root(async (ctx) => ctx.get(Canvas, { session: id, thing }, { readyTimeout: 500 }), context, { principal }),
	);
}

describe("the kind", () => {
	it("is a board without records, which the owner adds by its kind", async () => {
		const kinds = await t.root(async (ctx) => (await ctx.get(ThingKindCatalog, {})).kinds.value, context, {
			principal: OWNER,
		});
		assert.deepEqual(
			kinds.filter(({ kind }) => kind === CanvasKind.name),
			[{ kind: CanvasKind.name, title: "Canvas" }],
		);
		assert.deepEqual(CanvasKind.initial, { draw: true });
	});
});

describe("who may do what on a board", () => {
	/** A session with Ann (writes), Ben (reads) and Cleo (writes); its boards. */
	async function setup() {
		const ann = await person("Ann");
		const ben = await person("Ben");
		const cleo = await person("Cleo");
		const made = await session([
			{ kind: "person", id: ann.id, access: "write" },
			{ kind: "person", id: ben.id, access: "read" },
			{ kind: "person", id: cleo.id, access: "write" },
		]);
		return { ann, ben, cleo, ...made };
	}

	it("gives a reader and a writer whose options say no draw the viewer, writers and the owner the drawer", async () => {
		const { ann, ben, cleo, id, board } = await setup();
		await setOptions(id, board, { kind: "person", id: cleo.id }, false);
		assert.equal(await variant(ann, id, board), "drawer");
		assert.equal(await variant(OWNER, id, board), "drawer");
		assert.equal(await variant(ben, id, board), "viewer");
		assert.equal(await variant(cleo, id, board), "viewer");
		// The default turned to no draw: Ann, without options of her own, looks only, at once.
		await holding(ann, id, board, async (canvas, ctx) => {
			assert.equal(canvas.variant, "drawer");
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

	it("denies a member the moment they are removed, a person outside, and a thing of another kind", async () => {
		const { ben, id, board } = await setup();
		await denied(await person("Dana"), id, board);
		const tools = await t.root(
			async (ctx) => (await ctx.get(SessionsStore, {})).addThing({ session: id, thing: thingOf(CodingTools) }, ctx),
			context,
		);
		await denied(OWNER, id, tools);
		await denied(OWNER, id, "no-such-thing");
		await holding(ben, id, board, async (canvas, ctx) => {
			assert.equal(canvas.variant, "viewer");
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

describe("a board's shapes", () => {
	it("are kept per session and board, with who drew them as Me says", async () => {
		const ann = await person("Ann");
		const first = await session([{ kind: "person", id: ann.id, access: "write" }]);
		const second = await session([{ kind: "person", id: ann.id, access: "write" }]);
		const [stroke] = await holding(ann, first.id, first.board, (canvas, ctx) =>
			drawerOf(canvas).add({ shapes: [STROKE] }, ctx),
		);
		await holding(OWNER, first.id, first.board, (canvas, ctx) => drawerOf(canvas).add({ shapes: [BOX] }, ctx));
		await holding({ kind: "worker", session: first.id }, first.id, first.board, (canvas, ctx) =>
			drawerOf(canvas).add({ shapes: [BOX] }, ctx),
		);
		const rows = await holding(ann, first.id, first.board, async (canvas) => canvas.shapes.value.rows);
		assert.deepEqual(
			rows.map(({ author, shape }) => [author, shape.kind]),
			[
				[`person:${ann.id}`, "line"],
				["owner", "rect"],
				["agent", "rect"],
			],
		);
		assert.deepEqual(rows[0], { id: stroke, author: `person:${ann.id}`, shape: STROKE });
		// The session's other board, and the same thing id in another session, have none of them.
		assert.deepEqual(await holding(ann, first.id, first.other, async (canvas) => canvas.shapes.value.rows), []);
		assert.deepEqual(await holding(ann, second.id, second.board, async (canvas) => canvas.shapes.value.rows), []);
	});

	it("go with their session's data, and only theirs", async () => {
		const first = await session([]);
		const second = await session([]);
		await holding(OWNER, first.id, first.board, (canvas, ctx) => drawerOf(canvas).add({ shapes: [STROKE] }, ctx));
		await holding(OWNER, second.id, second.board, (canvas, ctx) => drawerOf(canvas).add({ shapes: [BOX] }, ctx));
		await t.host.deleteHostData(Session({ id: first.id }), context, { plugin: "@earendil-works/p3-canvas" });
		assert.deepEqual(await holding(OWNER, first.id, first.board, async (canvas) => canvas.shapes.value.rows), []);
		assert.equal(
			(await holding(OWNER, second.id, second.board, async (canvas) => canvas.shapes.value.rows)).length,
			1,
		);
	});

	it("are removed one by one and cleared by a drawer, live for every holder", async () => {
		const ann = await person("Ann");
		const ben = await person("Ben");
		const { id, board, other } = await session([
			{ kind: "person", id: ann.id, access: "write" },
			{ kind: "person", id: ben.id, access: "read" },
		]);
		await holding(OWNER, id, other, (canvas, ctx) => drawerOf(canvas).add({ shapes: [BOX] }, ctx));
		await holding(ben, id, board, async (watching, ctx) => {
			assert.equal(watching.variant, "viewer");
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
		// Clearing one board leaves the other.
		assert.equal((await holding(OWNER, id, other, async (canvas) => canvas.shapes.value.rows)).length, 1);
	});

	it("refuses shapes outside the schema", async () => {
		const { id, board } = await session([]);
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
		const { id, board } = await session([]);
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

describe("a board's motion", () => {
	it("shows every holder a pointer with the shape being drawn, a viewer's without, and nothing of another board", async () => {
		const ann = await person("Ann");
		const ben = await person("Ben");
		const { id, board, other } = await session([
			{ kind: "person", id: ann.id, access: "write" },
			{ kind: "person", id: ben.id, access: "read" },
		]);
		const seen: Motion[] = [];
		const elsewhere: Motion[] = [];
		await holding(OWNER, id, other, async (away, outer) => {
			await away.motion.on(({ value }) => elsewhere.push(value), outer);
			await holding(OWNER, id, board, async (watching, ctx) => {
				await watching.motion.on(({ value }) => seen.push(value), ctx);
				await holding(ann, id, board, async (canvas, inner) => {
					await canvas.point({ x: 5, y: 6, draft: STROKE }, inner);
					await canvas.leave(inner);
				});
				await holding(ben, id, board, async (canvas, inner) => {
					await canvas.point({ x: 7, y: 8, draft: STROKE }, inner);
				});
				// Events show in no watchable: the listener's log is polled.
				await eventually(
					() => seen.length,
					(count) => count === 3,
					2000,
				);
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
