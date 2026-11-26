// The notes kind's harness part, as the worker facet contributes it to `ThingHarnessParts`, given the notebooks an
// agent holds (real references, held as the session's worker on a server with the things plugin, `kindServer`): it
// offers `notes_list` and `notes_read` always and `notes_write` while one notebook gives Write; `notes_list` names
// each notebook with its id and whether the agent may write there; `notes_read` answers a page as JSON in the
// notebook's order, saying it, and asks to start over when the order changed since its cursor; it reads now, so
// the agent's own reference keeps its pages however often it reads (Astra: it grew with each read); `notes_write`
// adds, edits and removes, refused naming the notebook where Write is not given (also when it was taken back after
// the tools were offered) and for an id that is no notebook of the agent's.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type Ctx, BACKGROUND_CONTEXT as context, type P3Principal, until } from "@earendil-works/p3/v1";
import type { Extension } from "@earendil-works/p3/v1/worker";
import { within } from "../../../test/until.ts";
import { ThingHooks } from "../../things/contract.server.ts";
import { type HeldThing, ThingHarnessParts } from "../../things/contract.worker.ts";
import { type KindServer, kindServer, runTool, toolNames } from "../../things/test/kind-server.ts";
import { type Notes, NotesKind } from "../kind.ts";
import notesServer from "../server.ts";

/** The notes plugin's root. */
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The session's agent as a party: Write withheld from it by name applies by every route (item 106). */
const AGENT_PARTY = { kind: "agent", session: "s1" } as const;

let n: KindServer<typeof Notes>;
let s1: string;

beforeEach(async () => {
	n = await kindServer({ name: "@earendil-works/p3-notes", root: ROOT, server: notesServer }, NotesKind, context);
	s1 = await n.workspace("s1");
});

afterEach(() => n.close());

/** Runs `fn` with s1's agent holding notebooks `things` there: the part's extension for them, and the held things. */
const giving = <T>(
	things: readonly string[],
	fn: (extension: Extension, ctx: Ctx<P3Principal>, held: readonly HeldThing<typeof Notes>[]) => Promise<T>,
) => n.giving({ session: "s1", workspace: s1 }, things, fn);

