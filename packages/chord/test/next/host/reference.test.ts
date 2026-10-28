import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { type Context, BACKGROUND_CONTEXT as context, withAbortSignal } from "../../../src/context/index.ts";
import { int, keyed, local, method, obj, remote, str } from "../../../src/next/contracts/index.ts";
import { broken, type ChordError } from "../../../src/next/data/index.ts";
import { defineState, type KeyedHandle } from "../../../src/next/documents/index.ts";
import {
	createHost,
	defineFacet,
	type Held,
	type Reference,
	type RefIn,
	type RefState,
	type Self,
} from "../../../src/next/host/index.ts";
import { ChordObject } from "../../../src/next/host/object.ts";
import { RemoteObject } from "../../../src/next/remote/remote-object.ts";
import { constant } from "../../../src/next/state/index.ts";
import type { Store } from "../../../src/next/store/index.ts";
import type { ChordStore } from "../../../src/next/store/store.ts";
import type { NativeWatchable, Watchable } from "../../../src/watch.ts";
import {
	changesOf,
	delivered,
	expectCollected,
	flushed,
	framesOf,
	instancesOf,
	loaded,
	memoryStore,
	Notes,
	rejection,
	settledHeap,
} from "../support.ts";

/** Every remote object bound while this file runs, weakly. */
const remoteObjects = instancesOf(RemoteObject, "hold");
const chordObjects = instancesOf(ChordObject, "attempt");

const Doc = defineState("doc", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });
const Counter = local("app.counter", { version: 1, params: {}, members: { doc: obj({ n: int() }), bump: method() } });
const Viewer = local("app.viewer", { version: 1, params: { id: int() }, members: { n: int() } });

/** A counter: one document, exposed, and a method that increments it. */
function serveCounter(self: Self) {
	const doc = self.state(Doc);
	return {
		doc,
		bump: async (ctx: typeof context) => {
			await doc.change((draft) => {
				draft.n++;
			}, ctx);
			return null;
		},
	};
}

describe("references", () => {
	it("are hydrated when got; their state members are watchables", async () => {
		const { host } = await loaded((h) => h.serve(Counter, (_, self) => serveCounter(self)));
		const counter = await host.get(Counter, {}, context);
		expect(counter.doc.value).toEqual({ n: 0 });
		const frames = framesOf(await counter.doc.watch(context));
		await counter.bump(context);
		await delivered();
		expect(frames).toEqual([[{ n: 1 }, [["s", ["n"], 1]]]]);
		expect(counter.doc.value).toEqual({ n: 1 });
	});

	it("throw released on every use after release, which is idempotent", async () => {
		const { host } = await loaded((h) => h.serve(Counter, (_, self) => serveCounter(self)));
		const counter = await host.get(Counter, {}, context);
		counter.release();
		counter.release();
		const released = { code: "released", message: "app.counter: released" };
		expect(() => counter.doc.value).toThrow("app.counter: released");
		expect(await rejection(counter.doc.watch(context))).toEqual(released);
		expect(await rejection(counter.bump(context))).toEqual(released);
	});

	it("end their watches when released, while other references keep the object", async () => {
		const { host } = await loaded((h) => h.serve(Counter, (_, self) => serveCounter(self)));
		const first = await host.get(Counter, {}, context);
		const second = await host.get(Counter, {}, context);
		const one = await first.doc.watch(context);
		const two = await second.doc.watch(context);
		first.release();
		expect(await one.closed).toEqual({ kind: "ended" });
		const frames = framesOf(two);
		await second.bump(context);
		await delivered();
		expect(frames.map(([value]) => value)).toEqual([{ n: 1 }]);
	});

	it("declared with self.get keep their object alive and are released when the declaring object ends", async () => {
		const Inner = local("app.inner", { version: 1, params: { id: int() }, members: { n: int() } });
		const inner = vi.fn(() => ({ n: constant(1) }));
		const { host } = await loaded((h) => {
			h.serve(Inner, inner);
			h.serve(Viewer, ({ id }, self) => ({ n: self.get(Inner, { id }).n }));
		});
		const viewer = await host.get(Viewer, { id: 1 }, context);
		const direct = await host.get(Inner, { id: 1 }, context);
		direct.release();
		expect(viewer.n.value).toBe(1);
		expect(inner).toHaveBeenCalledTimes(1);
		viewer.release();
		// The viewer's teardown releases its reference in the background.
		await flushed();
		await host.get(Inner, { id: 1 }, context);
		expect(inner).toHaveBeenCalledTimes(2);
	});
});

