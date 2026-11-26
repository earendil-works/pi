// The notes plugin on a session's worker (`testPlugin`), beside a stand-in server serving `Notes` with the admission a
// case sets: the session's notebooks give the agent `notes_list` and `notes_read` always and `notes_write` when it may
// edit one of them; `notes_list` names each with its id and whether the agent may write there; the tools reach the
// server's notes through the agent's `call`, as the session's worker; a write in a notebook the agent may not edit, in
// an id that is no notebook, or one the server's admission no longer allows (options changed meanwhile) is refused.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	allow,
	constant,
	BACKGROUND_CONTEXT as context,
	defineFacet,
	isChordError,
	type P3Principal,
} from "@earendil-works/p3/v1";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { type Agent, type Extension, ThingExtensions } from "@earendil-works/p3/v1/worker";
import { NOTES_EDITS, type Note, Notes } from "../contract.ts";

const SESSION = "s1";

/** What the stand-in server admits callers of `Notes` with; a case changes it before the call. */
let admitted = { access: "write" as "read" | "write", options: { edit: true } };

/** The notes added through the stand-in, and the principals that held `Notes`. */
const added: string[] = [];
const holders: P3Principal["kind"][] = [];

/** A stand-in server: `Notes` over the notes added so far, admitting as `admitted` says. */
const standIn = defineFacet((host) => {
	host.serve(
		Notes,
		(_params, principal, _admitted, self) => {
			holders.push(principal.kind);
			const rows = (): Note[] => added.map((text, at) => ({ id: `n${at}`, text, at, author: { kind: "agent" } }));
			const list = self.writable({ rows: rows(), moreAfter: false });
			return {
				name: constant("Ideas"),
				list: self.derive([list], ([value]) => value),
				more: async () => null,
				add: async ({ text }) => {
					added.push(text);
					list.set({ rows: rows(), moreAfter: false });
					return `n${added.length - 1}`;
				},
				edit: async () => null,
				remove: async () => null,
			};
		},
		{
			admit: () => {
				const { access, options } = admitted;
				return constant(
					allow({ ...admitted, granted: access === "write" && options.edit ? [...NOTES_EDITS] : [] }),
				);
			},
		},
	);
});

let t: TestedPlugin<P3Principal>;

beforeEach(async () => {
	added.length = 0;
	holders.length = 0;
	admitted = { access: "write", options: { edit: true } };
	t = await testPlugin(
		fileURLToPath(new URL("../", import.meta.url)),
		{ kind: "worker", session: SESSION, server: [{ name: "test.server", facet: standIn }] },
		context,
	);
});

afterEach(() => t.close(context));

/** The extension the notes kind gives the session's notebooks `n1` ("Ideas") and `n2` ("Log") with the agent's `edit`s. */
function gift(edit: boolean, log = false): Extension {
	const [entry] = t.contributions(ThingExtensions);
	assert.equal(entry?.value.kind.name, "notes.notes");
	const agent: Agent = { session: SESSION, call: (fn, ctx) => t.root(fn, ctx) };
	const notebooks = [
		{ thing: "n1", name: "Ideas", options: { edit } },
		{ thing: "n2", name: "Log", options: { edit: log } },
	];
	const given = entry.value.give(notebooks, agent);
	assert.ok(given.extension !== undefined);
	return given.extension;
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

describe("what a notebook gives the agent", () => {
	it("offers notes_write only when the agent may edit one of the notebooks", () => {
		assert.deepEqual(
			gift(true).tools?.map(({ name }) => name),
			["notes_list", "notes_read", "notes_write"],
		);
		assert.deepEqual(
			gift(false).tools?.map(({ name }) => name),
			["notes_list", "notes_read"],
		);
	});

	it("lists the notebooks by id and name, with whether the agent may write there", async () => {
		assert.deepEqual(JSON.parse(await run(gift(true), "notes_list", {})), [
			{ id: "n1", name: "Ideas", write: true },
			{ id: "n2", name: "Log", write: false },
		]);
	});

	it("writes and reads the server's notes as the session's worker", async () => {
		const extension = gift(true);
		assert.equal(await run(extension, "notes_read", { notebook: "n1" }), "The notebook is empty.");
		assert.equal(
			await run(extension, "notes_write", { notebook: "n1", text: "remember the milk" }),
			"Added note n0.",
		);
		assert.deepEqual(added, ["remember the milk"]);
		assert.match(await run(extension, "notes_read", { notebook: "n1" }), /^- \S+ an agent: remember the milk$/);
		assert.deepEqual([...new Set(holders)], ["worker"]);
	});

	it("refuses a write in a notebook the agent may not edit, and in an id that is no notebook, naming it", async () => {
		const extension = gift(true);
		await assert.rejects(
			run(extension, "notes_write", { notebook: "n2", text: "no" }),
			(error: unknown) => isChordError(error) && error.code === "forbidden" && /"Log" \(n2\)/.test(error.message),
		);
		await assert.rejects(run(extension, "notes_write", { notebook: "n9", text: "no" }), /no notebook "n9"/);
		assert.deepEqual(added, []);
	});

	it("refuses a write the server no longer admits", async () => {
		const extension = gift(true);
		admitted = { ...admitted, options: { edit: false } };
		await assert.rejects(
			run(extension, "notes_write", { notebook: "n1", text: "too late" }),
			(error: unknown) => isChordError(error) && error.code === "forbidden",
		);
		assert.deepEqual(added, []);
	});
});
