// The notes kind's harness part: the worker facet contributes it to `ThingHarnessParts`; given the notebooks an agent
// holds (real references, held as the session's worker on a server with the things plugin), it offers `notes_list`
// and `notes_read` always and `notes_write` while one notebook gives Write; `notes_list` names each notebook with its
// id and whether the agent may write there; `notes_read` shows the notes with their ids and authors, page by page;
// `notes_write` adds, edits and removes, refused naming the notebook where Write is not given (also when it was taken
// back after the tools were offered) and for an id that is no notebook of the agent's.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type Ctx, BACKGROUND_CONTEXT as context, type P3Principal, until } from "@earendil-works/p3/v1";
import { testPlugin } from "@earendil-works/p3/v1/testing";
import type { Extension } from "@earendil-works/p3/v1/worker";
import { within } from "../../../test/until.ts";
import { type HarnessSession, type HeldThing, ThingHarnessParts } from "../../things/contract.worker.ts";
import { Notes, NotesKind } from "../contract.ts";
import { notesExtension } from "../worker.ts";
import { type Notebooks, notebooks } from "./notebooks.ts";

/** The session's agent. */
const AGENT: P3Principal = { kind: "worker", session: "s1" };

let n: Notebooks;
let s1: string;

beforeEach(async () => {
	n = await notebooks();
	s1 = await n.workspace("s1");
});

afterEach(() => n.close());

/** The agent's session as the part gets it: its calls run as the session's worker. */
function session(): HarnessSession {
	return { session: "s1", workspace: s1, call: (fn, ctx) => n.t.root(fn, ctx, { principal: AGENT }) };
}

/** Runs `fn` with the agent holding notebooks `things` in s1: the part's extension for them, and the held things. */
function giving<T>(
	things: readonly string[],
	fn: (extension: Extension, ctx: Ctx<P3Principal>, held: readonly HeldThing<typeof Notes>[]) => Promise<T>,
) {
	return n.t.root(
		async (ctx) => {
			const held: HeldThing<typeof Notes>[] = [];
			for (const thing of things)
				held.push({ thing, workspace: s1, ref: await ctx.get(Notes, { workspace: s1, thing }) });
			return fn(notesExtension(held, session()), ctx, held);
		},
		context,
		{ principal: AGENT },
	);
}

/** Runs tool `name` of `extension` with `args`; its output's text. */
async function run(extension: Extension, name: string, args: object): Promise<string> {
	const tool = extension.tools?.find((each) => each.name === name);
	assert.ok(tool !== undefined, name);
	// The notes tools use neither Durable's execution API nor arguments beyond their schema's.
	const result = await tool.execute(args as never, {} as never, context);
	// A park has no output: the notes tools never park.
	return (result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** The names of `extension`'s tools. */
const names = (extension: Extension) => extension.tools?.map((tool) => tool.name).toSorted();

describe("the notes kind's harness part", () => {
	it("is contributed by the worker facet", async () => {
		const t = await testPlugin(
			fileURLToPath(new URL("../", import.meta.url)),
			{ kind: "worker", session: "s1" },
			context,
		);
		try {
			// The facet as the plugin tier builds it: its own module, so compared by kind.
			assert.deepEqual(
				t.contributions(ThingHarnessParts).map(({ value }) => value.kind.name),
				[NotesKind.name],
			);
		} finally {
			await t.close(context);
		}
	});

	it("offers notes_write while one notebook gives Write, and lists which", async () => {
		const [plan, log] = [await n.notebookIn(s1, "Plan"), await n.notebookIn(s1, "Log")];
		await n.write(s1, plan, { kind: "agents" }, false);
		await giving([plan, log], async (extension) => {
			assert.deepEqual(names(extension), ["notes_list", "notes_read", "notes_write"]);
			assert.deepEqual(JSON.parse(await run(extension, "notes_list", {})), [
				{ id: plan, name: "Plan", write: false },
				{ id: log, name: "Log", write: true },
			]);
		});
		await giving([plan], async (extension) => assert.deepEqual(names(extension), ["notes_list", "notes_read"]));
	});

	it("adds, edits and removes notes, and reads them with their ids and authors, page by page", async () => {
		const log = await n.notebookIn(s1, "Log");
		const ann = await n.person("Ann", s1);
		await n.holding(ann, s1, log, async (notes, ctx) => {
			for (let i = 0; i < 50; i++) await notes.add!({ text: `old ${i}` }, ctx);
		});
		await giving([log], async (extension) => {
			const added = await run(extension, "notes_write", { notebook: log, change: { kind: "add", text: "first" } });
			const id = /^Added note (.+)\.$/.exec(added)?.[1];
			assert.ok(id !== undefined, added);
			await run(extension, "notes_write", { notebook: log, change: { kind: "edit", id, text: "edited" } });
			const read = await run(extension, "notes_read", { notebook: log });
			const lines = read.split("\n");
			assert.match(lines[0]!, new RegExp(`^- \\[${id}\\] \\S+ the agent of session s1: edited$`));
			assert.match(lines[1]!, / Ann: old 49$/);
			assert.equal(lines.at(-1), "(older notes follow: read more pages)");
			assert.equal((await run(extension, "notes_read", { notebook: log, pages: 2 })).split("\n").length, 51);
			await run(extension, "notes_write", { notebook: log, change: { kind: "remove", id } });
			assert.doesNotMatch(await run(extension, "notes_read", { notebook: log }), /edited/);
		});
	});

	it("refuses to write where Write is not given, also when taken back after offering, naming the notebook", async () => {
		const [plan, log] = [await n.notebookIn(s1, "Plan"), await n.notebookIn(s1, "Log")];
		await n.write(s1, plan, { kind: "agents" }, false);
		await giving([plan, log], async (extension, ctx, held) => {
			const add = { kind: "add", text: "a note" };
			await assert.rejects(
				run(extension, "notes_write", { notebook: plan, change: add }),
				/may not write in the notebook "Plan"/,
			);
			await n.write(s1, log, { kind: "agents" }, false);
			const { ref } = held[1]!;
			await until(ref.state, () => ref.add === undefined, within("Write taken back", ctx));
			await assert.rejects(
				run(extension, "notes_write", { notebook: log, change: add }),
				/may not write in the notebook "Log"/,
			);
		});
	});

	it("refuses an id that is no notebook of the agent's", async () => {
		const plan = await n.notebookIn(s1, "Plan");
		const elsewhere = await n.notebookIn(n.pi, "Elsewhere");
		await giving([plan], async (extension) => {
			for (const notebook of ["nb9", elsewhere]) {
				await assert.rejects(run(extension, "notes_read", { notebook }), /you have no notebook/);
				await assert.rejects(
					run(extension, "notes_write", { notebook, change: { kind: "add", text: "x" } }),
					/you have no notebook/,
				);
			}
		});
	});
});
