// Keyed slots (slice 6a §4, §10, §11): keyed reads with a context, per-key watches and `at(key)` sources with their
// pins, persisted keyed documents loaded on demand on the object's line (one load per key, shared), and their
// eviction.

import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { keyed, local, obj, str } from "../../../src/next/contracts/index.ts";
import { ChordError } from "../../../src/next/data/index.ts";
import { defineState, type KeyedHandle, type SingletonHandle } from "../../../src/next/documents/index.ts";
import { RETENTION_MS } from "../../../src/next/documents/residency.ts";
import type { StoreSelf } from "../../../src/next/host/index.ts";
import { ChordObject } from "../../../src/next/host/object.ts";
import type { ChordStore } from "../../../src/next/store/store.ts";
import type { Watchable, WatchHandle } from "../../../src/watch.ts";
import {
	changesOf,
	delivered,
	expectCollected,
	failLive,
	fakeTimers,
	flushed,
	holdNextCommit,
	instancesOf,
	loaded,
	memoryStore,
	rejection,
	restartable,
	storeRestartable,
} from "../support.ts";

const objects = instancesOf(ChordObject, "attempt");

type Note = { title: string };

const Memo = defineState("notes.memo", {
	schema: obj({ title: str() }),
	version: 1,
	initial: () => ({ title: "" }),
	keyed: true,
});

const Note = defineState("notes.note", {
	schema: obj({ title: str() }),
	version: 1,
	initial: () => ({ title: "" }),
	keyed: true,
	persist: true,
	checkpointWhen: () => false,
});

const stores: ChordStore[] = [];

afterEach(async () => {
	for (const store of stores.splice(0)) await store.close(context);
});

/** A fresh `:memory:` store, closed after the test. */
async function freshStore(): Promise<ChordStore> {
	const store = await memoryStore({ outbox: true });
	stores.push(store);
	return store;
}

/**
 * `StoreRestartable` over `store` declaring `Note` (and what `declare` adds) per attempt; `notes()` is the latest
 * attempt's handle.
 */
async function persisted(
	store: ChordStore,
	declare: (attempt: number, self: StoreSelf, notes: KeyedHandle<Note>) => void = () => {},
): Promise<Awaited<ReturnType<typeof storeRestartable>> & { readonly notes: () => KeyedHandle<Note> }> {
	let notes: KeyedHandle<Note> | undefined;
	const restartable = await storeRestartable(
		objects,
		(attempt, self) => {
			notes = self.state(Note);
			declare(attempt, self, notes);
		},
		{ store },
	);
	return { ...restartable, notes: () => notes! };
}

/** Writes `title` at `key` in `store`'s `Note` documents through a host of its own. */
async function seed(store: ChordStore, entries: Record<string, string>): Promise<void> {
	const { host, notes } = await persisted(store);
	for (const [key, title] of Object.entries(entries)) {
		await notes().change(
			key,
			(draft) => {
				draft.title = title;
			},
			context,
		);
	}
	await host.close(context);
}

describe("keyed reads in memory", () => {
	it("get and keys take a context; keys come in code point order", async () => {
		let memos: KeyedHandle<Note> | undefined;
		const { host } = await restartable(objects, (_, self) => {
			memos = self.state(Memo);
		});
		for (const key of ["b", "\u{1F600}", "a", "\uFFFF"])
			await memos!.change(
				key,
				(d) => {
					d.title = key;
				},
				context,
			);
		expect(await memos!.get("a", context)).toEqual({ title: "a" });
		expect(await memos!.get("z", context)).toBeUndefined();
		const keys: string[] = [];
		for await (const key of memos!.keys(context)) keys.push(key);
		expect(keys).toEqual(["a", "b", "\uFFFF", "\u{1F600}"]);
		await host.close(context);
	});
});

