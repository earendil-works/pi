// Tests of the keys a reference holds (slice 6a §12; decision "References are the only indirection" (4)): its key
// watches and factory pins of an object's keyed members, holding their last values while it is failed (one `failed`
// call), pinned again on its next instance once that is live (one frame), released once.

import { describe, expect, it, vi } from "vitest";
import { type Context, BACKGROUND_CONTEXT as context, withAbortSignal } from "../../../src/context/index.ts";
import { int, keyed, local, method, obj, str } from "../../../src/next/contracts/index.ts";
import { ChordError } from "../../../src/next/data/index.ts";
import { defineState, type KeyedHandle } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type Self } from "../../../src/next/host/index.ts";
import { ChordObject } from "../../../src/next/host/object.ts";
import {
	changesOf,
	delivered,
	expectCollected,
	failLive,
	flushed,
	holdNextCommit,
	instancesOf,
	loaded,
	memoryStore,
	valuesOf,
} from "../support.ts";

const attempted = instancesOf(ChordObject, "attempt");

type N = { n: number };
const Schema = obj({ n: int() });
const Notes = defineState("notes", { schema: Schema, version: 1, initial: () => ({ n: 0 }), keyed: true });
const Own = defineState("own", { schema: Schema, version: 1, initial: () => ({ n: 0 }) });
const Provider = local("app.provider", { version: 1, params: { id: str() }, members: { notes: keyed(Schema) } });
const Exposer = local("app.exposer", { version: 1, params: {}, members: { notes: keyed(Schema) } });
/** A viewer with params: it ends with its last reference (an object with empty params lives as long as its host). */
const Viewer = local("app.viewer", { version: 1, params: { id: int() }, members: { value: Schema, double: int() } });

/** Providers `a` and `b`, an exposer re-exposing provider `which()`'s notes, and a viewer of its key `k`. */
async function served(which: () => string) {
	const providers: Record<string, KeyedHandle<N>> = {};
	const exposers: Self[] = [];
	const { host } = await loaded((h) => {
		h.serve(Provider, ({ id }, self) => {
			const notes = self.state(Notes);
			providers[id] = notes;
			return { notes };
		});
		h.serve(Exposer, (_, self) => {
			exposers.push(self);
			self.state(Own);
			return { notes: self.get(Provider, { id: which() }).notes };
		});
		h.serve(Viewer, (_, self) => {
			const value = self.get(Exposer, {}).notes.at("k");
			return { value, double: self.derive([value], ([v]) => v.n * 2) };
		});
	});
	const a = await host.get(Provider, { id: "a" }, context);
	const b = await host.get(Provider, { id: "b" }, context);
	const set = (id: string, n: number) =>
		providers[id]!.change(
			"k",
			(draft) => {
				draft.n = n;
			},
			context,
		);
	await set("a", 1);
	await set("b", 2);
	const exposer = await host.get(Exposer, {}, context);
	const viewer = await host.get(Viewer, { id: 1 }, context);
	const fail = (): void =>
		failLive(attempted, exposers.at(-1)!, new ChordError({ code: "unavailable", message: "boom" }));
	return { host, a, b, exposer, viewer, set, fail, providers };
}

describe("a failed object's held keys", () => {
	it("keep their last values and get the failure once (at, watch, a derive over at); the provider goes on", async () => {
		const { host, a, exposer, viewer, set, fail } = await served(() => "a");
		const values = changesOf(await viewer.value.watch(context));
		const keyWatch = (await exposer.notes.watch("k", context))!;
		const keyed = changesOf(keyWatch);
		const direct = changesOf((await a.notes.watch("k", context))!);
		fail();
		await set("a", 3);
		await delivered();
		expect(exposer.state.value.kind).toBe("failed");
		expect([viewer.value.value, viewer.double.value, keyWatch.value]).toEqual([{ n: 1 }, 2, { n: 1 }]);
		expect([values, keyed].map((calls) => calls.map((call) => call.kind))).toEqual([["failed"], ["failed"]]);
		expect(valuesOf(direct)).toEqual([{ n: 3 }]);
		await host.close(context);
	});
});