describe("cycles (Q5)", () => {
	const A = local("a", { version: 1, params: { n: int() }, members: { v: str() } });
	const B = local("b", { version: 1, params: { n: int() }, members: { v: str() } });
	const C = local("c", { version: 1, params: { n: int() }, members: { v: str() } });

	it("fail a two-object cycle with invalid/cycle and keep nothing", async () => {
		const factories = { a: vi.fn(), b: vi.fn() };
		const { host } = await loaded((h) => {
			h.serve(A, ({ n }, self) => {
				factories.a();
				return { v: self.get(B, { n }).v };
			});
			h.serve(B, ({ n }, self) => {
				factories.b();
				return { v: self.get(A, { n }).v };
			});
		});
		expect(await rejection(host.get(A, { n: 1 }, context))).toEqual({
			code: "invalid",
			reason: "cycle",
			message: "dependency cycle: a(1) → b(1) → a(1)",
		});
		await expect(host.get(A, { n: 1 }, context)).rejects.toThrow("dependency cycle");
		expect([factories.a.mock.calls.length, factories.b.mock.calls.length]).toEqual([2, 2]);
	});

	it("fail a three-object cycle", async () => {
		const { host } = await loaded((h) => {
			h.serve(A, ({ n }, self) => ({ v: self.get(B, { n }).v }));
			h.serve(B, ({ n }, self) => ({ v: self.get(C, { n }).v }));
			h.serve(C, ({ n }, self) => ({ v: self.get(A, { n }).v }));
		});
		expect(await rejection(host.get(A, { n: 1 }, context))).toMatchObject({
			message: "dependency cycle: a(1) → b(1) → c(1) → a(1)",
		});
	});

	it("fail an object that gets itself", async () => {
		const { host } = await loaded((h) => h.serve(A, ({ n }, self) => ({ v: self.get(A, { n }).v })));
		expect(await rejection(host.get(A, { n: 1 }, context))).toMatchObject({
			message: "dependency cycle: a(1) → a(1)",
		});
	});
});

