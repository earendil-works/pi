// The canvas plugin end to end (`testServer`: the real server, workers as processes, the faux login under test, a
// copy of the built-in plugins the test edits): a faux model's script calls `canvas_draw`, and the shape appears in
// a board held open as a page holds it, by the agent; `canvas_read` gives the model the board as JSON; with the
// agent's `draw` off the model is offered `canvas_read` alone; a reload of the canvas plugin (server and worker
// facets) while the board is held keeps its shapes, and its pointers and the agent's drawing go on.

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BACKGROUND_CONTEXT as context,
	type Host,
	type P3Principal,
	type Reference,
	Sessions,
	THIS_DEVICE,
	Transcript,
	thingOf,
	until,
} from "@earendil-works/p3/v1";
import { PeopleStore, SessionsStore } from "@earendil-works/p3/v1/server";
import { type TestServer, testServer } from "@earendil-works/p3/v1/testing";
import { FauxLogin, FauxRequests, type Step } from "../../../test/plugins/faux-login/contract.ts";
import { eventually, within } from "../../../test/until.ts";
import { Canvas, CanvasKind, type Motion, type Shape } from "../contract.ts";

/** The faux login plugin, a plugin under test of a root of its own. */
const FAUX = fileURLToPath(new URL("../../../test/plugins/faux-login/", import.meta.url));

/** The agent's box. */
const BOX: Shape = { kind: "rect", color: "#1a7f37", x: 300, y: 200, w: 400, h: 250, fill: false };

/** The agent's label. */
const LABEL: Shape = { kind: "text", color: "#0969da", x: 320, y: 260, text: "Drawn by the agent", size: 40 };

/** The faux model's script: draw on `@draw`, read on `@read`, say what it got back. */
const SCRIPT: Step[] = [
	{ when: "@draw", reply: [{ kind: "tool", name: "canvas_draw", args: JSON.stringify({ shapes: [BOX] }) }] },
	{ when: "@label", reply: [{ kind: "tool", name: "canvas_draw", args: JSON.stringify({ shapes: [LABEL] }) }] },
	{ when: "@read", reply: [{ kind: "tool", name: "canvas_read", args: "{}" }] },
	{ when: "drew", reply: [{ kind: "text", text: "Drawn." }] },
	{ when: '"author":"agent"', reply: [{ kind: "text", text: "I see my box." }] },
	{ when: "@hello", reply: [{ kind: "text", text: "Hello." }] },
];

describe("the canvas end to end", () => {
	let t: TestServer;
	let dir: string;
	let built: string;
	let owner: Host<P3Principal>;
	let session: string;
	let board: string;
	let canvas: Reference<typeof Canvas>;

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "p3-canvas-e2e-"));
		built = join(dir, "built-in");
		await cp(fileURLToPath(new URL("../../", import.meta.url)), built, { recursive: true });
		t = await testServer({ plugins: [FAUX], builtIn: built }, context);
		owner = await t.client(context);
		session = await t.host.root(
			async (ctx) =>
				(await ctx.get(SessionsStore, {})).create(
					{
						app: "coding",
						title: "Canvas",
						location: { environment: THIS_DEVICE, folder: dir },
						things: [thingOf(FauxLogin, { provider: "faux", script: SCRIPT, tool: false }), thingOf(CanvasKind)],
					},
					ctx,
				),
			context,
		);
		board = await t.host.root(async (ctx) => {
			const things = (await (await ctx.get(SessionsStore, {})).things.of.page({ session }, 10, ctx)).items;
			return things.find((thing) => thing.kind === CanvasKind.name)!.thing;
		}, context);
		// The board open, as a page holds it.
		canvas = await owner.get(Canvas, { session, thing: board }, context);
	});

	after(async () => {
		await t?.close(context);
		await rm(dir, { recursive: true, force: true });
	});

	/** Sends `text` to the session as the owner and waits for the answer containing `answer`. */
	async function ask(text: string, answer: string): Promise<void> {
		await owner.root(async (ctx) => {
			const transcript = await ctx.get(Transcript, { session });
			if (transcript.variant !== "writer") return assert.fail(transcript.variant);
			await transcript.send({ text, requestId: `${text} ${Date.now()}` }, ctx);
			await until(
				transcript.view,
				(view) => JSON.stringify(view).includes(answer),
				within(`the answer to ${text}`, ctx, 20_000),
			);
		}, context);
	}

	it("shows the shape the agent draws in the open board, by the agent", async () => {
		assert.equal(canvas.variant, "drawer");
		await ask("@draw", "Drawn.");
		await until(canvas.shapes, (list) => list.rows.length === 1, within("the agent's box", context, 10_000));
		assert.deepEqual(
			canvas.shapes.value.rows.map(({ author, shape }) => [author, shape]),
			[["agent", BOX]],
		);
	});

	it("gives the model the board as JSON", async () => {
		await ask("@read", "I see my box.");
		const requests = await owner.root(
			async (ctx) => (await ctx.get(FauxRequests, { session })).requests.value,
			context,
		);
		assert.ok(requests.some(({ last }) => last.includes('"kind":"rect"') && last.includes('"author":"agent"')));
	});

	it("offers the model canvas_read alone while the agent's draw is off", async () => {
		const sessions = await owner.get(Sessions, {}, context);
		await sessions.setOptions({ session, thing: board, for: { kind: "agent" }, options: { draw: false } }, context);
		await ask("@hello", "Hello.");
		const requests = await owner.root(
			async (ctx) => (await ctx.get(FauxRequests, { session })).requests.value,
			context,
		);
		const last = requests.at(-1)!;
		assert.equal(last.tools.includes("canvas_read"), true);
		assert.equal(last.tools.includes("canvas_draw"), false);
		// The members' own board is unchanged: the owner still draws.
		assert.equal(canvas.variant, "drawer");
		await sessions.setOptions({ session, thing: board, for: { kind: "agent" }, options: null }, context);
	});

	it("keeps the held board through a reload of the canvas plugin: its shapes, its pointers, the agent's drawing", async () => {
		for (const facet of ["server.ts", "worker.ts"]) {
			const file = join(built, "canvas", facet);
			await writeFile(file, `${await readFile(file, "utf8")}\n// edited\n`);
		}
		await until(t.plugins, (marks) => marks.dirty.length > 0, within("the watcher's marks", context, 10_000));
		await t.apply(context);
		await until(canvas.state, (state) => state.kind === "live", within("the board live again", context, 10_000));
		assert.equal(canvas.shapes.value.rows.length, 1);
		// Pointers go on after the reload: a second holder sees the owner's.
		const other = await t.client(context);
		const seen: Motion[] = [];
		const watching = await other.get(Canvas, { session, thing: board }, context);
		await watching.motion.on(({ value }) => seen.push(value), context);
		await canvas.point({ x: 10, y: 20, draft: null }, context);
		await eventually(
			() => seen.length,
			(count) => count > 0,
			5000,
		);
		const [me] = (
			await t.host.root(async (ctx) => (await ctx.get(PeopleStore, {})).persons.owner.page({}, 1, ctx), context)
		).items;
		assert.deepEqual(seen[0], { kind: "point", who: `person:${me!.id}`, name: me!.name, x: 10, y: 20, draft: null });
		await ask("@label", "Drawn.");
		await until(watching.shapes, (list) => list.rows.length === 2, within("the label", context, 10_000));
		assert.deepEqual(t.errors, []);
	});
});