describe("re-binding when a new attempt goes live", () => {
	it("pins again on the new instance's member of the same name (one frame); the old provider's pin is released", async () => {
		let which = "a";
		const { host, exposer, viewer, set, fail, providers } = await served(() => which);
		const values = changesOf(await viewer.value.watch(context));
		const doubles = changesOf(await viewer.double.watch(context));
		const keyWatch = (await exposer.notes.watch("k", context))!;
		const keyed = changesOf(keyWatch);
		const pins = (id: string) =>
			(providers[id] as unknown as { slot: { source(key: string): { pins: number } | undefined } }).slot.source("k")
				?.pins;
		expect(pins("a")).toBe(1);
		fail();
		// Its keys follow the failed instance until its admitted commits published (audit A10), then show the failure.
		await delivered();
		which = "b";
		exposer.retry();
		(await host.get(Exposer, {}, context)).release();
		await delivered();
		expect([viewer.value.value, viewer.double.value, keyWatch.value]).toEqual([{ n: 2 }, 4, { n: 2 }]);
		expect([pins("a"), pins("b")]).toEqual([undefined, 1]);
		await set("b", 4);
		await set("a", 5);
		await delivered();
		// The failure once, then whole values (the first after a failure is `[["r", value]]`).
		expect(valuesOf(values)).toEqual([{ failed: "boom" }, { n: 2 }, { n: 4 }]);
		expect(valuesOf(keyed)).toEqual([{ failed: "boom" }, { n: 2 }, { n: 4 }]);
		// A derive over the key reads its last value meanwhile: it does not fail.
		expect(valuesOf(doubles)).toEqual([4, 8]);
		await host.close(context);
	});

	it("loads a cold persisted key of the new member once the new instance is live (the last value meanwhile)", async () => {
		const Stored = defineState("notes", {
			schema: Schema,
			version: 1,
			initial: () => ({ n: 0 }),
			keyed: true,
			persist: true,
			checkpointWhen: () => false,
		});
		const Durable = local("app.durable", { version: 1, params: {}, members: { notes: keyed(Schema) } });
		const store = await memoryStore();
		let memos: KeyedHandle<N> | undefined;
		const serveDurable = (h: Parameters<Parameters<typeof loaded>[0]>[0]) =>
			h.serve(Durable, (_, self) => {
				memos = self.state(Stored);
				return { notes: memos };
			});
		const seed = await loaded(serveDurable, { store });
		await seed.host.get(Durable, {}, context);
		await memos!.change(
			"k",
			(draft) => {
				draft.n = 10;
			},
			context,
		);
		await seed.host.close(context);
		// A new host: the key is in the store only.
		let runs = 0;
		const exposers: Self[] = [];
		const { host } = await loaded(
			(h) => {
				h.serve(Provider, (_, self) => ({ notes: self.state(Notes) }));
				serveDurable(h);
				h.serve(Exposer, (_, self) => {
					exposers.push(self);
					self.state(Own);
					return { notes: ++runs === 1 ? self.get(Provider, { id: "a" }).notes : self.get(Durable, {}).notes };
				});
				h.serve(Viewer, (_, self) => {
					const value = self.get(Exposer, {}).notes.at("k");
					return { value, double: self.derive([value], ([v]) => v.n * 2) };
				});
			},
			{ store },
		);
		const exposer = await host.get(Exposer, {}, context);
		const viewer = await host.get(Viewer, { id: 1 }, context);
		failLive(attempted, exposers[0]!, new ChordError({ code: "unavailable", message: "boom" }));
		exposer.retry();
		(await host.get(Exposer, {}, context)).release();
		// The key loads from the store after the new instance went live: one frame then.
		await vi.waitFor(() => expect([viewer.value.value, viewer.double.value]).toEqual([{ n: 10 }, 20]));
		await host.close(context);
		await store.close(context);
	});
});

/** A provider with a persisted keyed state (empty params: a stable identity), whose keys a new host loads cold. */
const ColdProvider = local("app.cold-provider", { version: 1, params: {}, members: { notes: keyed(Schema) } });
/** A persisted keyed state whose keys a new host loads from the store. */
const Stored = defineState("notes", {
	schema: Schema,
	version: 1,
	initial: () => ({ n: 0 }),
	keyed: true,
	persist: true,
	checkpointWhen: () => false,
});

/** The pins on key `k` of a provider's notes (`undefined`: none). */
function pinsOf(notes: KeyedHandle<N>): number | undefined {
	// The handle's slot keeps the key's source while it is pinned.
	return (notes as unknown as { slot: { source(key: string): { pins: number } | undefined } }).slot.source("k")?.pins;
}

