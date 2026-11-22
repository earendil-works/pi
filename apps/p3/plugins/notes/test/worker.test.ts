// The notes plugin on a session's worker (`testPlugin`), beside a stand-in server serving `Notes` with the admission a
// case sets: a notebook gives the agent `notes_read` always and `notes_write` only when its options say edit; the
// tools reach the server's notes through the agent's `call`, as the session's worker; a write the server's admission
// no longer allows (options changed meanwhile) is refused.

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
import { type Note, Notes } from "../contract.ts";

const SESSION = "s1";

/** What the stand-in server admits callers of `Notes` with; a case changes it before the call. */
let admitted = { access: "write" as "read" | "write", ref: "person:ann", options: { edit: true } };

/** The notes added through the stand-in, and the principals that held `Notes`. */
const added: string[] = [];
const holders: P3Principal["kind"][] = [];

/** A stand-in server: `Notes` over the notes added so far, admitting as `admitted` says. */
const standIn = defineFacet((host) => {
	host.serve(
		Notes,
		(_params, principal, { access, options }, self) => {
			holders.push(principal.kind);
			const rows = (): Note[] => added.map((text, at) => ({ id: `n${at}`, text, at, author: { kind: "agent" } }));
			const list = self.writable({ rows: rows(), moreAfter: false });
			const reader = { list: self.derive([list], ([value]) => value), more: async () => null };
			if (access === "read" || !options.edit) return { variant: "reader", members: reader };
			return {
				variant: "editor",
				members: {
					...reader,
					add: async ({ text }) => {
						added.push(text);
						list.set({ rows: rows(), moreAfter: false });
						return `n${added.length - 1}`;
					},
					edit: async () => null,
					remove: async () => null,
				},
			};
		},
		{ admit: () => constant(allow(admitted)) },
	);
});

let t: TestedPlugin<P3Principal>;

beforeEach(async () => {
	added.length = 0;
	holders.length = 0;
	admitted = { access: "write", ref: "person:ann", options: { edit: true } };
	t = await testPlugin(
		fileURLToPath(new URL("../", import.meta.url)),
		{ kind: "worker", session: SESSION, server: [{ name: "test.server", facet: standIn }] },
		context,
	);
});

afterEach(() => t.close(context));

/** The extension the notes kind gives notebook `n1` with the agent's options `{ edit }`. */
function gift(edit: boolean): Extension {
	const [entry] = t.contributions(ThingExtensions);
	assert.equal(entry?.value.kind.name, "notes.notes");
	const agent: Agent = { session: SESSION, call: (fn, ctx) => t.root(fn, ctx) };
	const given = entry.value.give({ thing: "n1", ref: "person:ann", options: { edit } }, agent);
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
	it("offers notes_write only when the agent's options say edit", () => {
		assert.deepEqual(
			gift(true).tools?.map(({ name }) => name),
			["notes_read", "notes_write"],
		);
		assert.deepEqual(
			gift(false).tools?.map(({ name }) => name),
			["notes_read"],
		);
	});

	it("writes and reads the server's notes as the session's worker", async () => {
		const extension = gift(true);
		assert.equal(await run(extension, "notes_read", {}), "The notebook is empty.");
		assert.equal(await run(extension, "notes_write", { text: "remember the milk" }), "Added note n0.");
		assert.deepEqual(added, ["remember the milk"]);
		assert.match(await run(extension, "notes_read", {}), /^- \S+ an agent: remember the milk$/);
		assert.deepEqual([...new Set(holders)], ["worker"]);
	});

	it("refuses a write the server no longer admits", async () => {
		const extension = gift(true);
		admitted = { ...admitted, options: { edit: false } };
		await assert.rejects(
			run(extension, "notes_write", { text: "too late" }),
			(error: unknown) => isChordError(error) && error.code === "forbidden",
		);
		assert.deepEqual(added, []);
	});
});
