// The canvas plugin on the server (`kindServer`: its server facet beside the things plugin's): the kind (registered by
// its plugin, made by anyone; named by its thing, "" while unnamed; its shapes dropped when the board goes with its
// last link, also when its delete runs again, and an add committed after it refused), the one admission (a person put
// in and the session's agent get Draw; Moderate only people; each tick alone gives its own members and flags; `@open`
// alone leaves a viewer; the owner gets every tick without being put in; a changed grant rebinds a held board live; a
// board hidden in a workspace, or a caller removed, is denied; nobody else is let in), shapes keyed by the board (the
// same in every workspace it is linked in), authors as the admission says (`Caller`), removing one's own shapes and,
// with Moderate, anyone's and clearing, refusals with their messages; each caller's pages (500, `more`, kept across a
// reload), a page read now; motion as events, per workspace, who moves as a tagged union; the counted cost of a shape;
// and a released board collected.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, type P3Principal, type Reference, until } from "@earendil-works/p3/v1";
import { collected, eventually, within } from "../../../test/until.ts";
import { ThingHooks } from "../../things/contract.server.ts";
import { OPEN, type Party, type Source } from "../../things/contract.ts";
import { ThingKinds } from "../../things/kind.ts";
import { BY, type KindServer, kindServer, refused } from "../../things/test/kind-server.ts";
import { type Canvas, CanvasKind, type Motion, type Shape } from "../kind.ts";
import canvasServer from "../server.ts";
import { CanvasStore } from "../store.ts";

/** The canvas plugin's root. */
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The canvas plugin: the source of its kind's default grants. */
const CANVAS_PLUGIN: Source = { kind: "plugin", plugin: "@earendil-works/p3-canvas" };

/** The session's agent of workspace `s1`. */
const AGENT: P3Principal = { kind: "worker", session: "s1" };

/** A short red stroke. */
const STROKE: Shape = { kind: "line", color: "#cf222e", width: 6, points: [10, 10, 20, 20, 30, 10] };

/** A blue box. */
const BOX = { kind: "rect", color: "#0969da", x: 100, y: 100, w: 50, h: 40, fill: false } as const satisfies Shape;

/** Everyone, as a party. */
const EVERYONE: Party = { kind: "everyone" };

let n: KindServer<typeof Canvas>;

beforeEach(async () => {
	n = await kindServer({ name: "@earendil-works/p3-canvas", root: ROOT, server: canvasServer }, CanvasKind, context);
});

afterEach(() => n.close());

/** Replaces the kind's Draw for everyone on `thing` in `where` by `@open`: everyone there looks, no more. */
const viewersOnly = (where: string, thing: string) =>
	n.things.setGrants(
		{
			source: CANVAS_PLUGIN,
			grants: [
				{ workspace: where, thing, party: EVERYONE, tick: "draw" },
				{ workspace: where, thing, party: EVERYONE, tick: OPEN, gives: true },
			],
		},
		context,
	);

/** The shapes `thing`'s store has now. */
const stored = async (thing: string) =>
	(await (await n.host.get(CanvasStore, {}, context)).shapes.of.page({ canvas: thing }, 10, context)).items;