describe("GC", () => {
	// AbortSignal.any keeps cleanup entries per call while its sources live before Node 24.16.0 (nodejs/node#62367): a
	// call's signal is linked to its reference and its attempt only until it settles.
	it.each([
		["without a caller's signal", () => context],
		["with a long-lived caller's signal", () => withAbortSignal(new AbortController().signal, context)],
	])("10,000 calls on one reference retain flat memory, %s", async (_case, caller) => {
		const { host } = await loaded((h) => h.serve(Counter, (_, self) => serveCounter(self)));
		const counter = await host.get(Counter, {}, context);
		const calls = caller();
		const run = async () => {
			for (let i = 0; i < 10_000; i++) await counter.bump(calls);
		};
		await run();
		const before = await settledHeap();
		await run();
		// The leak retained about 350 B per call; a document commit itself retains nothing.
		expect((await settledHeap()) - before).toBeLessThan(500_000);
	});

	it("a released reference keeps neither its contract nor its object", async () => {
		const objects: WeakRef<object>[] = [];
		const { host } = await loaded((h) =>
			h.serve(Viewer, ({ id }, self) => {
				objects.push(new WeakRef(self));
				return { n: constant(id) };
			}),
		);
		const { reference, contract } = await (async () => {
			// The caller's own declaration, equal to the served one.
			const Same = local("app.viewer", { version: 1, params: { id: int() }, members: { n: int() } });
			const reference = await host.get(Same, { id: 1 }, context);
			await reference.n.watch(context);
			reference.release();
			return { reference, contract: new WeakRef(Same) };
		})();
		await expectCollected(contract, ...objects);
		expect(() => reference.n.value).toThrow("app.viewer: released");
	});

	it("a released reference whose state was read keeps no host", async () => {
		const { reference, host } = await (async () => {
			const { host } = await loaded((h) => h.serve(Viewer, ({ id }) => ({ n: constant(id) })));
			const reference = await host.get(Viewer, { id: 1 }, context);
			expect(reference.state.value).toEqual({ kind: "live" });
			await (await reference.state.watch(context)).stop();
			reference.release();
			return { reference, host: new WeakRef(host) };
		})();
		await expectCollected(host);
		expect(reference.state.value).toMatchObject({ kind: "ended", error: { code: "released" } });
	});

	it("a released reference whose state was read after a failure keeps neither the failure's error nor the host", async () => {
		const { reference, refs } = await (async () => {
			const { host } = await loaded((h) =>
				h.serve(Viewer, (_, self) => {
					self.open(
						async () => {
							throw broken(new Error("no configuration"));
						},
						() => {},
					);
					return { n: constant(1) };
				}),
			);
			const reference = host.hold(Viewer, { id: 1 }, context);
			await flushed();
			const state = reference.state.value;
			if (state.kind !== "failed") throw new Error("expected a failure");
			const refs = [new WeakRef(state.cause.error), new WeakRef(host)];
			reference.release();
			return { reference, refs };
		})();
		await expectCollected(...refs);
		expect(reference.state.value).toMatchObject({ kind: "ended", error: { code: "released" } });
	});

	it("a hold released before load keeps nothing: the reference and its contract go while the host waits", async () => {
		const host = createHost({ onError: () => {} });
		const refs = (() => {
			const Same = local("app.viewer", { version: 1, params: { id: int() }, members: { n: int() } });
			const reference = host.hold(Same, { id: 1 }, context);
			reference.release();
			return [new WeakRef(reference), new WeakRef(Same)];
		})();
		await expectCollected(...refs);
		expect(host).toBeDefined();
	});

	it("a released hold keeps neither its object, nor its state's watches, nor a remote object without a link", async () => {
		const objects: WeakRef<object>[] = [];
		const { host } = await loaded((h) =>
			h.serve(Viewer, ({ id }, self) => {
				objects.push(new WeakRef(self));
				self.open(
					() => new Promise(() => {}),
					() => {},
				);
				return { n: constant(id) };
			}),
		);
		const client = createHost({ onError: () => {} });
		await client.load([], context);
		const { refs, held } = await (async () => {
			const made = remoteObjects.length;
			const local = host.hold(Viewer, { id: 1 }, context);
			const remote = client.hold(Notes, { session: "S1" }, context);
			const watches = [await local.state.watch(context), await remote.state.watch(context)];
			// A member watch waiting for the first value, and a parked call: both rejected by the release.
			const waits = [local.n.watch(context).catch(() => {}), remote.wait(context).catch(() => {})];
			local.release();
			remote.release();
			await Promise.all(waits);
			const refs = [...watches.map((watch) => new WeakRef(watch)), ...remoteObjects.slice(made)];
			return { refs, held: [local, remote] };
		})();
		await expectCollected(...objects, ...refs);
		expect(held).toHaveLength(2);
	});
});

describe("release", () => {
	it("rejects the calls made through the reference with released and aborts their handlers' contexts", async () => {
		const Slow = local("app.slow", { version: 1, params: {}, members: { wait: method() } });
		const aborted: unknown[] = [];
		const { host } = await loaded((h) =>
			h.serve(Slow, () => ({
				wait: (ctx) =>
					new Promise((resolve) =>
						ctx.abortSignal?.addEventListener("abort", () => {
							aborted.push(ctx.abortSignal?.reason);
							resolve(null);
						}),
					),
			})),
		);
		const first = await host.get(Slow, {}, context);
		const second = await host.get(Slow, {}, context);
		const pending = first.wait(context);
		const other = second.wait(context);
		first.release();
		expect(await rejection(pending)).toEqual({ code: "released", message: "app.slow: released" });
		expect(aborted).toHaveLength(1);
		second.release();
		await other.catch(() => {});
		expect(aborted).toHaveLength(2);
	});

	it("reads, watches and calls after the object ended carry the end's reason; the holder's own release has none", async () => {
		const Ended = local("app.ended", { version: 1, params: {}, members: { n: int(), m: method() } });
		const { host } = await loaded((h) => h.serve(Ended, () => ({ n: constant(1), m: async () => null })));
		const ended = await host.get(Ended, {}, context);
		const released = await host.get(Ended, {}, context);
		released.release();
		await host.close(context);
		const reasonOf = (error: unknown) => {
			const { code, reason } = error as ChordError;
			return `${code}/${reason}`;
		};
		const thrown = (read: () => unknown) => {
			try {
				read();
				return "no throw";
			} catch (error) {
				return reasonOf(error);
			}
		};
		expect([
			thrown(() => ended.n.value),
			reasonOf(await ended.n.watch(context).catch((error: unknown) => error)),
			reasonOf(await ended.m(context).catch((error: unknown) => error)),
		]).toEqual(["released/ended", "released/ended", "released/ended"]);
		expect(thrown(() => released.n.value)).toBe("released/undefined");
	});
});