describe("migration on access", () => {
	it("a newer version migrates each in-memory key when it is read; a key whose migrate fails fails the owner then", async () => {
		const migrated: string[] = [];
		const MemoV2 = defineState("notes.memo", {
			schema: obj({ title: str() }),
			version: 2,
			initial: () => ({ title: "" }),
			keyed: true,
			migrate: (old) => {
				const title = old.title as string;
				if (title === "bad") throw new Error("cannot migrate");
				migrated.push(title);
				return { title: `${title}!` };
			},
		});
		const memos: KeyedHandle<Note>[] = [];
		const { attempts, restart, errors, reference } = await restartable(objects, (attempt, self) => {
			memos.push(self.state(attempt === 1 ? Memo : MemoV2));
		});
		for (const key of ["a", "b", "c"]) {
			await memos[0]!.change(
				key,
				(draft) => {
					draft.title = key === "c" ? "bad" : key;
				},
				context,
			);
		}
		await restart();
		// The activation migrated nothing: no key was read.
		expect(migrated).toEqual([]);
		expect(await memos[1]!.get("a", context)).toEqual({ title: "a!" });
		expect(migrated).toEqual(["a"]);
		await attempts[1]!.tx(async (tx) => {
			expect(await tx.draft(memos[1]!, "b")).toEqual({ title: "b!" });
		}, context);
		expect(migrated).toEqual(["a", "b"]);
		expect(await rejection(memos[1]!.get("c", context))).toMatchObject({
			message: expect.stringContaining("cannot migrate"),
		});
		expect(errors.map(({ kind }) => kind)).toEqual(["object_failed", "object_failed"]);
		expect(reference.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken" } });
	});
});

describe("keys and the text rules", () => {
	/** Every key of `handle`, in order. */
	async function keysOf(handle: KeyedHandle<Note>): Promise<string[]> {
		const keys: string[] = [];
		for await (const key of handle.keys(context)) keys.push(key);
		return keys;
	}

	const title = (value: string) => (draft: Note) => {
		draft.title = value;
	};

	it("a lone surrogate in a key is U+FFFD at every entry point, in memory and in the store; NUL is refused", async () => {
		const store = await freshStore();
		const { host, notes, attempts } = await persisted(store);
		await notes().change("x\uD800", title("one"), context);
		expect(await keysOf(notes())).toEqual(["x\uFFFD"]);
		// One key: the change through either spelling reaches the same document and record.
		await notes().change("x\uFFFD", title("two"), context);
		await attempts[0]!.tx(async (tx) => {
			(await tx.draft(notes(), "x\uD800")).title += "!";
		}, context);
		expect(await notes().get("x\uD800", context)).toEqual({ title: "two!" });
		expect((await notes().watch("x\uD800", context))?.value).toEqual({ title: "two!" });
		for (const use of [
			() => notes().change("a\0b", title("nul"), context),
			() => notes().get("a\0b", context),
			() => notes().watch("a\0b", context),
			() => notes().retire("a\0b", context),
		]) {
			expect(await rejection(use())).toMatchObject({ code: "invalid", reason: "args" });
		}
		await notes().retire("x\uD800", context);
		expect(await keysOf(notes())).toEqual([]);
		await host.close(context);
		// The store has the key as memory had it.
		const again = await persisted(store);
		expect(await again.notes().get("x\uFFFD", context)).toBeUndefined();
		await again.host.close(context);
	});

	it("in memory too: one key per spelling, NUL refused", async () => {
		let memos: KeyedHandle<Note> | undefined;
		const { host } = await restartable(objects, (_, self) => {
			memos = self.state(Memo);
		});
		await memos!.change("x\uDC00", title("one"), context);
		expect(await memos!.get("x\uFFFD", context)).toEqual({ title: "one" });
		expect(await keysOf(memos!)).toEqual(["x\uFFFD"]);
		expect(await rejection(memos!.change("\0", title("nul"), context))).toMatchObject({ code: "invalid" });
		await host.close(context);
	});

	it("the empty key is a key: listed first, also on a later page", async () => {
		const store = await freshStore();
		const entries: Record<string, string> = { "": "empty" };
		for (let i = 0; i < 120; i++) entries[`k${String(i).padStart(3, "0")}`] = "x";
		await seed(store, entries);
		const { host, notes } = await persisted(store);
		const keys = await keysOf(notes());
		expect(keys.length).toBe(121);
		expect(keys[0]).toBe("");
		expect(await notes().get("", context)).toEqual({ title: "empty" });
		await host.close(context);
	});
});

describe("keyed watches", () => {
	it("watch(key) is undefined when absent; it follows the address through a retirement and a recreation", async () => {
		let memos: KeyedHandle<Note> | undefined;
		const { host, attempts } = await restartable(objects, (_, self) => {
			memos = self.state(Memo);
		});
		expect(await memos!.watch("a", context)).toBeUndefined();
		await memos!.change(
			"a",
			(d) => {
				d.title = "x";
			},
			context,
		);
		const watch = (await memos!.watch("a", context))!;
		expect(watch.value).toEqual({ title: "x" });
		const changes = changesOf(watch);
		await memos!.change(
			"a",
			(d) => {
				d.title = "y";
			},
			context,
		);
		await delivered();
		await memos!.retire("a", context);
		await delivered();
		await memos!.change(
			"a",
			(d) => {
				d.title = "z";
			},
			context,
		);
		await delivered();
		await attempts[0]!.tx(async (tx) => {
			await tx.retire(memos!, "a");
			(await tx.draft(memos!, "a")).title = "w";
		}, context);
		await delivered();
		expect(changes).toEqual([
			{ kind: "value", value: { title: "y" }, ops: [["s", ["title"], "y"]], retired: false },
			{ kind: "value", value: { title: "" }, ops: [["r", { title: "" }]], retired: true },
			{ kind: "value", value: { title: "z" }, ops: [["r", { title: "z" }]], retired: false },
			{ kind: "value", value: { title: "w" }, ops: [["r", { title: "w" }]], retired: true },
		]);
		await host.close(context);
		expect(await watch.closed).toEqual({ kind: "ended" });
	});

	it("a stopped watch unpins its key: its source is collected", async () => {
		let memos: KeyedHandle<Note> | undefined;
		const { host } = await restartable(objects, (_, self) => {
			memos = self.state(Memo);
		});
		await memos!.change(
			"a",
			(d) => {
				d.title = "x";
			},
			context,
		);
		let watch: WatchHandle<Note> | undefined = (await memos!.watch("a", context))!;
		// The watch's source: the slot's per-key source while pinned.
		const slot = (memos as unknown as { slot: { source(key: string): object } }).slot;
		const source = new WeakRef(slot.source("a"));
		await watch.stop();
		watch = undefined;
		await flushed();
		await expectCollected(source);
		await host.close(context);
	});
});

describe("at(key)", () => {
	it("is initial() while absent, a state member, derive and on source; retirement arrives with the flag", async () => {
		let memos: KeyedHandle<Note> | undefined;
		let pinned: Watchable<Note> | undefined;
		let upper: Watchable<string> | undefined;
		const seen: { title: string; retired: boolean }[] = [];
		const { host } = await restartable(objects, (_, self) => {
			memos = self.state(Memo);
			pinned = memos.at("a");
			upper = self.derive([pinned], ([note]) => note.title.toUpperCase());
			self.on(pinned, async ({ value, retired }) => void seen.push({ title: value.title, retired }));
		});
		expect(pinned!.value).toEqual({ title: "" });
		const changes = changesOf(await upper!.watch(context));
		await memos!.change(
			"a",
			(d) => {
				d.title = "x";
			},
			context,
		);
		await delivered();
		expect(pinned!.value).toEqual({ title: "x" });
		await memos!.retire("a", context);
		await delivered();
		await flushed();
		expect(changes).toEqual([
			{ kind: "value", value: "X", ops: [["r", "X"]], retired: false },
			{ kind: "value", value: "", ops: [["r", ""]], retired: true },
		]);
		expect(seen).toEqual([
			{ title: "", retired: false },
			{ title: "x", retired: false },
			{ title: "", retired: true },
		]);
		await host.close(context);
	});

	it("only in the factory", async () => {
		let memos: KeyedHandle<Note> | undefined;
		const { host } = await restartable(objects, (_, self) => {
			memos = self.state(Memo);
		});
		expect(() => memos!.at("a")).toThrow("valid only in the factory");
		await host.close(context);
	});

	it("a persisted key is loaded before the object goes live and stays pinned until the next factory returns", async () => {
		const store = await freshStore();
		await seed(store, { a: "x", b: "y" });
		let pinned: Watchable<Note> | undefined;
		const { host, restart, notes } = await persisted(store, (attempt, _, notes) => {
			pinned = notes.at(attempt === 1 ? "a" : "b");
		});
		expect(pinned!.value).toEqual({ title: "x" });
		const slot = (notes() as unknown as { slot: { source(key: string): object | undefined } }).slot;
		const first = new WeakRef(slot.source("a")!);
		await restart();
		expect(pinned!.value).toEqual({ title: "y" });
		expect(slot.source("a")).toBeUndefined();
		await expectCollected(first);
		await host.close(context);
	});
});

describe("cold keyed loads on the line", () => {
	it("load a cold key once; a cached get touches no SQLite; an absent key is not cached", async () => {
		const store = await freshStore();
		await seed(store, { a: "x" });
		const { host, notes } = await persisted(store);
		const read = vi.spyOn(store, "read");
		expect(await notes().get("a", context)).toEqual({ title: "x" });
		expect(read).toHaveBeenCalledTimes(1);
		expect(await notes().get("a", context)).toEqual({ title: "x" });
		expect(read).toHaveBeenCalledTimes(1);
		expect(await notes().get("z", context)).toBeUndefined();
		expect(await notes().get("z", context)).toBeUndefined();
		expect(read).toHaveBeenCalledTimes(3);
		await host.close(context);
	});

	it("two readers share one load; a cancelled waiter rejects alone", async () => {
		const store = await freshStore();
		await seed(store, { a: "x" });
		const { host, notes, attempts } = await persisted(store);
		const read = vi.spyOn(store, "read");
		// Hold the line so that the load waits behind it.
		const { promise: holding, resolve: release } = Promise.withResolvers<void>();
		const tx = attempts[0]!.tx(() => holding, context);
		const cancel = new AbortController();
		const first = notes().get("a", { ...context, abortSignal: cancel.signal });
		const second = notes().get("a", context);
		cancel.abort(new Error("gone"));
		await expect(first).rejects.toThrow("gone");
		release();
		await tx;
		expect(await second).toEqual({ title: "x" });
		expect(read).toHaveBeenCalledTimes(1);
		await host.close(context);
	});

	it("a cold get racing a draft of the same key: the load installs only while the key is absent", async () => {
		const store = await freshStore();
		await seed(store, { a: "x" });
		const { host, notes, attempts } = await persisted(store);
		let get: Promise<Note | undefined> | undefined;
		await attempts[0]!.tx(async (tx) => {
			get = notes().get("a", context);
			const draft = await tx.draft(notes(), "a");
			expect(draft.title).toBe("x");
			draft.title = "y";
		}, context);
		expect(await get).toEqual({ title: "y" });
		expect(await notes().get("a", context)).toEqual({ title: "y" });
		await host.close(context);
	});

	it("keys come from the store in code point order, a page per line job", async () => {
		const store = await freshStore();
		const entries: Record<string, string> = {};
		for (let i = 0; i < 150; i++) entries[`k${String(i).padStart(3, "0")}`] = "x";
		entries["\u{1F600}"] = "x";
		entries["\uFFFF"] = "x";
		await seed(store, entries);
		const { host, notes } = await persisted(store);
		const keys: string[] = [];
		for await (const key of notes().keys(context)) keys.push(key);
		expect(keys).toEqual([...Object.keys(entries).filter((key) => key.startsWith("k")), "\uFFFF", "\u{1F600}"]);
		await host.close(context);
	});

	it("tx.retire of a cold key finds it without loading it; an absent key retires nothing", async () => {
		const store = await freshStore();
		await seed(store, { a: "x" });
		const { host, notes } = await persisted(store);
		const seq = store.lastSeq;
		await notes().retire("z", context);
		expect(store.lastSeq).toBe(seq);
		await notes().retire("a", context);
		expect(store.lastSeq).toBe(seq + 1);
		expect(await notes().get("a", context)).toBeUndefined();
		await host.close(context);
	});

	it.each([
		["a newer version", 2, { title: str(), n: str() }, "stored at version 2, newer than the code's 1"],
		["another fingerprint at its version", 1, { title: str(), n: str() }, "stored with another schema at version 1"],
	])(
		"tx.retire of a cold key stored at %s fails the owner broken as a read would and keeps it (R15, audit)",
		async (_, version, schema, message) => {
			const store = await freshStore();
			// Written by other code: a newer version, or the same version with another schema.
			const Other = defineState("notes.note", {
				schema: obj(schema),
				version,
				initial: () => ({ title: "", n: "" }),
				keyed: true,
				persist: true,
				checkpointWhen: () => false,
			});
			const writer = await storeRestartable(
				objects,
				(_, self) => {
					void self
						.state(Other)
						.change("a", (draft) => void Object.assign(draft, { title: "kept", n: "1" }), context);
				},
				{ store },
			);
			await flushed();
			await writer.host.close(context);
			const { host, notes, errors, reference } = await persisted(store);
			expect(await rejection(notes().retire("a", context))).toMatchObject({
				message: expect.stringContaining(message),
			});
			expect(errors.map(({ kind }) => kind)).toEqual(["object_failed"]);
			expect(reference.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken" } });
			await host.close(context);
			const reader = await storeRestartable(objects, (_, self) => void self.state(Other), { store });
			expect(await store.read((executor) => executor.all("SELECT key FROM chord_documents"), context)).toEqual([
				{ key: "a" },
			]);
			await reader.host.close(context);
		},
	);

	it("a retirement cut by its attempt's seal while it finds the document fails no successor (audit)", async () => {
		const store = await freshStore();
		const Newer = defineState("notes.note", {
			schema: obj({ title: str() }),
			version: 2,
			initial: () => ({ title: "" }),
			keyed: true,
			persist: true,
			checkpointWhen: () => false,
		});
		const writer = await storeRestartable(
			objects,
			(_, self) =>
				void self.state(Newer).change(
					"a",
					(draft) => {
						draft.title = "kept";
					},
					context,
				),
			{ store },
		);
		await flushed();
		await writer.host.close(context);
		const { host, notes, errors, reference, fail, retry } = await persisted(store);
		// The find's read is held past the seal: the retirement resumes on a cut transaction.
		const read = store.read.bind(store);
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		store.read = async (fn, ctx) => {
			store.read = read;
			const value = await read(fn, ctx);
			entered.resolve();
			await gate.promise;
			return value;
		};
		const retired = rejection(notes().retire("a", context));
		await entered.promise;
		fail();
		await retry();
		gate.resolve();
		expect(await retired).toMatchObject({ code: "released" });
		await flushed();
		expect(reference.state.value).toEqual({ kind: "live" });
		expect(errors.filter(({ kind }) => kind === "object_failed")).toHaveLength(1);
		await host.close(context);
	});

	it("a sealed handle reads cached documents; a cold read is refused released", async () => {
		const store = await freshStore();
		await seed(store, { a: "x", b: "y" });
		const { host, notes, restart } = await persisted(store);
		const old = notes();
		await old.get("a", context);
		await restart();
		expect(await old.get("a", context)).toEqual({ title: "x" });
		expect(await rejection(old.get("b", context))).toMatchObject({ code: "released" });
		await host.close(context);
	});

	it("a sealed handle joining a cold load in flight is refused released (rule 4)", async () => {
		const store = await freshStore();
		await seed(store, { b: "y" });
		const { host, notes, restart } = await persisted(store);
		const gate = holdNextRead(store);
		const old = notes();
		const first = old.get("b", context);
		await gate.reached;
		const restarting = restart();
		await delivered();
		expect(await rejection(old.get("b", context))).toMatchObject({ code: "released" });
		gate.open();
		expect(await first).toEqual({ title: "y" });
		await restarting;
		await host.close(context);
	});

	it("cold reads queued on the line before the object's end are refused released when they run after it", async () => {
		const store = await freshStore();
		await seed(store, { a: "x", b: "y", c: "z" });
		const { host, notes } = await persisted(store);
		const gate = holdNextRead(store);
		const first = notes().get("a", context);
		await gate.reached;
		const get = rejection(notes().get("b", context));
		const watch = rejection(notes().watch("c", context));
		const closing = host.close(context);
		gate.open();
		expect(await get).toMatchObject({ code: "released" });
		expect(await watch).toMatchObject({ code: "released" });
		// The load holding the line before the end finishes.
		expect(await first).toEqual({ title: "x" });
		await closing;
	});

	it("cold reads queued behind an admitted step are refused released when their attempt failed live meanwhile", async () => {
		const store = await freshStore();
		await seed(store, { a: "x" });
		const P = defineState("notes.p", {
			schema: obj({ title: str() }),
			version: 1,
			initial: () => ({ title: "" }),
			persist: true,
			checkpointWhen: () => false,
		});
		let p: SingletonHandle<Note> | undefined;
		const { host, notes, attempts } = await persisted(store, (_, self) => {
			p = self.state(P);
		});
		const held = holdNextCommit(store);
		const change = p!.change((draft) => {
			draft.title = "p";
		}, context);
		await held.entered;
		const get = rejection(notes().get("a", context));
		const watch = rejection(notes().watch("a", context));
		const keys = rejection(
			(async () => {
				for await (const _ of notes().keys(context));
			})(),
		);
		// The attempt is sealed; the object stays open.
		failLive(objects, attempts[0]!, new ChordError({ code: "unavailable", message: "boom" }));
		held.release();
		await change;
		expect(await get).toMatchObject({ code: "released" });
		expect(await watch).toMatchObject({ code: "released" });
		expect(await keys).toMatchObject({ code: "released" });
		await host.close(context);
	});

	it("a still-valid waiter sharing that load gets the document: only the sealed handle's read is refused", async () => {
		const store = await freshStore();
		await seed(store, { a: "x" });
		const Notes = local("app.store", { version: 1, params: {}, members: { notes: keyed(obj({ title: str() })) } });
		let self: StoreSelf | undefined;
		let notes: KeyedHandle<Note> | undefined;
		const { host } = await loaded(
			(h) =>
				h.serve(Notes, (_, s) => {
					self = s;
					notes = s.state(Note);
					return { notes };
				}),
			{ store },
		);
		const ref = await host.get(Notes, {}, context);
		const held = holdNextCommit(store);
		const change = notes!.change(
			"b",
			(draft) => {
				draft.title = "y";
			},
			context,
		);
		await held.entered;
		const sealed = rejection(notes!.get("a", context));
		// A consumer reads as the provider's own code may (the object's own token), joining the same load.
		const shared = ref.notes.get("a", context);
		await flushed();
		failLive(objects, self!, new ChordError({ code: "unavailable", message: "boom" }));
		held.release();
		await change;
		expect(await sealed).toMatchObject({ code: "released" });
		expect(await shared).toEqual({ title: "x" });
		await host.close(context);
	});

	it("a load cut by the seal never installs: a successor's retirement stands", async () => {
		const store = await freshStore();
		await seed(store, { a: "x" });
		const { host, notes, attempts, restart } = await persisted(store);
		const gate = holdNextRead(store);
		const old = notes();
		const cut = attempts[0]!.tx(async (tx) => {
			(await tx.draft(old, "a")).title = "z";
		}, context);
		await gate.reached;
		// The seal cuts the transaction and releases the line; the successor retires the key.
		await restart();
		await notes().retire("a", context);
		gate.open();
		expect(await rejection(cut)).toMatchObject({ code: "released" });
		expect(await notes().get("a", context)).toBeUndefined();
		await host.close(context);
	});

	it("a plugin migrate throwing a ChordError fails its owner like any other error", async () => {
		const store = await freshStore();
		await seed(store, { a: "x" });
		const V2 = defineState("notes.note", {
			schema: obj({ title: str() }),
			version: 2,
			initial: () => ({ title: "" }),
			migrate: () => {
				throw new ChordError({ code: "unavailable", message: "plugin says no" });
			},
			keyed: true,
			persist: true,
			checkpointWhen: () => false,
		});
		let notes: KeyedHandle<Note> | undefined;
		const { host, errors, reference } = await storeRestartable(
			objects,
			(_, self) => {
				notes = self.state(V2);
			},
			{ store },
		);
		expect(await rejection(notes!.get("a", context))).toMatchObject({ message: "plugin says no" });
		expect(errors.map(({ kind }) => kind)).toEqual(["object_failed"]);
		expect(reference.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken" } });
		await host.close(context);
	});

	it("a key whose migrate fails fails its owner broken; the get rejects with the cause", async () => {
		const store = await freshStore();
		await seed(store, { a: "x" });
		const V2 = defineState("notes.note", {
			schema: obj({ title: str() }),
			version: 2,
			initial: () => ({ title: "" }),
			migrate: () => {
				throw new Error("cannot migrate");
			},
			keyed: true,
			persist: true,
			checkpointWhen: () => false,
		});
		let notes: KeyedHandle<Note> | undefined;
		const { host, errors, reference } = await storeRestartable(
			objects,
			(_, self) => {
				notes = self.state(V2);
			},
			{ store },
		);
		expect(await rejection(notes!.get("a", context))).toMatchObject({
			code: "unavailable",
			message: expect.stringContaining("cannot migrate"),
		});
		expect(errors.map(({ kind }) => kind)).toEqual(["object_failed"]);
		expect(reference.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken" } });
		await host.close(context);
	});
});

describe("eviction", () => {
	fakeTimers();

	it("an unpinned key idle for the retention leaves memory; a pinned one stays", async () => {
		const store = await freshStore();
		await seed(store, { a: "x", b: "y" });
		const { host, notes } = await persisted(store);
		const read = vi.spyOn(store, "read");
		await notes().get("a", context);
		const watch = (await notes().watch("b", context))!;
		expect(read).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(RETENTION_MS + 1_000);
		await flushed();
		await notes().get("a", context);
		await notes().get("b", context);
		expect(read).toHaveBeenCalledTimes(3);
		await watch.stop();
		await flushed();
		vi.advanceTimersByTime(RETENTION_MS + 1_000);
		await flushed();
		await notes().get("b", context);
		expect(read).toHaveBeenCalledTimes(4);
		await host.close(context);
	});

	it("an evicted document is collected", async () => {
		const store = await freshStore();
		await seed(store, { a: "x" });
		const { host, notes } = await persisted(store);
		let value: Note | undefined = await notes().get("a", context);
		const collected = new WeakRef(value!);
		value = undefined;
		vi.advanceTimersByTime(RETENTION_MS + 1_000);
		await flushed();
		await expectCollected(collected);
		expect(await notes().get("a", context)).toEqual({ title: "x" });
		await host.close(context);
	});
});

/** Holds `store`'s next read after the backend returned its result, until `open()`. */
function holdNextRead(store: ChordStore): { readonly reached: Promise<void>; open(): void } {
	const reached = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const read = store.read.bind(store);
	store.read = async (fn, ctx) => {
		store.read = read;
		const result = await read(fn, ctx);
		reached.resolve();
		await gate.promise;
		return result;
	};
	return { reached: reached.promise, open: () => gate.resolve() };
}