describe("the kind", () => {
	it("is registered by the canvas plugin, made by anyone", async () => {
		const entry = (await n.host.registry(ThingKinds, context)).value.get(CanvasKind.name);
		assert.deepEqual([entry?.plugin, entry?.value.makers], ["@earendil-works/p3-canvas", "anyone"]);
	});

	it("names a board by its thing, empty while it has none, and follows a rename", async () => {
		const ann = await n.person("Ann");
		const named = await n.thingIn(n.pi, "Sketches");
		const unnamed = await n.thingIn(n.pi);
		assert.equal(await n.holding(ann, n.pi, named, async (canvas) => canvas.name.value), "Sketches");
		await n.holding(ann, n.pi, unnamed, async (canvas, ctx) => {
			assert.equal(canvas.name.value, "");
			await n.things.rename({ thing: unnamed, name: "Ideas" }, context);
			await until(canvas.name, (name) => name === "Ideas", within("the new name", ctx));
		});
	});

	it("drops a board's shapes when it goes with its last link, and only its; its delete may run again", async () => {
		const ann = await n.person("Ann");
		const [board, other] = [await n.thingIn(n.pi), await n.thingIn(n.pi)];
		await n.holding(ann, n.pi, board, (canvas, ctx) => canvas.add!({ shapes: [STROKE, BOX] }, ctx));
		await n.holding(ann, n.pi, other, (canvas, ctx) => canvas.add!({ shapes: [BOX] }, ctx));
		await n.things.unlink({ workspace: n.pi, thing: board }, context);
		await eventually(
			() => stored(board),
			(rows) => rows.length === 0,
			2000,
		);
		// The things plugin runs a delete again after a failure or a restart: a second run finds nothing and succeeds.
		const hook = (await n.host.registry(ThingHooks, context)).value.get(CanvasKind.name)?.value.delete;
		await n.host.root((ctx) => hook!(board, ctx), context);
		assert.equal((await stored(other)).length, 1);
	});

	it("refuses an add that commits after the board's delete, so none of it comes back", async () => {
		const board = await n.thingIn(n.pi);
		const hook = (await n.host.registry(ThingHooks, context)).value.get(CanvasKind.name)?.value.delete;
		await n.host.root((ctx) => hook!(board, ctx), context);
		// The delete marked the board gone: an add begun before it (its caller held the board) commits after it.
		const store = await n.host.get(CanvasStore, {}, context);
		await refused(
			store.add({ canvas: board, shapes: [BOX], author: { kind: "server" } }, context),
			"invalid",
			"gone",
		);
		assert.deepEqual(await stored(board), []);
	});
});

describe("who may do what on a board", () => {
	it("gives a person put in and the session's agent Draw; Moderate only to people; nobody outside anything", async () => {
		const s1 = await n.workspace("s1");
		const ann = await n.person("Ann", s1);
		const board = await n.thingIn(s1);
		assert.deepEqual(await n.granted(ann, s1, board), ["add", "export", "remove"]);
		assert.deepEqual(await n.granted(AGENT, s1, board), ["add", "export", "remove"]);
		await n.tick(s1, board, { kind: "person", person: ann.id }, "moderate", true);
		assert.deepEqual(await n.granted(ann, s1, board), ["add", "clear", "export", "remove", "removeAny"]);
		await refused(n.tick(s1, board, { kind: "agents" }, "moderate", true), "invalid");
		await refused(n.granted({ kind: "worker", session: "s2" }, s1, board));
		const dana = await n.things.createPerson({ name: "Dana", madeBy: BY }, context);
		await refused(n.granted({ kind: "person", id: dana, name: "Dana" }, s1, board));
	});

	it("gives each tick alone its own members and flags", async () => {
		const bo = await n.person("Bo");
		const party: Party = { kind: "person", person: bo.id };
		const alone: readonly (readonly [string, readonly string[]])[] = [
			["draw", ["add", "export", "remove"]],
			["moderate", ["clear", "removeAny"]],
			["export", ["export"]],
			["removeAny", ["removeAny"]],
		];
		for (const [tick, members] of alone) {
			const board = await n.thingIn(n.pi);
			await viewersOnly(n.pi, board);
			await n.tick(n.pi, board, party, tick, true);
			await n.holding(bo, n.pi, board, async (canvas) => {
				assert.deepEqual([...canvas.granted].sort(), members, tick);
				assert.deepEqual(
					[canvas.add !== undefined, canvas.clear !== undefined],
					[members.includes("add"), members.includes("clear")],
					tick,
				);
			});
		}
	});

	it("lets in with @open alone a viewer, who looks, pages and points but has no drawing members", async () => {
		const ann = await n.person("Ann");
		const board = await n.thingIn(n.pi);
		await n.holding(ann, n.pi, board, (canvas, ctx) => canvas.add!({ shapes: [BOX] }, ctx));
		await viewersOnly(n.pi, board);
		await n.holding(ann, n.pi, board, async (canvas, ctx) => {
			assert.deepEqual(
				[canvas.add, canvas.remove, canvas.clear, canvas.granted.size],
				[undefined, undefined, undefined, 0],
			);
			assert.equal(canvas.shapes.value.rows.length, 1);
			assert.equal((await canvas.page({}, ctx)).rows.length, 1);
			await canvas.more(ctx);
			await canvas.point({ x: 1, y: 1, draft: null }, ctx);
			await canvas.leave(ctx);
		});
	});

	it("gives the owner every tick without being put in, also where Draw is withheld from everyone", async () => {
		const id = await n.things.createPerson({ name: "Olga", madeBy: BY }, context);
		await n.things.setOwner({ person: id, owner: true }, context);
		const board = await n.thingIn(n.pi);
		await n.tick(n.pi, board, EVERYONE, "draw", false);
		assert.deepEqual(await n.granted({ kind: "person", id, name: "Olga" }, n.pi, board), [
			"add",
			"clear",
			"export",
			"remove",
			"removeAny",
		]);
	});

	it("follows the grants live, on the same hold: Draw taken from everyone leaves a viewer, removed denied", async () => {
		const ann = await n.person("Ann");
		const board = await n.thingIn(n.pi);
		await n.holding(ann, n.pi, board, async (canvas, ctx) => {
			assert.ok(canvas.add !== undefined);
			await viewersOnly(n.pi, board);
			await until(
				canvas.state,
				(state) => state.kind === "live" && canvas.add === undefined,
				within("the viewer", ctx),
			);
			// A viewer's pointer travels without a draft.
			await canvas.point({ x: 1, y: 2, draft: STROKE }, ctx);
			await n.things.removeParty({ workspace: n.pi, party: { kind: "person", person: ann.id } }, context);
			await until(
				canvas.state,
				(state) => state.kind === "failed" && state.cause.kind === "denied",
				within("Ann denied", ctx),
			);
		});
	});

	it("denies a board hidden in a workspace there, live, and still lets it in where it is shown", async () => {
		const s1 = await n.workspace("s1");
		const ann = await n.person("Ann", s1);
		await n.things.putParty({ workspace: n.pi, party: { kind: "person", person: ann.id }, source: BY }, context);
		const board = await n.thingIn(n.pi, "Plan");
		await n.holding(ann, s1, board, async (canvas, ctx) => {
			assert.equal(canvas.name.value, "Plan");
			await n.things.setSwitch({ workspace: s1, item: { kind: "thing", thing: board }, shown: false }, context);
			await until(
				canvas.state,
				(state) => state.kind === "failed" && state.cause.kind === "denied",
				within("hidden in s1", ctx),
			);
		});
		assert.equal(await n.holding(ann, n.pi, board, async (canvas) => canvas.name.value), "Plan");
	});
});