describe("remote references", () => {
	it("have every member of every variant; variant is undefined before live and released after release", async () => {
		const Two = remote("app.two", {
			version: 1,
			params: {},
			variants: { full: { state: { n: int() }, methods: { bump: method() } }, view: { state: { m: int() } } },
		});
		const Holder = local("app.holder", { version: 1, params: {}, members: { n: int() } });
		const seen: unknown[] = [];
		const owner = { kind: "owner" } as const;
		const host = createHost<typeof owner>({ principal: owner, onError: () => {} });
		const facet = defineFacet<typeof owner>((h) => {
			h.serve(Two, () => ({ variant: "view", members: { m: constant(1) } }));
			h.serve(Holder, (_, self) => {
				const two = self.get(Two, {});
				seen.push(Object.keys(two).sort());
				seen.push(two.variant);
				return { n: constant(1) };
			});
		});
		await host.load([{ name: "@test/app", facet }], context);
		expect(seen).toEqual([["bump", "m", "n", "release", "retry", "state", "variant"], undefined]);
		const two = await host.get(Two, {}, context);
		expect(() => (two as unknown as { n: { value: number } }).n.value).toThrow(
			'app.two (variant view) has no state member "n"',
		);
		two.release();
		expect(() => two.variant).toThrow("app.two: released");
	});
});

describe("remote reference types", () => {
	it("narrow on variant; RefIn picks variants", () => {
		const Two = remote("app.two", {
			version: 1,
			params: {},
			variants: { full: { state: { n: int() }, methods: { bump: method() } }, view: { state: { m: int() } } },
		});
		type Ref = Reference<typeof Two>;
		expectTypeOf<Ref["variant"]>().toEqualTypeOf<"full" | "view">();
		expectTypeOf<RefIn<typeof Two, "view">["m"]["value"]>().toEqualTypeOf<number>();
		expectTypeOf<keyof RefIn<typeof Two, "full">>().toEqualTypeOf<
			"variant" | "n" | "bump" | "release" | "retry" | "state"
		>();
		expectTypeOf<Reference<typeof Counter>>().not.toHaveProperty("variant");
	});

	it("a held reference's variant may be undefined (before its first binding) and still narrows", () => {
		const Two = remote("app.two", {
			version: 1,
			params: {},
			variants: { full: { state: { n: int() }, methods: { bump: method() } }, view: { state: { m: int() } } },
		});
		expectTypeOf<Held<typeof Two>["variant"]>().toEqualTypeOf<"full" | "view" | undefined>();
		const narrow = (held: Held<typeof Two>) => (held.variant === "full" ? held.bump : undefined);
		expectTypeOf(narrow).returns.toEqualTypeOf<((ctx: Context) => Promise<null>) | undefined>();
		expectTypeOf<Held<typeof Counter>>().toEqualTypeOf<Reference<typeof Counter>>();
		expectTypeOf<Reference<typeof Two>["state"]>().toEqualTypeOf<NativeWatchable<RefState>>();
		expectTypeOf<Held<typeof Two>["retry"]>().toEqualTypeOf<() => void>();
	});
});

