// Tests of keyed members across attempts (slice 6a §1.2, §1.4, §12): the keys references hold on an object's keyed
// members, frozen while it is failed, re-bound by name (loaded first) when its next attempt goes live, released once.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "../../../src/context/index.ts";
import { int, keyed, local, obj, str } from "../../../src/next/contracts/index.ts";
import { ChordError } from "../../../src/next/data/index.ts";
import { defineState, type KeyedHandle } from "../../../src/next/documents/index.ts";
import type { Self } from "../../../src/next/host/index.ts";
import { ChordObject } from "../../../src/next/host/object.ts";
import {
	changesOf,
	delivered,
	expectCollected,
	failLive,
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
	it("keep their last values and get no frames (at, watch, a derive over at); the provider goes on", async () => {
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
		expect([values, keyed]).toEqual([[], []]);
		expect(valuesOf(direct)).toEqual([{ n: 3 }]);
		await host.close(context);
	});
});

describe("re-binding when a new attempt goes live", () => {
	it("follows the new attempt's member of the same name (one frame); the old provider's pin is released", async () => {
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
		which = "b";
		exposer.retry();
		(await host.get(Exposer, {}, context)).release();
		await delivered();
		expect([viewer.value.value, viewer.double.value, keyWatch.value]).toEqual([{ n: 2 }, 4, { n: 2 }]);
		expect([pins("a"), pins("b")]).toEqual([undefined, 1]);
		await set("b", 4);
		await set("a", 5);
		await delivered();
		expect(valuesOf(values)).toEqual([{ n: 2 }, { n: 4 }]);
		expect(valuesOf(keyed)).toEqual([{ n: 2 }, { n: 4 }]);
		expect(valuesOf(doubles)).toEqual([4, 8]);
		await host.close(context);
	});

	it("loads a cold persisted key of the new member before the new attempt goes live", async () => {
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
		expect([viewer.value.value, viewer.double.value]).toEqual([{ n: 10 }, 20]);
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
		expect(errors.filter((error) => error.kind === "activation_failed").length).toBe(1);
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

	it("the object fails and stays failed: the consumer's activation fails transient, never live on it", async () => {
		const { host, errors, exposer, providers, hold, gate, entered, fail, close } = await cold(() => "a");
		hold();
		const abort = new AbortController();
		const loading = host.get(Viewer, { id: 1 }, withAbortSignal(abort.signal, context));
		await entered.promise;
		fail();
		gate.resolve();
		await delivered();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(exposer.state.value.kind).toBe("failed");
		const failure = errors.find((error) => error.kind === "activation_failed");
		expect(failure).toMatchObject({ failure: { kind: "transient" } });
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
	it("a key re-exposed through two objects freezes with the middle one and follows its next attempt", async () => {
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
		expect([viewer.value.value, values]).toEqual([{ n: 1 }, []]);
		which = "b";
		middle.retry();
		(await host.get(Exposer, {}, context)).release();
		await delivered();
		expect(viewer.value.value).toEqual({ n: 2 });
		expect(valuesOf(values)).toEqual([{ n: 2 }]);
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
