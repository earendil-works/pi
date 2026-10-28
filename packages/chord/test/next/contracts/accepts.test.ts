import { describe, expect, it, vi } from "vitest";
import {
	type AcceptsTable,
	arr,
	evolve,
	int,
	local,
	method,
	nul,
	obj,
	remote,
	str,
} from "../../../src/next/contracts/index.ts";
import { checkAccepts } from "../../../src/next/contracts/internal.ts";

const Note = obj({ text: str() });
const NoteV2 = obj({ text: str(), tag: str() });

const NotesV1 = remote("notes", {
	version: 1,
	params: { session: str() },
	variants: {
		editor: { state: { notes: arr(Note), count: int() }, methods: { add: method(Note, str()), clear: method() } },
		reader: { state: { notes: arr(Note) }, methods: { add: method(Note, str()) } },
	},
});

/** Calls `checkAccepts` through an untyped door, as a JavaScript caller would. */
const checkUntyped = checkAccepts as (contract: unknown, accepts: unknown) => unknown;

const toV1 = (note: { text: string; tag: string }) => ({ text: note.text });

describe("state mappings", () => {
	const v2 = evolve(NotesV1, (e) => e.state("editor", "notes", arr(NoteV2)));

	it("a changed member maps the current member to the old one", () => {
		const accepts: AcceptsTable<typeof v2> = { 1: { state: { editor: { notes: (current) => current.map(toV1) } } } };
		expect(checkAccepts(v2, accepts)).toEqual({ versions: [{ version: 1, fingerprint: NotesV1.fingerprint }] });
		// @ts-expect-error: the changed member needs a mapping
		expect(() => checkAccepts(v2, { 1: { state: { editor: {} } } })).toThrow(
			"notes accepts[1].state.editor.notes: missing mapping",
		);
		// @ts-expect-error: "refuse" is only for removed members
		expect(() => checkAccepts(v2, { 1: { state: { editor: { notes: "refuse" } } } })).toThrow(
			"notes accepts[1].state.editor.notes: expected a function",
		);
		// @ts-expect-error: the mapping returns the old shape, not the current one
		checkAccepts(v2, { 1: { state: { editor: { notes: (current) => current.map((note) => note.tag) } } } });
	});

	it("a removed member maps the variant's whole current state, or refuses", () => {
		const v3 = evolve(v2, (e) => e.removeState("editor", "count"));
		const accepts: AcceptsTable<typeof v3> = {
			1: { state: { editor: { notes: (current) => current.map(toV1), count: (state) => state.notes.length } } },
			2: { state: { editor: { count: "refuse" } } },
		};
		expect(checkAccepts(v3, accepts).versions.map(({ version }) => version)).toEqual([1, 2]);
		expect(() => checkUntyped(v3, { 2: { state: { editor: { count: 1 } } } })).toThrow(
			'notes accepts[2].state.editor.count: expected a function or "refuse"',
		);
	});

	it("an absent section is allowed only when nothing is needed there", () => {
		// @ts-expect-error: the state section is needed
		expect(() => checkAccepts(v2, { 1: {} })).toThrow("notes accepts[1].state.editor: missing mapping");
		const v3 = evolve(v2, (e) => e.addState("reader", "count", int()));
		expect(() => checkAccepts(v3, { 2: {} })).not.toThrow();
		expect(() => checkAccepts(v3, { 2: { state: {}, methods: {} } })).not.toThrow();
	});

	it("unnecessary mappings are refused", () => {
		expect(() =>
			// @ts-expect-error: reader.notes did not change
			checkAccepts(v2, { 1: { state: { editor: { notes: (c) => c.map(toV1) }, reader: { notes: (c) => c } } } }),
		).toThrow("notes accepts[1].state.reader: unnecessary mapping");
		const v3 = evolve(v2, (e) => e.addState("reader", "count", int()));
		// @ts-expect-error: added members need nothing
		expect(() => checkAccepts(v3, { 2: { state: { reader: { count: () => 0 } } } })).toThrow(
			"notes accepts[2].state.reader: unnecessary mapping",
		);
	});

	it("is checked by edit, not by schema: a no-op edit and a reverted change still need mappings", () => {
		const noop = evolve(NotesV1, (e) => e.state("reader", "notes", arr(Note)));
		// @ts-expect-error: the edit needs an (identity) mapping
		expect(() => checkAccepts(noop, { 1: {} })).toThrow("notes accepts[1].state.reader: missing mapping");
		expect(() => checkAccepts(noop, { 1: { state: { reader: { notes: (current) => current } } } })).not.toThrow();
		const reverted = evolve(v2, (e) => e.state("editor", "notes", arr(Note)));
		expect(() => checkAccepts(reverted, { 1: { state: { editor: { notes: (current) => current } } } })).not.toThrow();
		const readded = evolve(NotesV1, (e) => e.removeState("editor", "count").addState("editor", "count", int()));
		expect(() => checkAccepts(readded, { 1: { state: { editor: { count: (current) => current } } } })).not.toThrow();
	});
});