describe("a board's shapes", () => {
	it("are the board's: the same drawing in every workspace it is linked in; who may draw each link's", async () => {
		const [s1, s2] = [await n.workspace("s1"), await n.workspace("s2")];
		const ann = await n.person("Ann", s1);
		await n.things.putParty({ workspace: s2, party: { kind: "person", person: ann.id }, source: BY }, context);
		const shared = await n.thingIn(s1, "Shared");
		await n.things.link({ workspace: s2, thing: shared }, context);
		await viewersOnly(s2, shared);
		const [stroke] = await n.holding(ann, s1, shared, (canvas, ctx) => canvas.add!({ shapes: [STROKE] }, ctx));
		await n.holding(ann, s2, shared, async (canvas) => {
			assert.equal(canvas.add, undefined);
			assert.equal(canvas.name.value, "Shared");
			assert.deepEqual(canvas.shapes.value.rows, [
				{ id: stroke, author: { kind: "person", person: ann.id }, shape: STROKE },
			]);
		});
	});

	it("are kept per board, with who drew them as the admission says", async () => {
		const s1 = await n.workspace("s1");
		const ann = await n.person("Ann", s1);
		const [board, other] = [await n.thingIn(s1), await n.thingIn(s1)];
		await n.holding(ann, s1, board, (canvas, ctx) => canvas.add!({ shapes: [STROKE] }, ctx));
		await n.holding(AGENT, s1, board, (canvas, ctx) => canvas.add!({ shapes: [BOX] }, ctx));
		const rows = await n.holding(ann, s1, board, async (canvas) => canvas.shapes.value.rows);
		assert.deepEqual(
			rows.map(({ author, shape }) => [author, shape.kind]),
			[
				[{ kind: "person", person: ann.id }, "line"],
				[{ kind: "agent", session: "s1" }, "rect"],
			],
		);
		assert.deepEqual(await n.holding(ann, s1, other, async (canvas) => canvas.shapes.value.rows), []);
	});

	it("a drawer removes their own; with Moderate anyone's, and clears, live for every holder", async () => {
		const [ann, ben] = [await n.person("Ann"), await n.person("Ben")];
		const board = await n.thingIn(n.pi);
		await n.holding(ben, n.pi, board, async (watching, outer) => {
			const [bens] = await watching.add!({ shapes: [BOX] }, outer);
			await n.holding(ann, n.pi, board, async (canvas, ctx) => {
				const [first, second] = await canvas.add!({ shapes: [STROKE, BOX] }, ctx);
				await until(watching.shapes, (list) => list.rows.length === 3, within("three shapes", outer));
				await canvas.remove!({ id: second! }, ctx);
				await refused(canvas.remove!({ id: bens! }, ctx), "invalid", "notYours");
				await refused(canvas.remove!({ id: second! }, ctx), "invalid", "noShape");
				assert.equal(canvas.clear, undefined);
				await n.tick(n.pi, board, { kind: "person", person: ann.id }, "moderate", true);
				await until(canvas.state, () => canvas.clear !== undefined, within("Moderate", ctx));
				await canvas.remove!({ id: bens! }, ctx);
				await until(
					watching.shapes,
					(list) => list.rows.length === 1 && list.rows[0]?.id === first,
					within("two removed", outer),
				);
				await canvas.clear!(ctx);
				await until(watching.shapes, (list) => list.rows.length === 0, within("cleared", outer));
			});
		});
	});

	it("refuses shapes outside the schema", async () => {
		const ann = await n.person("Ann");
		const board = await n.thingIn(n.pi);
		await n.holding(ann, n.pi, board, async (canvas, ctx) => {
			const bad = [
				{ ...STROKE, color: "red" },
				{ ...STROKE, points: [1, 2] },
				{ kind: "circle", color: "#000000" },
			];
			// Shapes the schema refuses, on purpose.
			for (const shape of bad) await refused(canvas.add!({ shapes: [shape as Shape] }, ctx), "invalid");
			assert.deepEqual(canvas.shapes.value.rows, []);
		});
	});
});