describe("the notes kind's harness part", () => {
	it("is the worker facet's one part, for the notes kind", async () => {
		assert.deepEqual(
			(await n.worker("s1")).contributions(ThingHarnessParts).map(({ value }) => value.kind.name),
			[NotesKind.name],
		);
	});

	it("offers notes_write while one notebook gives Write, and lists which", async () => {
		const [plan, log] = [await n.thingIn(s1, "Plan"), await n.thingIn(s1, "Log")];
		await n.tick(s1, plan, AGENT_PARTY, "write", false);
		await giving([plan, log], async (extension) => {
			assert.deepEqual(toolNames(extension), ["notes_list", "notes_read", "notes_write"]);
			assert.deepEqual(JSON.parse(await runTool(extension, "notes_list", {}, context)), [
				{ id: plan, name: "Plan", write: false },
				{ id: log, name: "Log", write: true },
			]);
		});
		await giving([plan], async (extension) => assert.deepEqual(toolNames(extension), ["notes_list", "notes_read"]));
	});

	it("adds, edits and removes notes, and reads them as JSON a page at a time; the agent's hold stays", async () => {
		const log = await n.thingIn(s1, "Log");
		const ann = await n.person("Ann", s1);
		await n.holding(ann, s1, log, async (notes, ctx) => {
			for (let i = 0; i < 60; i++) await notes.add!({ text: `old ${i}` }, ctx);
		});
		await giving([log], async (extension, ctx, [held]) => {
			const added = await runTool(
				extension,
				"notes_write",
				{
					notebook: log,
					change: { kind: "add", text: "first" },
				},
				context,
			);
			const { id } = JSON.parse(added) as { id: string };
			assert.equal(typeof id, "string", added);
			await runTool(
				extension,
				"notes_write",
				{ notebook: log, change: { kind: "edit", id, text: "edited" } },
				context,
			);
			const read = async (after?: string) =>
				JSON.parse(
					await runTool(
						extension,
						"notes_read",
						{ notebook: log, ...(after === undefined ? {} : { after }) },
						context,
					),
				);
			await until(held!.ref.list, (list) => list.rows[0]?.text === "edited", within("the edit held", ctx));
			// The agent's first page, with the note it added on top.
			const holds = held!.ref.list.value.rows.length;
			const first = await read();
			const { id: latest, text, author } = first.rows[0];
			assert.deepEqual([latest, text, author], [id, "edited", { kind: "agent", session: "s1" }]);
			assert.deepEqual(first.rows[1].author, { kind: "person", person: ann.id, name: "Ann" });
			const second = await read(first.next);
			assert.deepEqual([first.rows.length, second.rows.length, second.next], [50, 11, undefined]);
			// Read again and again: each read is its own; what the agent holds keeps its first page.
			assert.equal((await read(first.next)).rows.length, 11);
			assert.equal((await read()).rows.length, 50);
			assert.deepEqual([holds, held!.ref.list.value.rows.length], [51, 51]);
			assert.equal(
				await runTool(extension, "notes_write", { notebook: log, change: { kind: "remove", id } }, context),
				"{}",
			);
			assert.notEqual((await read()).rows[0].id, id);
		});
	});

	it("reads in the notebook's order, says it with each page, and asks to start over once it changed", async () => {
		const log = await n.thingIn(s1, "Log");
		const ann = await n.person("Ann", s1);
		await n.holding(ann, s1, log, async (notes, ctx) => {
			for (let i = 0; i < 60; i++) await notes.add!({ text: `n${i}` }, ctx);
		});
		const configure = (await n.host.registry(ThingHooks, context)).value.get(NotesKind.name)?.value.configure;
		await giving([log], async (extension) => {
			const read = async (after?: string) =>
				JSON.parse(
					await runTool(
						extension,
						"notes_read",
						{ notebook: log, ...(after === undefined ? {} : { after }) },
						context,
					),
				);
			const first = await read();
			assert.deepEqual([first.order, first.rows[0].text], ["newest", "n59"]);
			await n.host.root((ctx) => configure!(log, { order: "oldest" }, ctx), context);
			// Opus, round 5: a cursor of the order before was refused with no way on.
			await assert.rejects(read(first.next), /the notebook's order changed; read again from the start/);
			const again = await read();
			assert.deepEqual([again.order, again.rows[0].text], ["oldest", "n0"]);
			assert.deepEqual(
				(await read(again.next)).rows.map(({ text }: { text: string }) => text),
				["n50", "n51", "n52", "n53", "n54", "n55", "n56", "n57", "n58", "n59"],
			);
		});
	});

	it("refuses to write where Write is not given, also when taken back after offering, naming the notebook", async () => {
		const [plan, log] = [await n.thingIn(s1, "Plan"), await n.thingIn(s1, "Log")];
		await n.tick(s1, plan, AGENT_PARTY, "write", false);
		await giving([plan, log], async (extension, ctx, held) => {
			const add = { kind: "add", text: "a note" };
			await assert.rejects(
				runTool(extension, "notes_write", { notebook: plan, change: add }, context),
				/may not write in the notebook "Plan"/,
			);
			await n.tick(s1, log, AGENT_PARTY, "write", false);
			const { ref } = held[1]!;
			await until(ref.state, () => ref.add === undefined, within("Write taken back", ctx));
			await assert.rejects(
				runTool(extension, "notes_write", { notebook: log, change: add }, context),
				/may not write in the notebook "Log"/,
			);
		});
	});

	it("refuses an id that is no notebook of the agent's", async () => {
		const plan = await n.thingIn(s1, "Plan");
		const elsewhere = await n.thingIn(n.pi, "Elsewhere");
		await giving([plan], async (extension) => {
			for (const notebook of ["nb9", elsewhere]) {
				await assert.rejects(runTool(extension, "notes_read", { notebook }, context), /you have no notebook/);
				await assert.rejects(
					runTool(extension, "notes_write", { notebook, change: { kind: "add", text: "x" } }, context),
					/you have no notebook/,
				);
			}
		});
	});
});