describe("method mappings", () => {
	it("changed args map old to current; a changed result maps current to old; both need both", () => {
		const args = evolve(NotesV1, (e) => e.args("add", NoteV2));
		expect(() =>
			checkAccepts(args, { 1: { methods: { add: { args: (old) => ({ ...old, tag: "" }) } } } }),
		).not.toThrow();
		expect(() =>
			// @ts-expect-error: only args changed
			checkAccepts(args, { 1: { methods: { add: { args: (old) => ({ ...old, tag: "" }), result: (r) => r } } } }),
		).toThrow("notes accepts[1].methods.add.result: unnecessary mapping");
		// @ts-expect-error: args must produce the current shape
		checkAccepts(args, { 1: { methods: { add: { args: (old) => old } } } });

		const result = evolve(NotesV1, (e) => e.result("add", int()));
		expect(() =>
			checkAccepts(result, { 1: { methods: { add: { result: (current) => String(current) } } } }),
		).not.toThrow();
		// @ts-expect-error: the result mapping is missing
		expect(() => checkAccepts(result, { 1: { methods: { add: {} } } })).toThrow(
			"notes accepts[1].methods.add.result: missing mapping",
		);

		const both = evolve(NotesV1, (e) => e.method("add", NoteV2, int()));
		const accepts: AcceptsTable<typeof both> = {
			1: { methods: { add: { args: (old) => ({ ...old, tag: "" }), result: (current) => String(current) } } },
		};
		expect(() => checkAccepts(both, accepts)).not.toThrow();
		// @ts-expect-error: both sides changed
		expect(() => checkAccepts(both, { 1: { methods: { add: { args: (old) => ({ ...old, tag: "" }) } } } })).toThrow(
			"notes accepts[1].methods.add.result: missing mapping",
		);
	});

	it("a removed method takes a call replacement or refuses", () => {
		const v2 = evolve(NotesV1, (e) => e.removeMethod("clear"));
		const call = async (args: null) => args;
		expect(() => checkAccepts(v2, { 1: { methods: { clear: { call } } } })).not.toThrow();
		expect(() => checkAccepts(v2, { 1: { methods: { clear: "refuse" } } })).not.toThrow();
		// @ts-expect-error: a removed method has no args mapping
		expect(() => checkAccepts(v2, { 1: { methods: { clear: { args: (old) => old } } } })).toThrow(
			'notes accepts[1].methods.clear: expected { call } or "refuse"',
		);
		// @ts-expect-error: the removed method needs a replacement or a refusal
		expect(() => checkAccepts(v2, { 1: {} })).toThrow("notes accepts[1].methods.clear: missing mapping");
	});

	it("a method removed from one variant that had it counts as removed", () => {
		const v2 = evolve(NotesV1, (e) => e.removeMethod("add").addMethod("editor", "add", Note, str()));
		// @ts-expect-error: reader lost `add`
		expect(() => checkAccepts(v2, { 1: { methods: { add: { args: (old) => old, result: (r) => r } } } })).toThrow(
			'notes accepts[1].methods.add: expected { call } or "refuse"',
		);
		expect(() => checkAccepts(v2, { 1: { methods: { add: "refuse" } } })).not.toThrow();
	});

	it("call and refuse are also allowed for changed methods", () => {
		const v2 = evolve(NotesV1, (e) => e.args("add", NoteV2));
		expect(() => checkAccepts(v2, { 1: { methods: { add: { call: async (old) => old.text } } } })).not.toThrow();
		expect(() => checkAccepts(v2, { 1: { methods: { add: "refuse" } } })).not.toThrow();
		expect(() =>
			// @ts-expect-error: call cannot be combined with args
			checkAccepts(v2, { 1: { methods: { add: { call: async () => "", args: (old) => ({ ...old, tag: "" }) } } } }),
		).toThrow('notes accepts[1].methods.add: expected { call } or "refuse"');
		// @ts-expect-error: call returns the old result type
		checkAccepts(v2, { 1: { methods: { add: { call: async () => 1 } } } });
	});

	it("added methods and methods added to a new variant need nothing", () => {
		const v2 = evolve(NotesV1, (e) => e.addMethod("reader", "clear", nul(), nul()));
		expect(checkAccepts(v2, { 1: {} }).versions).toHaveLength(1);
		// @ts-expect-error: unnecessary mapping
		expect(() => checkAccepts(v2, { 1: { methods: { clear: "refuse" } } })).toThrow(
			"notes accepts[1].methods.clear: unnecessary mapping",
		);
	});

	it("refuses wrong shapes", () => {
		const v2 = evolve(NotesV1, (e) => e.args("add", NoteV2));
		expect(() => checkUntyped(v2, { 1: { methods: { add: { args: 1 } } } })).toThrow(
			"notes accepts[1].methods.add.args: expected a function",
		);
		expect(() => checkUntyped(v2, { 1: { methods: { add: { args: () => 0, extra: 1 } } } })).toThrow(
			'notes accepts[1].methods.add: unknown key "extra"',
		);
		expect(() => checkUntyped(v2, { 1: { methods: { add: { args: () => 0 } } }, other: 1 })).toThrow(
			"notes accepts[other]: not an older version",
		);
		expect(() => checkUntyped(v2, { 1: { methods: { add: { args: () => 0 } }, extra: {} } })).toThrow(
			'notes accepts[1]: unknown key "extra"',
		);
		expect(() => checkUntyped(v2, null)).toThrow("notes accepts: expected an object");
	});
});

