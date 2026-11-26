// The canvas plugin end to end (`testServer`: the real server, workers as processes, the faux login under test, a
// copy of the built-in plugins the test edits): a session with a canvas (its content) and a faux login; the faux
// model's script calls `canvas_draw` with the canvas's id, and the shape appears in the canvas held open as a page
// holds it, by the agent; `canvas_list` names the canvas and `canvas_read` gives the model its shapes as JSON; with the
// agent's `draw` off the model is offered no `canvas_draw`; a reload of the canvas plugin (server and worker facets)
// while the canvas is held keeps its shapes, and its pointers and the agent's drawing go on.

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
	SessionThings,
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

/** The faux model's script for board `canvas`: draw on `@draw`, read on `@read`, say what it got back. */
function script(canvas: string): Step[] {
	const tool = (name: string, args: object) => ({ kind: "tool" as const, name, args: JSON.stringify(args) });
	return [
		{ when: "@draw", reply: [tool("canvas_draw", { canvas, shapes: [BOX] })] },
		{ when: "@label", reply: [tool("canvas_draw", { canvas, shapes: [LABEL] })] },
		{ when: "@read", reply: [tool("canvas_read", { canvas })] },
		{ when: "@list", reply: [tool("canvas_list", {})] },
		{ when: '"name":"Board"', reply: [{ kind: "text", text: "One canvas." }] },
		{ when: "drew", reply: [{ kind: "text", text: "Drawn." }] },
		{ when: '"author":"agent"', reply: [{ kind: "text", text: "I see my box." }] },
		{ when: "@hello", reply: [{ kind: "text", text: "Hello." }] },
	];
}

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
		// A session following nobody (the Pi's faux login stays out), with a canvas and a faux login of its own.
		session = await t.host.root(
			async (ctx) =>
				(await ctx.get(SessionsStore, {})).create(
					{
						app: "coding",
						title: "Canvas",
						location: { environment: THIS_DEVICE, folder: dir },
						things: [thingOf(CanvasKind, { name: "Board" }), thingOf(FauxLogin)],
						follows: null,
					},
					ctx,
				),
			context,
		);
		// The login's script names the canvas, known once it is made.
		board = await t.host.root(async (ctx) => {
			const store = await ctx.get(SessionsStore, {});
			const links = (await store.links.of.page({ session }, 10, ctx)).items;
			const made = links.find(({ kind }) => kind === CanvasKind.name)?.thing ?? assert.fail("no canvas");
			const login = links.find(({ kind }) => kind === FauxLogin.name)?.thing ?? assert.fail("no login");
			const options = { provider: "faux", script: script(made), tool: false };
			await store.setOptions({ session, thing: login, for: { kind: "everyone" }, options }, ctx);
			return made;
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

	it("names the canvas to the model and gives it the canvas's shapes as JSON", async () => {
		await ask("@list", "One canvas.");
		await ask("@read", "I see my box.");
		const requests = await owner.root(
			async (ctx) => (await ctx.get(FauxRequests, { session })).requests.value,
			context,
		);
		assert.ok(requests.some(({ last }) => last.includes('"kind":"rect"') && last.includes('"author":"agent"')));
	});

	it("offers the model no canvas_draw while the agent's draw is off", async () => {
		const things = await owner.get(SessionThings, { session }, context);
		if (things.variant !== "writer") return assert.fail(things.variant);
		await things.setOptions({ thing: board, for: { kind: "agent" }, options: { draw: false } }, context);
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
		await things.setOptions({ thing: board, for: { kind: "agent" }, options: null }, context);
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