describe("a board's pages", () => {
	/** Adds 600 boxes `x` 0 to 599 to `thing` in Pi as Ann; Ann. */
	async function filled(thing: string) {
		const ann = await n.person("Ann");
		await n.holding(ann, n.pi, thing, async (canvas, ctx) => {
			for (let batch = 0; batch < 6; batch++) {
				await canvas.add!(
					{ shapes: Array.from({ length: 100 }, (_, i): Shape => ({ ...BOX, x: batch * 100 + i })) },
					ctx,
				);
			}
		});
		return ann;
	}

	it("load 500, oldest first, and the next with more", async () => {
		const board = await n.thingIn(n.pi);
		const ann = await filled(board);
		await n.holding(ann, n.pi, board, async (canvas, ctx) => {
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

	it("can be read a page at a time without changing what the caller holds (Astra, round 1)", async () => {
		const board = await n.thingIn(n.pi);
		const ann = await filled(board);
		await n.holding(ann, n.pi, board, async (canvas, ctx) => {
			const first = await canvas.page({}, ctx);
			assert.equal(first.rows.length, 500);
			assert.ok(first.next !== undefined);
			const second = await canvas.page({ after: first.next }, ctx);
			assert.deepEqual([second.rows.length, second.next], [100, undefined]);
			assert.equal(canvas.shapes.value.rows.length, 500, "the holder keeps its first page only");
		});
	});

	it("keep each caller's pages across a reload of the plugin", async () => {
		const board = await n.thingIn(n.pi);
		const ann = await filled(board);
		const ben = await n.person("Ben");
		const holders = await n.holders([ann, ben], n.pi, board);
		try {
			const [anns, bens] = holders.held;
			await anns!.ref.more(anns!.ctx);
			await n.reload();
			await anns!.ref.add!({ shapes: [STROKE] }, anns!.ctx);
			for (const { ref, ctx } of holders.held) {
				await until(ref.shapes, (list) => list.rows.length > 0, within("live again", ctx));
			}
			await until(anns!.ref.shapes, (list) => list.rows.length === 601, within("the stroke at the end", anns!.ctx));
			assert.deepEqual(
				[anns!.ref.shapes.value.rows.at(-1)?.shape, bens!.ref.shapes.value.rows.length],
				[STROKE, 500],
			);
		} finally {
			await holders.release();
		}
	});
});

describe("a board's motion", () => {
	it("shows every holder in the workspace a pointer with its draft, a viewer's without, nothing elsewhere", async () => {
		const s1 = await n.workspace("s1");
		const [ann, ben] = [await n.person("Ann", s1), await n.person("Ben", s1)];
		const [board, other] = [await n.thingIn(s1), await n.thingIn(s1)];
		await n.things.link({ workspace: n.pi, thing: board }, context);
		await n.things.putParty({ workspace: n.pi, party: { kind: "person", person: ann.id }, source: BY }, context);
		// Ben keeps a viewer: Draw withheld from him removes everyone's Draw from him (item 106).
		await n.tick(s1, board, { kind: "person", person: ben.id }, "draw", false);
		const seen: Motion[] = [];
		const elsewhere: Motion[] = [];
		await n.holding(ann, s1, other, async (away, outer) => {
			await away.motion.on(({ value }) => elsewhere.push(value), outer);
			await n.holding(ann, n.pi, board, async (there, inner) => {
				await there.motion.on(({ value }) => elsewhere.push(value), inner);
				await n.holding(ann, s1, board, async (watching, ctx) => {
					await watching.motion.on(({ value }) => seen.push(value), ctx);
					await n.holding(ann, s1, board, async (canvas, call) => {
						await canvas.point({ x: 5, y: 6, draft: STROKE }, call);
						await canvas.leave(call);
					});
					await n.holding(ben, s1, board, (canvas, call) => canvas.point({ x: 7, y: 8, draft: STROKE }, call));
					await n.holding(AGENT, s1, board, (canvas, call) => canvas.point({ x: 1, y: 1, draft: null }, call));
					await eventually(
						() => seen.length,
						(count) => count === 4,
						2000,
					);
				});
			});
		});
		assert.deepEqual(seen, [
			{ kind: "point", who: { kind: "person", person: ann.id, name: "Ann" }, x: 5, y: 6, draft: STROKE },
			{ kind: "leave", who: { kind: "person", person: ann.id } },
			{ kind: "point", who: { kind: "person", person: ben.id, name: "Ben" }, x: 7, y: 8, draft: null },
			{ kind: "point", who: { kind: "agent", session: "s1" }, x: 1, y: 1, draft: null },
		]);
		assert.deepEqual(elsewhere, []);
	});
});

describe("the cost of a board's shapes", () => {
	// Lists do not share their pages yet (Chord's carry-over; ERNDL-1177 makes them keyed lookups): one run per holder.
	it("is one list run per holder per shape added; a pointer moved runs no query", async () => {
		const persons = [await n.person("Ann"), await n.person("Ben"), await n.person("Cy")];
		const board = await n.thingIn(n.pi);
		const holders = await n.holders(persons, n.pi, board);
		try {
			const [ann] = holders.held;
			const added = async (count: number) => {
				const before = n.count("chord.query.runs");
				await ann!.ref.add!({ shapes: [BOX] }, ann!.ctx);
				await Promise.all(
					holders.held.map(({ ref, ctx }) =>
						until(ref.shapes, (list) => list.rows.length === count, within(`${count} shapes`, ctx)),
					),
				);
				return n.count("chord.query.runs") - before;
			};
			await added(1);
			assert.equal(await added(2), 3, "each holder's list");
			const before = n.count("chord.query.runs");
			await ann!.ref.point({ x: 1, y: 1, draft: STROKE }, ann!.ctx);
			assert.equal(n.count("chord.query.runs") - before, 0);
		} finally {
			await holders.release();
		}
	});
});

describe("a released board", () => {
	it("is collected", async () => {
		const ann = await n.person("Ann");
		const board = await n.thingIn(n.pi);
		const refs: WeakRef<object>[] = [];
		await n.holding(ann, n.pi, board, async (canvas: Reference<typeof Canvas>) => {
			refs.push(new WeakRef(canvas), new WeakRef(canvas.shapes), new WeakRef(canvas.motion));
		});
		assert.ok(await collected(refs));
	});
});
