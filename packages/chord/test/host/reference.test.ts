import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
	BACKGROUND_CONTEXT,
	type Context,
	BACKGROUND_CONTEXT as context,
	withAbortSignal,
} from "../../src/context/index.ts";
import { arr, evolve, grantable, int, keyed, local, method, obj, remote, str } from "../../src/contracts/index.ts";
import { broken, type ChordError } from "../../src/data/index.ts";
import { defineState, type KeyedHandle } from "../../src/documents/index.ts";
import {
	allow,
	createHost,
	defineFacet,
	type FacetHost,
	type Reference,
	type RefState,
	type Self,
} from "../../src/host/index.ts";
import { ChordObject } from "../../src/host/object.ts";
import { Binding } from "../../src/host/reference.ts";
import { jsonPart } from "../../src/link/internal.ts";
import { RemoteObject } from "../../src/remote/remote-object.ts";
import { constant } from "../../src/state/index.ts";
import type { Store } from "../../src/store/index.ts";
import type { ChordStore } from "../../src/store/store.ts";
import type { NativeWatchable, Watchable } from "../../src/watch.ts";
import {
	bindHold,
	bindNext,
	changesOf,
	Desk,
	delivered,
	desk,
	EDITOR,
	expectCollected,
	flagLabel,
	flushed,
	framesOf,
	instancesOf,
	linked,
	loaded,
	memoryStore,
	Notes,
	rawProvider,
	rejection,
	Server,
	settledHeap,
	statesOf,
	type TestPrincipal,
	valuesOf,
	waitLive,
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

	it("a hold released while it waits unbound keeps nothing: the reference and its contract leave the index and its clock", async () => {
		const host = createHost({ onError: () => {} });
		await host.load([], context);
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
	it("have the plain members always and the grantable ones while granted; granted is empty before live, released after", async () => {
		const Two = remote("app.two", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			state: { n: grantable(int()), m: int() },
			methods: { bump: grantable(method()) },
			flags: { export: flagLabel("export") },
		});
		const Holder = local("app.holder", { version: 1, params: {}, members: { n: int() } });
		const seen: unknown[] = [];
		const owner = { kind: "owner" } as const;
		const host = createHost<typeof owner>({ address: Server(), principal: owner, onError: () => {} });
		const facet = defineFacet<typeof owner>((h) => {
			h.serve(Two, () => ({ n: () => constant(0), m: constant(1), bump: async () => null }), {
				admit: () => constant(allow({ granted: ["export"] })),
			});
			h.serve(Holder, (_, self) => {
				const two = self.get(Two, {});
				seen.push(Object.keys(two).sort());
				// In a factory the dependency is not bound yet: every member is there, nothing granted (slice 15 §1.4).
				seen.push([typeof two.n, typeof two.bump, [...two.granted]]);
				return { n: constant(1) };
			});
		});
		await host.load([{ name: "@test/app", facet }], context);
		expect(seen).toEqual([
			["bump", "granted", "m", "n", "release", "retry", "state"],
			["object", "function", []],
		]);
		const two = await host.get(Two, {}, context);
		expect([two.n, two.bump, [...two.granted], two.m.value]).toEqual([undefined, undefined, ["export"], 1]);
		two.release();
		expect(() => two.granted).toThrow("app.two: released");
		expect(() => two.n).toThrow("app.two: released");
	});
});

describe('a binding moved by a retry alone (decision "References share one wire hold")', () => {
	it("keeps its reference, member handles, state watch and member watch; the sibling it leaves stays failed", async () => {
		const { client, peer } = await rawProvider({ limits: { part: 64 } });
		const a = client.hold(Notes, { session: "S1" }, context);
		const b = client.hold(Notes, { session: "S1" }, context);
		const hold = await bindNext(peer);
		await waitLive(a);
		const member = a.count;
		const states = statesOf(await a.state.watch(context));
		const counts = changesOf(await a.count.watch(context));
		const ops = jsonPart([["r", [{ text: "x".repeat(100) }]]]);
		peer.send({
			kind: "state",
			holds: [{ hold, members: [{ member: EDITOR.state.notes!, ops }], failed: [], retired: [] }],
		});
		await delivered();
		a.retry();
		const { hold: own } = await peer.next("hold");
		bindHold(peer, own, [{ text: "a" }]);
		await waitLive(a);
		await delivered();
		expect([a.count, a.count.value, b.state.value.kind]).toEqual([member, 1, "failed"]);
		expect(states.map((state) => state.replace(/:.*/, ""))).toEqual(["failed", "loading", "live"]);
		expect(valuesOf(counts)).toEqual([{ failed: expect.stringContaining("over the wire limit") }, 1]);
		a.release();
		b.release();
	});
});