describe("keyed state members (slice 6a §12)", () => {
	const NoteSchema = obj({ title: str() });
	const Memo = defineState("memo", {
		schema: NoteSchema,
		version: 1,
		initial: () => ({ title: "" }),
		keyed: true,
	});
	const NoteStore = local("app.note-store", {
		version: 1,
		params: {},
		members: { notes: keyed(NoteSchema), write: method(obj({ id: str(), title: str() })), remove: method(str()) },
	});
	const Relay = local("app.relay", { version: 1, params: {}, members: { notes: keyed(NoteSchema) } });
	/** A view of note `id`; views of one note with another `copy` are other objects. */
	const NoteView = local("app.note-view", {
		version: 1,
		params: { id: str(), copy: int() },
		members: { note: NoteSchema },
	});

	/** Serves the store, a relay re-exposing its keyed member, and views pinning one key each; `memos()` is the store's. */
	async function notes(options: { readonly viewOf?: "store" | "relay" } = {}) {
		let memos: KeyedHandle<{ title: string }> | undefined;
		const pinned: Watchable<{ title: string }>[] = [];
		const refs: object[] = [];
		const { host, errors } = await loaded((h) => {
			h.serve(NoteStore, (_, self) => {
				memos = self.state(Memo);
				return {
					notes: memos,
					write: async ({ id, title }, ctx) => {
						await memos!.change(
							id,
							(draft) => {
								draft.title = title;
							},
							ctx,
						);
						return null;
					},
					remove: async (id, ctx) => {
						await memos!.retire(id, ctx);
						return null;
					},
				};
			});
			h.serve(Relay, (_, self) => ({ notes: self.get(NoteStore, {}).notes }));
			h.serve(NoteView, ({ id }, self) => {
				const source = options.viewOf === "relay" ? self.get(Relay, {}) : self.get(NoteStore, {});
				refs.push(source);
				const note = source.notes.at(id);
				pinned.push(note);
				return { note };
			});
		});
		const store = await host.get(NoteStore, {}, context);
		return { host, errors, store, memos: () => memos!, pinned, refs };
	}

	it("a consumer's at(key) is the provider's per-key source, loaded before it goes live; retirement carries the flag", async () => {
		const { host, store } = await notes();
		await store.write({ id: "a", title: "x" }, context);
		const view = await host.get(NoteView, { id: "a", copy: 1 }, context);
		expect(view.note.value).toEqual({ title: "x" });
		const changes = changesOf(await view.note.watch(context));
		await store.write({ id: "a", title: "y" }, context);
		await delivered();
		await store.remove("a", context);
		await delivered();
		expect(changes).toEqual([
			{ kind: "value", value: { title: "y" }, ops: [["s", ["title"], "y"]], retired: false },
			{ kind: "value", value: { title: "" }, ops: [["r", { title: "" }]], retired: true },
		]);
		view.release();
		await host.close(context);
	});

	it("two consumers of one key share one source and one pin; each hold is released once, with its reference", async () => {
		const { host, store, memos, pinned } = await notes();
		await store.write({ id: "a", title: "x" }, context);
		const first = await host.get(NoteView, { id: "a", copy: 1 }, context);
		const second = await host.get(NoteView, { id: "a", copy: 2 }, context);
		const slot = (memos() as unknown as { slot: { source(key: string): { pins: number } | undefined } }).slot;
		const [one, two] = pinned.map((at) => (at as unknown as { source: object }).source);
		// The store object's source of the key, which follows its attempts.
		expect(one).toBe(two);
		const shared = slot.source("a")!;
		expect(shared.pins).toBe(1);
		first.release();
		await flushed();
		expect(slot.source("a")).toBe(shared);
		second.release();
		await flushed();
		expect(slot.source("a")).toBeUndefined();
		await host.close(context);
	});

	it("a re-exposed keyed member resolves to the ultimate provider's source (no second tracker)", async () => {
		const { host, store, memos } = await notes({ viewOf: "relay" });
		await store.write({ id: "a", title: "x" }, context);
		const view = await host.get(NoteView, { id: "a", copy: 1 }, context);
		expect(view.note.value).toEqual({ title: "x" });
		const slot = (memos() as unknown as { slot: { source(key: string): { pins: number } | undefined } }).slot;
		// One pin on the ultimate slot, through the relay's key and the store's.
		expect(slot.source("a")!.pins).toBe(1);
		await store.write({ id: "a", title: "y" }, context);
		expect(view.note.value).toEqual({ title: "y" });
		await host.close(context);
	});

	it("ref.member.get and watch work anywhere; at(key) only in a factory", async () => {
		const { host, store } = await notes();
		expect(await store.notes.get("a", context)).toBeUndefined();
		expect(await store.notes.watch("a", context)).toBeUndefined();
		await store.write({ id: "a", title: "x" }, context);
		expect(await store.notes.get("a", context)).toEqual({ title: "x" });
		const watch = (await store.notes.watch("a", context))!;
		expect(watch.value).toEqual({ title: "x" });
		expect(() => store.notes.at("a")).toThrow("valid only in the factory");
		store.release();
		expect(await watch.closed).toEqual({ kind: "ended" });
		await host.close(context);
	});

	it("a watch(key) settling after its reference was released is ended at once with its pin; it rejects released", async () => {
		const { host, store, memos } = await notes();
		await store.write({ id: "a", title: "x" }, context);
		const slot = (memos() as unknown as { slot: { source(key: string): object | undefined } }).slot;
		const watching = store.notes.watch("a", context);
		// The slot's watch is underway: the release lands before the reference follows it.
		await Promise.resolve();
		await Promise.resolve();
		store.release();
		expect(await rejection(watching)).toMatchObject({ code: "released" });
		await flushed();
		expect(slot.source("a")).toBeUndefined();
		await host.close(context);
	});

	it("a retained released factory reference keeps no provider: its at(key) drops the source", async () => {
		const from = chordObjects.length;
		const { host, store, refs, pinned } = await notes();
		await store.write({ id: "a", title: "x" }, context);
		const view = await host.get(NoteView, { id: "a", copy: 1 }, context);
		view.release();
		store.release();
		await host.close(context);
		// The factory's reference and its at(key) are still held here (and by the host's factory).
		expect(refs).toHaveLength(1);
		await expectCollected(...chordObjects.slice(from));
		expect(() => (pinned[0] as unknown as { value: unknown }).value).toThrow("released");
	});

	/** Serves `NoteStore` over `definition` (persisted) on `store`, and views pinning one key each. */
	async function persistedNotes(store: Store, definition: ReturnType<typeof persistedMemo>) {
		return loaded(
			(h) => {
				h.serve(NoteStore, (_, self) => {
					const memos = self.state(definition);
					return {
						notes: memos,
						write: async ({ id, title }, ctx) => {
							await memos.change(
								id,
								(draft) => {
									draft.title = title;
								},
								ctx,
							);
							return null;
						},
						remove: async () => null,
					};
				});
				h.serve(NoteView, ({ id }, self) => ({ note: self.get(NoteStore, {}).notes.at(id) }));
			},
			{ store },
		);
	}

	/** A persisted keyed `memo` at `version`, whose `migrate` (from older versions) throws. */
	function persistedMemo(version: number) {
		return defineState("memo", {
			schema: NoteSchema,
			version,
			initial: () => ({ title: "" }),
			migrate: () => {
				throw new Error("cannot migrate");
			},
			keyed: true,
			persist: true,
			checkpointWhen: () => false,
		});
	}

	/** A store holding memo `a` = "x" at version 1, written by a host of its own. */
	async function seeded(): Promise<ChordStore> {
		const store = await memoryStore();
		const { host } = await persistedNotes(store, persistedMemo(1));
		await (await host.get(NoteStore, {}, context)).write({ id: "a", title: "x" }, context);
		await host.close(context);
		return store;
	}

	it("a persisted key a consumer pins is loaded from the store before the consumer goes live", async () => {
		const store = await seeded();
		const { host } = await persistedNotes(store, persistedMemo(1));
		const view = await host.get(NoteView, { id: "a", copy: 1 }, context);
		expect(view.note.value).toEqual({ title: "x" });
		await host.close(context);
		await store.close(context);
	});

	it("a pin load that fails its provider fails the consumer as a dependency failure (transient)", async () => {
		const store = await seeded();
		const { host, errors } = await persistedNotes(store, persistedMemo(2));
		const provider = await host.get(NoteStore, {}, context);
		const view = host.hold(NoteView, { id: "a", copy: 1 }, context);
		await vi.waitFor(() => expect(view.state.value.kind).toBe("failed"));
		expect(view.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "transient", error: { message: expect.stringContaining("cannot migrate") } },
		});
		expect(provider.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken" } });
		expect(errors.map(({ kind }) => kind)).toContain("object_failed");
		view.release();
		await host.close(context);
		await store.close(context);
	});

	it("a failed provider's ref.member.get rejects with the failure's cause", async () => {
		const store = await seeded();
		const { host } = await persistedNotes(store, persistedMemo(2));
		const provider = await host.get(NoteStore, {}, context);
		expect(await rejection(provider.notes.get("a", context))).toMatchObject({
			message: expect.stringContaining("cannot migrate"),
		});
		expect(await rejection(provider.notes.get("b", context))).toMatchObject({
			message: expect.stringContaining("cannot migrate"),
		});
		await host.close(context);
		await store.close(context);
	});

	it("a provider returning something else for a keyed member fails broken", async () => {
		const { host } = await loaded((h) => {
			// Plugin code returning a wrong value for the keyed member.
			h.serve(
				NoteStore,
				() => ({ notes: constant({}), write: async () => null, remove: async () => null }) as never,
			);
		});
		expect(await rejection(host.get(NoteStore, {}, context))).toMatchObject({
			message: expect.stringContaining("notes: a keyed member is a keyed document handle"),
		});
		await host.close(context);
	});
});
