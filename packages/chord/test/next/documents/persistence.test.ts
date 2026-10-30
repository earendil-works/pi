// Persisted documents' store side (slice 6a §8, §10): loads with the version and fingerprint checks and `migrate`,
// finds, keys, and the writes one commit stages (creation, base or delta by `checkpointWhen`, retirement).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { track } from "../../../src/delta/index.ts";
import { int, obj, str } from "../../../src/next/contracts/index.ts";
import { defineState, type JsonObject } from "../../../src/next/documents/index.ts";
import { Persistence, type Stored, storedAfter } from "../../../src/next/documents/persistence.ts";
import type { AnyDefinition } from "../../../src/next/documents/slot.ts";
import type { StagedWrite } from "../../../src/next/store/step.ts";
import type { ChordStore } from "../../../src/next/store/store.ts";
import { memoryStore, metered } from "../support.ts";

const context = BACKGROUND_CONTEXT;

const Note = defineState("notes.note", {
	schema: obj({ title: str(), n: int() }),
	version: 1,
	initial: () => ({ title: "", n: 0 }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 2,
});

let store: ChordStore;
let notes: Persistence;

beforeEach(async () => {
	store = await memoryStore({ outbox: true });
	notes = new Persistence(store, "app.store", "chord", "notes.note");
});

afterEach(async () => {
	await store.close(context);
});

/** Stages the change of `before` to `after` at `key` and commits it; resolves with what is stored afterwards. */
async function change(
	key: string,
	before: JsonObject | undefined,
	after: (draft: JsonObject) => void,
	stored: Stored | undefined,
	definition: AnyDefinition = Note,
): Promise<Stored | undefined> {
	const tracker = track(before ?? definition.initial(context));
	const draft = tracker.beginChange();
	after(draft.state);
	const prepared = draft.prepare();
	const writes: StagedWrite[] = [];
	const result = notes.stage(key, definition, stored, { prepared, retires: false }, writes);
	await store.commit(writes, { admit: () => true, adopt: () => {} }, context);
	tracker.adopt(prepared);
	return storedAfter(result);
}

/** The document at `key` read from the store and decoded by `definition`, `undefined` when absent. */
async function load(key: string, definition: AnyDefinition, at: typeof context) {
	const document = await notes.read(key, at);
	return document === undefined ? undefined : notes.decode(document, definition, at);
}

/** The kinds of the outbox's writes, per commit. */
async function outboxKinds(): Promise<string[][]> {
	const commits = await store.outbox!.read(0, 100, context);
	return commits.map(({ writes }) =>
		writes.map((write) => (write.kind === "document.change" ? `change:${write.content.kind}` : write.kind)),
	);
}

describe("loads", () => {
	it("load an absent document as undefined and a stored one with its record", async () => {
		expect(await load("a", Note, context)).toBeUndefined();
		const stored = await change(
			"a",
			undefined,
			(d) => {
				d.title = "x";
			},
			undefined,
		);
		const { counts, context: counting } = await metered();
		expect(await load("a", Note, counting)).toEqual({
			value: { title: "x", n: 0 },
			stored: { id: stored!.id, revision: 1, version: 1, deltasSinceBase: 0 },
		});
		expect(counts()["chord.store.loads"]).toBe(1);
	});

	it("migrate an older stored version and check the result once", async () => {
		const V1 = defineState("notes.note", {
			schema: obj({ title: str() }),
			version: 1,
			initial: () => ({ title: "" }),
			persist: true,
			checkpointWhen: () => false,
		});
		await change(
			"a",
			undefined,
			(d) => {
				d.title = "x";
			},
			undefined,
			V1,
		);
		const V2 = defineState("notes.note", {
			schema: obj({ title: str(), n: int() }),
			version: 2,
			initial: () => ({ title: "", n: 0 }),
			migrate: (old) => ({ title: String(old.title), n: 7 }),
			persist: true,
			checkpointWhen: () => false,
		});
		const { counts, context: counting } = await metered();
		expect(await load("a", V2, counting)).toMatchObject({
			value: { title: "x", n: 7 },
			stored: { version: 1 },
		});
		expect(counts()["chord.data.validations"]).toBe(1);
		const Bad = defineState("notes.note", {
			schema: obj({ title: str(), n: int() }),
			version: 2,
			initial: () => ({ title: "", n: 0 }),
			// A migrate returning a wrong shape: the load is refused.
			migrate: (old) => ({ title: String(old.title) }) as { title: string; n: number },
			persist: true,
			checkpointWhen: () => false,
		});
		await expect(load("a", Bad, context)).rejects.toThrow("migrate() from version 1 does not match");
	});

	it("refuse a stored version newer than the code's and the same version with another fingerprint (D9)", async () => {
		await change(
			"a",
			undefined,
			(d) => {
				d.title = "x";
			},
			undefined,
		);
		const Old = defineState("notes.note", {
			schema: obj({ title: str(), n: int() }),
			version: 0,
			initial: () => ({ title: "", n: 0 }),
			persist: true,
			checkpointWhen: () => false,
		});
		await expect(load("a", Old, context)).rejects.toThrow("stored at version 1, newer than the code's 0");
		const Edited = defineState("notes.note", {
			schema: obj({ title: str(), n: int(), extra: str() }),
			version: 1,
			initial: () => ({ title: "", n: 0, extra: "" }),
			persist: true,
			checkpointWhen: () => false,
		});
		await expect(load("a", Edited, context)).rejects.toThrow("stored with another schema at version 1");
	});

	it("find a live record without loading it, and list keys in code point order by pages", async () => {
		expect(await notes.find("a", context)).toBeUndefined();
		for (const key of ["b", "\u{1F600}", "a", "\uFFFF"])
			await change(
				key,
				undefined,
				(d) => {
					d.n = 1;
				},
				undefined,
			);
		expect(await notes.find("a", context)).toMatchObject({
			stored: { revision: 1, version: 1 },
			fingerprint: expect.any(String),
		});
		expect(await notes.keys(undefined, 10, context)).toEqual(["a", "b", "\uFFFF", "\u{1F600}"]);
		expect(await notes.keys("b", 1, context)).toEqual(["\uFFFF"]);
	});
});

describe("staged writes", () => {
	it("store a creation as a base, changes as deltas until checkpointWhen asks for a base", async () => {
		let stored = await change(
			"a",
			undefined,
			(d) => {
				d.n = 1;
			},
			undefined,
		);
		expect(stored).toMatchObject({ revision: 1, deltasSinceBase: 0 });
		let value = (await load("a", Note, context))!.value;
		for (const n of [2, 3, 4]) {
			stored = await change(
				"a",
				value,
				(d) => {
					d.n = n;
				},
				stored,
			);
			value = (await load("a", Note, context))!.value;
		}
		expect(stored).toMatchObject({ revision: 4, deltasSinceBase: 0 });
		expect(value).toEqual({ title: "", n: 4 });
		expect(await outboxKinds()).toEqual([["document.create"], ["change:delta"], ["change:delta"], ["change:base"]]);
		expect((await load("a", Note, context))!.stored.deltasSinceBase).toBe(0);
	});

	it("store a base when the stored version is older than the definition's (the migrated base written back)", async () => {
		const stored = await change(
			"a",
			undefined,
			(d) => {
				d.n = 1;
			},
			undefined,
		);
		const V2 = defineState("notes.note", {
			schema: obj({ title: str(), n: int() }),
			version: 2,
			initial: () => ({ title: "", n: 0 }),
			migrate: (old) => old as { title: string; n: number },
			persist: true,
			checkpointWhen: () => false,
		});
		const after = await change(
			"a",
			{ title: "", n: 1 },
			(d) => {
				d.n = 2;
			},
			stored,
			V2,
		);
		expect(after).toMatchObject({ version: 2, revision: 2, deltasSinceBase: 0 });
		expect((await outboxKinds()).at(-1)).toEqual(["change:base"]);
		expect(await load("a", V2, context)).toMatchObject({ value: { n: 2 }, stored: { version: 2 } });
	});

	it("stage a retirement before a recreation, and number creations by their order in the commit", async () => {
		const stored = await change(
			"a",
			undefined,
			(d) => {
				d.n = 1;
			},
			undefined,
		);
		const writes: StagedWrite[] = [];
		const fresh = (n: number) => {
			const tracker = track(Note.initial(context));
			const draft = tracker.beginChange();
			draft.state.n = n;
			return draft.prepare();
		};
		const first = notes.stage("b", Note, undefined, { prepared: fresh(2), retires: false }, writes);
		const again = notes.stage("a", Note, stored, { prepared: fresh(3), retires: true }, writes);
		const gone = notes.stage("c", Note, undefined, { prepared: undefined, retires: true }, writes);
		expect([first, again, gone]).toMatchObject([
			{ kind: "create", version: 1 },
			{ kind: "create", version: 1 },
			{ kind: "retire" },
		]);
		let ids: readonly number[] = [];
		await store.commit(
			writes,
			{
				admit: () => true,
				adopt: (_seq, created) => {
					ids = created;
				},
			},
			context,
		);
		expect(ids).toEqual([stored!.id + 1, stored!.id + 2]);
		expect(storedAfter(again)).toEqual({ id: stored!.id + 2, revision: 1, version: 1, deltasSinceBase: 0 });
		expect((await outboxKinds()).at(-1)).toEqual(["document.retire", "document.create", "document.create"]);
	});

	it("serialize at staging: a value JSON cannot encode fails there, never in the step (rule 8)", () => {
		// Drafts refuse such values when placed; a prepared change made by hand shows where the text is made.
		const value = { title: "", n: 1n } as unknown as JsonObject;
		const prepared = { base: value, value, ops: [], baseRevision: 0, abort: () => {} };
		expect(() => notes.stage("a", Note, undefined, { prepared, retires: false }, [])).toThrow(TypeError);
	});
});