describe("versions", () => {
	it("refuses unknown versions and the current version", () => {
		const v2 = evolve(NotesV1, (e) => e);
		// @ts-expect-error: version 3 does not exist
		expect(() => checkAccepts(v2, { 3: {} })).toThrow("notes accepts[3]: not an older version");
		// @ts-expect-error: version 2 is current
		expect(() => checkAccepts(v2, { 2: {} })).toThrow("notes accepts[2]: not an older version");
		expect(checkAccepts(v2, {})).toEqual({ versions: [] });
	});

	it("maps directly over several versions: every edit after the accepted version counts", () => {
		const v2 = evolve(NotesV1, (e) => e.args("add", NoteV2));
		const v3 = evolve(v2, (e) => e.result("add", int()).removeState("editor", "count"));
		const accepts: AcceptsTable<typeof v3> = {
			1: {
				state: { editor: { count: "refuse" } },
				methods: { add: { args: (old) => ({ ...old, tag: "" }), result: (current) => String(current) } },
			},
			2: {
				state: { editor: { count: (state) => state.notes.length } },
				methods: { add: { result: (r) => `${r}` } },
			},
		};
		expect(checkAccepts(v3, accepts).versions).toEqual([
			{ version: 1, fingerprint: NotesV1.fingerprint },
			{ version: 2, fingerprint: v2.fingerprint },
		]);
		const fromV1 = {
			state: { editor: { count: "refuse" } },
			methods: { add: { result: (r: number) => `${r}` } },
		} as const;
		// @ts-expect-error: from v1, args changed too
		expect(() => checkAccepts(v3, { 1: fromV1 })).toThrow("notes accepts[1].methods.add.args: missing mapping");
	});

	it("never calls a mapping", () => {
		const v2 = evolve(NotesV1, (e) => e.args("add", NoteV2).removeMethod("clear").state("editor", "count", str()));
		const mappings = { args: vi.fn(), call: vi.fn(), count: vi.fn() };
		checkUntyped(v2, {
			1: {
				state: { editor: { count: mappings.count } },
				methods: { add: { args: mappings.args }, clear: { call: mappings.call } },
			},
		});
		expect(Object.values(mappings).map((mapping) => mapping.mock.calls.length)).toEqual([0, 0, 0]);
	});

	it("local tables are flat: state without a variant level", () => {
		const v1 = local("info", { version: 1, params: {}, members: { title: str(), save: method(str()) } });
		const v2 = evolve(v1, (e) => e.state("title", int()).args("save", int()));
		const accepts: AcceptsTable<typeof v2> = {
			1: { state: { title: (current) => String(current) }, methods: { save: { args: (old) => old.length } } },
		};
		expect(() => checkAccepts(v2, accepts)).not.toThrow();
		expect(() =>
			checkUntyped(v2, { 1: { state: { members: { title: String } }, methods: { save: "refuse" } } }),
		).toThrow("info accepts[1].state.members: unnecessary mapping");
	});
});