describe("remote reference types (slice 15 §1.4)", () => {
	const Two = remote("app.two", {
		version: 1,
		params: {},
		hostAddress: () => Server(),
		state: { n: grantable(int()), m: int() },
		methods: { bump: grantable(method()), read: method() },
		flags: { export: flagLabel("export") },
	});

	it("have the plain members, the grantable ones optional, and granted", () => {
		type Ref = Reference<typeof Two>;
		expectTypeOf<Ref["m"]["value"]>().toEqualTypeOf<number>();
		expectTypeOf<Ref["n"]>().toEqualTypeOf<Watchable<number> | undefined>();
		expectTypeOf<Ref["bump"]>().toEqualTypeOf<((ctx: Context) => Promise<null>) | undefined>();
		expectTypeOf<Ref["read"]>().toEqualTypeOf<(ctx: Context) => Promise<null>>();
		expectTypeOf<Ref["granted"]>().toEqualTypeOf<ReadonlySet<"n" | "bump" | "export">>();
		expectTypeOf<keyof Ref>().toEqualTypeOf<
			"n" | "m" | "bump" | "read" | "granted" | "release" | "retry" | "state"
		>();
		expectTypeOf<Reference<typeof Counter>>().not.toHaveProperty("granted");
		expectTypeOf<Ref["state"]>().toEqualTypeOf<NativeWatchable<RefState>>();
		expectTypeOf<Ref["retry"]>().toEqualTypeOf<() => void>();
	});

	it("refuse a call of a grantable method without a check", () => {
		const call = (ref: Reference<typeof Two>) => {
			// @ts-expect-error: `bump` may not be granted
			void ref.bump(BACKGROUND_CONTEXT);
			if (ref.bump !== undefined) void ref.bump(BACKGROUND_CONTEXT);
			void ref.read(BACKGROUND_CONTEXT);
		};
		expectTypeOf(call).toBeFunction();
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

	it("two consumers of one key each hold their own pin (references own their keys); each released once, with its reference", async () => {
		const { host, store, memos, pinned } = await notes();
		await store.write({ id: "a", title: "x" }, context);
		const first = await host.get(NoteView, { id: "a", copy: 1 }, context);
		const second = await host.get(NoteView, { id: "a", copy: 2 }, context);
		const slot = (memos() as unknown as { slot: { source(key: string): { pins: number } | undefined } }).slot;
		const [one, two] = pinned.map((at) => (at as unknown as { source: object }).source);
		// Each reference's own source of the key, on the store's instance (decision "References are the only indirection").
		expect(one).not.toBe(two);
		const shared = slot.source("a")!;
		expect(shared.pins).toBe(2);
		first.release();
		await flushed();
		expect([slot.source("a"), shared.pins]).toEqual([shared, 1]);
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

	it("a pin load that fails its provider parks the consumer failed { waiting } on it (a dependency failure)", async () => {
		const store = await seeded();
		const { host, errors } = await persistedNotes(store, persistedMemo(2));
		const provider = await host.get(NoteStore, {}, context);
		const view = host.hold(NoteView, { id: "a", copy: 1 }, context);
		await vi.waitFor(() => expect(view.state.value.kind).toBe("failed"));
		expect(view.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: { message: expect.stringContaining("cannot migrate") } },
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

describe("a binding released while it binds (fix round 5)", () => {
	it("ends cleanly when its object's hold releases it at once, keeping nothing (Sol)", async () => {
		const Type = local("app.reentrant", { version: 1, params: {}, members: { x: int() } });
		const facet = defineFacet((h) => h.serve(Type, () => ({ x: constant(1) })));
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@app/reentrant", facet }], context);
		let ref = await host.get(Type, {}, context);
		const released = new WeakRef(ref);
		// The type is removed: the reference waits, with its last values.
		await host.reload([], context);
		const bind = Binding.prototype.bind;
		const failures: unknown[] = [];
		const binding = vi.spyOn(Binding.prototype, "bind").mockImplementation(function (this: Binding, target) {
			try {
				bind.call(this, target);
			} catch (error) {
				failures.push(error);
				throw error;
			}
		});
		// `ChordObject.hold` lets a presence derive release a holder synchronously: the binding ends inside its bind.
		const hold = ChordObject.prototype.hold;
		const holding = vi.spyOn(ChordObject.prototype, "hold").mockImplementation(function (this: ChordObject, holder) {
			hold.call(this, holder);
			ref.release();
		});
		try {
			await host.reload([{ name: "@app/reentrant", facet }], context);
			expect(holding).toHaveBeenCalledOnce();
		} finally {
			holding.mockRestore();
			binding.mockRestore();
		}
		expect(failures).toEqual([]);
		expect(ref.state.value.kind).toBe("ended");
		ref = undefined as never;
		await expectCollected(released);
		await host.close(context);
	});
});

describe("a reference's grant while it waits (review round 1, Astra 5)", () => {
	const Board = remote("test.waiting-board", {
		version: 1,
		params: {},
		hostAddress: () => Server(),
		state: { title: str(), history: grantable(arr(str())) },
	});
	/** The board's plugin, granting every holder `granted`. */
	const serving = (granted: "history"[]) =>
		defineFacet((h) =>
			h.serve(Board, () => ({ title: constant("t"), history: () => constant(["a"]) }), {
				admit: () => constant(allow({ granted })),
			}),
		);

	it("keeps its last grant and its members while its provider is removed; a new binding replaces the grant", async () => {
		const host = createHost({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		await host.load([{ name: "@test/board", facet: serving(["history"]) }], context);
		const board = await host.get(Board, {}, context);
		expect(board.history?.value).toEqual(["a"]);
		await host.reload([], context);
		await flushed();
		expect(board.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		// Waiting, it keeps its grant with its values: `history` is still there, with its last value.
		expect([...board.granted]).toEqual(["history"]);
		expect(board.history?.value).toEqual(["a"]);
		await host.reload([{ name: "@test/board", facet: serving([]) }], context);
		await waitLive(board);
		expect([board.granted.size, board.history]).toEqual([0, undefined]);
		await host.close(context);
	});
});

describe("a reference's grant (review round 2, Sol 1 and 4)", () => {
	it("a first denial removes the grantable members it showed while it loaded", async () => {
		const { client, server, admit } = await desk();
		await admit("none");
		const held = client.hold(Desk, {}, context);
		// Loading: every grantable member is there, its calls park until the binding decides.
		expect(held.write).toBeDefined();
		await expect.poll(() => held.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		expect([[...held.granted], held.write]).toEqual([[], undefined]);
		await client.close(context);
		await server.close(context);
	});

	it("an older consumer on the same host is granted only the names its version declares", async () => {
		const V1 = remote("test.versions", {
			version: 1,
			params: {},
			hostAddress: Server,
			methods: { first: grantable(method()) },
		});
		const V2 = evolve(V1, (e) => e.addMethod("second", grantable(method())));
		const host = createHost({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		const facet = defineFacet((h) =>
			h.serve(V2, () => ({ first: async () => null, second: async () => null }), {
				admit: () => constant(allow({ granted: ["first", "second"] })),
				accepts: { 1: {} },
			}),
		);
		await host.load([{ name: "test", facet }], context);
		const older = await host.get(V1, {}, context);
		expect([...older.granted]).toEqual(["first"]);
		await host.close(context);
	});

	// Found by the review of the pass (first reviewer, 2026-11-26): the projection tested the names twice once one was missing.
	it("an older consumer's grant keeps the target's order without the names it lacks; a current one's is the target's set", async () => {
		const V1 = remote("test.versions-order", {
			version: 1,
			params: {},
			hostAddress: Server,
			methods: { a: grantable(method()), c: grantable(method()), e: grantable(method()) },
		});
		const V2 = evolve(V1, (e) => e.addMethod("b", grantable(method())).addMethod("d", grantable(method())));
		const host = createHost({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		const run = async () => null;
		const facet = defineFacet((h) =>
			h.serve(V2, () => ({ a: run, b: run, c: run, d: run, e: run }), {
				admit: () => constant(allow({ granted: ["e", "d", "c", "b", "a"] })),
				accepts: { 1: {} },
			}),
		);
		await host.load([{ name: "test", facet }], context);
		const [current, other, older] = [
			await host.get(V2, {}, context),
			await host.get(V2, {}, context),
			await host.get(V1, {}, context),
		];
		expect([[...current.granted], [...older.granted]]).toEqual([
			["a", "b", "c", "d", "e"],
			["a", "c", "e"],
		]);
		expect([current.granted === other.granted, older.granted === current.granted]).toEqual([true, false]);
		await host.close(context);
	});

	it("keeps its last grant while a replacement provider loads; the grant it binds live with replaces it", async () => {
		const Counter = remote("test.counter", {
			version: 1,
			params: {},
			hostAddress: Server,
			state: { number: grantable(str()) },
		});
		const host = createHost({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const granting = defineFacet((h) =>
			h.serve(Counter, () => ({ number: () => constant("one") }), {
				admit: () => constant(allow({ granted: ["number"] })),
			}),
		);
		// The replacement grants nothing, and opens a native that waits for the gate.
		const replacement = defineFacet((h) =>
			h.serve(
				Counter,
				(_params, _principal, _admitted, self) => {
					self.open(
						async () => {
							started.resolve();
							await gate.promise;
						},
						() => {},
					);
					return { number: () => constant("two") };
				},
				{ admit: () => constant(allow({})) },
			),
		);
		await host.load([{ name: "test", facet: granting }], context);
		const ref = await host.get(Counter, {}, context);
		await host.reload([], context);
		expect([...ref.granted]).toEqual(["number"]);
		await host.reload([{ name: "test", facet: replacement }], context);
		await started.promise;
		expect([ref.state.value.kind, [...ref.granted], ref.number?.value]).toEqual(["loading", ["number"], "one"]);
		gate.resolve();
		await expect.poll(() => ref.state.value.kind).toBe("live");
		expect([[...ref.granted], ref.number]).toEqual([[], undefined]);
		await host.close(context);
	});
});

describe("a reference's grant is its own binding's (review round 2, granttest F4)", () => {
	const Flagged = remote("test.flagged", {
		version: 1,
		params: {},
		hostAddress: Server,
		state: { s0: grantable(str()) },
		flags: { f0: flagLabel("f0") },
	});
	const serveFlagged = (h: FacetHost<TestPrincipal>): void =>
		h.serve(Flagged, () => ({ s0: () => constant("s0") }), {
			admit: () => constant(allow({ granted: ["f0", "s0"] })),
		});

	it("one made while its link is down joins the shared hold without its grant (F4a)", async () => {
		const { server, client, links } = await linked(serveFlagged);
		const first = client.hold(Flagged, {}, context);
		await waitLive(first);
		expect([...first.granted]).toEqual(["f0", "s0"]);
		links[1].close();
		await expect.poll(() => first.state.value.kind).toBe("loading");
		const second = client.hold(Flagged, {}, context);
		expect([second.state.value.kind, [...second.granted]]).toEqual(["loading", []]);
		await client.close(context);
		await server.close(context);
	});

	it("one on the provider's host refused at its version has none of the object's grant (F4b)", async () => {
		const Tick = obj({ y: int() });
		const V1 = remote("test.ticks", {
			version: 1,
			params: {},
			hostAddress: Server,
			state: { s1: grantable(str()) },
			events: { e0: Tick },
		});
		const V2 = evolve(V1, (e) => e.event("e0", obj({ y: str() })));
		const host = createHost({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		const facet = defineFacet((h) =>
			h.serve(V2, (_p, _principal, _admitted, self) => ({ s1: () => constant("s1"), e0: self.events() }), {
				admit: () => constant(allow({ granted: ["s1"] })),
				accepts: { 1: { events: { e0: "refuse" } } },
			}),
		);
		await host.load([{ name: "test", facet }], context);
		const current = await host.get(V2, {}, context);
		const older = host.hold(V1, {}, context);
		await expect.poll(() => older.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		expect([[...current.granted], [...older.granted]]).toEqual([["s1"], []]);
		await host.close(context);
	});
});