/**
 * Provider `a` (its key `k` in the store only, its loads held at `gate` once `hold()` is called) and `b` (in memory),
 * an exposer re-exposing `which()`'s notes, and a viewer of key `k`.
 */
async function cold(which: () => string) {
	const store = await memoryStore();
	let seeded: KeyedHandle<N> | undefined;
	const seed = await loaded(
		(h) =>
			h.serve(ColdProvider, (_, self) => {
				seeded = self.state(Stored);
				return { notes: seeded };
			}),
		{
			store,
		},
	);
	await seed.host.get(ColdProvider, {}, context);
	await seeded!.change(
		"k",
		(draft) => {
			draft.n = 1;
		},
		context,
	);
	await seed.host.close(context);
	// A new host: the key is in the store only.
	const providers: Record<string, KeyedHandle<N>> = {};
	const exposers: Self[] = [];
	const { host, errors } = await loaded(
		(h) => {
			h.serve(ColdProvider, (_, self) => {
				providers.a = self.state(Stored);
				return { notes: providers.a };
			});
			h.serve(Provider, ({ id }, self) => {
				providers[id] = self.state(Notes);
				return { notes: providers[id] };
			});
			h.serve(Exposer, (_, self) => {
				exposers.push(self);
				self.state(Own);
				const notes = which() === "a" ? self.get(ColdProvider, {}).notes : self.get(Provider, { id: "b" }).notes;
				return { notes };
			});
			h.serve(Viewer, (_, self) => {
				const value = self.get(Exposer, {}).notes.at("k");
				return { value, double: self.derive([value], ([v]) => v.n * 2) };
			});
		},
		{ store },
	);
	await host.get(ColdProvider, {}, context);
	await host.get(Provider, { id: "b" }, context);
	await providers.b!.change(
		"k",
		(draft) => {
			draft.n = 2;
		},
		context,
	);
	const exposer = await host.get(Exposer, {}, context);
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const hold = (): void => {
		// The slot's persistence reads cold keys from the store; the test holds the read open.
		const persistence = (providers.a as unknown as { slot: { persistence: { read(...args: unknown[]): unknown } } })
			.slot.persistence;
		const read = persistence.read.bind(persistence);
		persistence.read = async (...args: unknown[]) => {
			const result = await read(...args);
			entered.resolve();
			await gate.promise;
			return result;
		};
	};
	const fail = (): void =>
		failLive(attempted, exposers.at(-1)!, new ChordError({ code: "unavailable", message: "boom" }));
	const close = async (): Promise<void> => {
		await host.close(context);
		await store.close(context);
	};
	return { host, errors, exposer, providers, hold, gate, entered, fail, close };
}

describe("a key whose first pin still loads", () => {
	it("the object fails and re-binds meanwhile: the consumer retries on the new member, the late pin is released", async () => {
		let which = "a";
		const { host, errors, exposer, providers, hold, gate, entered, fail, close } = await cold(() => which);
		hold();
		const loading = host.get(Viewer, { id: 1 }, context);
		await entered.promise;
		fail();
		which = "b";
		exposer.retry();
		(await host.get(Exposer, {}, context)).release();
		gate.resolve();
		const viewer = await loading;
		await delivered();
		expect([viewer.value.value, viewer.double.value]).toEqual([{ n: 2 }, 4]);
		expect([pinsOf(providers.a!), pinsOf(providers.b!)]).toEqual([undefined, 1]);
		// The pin's failed load parked the viewer (a dependency failure is not its own): nothing failed it.
		expect(errors.filter((error) => error.kind === "activation_failed").length).toBe(0);
		const values = changesOf(await viewer.value.watch(context));
		await providers.a!.change(
			"k",
			(draft) => {
				draft.n = 3;
			},
			context,
		);
		await providers.b!.change(
			"k",
			(draft) => {
				draft.n = 4;
			},
			context,
		);
		await delivered();
		expect(valuesOf(values)).toEqual([{ n: 4 }]);
		await close();
	});

	it("the object fails and stays failed: the consumer parks failed { waiting } on it, never live on it", async () => {
		const { host, exposer, providers, hold, gate, entered, fail, close } = await cold(() => "a");
		hold();
		const abort = new AbortController();
		const viewer = host.hold(Viewer, { id: 1 }, context);
		const loading = host.get(Viewer, { id: 1 }, withAbortSignal(abort.signal, context));
		await entered.promise;
		fail();
		gate.resolve();
		await delivered();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(exposer.state.value.kind).toBe("failed");
		expect(viewer.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		viewer.release();
		abort.abort();
		await expect(loading).rejects.toThrow();
		expect(pinsOf(providers.a!)).toBeUndefined();
		await close();
	});

	it("the object ends meanwhile: the consumer's wait rejects, the late pin is released", async () => {
		const { host, providers, hold, gate, entered, close } = await cold(() => "a");
		hold();
		const loading = host.get(Viewer, { id: 1 }, context);
		await entered.promise;
		const closing = host.close(context);
		gate.resolve();
		await expect(loading).rejects.toThrow();
		await closing;
		expect(pinsOf(providers.a!)).toBeUndefined();
		await close();
	});
});

describe("a keyed watch whose object closes while it is set up", () => {
	it("rejects with the object's end error, whichever microtask the close lands in", async () => {
		for (let gap = 0; gap < 40; gap++) {
			let notes: KeyedHandle<N> | undefined;
			const { host } = await loaded((h) =>
				h.serve(Exposer, (_, self) => {
					notes = self.state(Notes);
					return { notes };
				}),
			);
			const exposer = await host.get(Exposer, {}, context);
			await notes!.change(
				"a",
				(draft) => {
					draft.n = 1;
				},
				context,
			);
			const watching = exposer.notes.watch("a", context).then(
				() => "watch",
				(error: unknown) => `${(error as ChordError).code}/${(error as ChordError).reason}`,
			);
			for (let turn = 0; turn < gap; turn++) await Promise.resolve();
			await host.close(context);
			expect(["watch", "released/ended"]).toContain(await watching);
		}
	});
});

describe("chains and releases", () => {
	it("a key re-exposed through two objects holds with the middle one (the failure once) and follows its next instance", async () => {
		const Outer = local("app.outer", { version: 1, params: {}, members: { notes: keyed(Schema) } });
		const OuterViewer = local("app.outer-viewer", { version: 1, params: {}, members: { value: Schema } });
		let which = "a";
		const middles: Self[] = [];
		const providers: Record<string, KeyedHandle<N>> = {};
		const { host } = await loaded((h) => {
			h.serve(Provider, ({ id }, self) => {
				const notes = self.state(Notes);
				providers[id] = notes;
				return { notes };
			});
			h.serve(Exposer, (_, self) => {
				middles.push(self);
				self.state(Own);
				return { notes: self.get(Provider, { id: which }).notes };
			});
			h.serve(Outer, (_, self) => ({ notes: self.get(Exposer, {}).notes }));
			h.serve(OuterViewer, (_, self) => ({ value: self.get(Outer, {}).notes.at("k") }));
		});
		for (const id of ["a", "b"]) {
			await host.get(Provider, { id }, context);
			await providers[id]!.change(
				"k",
				(draft) => {
					draft.n = id === "a" ? 1 : 2;
				},
				context,
			);
		}
		const middle = await host.get(Exposer, {}, context);
		const viewer = await host.get(OuterViewer, {}, context);
		const values = changesOf(await viewer.value.watch(context));
		failLive(attempted, middles[0]!, new ChordError({ code: "unavailable", message: "boom" }));
		await providers.a!.change(
			"k",
			(draft) => {
				draft.n = 3;
			},
			context,
		);
		await delivered();
		expect([viewer.value.value, values.map((call) => call.kind)]).toEqual([{ n: 1 }, ["failed"]]);
		which = "b";
		middle.retry();
		(await host.get(Exposer, {}, context)).release();
		await delivered();
		expect(viewer.value.value).toEqual({ n: 2 });
		expect(valuesOf(values)).toEqual([{ failed: "boom" }, { n: 2 }]);
		await host.close(context);
	});

	it("a consumer released while the object re-activates leaves no hold behind; nothing is kept for it", async () => {
		let which = "a";
		const refs = await (async () => {
			const { host, exposer, viewer, fail, providers } = await served(() => which);
			const pins = (id: string) =>
				(providers[id] as unknown as { slot: { source(key: string): { pins: number } | undefined } }).slot.source(
					"k",
				)?.pins;
			fail();
			which = "b";
			exposer.retry();
			viewer.release();
			(await host.get(Exposer, {}, context)).release();
			// The viewer's teardown releases its references.
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect([pins("a"), pins("b")]).toEqual([undefined, undefined]);
			const kept = [new WeakRef(viewer), new WeakRef(providers.a!)];
			await host.close(context);
			return kept;
		})();
		await expectCollected(...refs);
	});
});

describe("a key whose first pin still loads at startup (scenario 20, Astra)", () => {
	it("keeps the first pass pending during an otherwise-ready dependency's delayed keyed pin", async () => {
		const Data = defineState("app.pin-data", {
			schema: Schema,
			version: 1,
			keyed: true,
			initial: () => ({ n: 4 }),
		});
		const Store = local("app.pin-store", { version: 1, params: {}, members: { notes: keyed(Schema) } });
		const Reader = local("app.pin-reader", { version: 1, params: {}, members: { value: Schema } });
		const gate = Promise.withResolvers<void>();
		const original = ChordObject.prototype.pinKey;
		const spy = vi.spyOn(ChordObject.prototype, "pinKey").mockImplementation(async function (
			this: ChordObject,
			member,
			key,
			version,
			ctx,
		) {
			await gate.promise;
			return original.call(this, member, key, version, ctx);
		});
		const host = createHost({ onError: () => {} });
		let done = false;
		const loading = host
			.load(
				[
					{
						name: "@test/pin",
						facet: defineFacet((h) => {
							h.serve(Store, (_, self) => ({ notes: self.state(Data) }));
							h.serve(Reader, (_, self) => ({ value: self.get(Store, {}).notes.at("k") }));
						}),
					},
				],
				context,
			)
			.then(() => {
				done = true;
			});
		await flushed();
		const premature = done;
		gate.resolve();
		await loading;
		spy.mockRestore();
		const ref = await host.get(Reader, {}, context);
		expect(ref.value.value).toEqual({ n: 4 });
		await host.close(context);
		expect(premature).toBe(false);
	});
});

describe("a released key leaves its document (final review)", () => {
	it("collects a reference whose key watch stopped while another reference pins the same key (Astra)", async () => {
		const Rows = defineState("rows", {
			version: 1,
			schema: obj({ n: int() }),
			initial: () => ({ n: 1 }),
			keyed: true,
		});
		const Type = local("app.key-gc", {
			version: 1,
			params: {},
			members: { rows: keyed(obj({ n: int() })), set: method() },
		});
		const facet = defineFacet((h) =>
			h.serve(Type, (_, self) => {
				const rows = self.state(Rows);
				const set = async (ctx: Context) => {
					await rows.change(
						"a",
						(draft) => {
							draft.n = 2;
						},
						ctx,
					);
					return null;
				};
				return { rows, set };
			}),
		);
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@app/key-gc", facet }], context);
		const keeper = await host.get(Type, {}, context);
		await keeper.set(context);
		const kept = (await keeper.rows.watch("a", context))!;
		kept.start(async () => {});
		const released = await (async () => {
			const ref = await host.get(Type, {}, context);
			const watch = (await ref.rows.watch("a", context))!;
			watch.start(async () => {});
			await watch.stop();
			ref.release();
			return new WeakRef(ref);
		})();
		await flushed();
		await expectCollected(released);
		await kept.stop();
		keeper.release();
		await host.close(context);
	});
});

describe("keys across a restart and a failed re-pin (Astra's coverage note)", () => {
	const Keys = local("app.keys", { version: 1, params: {}, members: { notes: keyed(Schema) } });

	/** Serves `Keys` over the persisted `Stored` (its handle kept in `handles`), with a native opened by `open`. */
	const serveKeys = (handles: KeyedHandle<N>[], open: () => Promise<void>) =>
		defineFacet((h) =>
			h.serve(Keys, (_, self) => {
				self.open(open, () => {});
				const notes = self.state(Stored);
				handles.push(notes);
				return { notes };
			}),
		);

	it("a commit admitted to a watched key, landing after a restart's drain, is in the key's last value", async () => {
		const store = await memoryStore();
		const handles: KeyedHandle<N>[] = [];
		const host = createHost({ store, onError: () => {} });
		await host.load([{ name: "@test/app", facet: serveKeys(handles, async () => {}) }], context);
		const keys = await host.get(Keys, {}, context);
		const change = (n: number) =>
			handles.at(-1)!.change(
				"k",
				(draft) => {
					draft.n = n;
				},
				context,
			);
		await change(1);
		const watch = (await keys.notes.watch("k", context))!;
		const calls = changesOf(watch);
		const held = holdNextCommit(store);
		const admitted = change(5);
		await held.entered;
		// The new code's native stays opening: the new instance is not live while the key holds its last value.
		const opening = Promise.withResolvers<void>();
		const reloading = host.reload([{ name: "@test/app", facet: serveKeys(handles, () => opening.promise) }], context);
		await delivered();
		held.release();
		await admitted;
		await reloading;
		await delivered();
		expect([watch.value, valuesOf(calls)]).toEqual([{ n: 5 }, [{ n: 5 }]]);
		opening.resolve();
		await vi.waitFor(() => expect(keys.state.value).toEqual({ kind: "live" }));
		expect(watch.value).toEqual({ n: 5 });
		await host.close(context);
		await store.close(context);
	});

	it("a key's re-pin on a new instance that fails to load keeps its last value, one failed call; the next pin heals it", async () => {
		const store = await memoryStore();
		const seeded: KeyedHandle<N>[] = [];
		const seed = createHost({ store, onError: () => {} });
		await seed.load([{ name: "@test/app", facet: serveKeys(seeded, async () => {}) }], context);
		await seed.get(Keys, {}, context);
		await seeded[0]!.change(
			"k",
			(draft) => {
				draft.n = 1;
			},
			context,
		);
		await seed.close(context);
		// A new host: `Keys`' key is in the store only; the exposer re-exposes provider `b` (in memory) first.
		const handles: KeyedHandle<N>[] = [];
		let b: KeyedHandle<N> | undefined;
		const providers = defineFacet((h) => {
			h.serve(Keys, (_, self) => {
				const notes = self.state(Stored);
				handles.push(notes);
				return { notes };
			});
			h.serve(Provider, (_, self) => {
				b = self.state(Notes);
				return { notes: b };
			});
		});
		const exposing = (which: "keys" | "b") =>
			defineFacet((h) =>
				h.serve(Exposer, (_, self) => {
					self.state(Own);
					const notes = which === "keys" ? self.get(Keys, {}).notes : self.get(Provider, { id: "b" }).notes;
					return { notes };
				}),
			);
		const host = createHost({ store, onError: () => {} });
		await host.load(
			[
				{ name: "@test/providers", facet: providers },
				{ name: "@test/exposer", facet: exposing("b") },
			],
			context,
		);
		await host.get(Provider, { id: "b" }, context);
		await b!.change(
			"k",
			(draft) => {
				draft.n = 2;
			},
			context,
		);
		const exposer = await host.get(Exposer, {}, context);
		const watch = (await exposer.notes.watch("k", context))!;
		const calls = changesOf(watch);
		// The cold provider's next read of the key fails once.
		const persistence = (handles[0] as unknown as { slot: { persistence: { read(...args: unknown[]): unknown } } })
			.slot.persistence;
		const read = persistence.read.bind(persistence);
		persistence.read = async () => {
			persistence.read = read;
			throw new Error("disk");
		};
		// A swap in place: the new instance re-exposes the cold provider's notes; the key's pin there fails to load.
		await host.reload(
			[
				{ name: "@test/providers", facet: providers },
				{ name: "@test/exposer", facet: exposing("keys") },
			],
			context,
		);
		await flushed();
		expect(exposer.state.value).toEqual({ kind: "live" });
		expect([watch.value, valuesOf(calls)]).toEqual([{ n: 2 }, [{ failed: expect.stringContaining("disk") }]]);
		// The next instance pins it again, loaded this time: one frame heals it.
		await host.reload(
			[
				{ name: "@test/providers", facet: providers },
				{ name: "@test/exposer", facet: exposing("keys") },
			],
			context,
		);
		await vi.waitFor(() => expect(watch.value).toEqual({ n: 1 }));
		expect(valuesOf(calls)).toEqual([{ failed: expect.stringContaining("disk") }, { n: 1 }]);
		await host.close(context);
		await store.close(context);
	});
});
