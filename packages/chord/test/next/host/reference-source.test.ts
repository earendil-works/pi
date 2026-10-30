// Tests of a reference's members (`ReferenceSource`; slice 6a §1.2, §1.4; decision "References are the only
// indirection"): consumers' watches and derives over `ref.member` pass straight through to the instance's member while
// live, keep the last value while it points at nothing (one `failed` call for a failure), move by name to the next
// instance (one frame, whole after a failure).

import { describe, expect, it } from "vitest";
import { type Context, BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { arr, int, keyed, local, method, obj, remote, str } from "../../../src/next/contracts/index.ts";
import { ChordError } from "../../../src/next/data/index.ts";
import { defineState, type SingletonHandle } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type Reference, type Self, type StoreSelf } from "../../../src/next/host/index.ts";
import { ChordObject } from "../../../src/next/host/object.ts";
import { resolveWatchable } from "../../../src/next/host/reference.ts";
import { constant } from "../../../src/next/state/index.ts";
import type { Source, Subscriber } from "../../../src/next/state/internal.ts";
import {
	changesOf,
	delivered,
	expectCollected,
	failLive,
	flushed,
	holdNextCommit,
	instancesOf,
	linked,
	loaded,
	memoryStore,
	metered,
	Server,
	transported,
	valuesOf,
} from "../support.ts";

const attempted = instancesOf(ChordObject, "attempt");

const List = defineState("list", { schema: obj({ items: arr(str()) }), version: 1, initial: () => ({ items: [] }) });
const Store = local("app.store", {
	version: 1,
	params: {},
	members: { list: obj({ items: arr(str()) }), count: int(), add: method(obj({ text: str() })) },
});
const Viewer = local("app.count-viewer", { version: 1, params: {}, members: { tens: int() } });

/** Serves `Store` (a list, its count, `add`) and `Viewer` (a derive over the store's count); `attempts` are the store's. */
async function served(options: Parameters<typeof loaded>[1] = {}) {
	const attempts: Self[] = [];
	const lists: SingletonHandle<{ items: string[] }>[] = [];
	const { host, errors } = await loaded((h) => {
		h.serve(Store, (_, self) => {
			attempts.push(self);
			const list = self.state(List);
			lists.push(list);
			return {
				list,
				count: self.derive([list], ([l]) => l.items.length),
				add: async ({ text }: { text: string }, ctx: Context) => {
					await list.change((draft) => void draft.items.push(text), ctx);
					return null;
				},
			};
		});
		h.serve(Viewer, (_, self) => ({ tens: self.derive([self.get(Store, {}).count], ([n]) => n * 10) }));
	}, options);
	const store = await host.get(Store, {}, context);
	const fail = (): void =>
		failLive(attempted, attempts.at(-1)!, new ChordError({ code: "unavailable", message: "boom" }));
	return { host, errors, store, attempts, lists, fail };
}

describe("following the live attempt", () => {
	it("passes the member's frames on as they are, and keeps a derive member lazy while nothing watches it", async () => {
		const { telemetry, counts } = await metered();
		const { host, store, lists: handles } = await served({ telemetry });
		expect(store.count.value).toBe(0);
		const computes = (): number => counts()["chord.derive.computes"] ?? 0;
		const before = computes();
		expect(before).toBeGreaterThan(0);
		await store.add({ text: "a" }, context);
		await store.add({ text: "b" }, context);
		// Unwatched: marked only, computed by the next read.
		expect(computes()).toBe(before);
		expect(store.count.value).toBe(2);
		const watch = await store.count.watch(context);
		const counted = changesOf(watch);
		const lists = changesOf(await store.list.watch(context));
		const own = changesOf(await handles[0]!.watch(context));
		await store.add({ text: "c" }, context);
		await delivered();
		expect(counted).toEqual([{ kind: "value", value: 3, ops: [["r", 3]], retired: false }]);
		// The slot's own change, not a copy.
		expect(lists).toHaveLength(1);
		expect(lists[0]).toBe(own[0]);
		await watch.stop();
		await delivered();
		const stopped = computes();
		await store.add({ text: "d" }, context);
		expect(computes()).toBe(stopped);
		await host.close(context);
	});
});

describe("a failed object's members", () => {
	it("keep their last values and get the failure once; a new watch opens at the last value (slice 6a §1.4)", async () => {
		const { host, store, lists, fail } = await served();
		await store.add({ text: "a" }, context);
		const counted = changesOf(await store.count.watch(context));
		fail();
		await delivered();
		expect(store.state.value.kind).toBe("failed");
		const late = await store.count.watch(context);
		expect(late.value).toBe(1);
		const lately = changesOf(late);
		const listed = changesOf(await store.list.watch(context));
		// The failed attempt's handle is sealed; the slot changes only through a new attempt.
		expect(lists[0]!.value).toEqual({ items: ["a"] });
		store.retry();
		await (await host.get(Store, {}, context)).add({ text: "b" }, context);
		await delivered();
		// The failure once; after it, whole values: the next instance's (unchanged) 1, then 2.
		expect(valuesOf(counted)).toEqual([{ failed: "boom" }, 1, 2]);
		// Opened while failed: at the last value, the failure once, then whole values.
		expect(valuesOf(listed)).toEqual([{ failed: "boom" }, { items: ["a"] }, { items: ["a", "b"] }]);
		expect(valuesOf(lately)).toEqual([{ failed: "boom" }, 1, 2]);
		await host.close(context);
	});

	it("re-exposed from another object hold with the re-exposing object; the provider's source goes on", async () => {
		const Note = obj({ title: str() });
		const Memo = defineState("memo", { schema: Note, version: 1, initial: () => ({ title: "" }), keyed: true });
		const Own = defineState("own", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });
		const Provider = local("app.provider", {
			version: 1,
			params: {},
			members: { n: int(), notes: keyed(Note), set: method(int()) },
		});
		const Exposer = local("app.exposer", { version: 1, params: {}, members: { n: int(), note: Note } });
		let exposer: Self | undefined;
		const { host } = await loaded((h) => {
			h.serve(Provider, (_, self) => {
				const memos = self.state(Memo);
				const n = self.derive([memos.at("a")], ([note]) => note.title.length);
				return {
					n,
					notes: memos,
					set: async (length, ctx) => {
						await memos.change(
							"a",
							(draft) => {
								draft.title = "x".repeat(length);
							},
							ctx,
						);
						return null;
					},
				};
			});
			h.serve(Exposer, (_, self) => {
				exposer = self;
				self.state(Own);
				const provider = self.get(Provider, {});
				return { n: provider.n, note: provider.notes.at("a") };
			});
		});
		const provider = await host.get(Provider, {}, context);
		const exposed = await host.get(Exposer, {}, context);
		await provider.set(1, context);
		const exposedN = changesOf(await exposed.n.watch(context));
		const exposedNote = changesOf(await exposed.note.watch(context));
		const providerN = changesOf(await provider.n.watch(context));
		failLive(attempted, exposer!, new ChordError({ code: "unavailable", message: "boom" }));
		await delivered();
		await provider.set(7, context);
		await delivered();
		expect(exposed.state.value.kind).toBe("failed");
		expect([exposed.n.value, exposed.note.value]).toEqual([1, { title: "x" }]);
		expect([exposedN, exposedNote].map((calls) => calls.map((call) => call.kind))).toEqual([["failed"], ["failed"]]);
		expect(provider.n.value).toBe(7);
		expect(valuesOf(providerN)).toEqual([7]);
		await host.close(context);
	});
});

describe("the window of a live failure", () => {
	it("every member follows on while an admitted commit of the object runs, then all hold (audit A10)", async () => {
		const Counter = defineState("counter", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });
		const Persisted = defineState("own", {
			schema: obj({ n: int() }),
			version: 1,
			initial: () => ({ n: 0 }),
			persist: true,
			checkpointWhen: () => false,
		});
		const Provider = local("app.provider", { version: 1, params: {}, members: { n: int(), set: method(int()) } });
		const Exposer = local("app.exposer", { version: 1, params: {}, members: { n: int(), own: obj({ n: int() }) } });
		const store = await memoryStore();
		let exposer: StoreSelf | undefined;
		let own: SingletonHandle<{ n: number }> | undefined;
		const { host } = await loaded(
			(h) => {
				h.serve(Provider, (_, self) => {
					const doc = self.state(Counter);
					return {
						n: self.derive([doc], ([d]) => d.n),
						set: async (n, ctx) => {
							await doc.change((draft) => {
								draft.n = n;
							}, ctx);
							return null;
						},
					};
				});
				h.serve(Exposer, (_, self) => {
					exposer = self;
					own = self.state(Persisted);
					return { n: self.get(Provider, {}).n, own };
				});
			},
			{ store },
		);
		const provider = await host.get(Provider, {}, context);
		const exposed = await host.get(Exposer, {}, context);
		await provider.set(1, context);
		const frames = changesOf(await exposed.n.watch(context));
		const owned = changesOf(await exposed.own.watch(context));
		const held = holdNextCommit(store);
		const change = own!.change((draft) => {
			draft.n = 5;
		}, context);
		await held.entered;
		failLive(attempted, exposer!, new ChordError({ code: "unavailable", message: "boom" }));
		await provider.set(9, context);
		await delivered();
		// A re-exposed member shows one more change of its provider in the window.
		expect([exposed.n.value, frames.map((call) => call.kind)]).toEqual([9, ["value"]]);
		held.release();
		await change;
		await delivered();
		// The object's own admitted commit still publishes once; then every member holds (the failure once).
		expect(valuesOf(owned)).toEqual([{ n: 5 }, { failed: "boom" }]);
		expect([exposed.n.value, frames.map((call) => call.kind)]).toEqual([9, ["value", "failed"]]);
		await host.close(context);
		await store.close(context);
	});
});

describe("re-binding when a new attempt goes live", () => {
	it("recovers a consumer's derive that failed on the provider's earlier error, and the derives downstream", async () => {
		const Counted = local("app.counted", { version: 1, params: {}, members: { count: int(), add: method(str()) } });
		const Tens = local("app.tens", { version: 1, params: {}, members: { tens: int(), hundreds: int() } });
		const selves: Self[] = [];
		const { host } = await loaded((h) => {
			h.serve(Counted, (_, self) => {
				selves.push(self);
				const first = selves.length === 1;
				const list = self.state(List);
				return {
					count: self.derive([list], ([l]) => {
						if (first && l.items.length === 1) throw new Error("count broke");
						return l.items.length;
					}),
					add: async (text, ctx) => {
						await list.change((draft) => void draft.items.push(text), ctx);
						return null;
					},
				};
			});
			h.serve(Tens, (_, self) => {
				const tens = self.derive([self.get(Counted, {}).count], ([n]) => n * 10);
				return { tens, hundreds: self.derive([tens], ([n]) => n * 10) };
			});
		});
		const counted = await host.get(Counted, {}, context);
		const tens = await host.get(Tens, {}, context);
		await counted.add("a", context);
		expect(() => tens.tens.value).toThrow("count broke");
		expect(() => tens.hundreds.value).toThrow("count broke");
		failLive(attempted, selves[0]!, new ChordError({ code: "unavailable", message: "boom" }));
		counted.retry();
		(await host.get(Counted, {}, context)).release();
		expect([tens.tens.value, tens.hundreds.value]).toEqual([10, 100]);
		const frames = changesOf(await tens.hundreds.watch(context));
		await counted.add("b", context);
		await delivered();
		expect(valuesOf(frames)).toEqual([200]);
		await host.close(context);
	});

	it("re-binds a consumer's derive over a retried provider's derive member, and its watches get frames again", async () => {
		const { host, store, fail } = await served();
		const viewer = await host.get(Viewer, {}, context);
		const tens = changesOf(await viewer.tens.watch(context));
		const counted = changesOf(await store.count.watch(context));
		await store.add({ text: "a" }, context);
		await delivered();
		fail();
		await delivered();
		expect([store.count.value, viewer.tens.value]).toEqual([1, 10]);
		store.retry();
		await (await host.get(Store, {}, context)).add({ text: "b" }, context);
		await delivered();
		expect(viewer.state.value.kind).toBe("live");
		expect([store.count.value, viewer.tens.value]).toEqual([2, 20]);
		// A derive over the held member keeps its last value (no failure); the member's watch gets it once.
		expect(valuesOf(tens)).toEqual([10, 20]);
		expect(valuesOf(counted)).toEqual([1, { failed: "boom" }, 1, 2]);
		await host.close(context);
	});

	it("sends one frame from the last value when the new attempt's member differs", async () => {
		const Shown = local("app.shown", { version: 1, params: {}, members: { label: str() } });
		const labels = ["old", "new"];
		let attempt = 0;
		const selves: Self[] = [];
		const { host } = await loaded((h) =>
			h.serve(Shown, (_, self) => {
				selves.push(self);
				self.state(List);
				const label = labels[attempt++]!;
				return { label: self.derive([], () => label) };
			}),
		);
		const shown = await host.get(Shown, {}, context);
		const frames = changesOf(await shown.label.watch(context));
		failLive(attempted, selves[0]!, new ChordError({ code: "unavailable", message: "boom" }));
		shown.retry();
		(await host.get(Shown, {}, context)).release();
		await delivered();
		expect(shown.label.value).toBe("new");
		expect(frames).toEqual([{ kind: "value", value: "new", ops: [["r", "new"]], retired: false }]);
		await host.close(context);
	});
});

describe("subscribers", () => {
	it("a hold over a link on a remote object re-exposing a local member gets frames again after the local retry", async () => {
		const Count = local("app.count", { version: 1, params: {}, members: { n: obj({ n: int() }), add: method() } });
		const View = remote("app.view", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: { v: { state: { n: obj({ n: int() }) } } },
		});
		const Counter = defineState("counter", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });
		const selves: Self[] = [];
		const { server, client } = await linked((h) => {
			h.serve(Count, (_, self) => {
				selves.push(self);
				const counter = self.state(Counter);
				return {
					n: self.derive([counter], ([c]) => ({ n: c.n * 10 })),
					add: async (ctx: Context) => {
						await counter.change((draft) => void draft.n++, ctx);
						return null;
					},
				};
			});
			h.serve(View, (_, _principal, self) => ({ variant: "v", members: { n: self.get(Count, {}).n } }));
		});
		const count = await server.get(Count, {}, context);
		const view = await client.get(View, {}, context);
		if (view.variant !== "v") throw new Error("expected variant v");
		const frames = changesOf(await view.n.watch(context));
		await count.add(context);
		await transported();
		failLive(attempted, selves[0]!, new ChordError({ code: "unavailable", message: "boom" }));
		count.retry();
		await (await server.get(Count, {}, context)).add(context);
		await transported();
		expect(view.n.value).toEqual({ n: 20 });
		expect(valuesOf(frames)).toEqual([{ n: 10 }, { n: 20 }]);
		await client.close(context);
		await server.close(context);
	});
});

describe("subscribers, directly", () => {
	it("are fed the member's calls: a failure, then its recovery at the re-bind as a root replacement", async () => {
		const Counted = local("app.counted", { version: 1, params: {}, members: { count: int(), add: method(str()) } });
		const selves: Self[] = [];
		const { host } = await loaded((h) =>
			h.serve(Counted, (_, self) => {
				selves.push(self);
				const first = selves.length === 1;
				const list = self.state(List);
				return {
					count: self.derive([list], ([l]) => {
						if (first && l.items.length === 2) throw new Error("count broke");
						return l.items.length;
					}),
					add: async (text, ctx) => {
						await list.change((draft) => void draft.items.push(text), ctx);
						return null;
					},
				};
			}),
		);
		const counted = await host.get(Counted, {}, context);
		const source = resolveWatchable(counted.count) as Source;
		const events: unknown[] = [];
		const subscriber: Subscriber = {
			advance: (call) =>
				void events.push(call.kind === "value" ? [call.value, call.ops] : (call.error as Error).message),
			end: (end) => void events.push(end.kind),
			endAfterDelivery: () => void events.push("ended"),
		};
		expect(source.value).toBe(0);
		source.subscribe(subscriber);
		await counted.add("a", context);
		await counted.add("b", context);
		failLive(attempted, selves[0]!, new ChordError({ code: "unavailable", message: "boom" }));
		counted.retry();
		await (await host.get(Counted, {}, context)).add("c", context);
		expect(counted.count.value).toBe(3);
		expect(events).toEqual([[1, [["r", 1]]], "count broke", [2, [["r", 2]]], [3, [["r", 3]]]]);
		await host.close(context);
	});
});

describe("a member the new attempt's variant lacks", () => {
	it("fails: its watch gets one failure call and stays open, reads throw invalid/member; a later attempt brings it back", async () => {
		const Two = remote("app.two", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: { full: { state: { n: int() } }, view: { state: { m: int() } } },
		});
		const owner = { kind: "owner" } as const;
		const host = createHost<typeof owner>({ address: Server(), principal: owner, onError: () => {} });
		const selves: Self[] = [];
		const facet = defineFacet<typeof owner>((h) =>
			h.serve(Two, (_, _principal, self) => {
				selves.push(self);
				self.state(List);
				return selves.length === 2
					? { variant: "view", members: { m: constant(2) } }
					: { variant: "full", members: { n: constant(selves.length) } };
			}),
		);
		await host.load([{ name: "@test/app", facet }], context);
		const two = await host.get(Two, {}, context);
		if (two.variant !== "full") throw new Error("expected the full variant");
		const n = two.n;
		const calls = changesOf(await n.watch(context));
		const boom = new ChordError({ code: "unavailable", message: "boom" });
		failLive(attempted, selves[0]!, boom);
		two.retry();
		(await host.get(Two, {}, context)).release();
		await delivered();
		// The failed instance is followed until its admitted commits published (audit A10), when the retry's attempt
		// loads already (no failure call for it); then the new variant's lack of it.
		expect(calls).toEqual([
			{ kind: "failed", error: expect.objectContaining({ code: "invalid", reason: "member" }) },
		]);
		expect(() => n.value).toThrow('app.two (variant view) has no state member "n"');
		// The same as over a link: the member comes back with the next attempt that has it.
		failLive(attempted, selves[1]!, boom);
		two.retry();
		(await host.get(Two, {}, context)).release();
		await delivered();
		expect(n.value).toBe(3);
		expect(calls.at(-1)).toEqual({ kind: "value", value: 3, ops: [["r", 3]], retired: false });
		await host.close(context);
	});
});

describe("an ended object's members", () => {
	it("mark the derives over them: a consumer's derive keeps no cached value, its read throws released", async () => {
		const Paged = local("app.paged", { version: 1, params: { id: int() }, members: { n: int() } });
		const Reader = local("app.reader", { version: 1, params: {}, members: { twice: int() } });
		const { host } = await loaded((h) => {
			h.serve(Paged, () => ({ n: constant(4) }));
			h.serve(Reader, (_, self) => ({ twice: self.derive([self.get(Paged, { id: 1 }).n], ([n]) => n * 2) }));
		});
		const reader = await host.get(Reader, {}, context);
		expect(reader.twice.value).toBe(8);
		for (const object of attempted) {
			const paged = object.deref();
			if (paged?.label === "app.paged(1)") paged.end();
		}
		expect(() => reader.twice.value).toThrow(expect.objectContaining({ code: "released" }));
		await host.close(context);
	});
});

describe("member sources and memory", () => {
	it("a failed attempt is collected after a retry while the object, its member source and a retained watch live", async () => {
		const attempts: WeakRef<Self>[] = [];
		const { host } = await loaded((h) =>
			h.serve(Store, (_, self) => {
				attempts.push(new WeakRef(self));
				const list = self.state(List);
				return {
					list,
					count: self.derive([list], ([l]) => l.items.length),
					add: async ({ text }, ctx) => {
						await list.change((draft) => void draft.items.push(text), ctx);
						return null;
					},
				};
			}),
		);
		const store = await host.get(Store, {}, context);
		const frames = changesOf(await store.count.watch(context));
		failLive(attempted, attempts[0]!.deref()!, new ChordError({ code: "unavailable", message: "boom" }));
		store.retry();
		(await host.get(Store, {}, context)).release();
		await store.add({ text: "a" }, context);
		await delivered();
		expect(valuesOf(frames)).toEqual([1]);
		await expectCollected(attempts[0]!);
		expect(attempts[1]!.deref()).toBeDefined();
		await host.close(context);
	});

	it("an ended object's member sources are collected with it", async () => {
		const refs = await (async () => {
			const { host, store } = await served();
			const source = resolveWatchable(store.count);
			expect(source?.value).toBe(0);
			const ref = new WeakRef(source!);
			await host.close(context);
			return [ref];
		})();
		await expectCollected(...refs);
	});
});

describe('what a reference keeps (decision "References are the only indirection")', () => {
	it("keeps nothing of an ended instance while it waits with an open watch, its failure's error included", async () => {
		const Count = local("app.kept", { version: 1, params: {}, members: { n: int() } });
		const Doc = defineState("kept", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 5 }) });
		const selves: WeakRef<object>[] = [];
		const facet = defineFacet((h) =>
			h.serve(Count, (_, self) => {
				selves.push(new WeakRef(self));
				const doc = self.state(Doc);
				return { n: self.derive([doc], ([value]) => value.n) };
			}),
		);
		const host = createHost({ onError: () => {} });
		const from = attempted.length;
		await host.load([{ name: "@app/kept", facet }], context);
		let ref: Reference<typeof Count> | undefined = await host.get(Count, {}, context);
		const watch = await ref.n.watch(context);
		const calls = changesOf(watch);
		const objects = attempted.slice(from);
		const documents = objects.map((object) => new WeakRef(object.deref()!.documents));
		// Removed: the reference waits with its last value and its failure; the instance ends.
		await host.reload([], context);
		await delivered();
		const state = ref.state.value;
		if (state.kind !== "failed") throw new Error("expected failed");
		const kept = state.cause.error;
		expect([ref.n.value, valuesOf(calls)]).toEqual([5, [{ failed: kept.message }]]);
		await expectCollected(...selves, ...objects, ...documents);
		// Released: its last values and bindings go with it.
		const released = new WeakRef(ref);
		await watch.stop();
		ref.release();
		ref = undefined;
		await expectCollected(released);
		expect(kept.code).toBe("unavailable");
		await host.close(context);
	});

	it("never takes values from an instance it never attached to: a reference made while its object is failed has none", async () => {
		const { host, store, fail } = await served();
		await store.add({ text: "a" }, context);
		fail();
		await delivered();
		const late = host.hold(Store, {}, context);
		expect(store.count.value).toBe(1);
		expect(() => late.count.value).toThrow("boom");
		late.release();
		await host.close(context);
	});

	it("computes a consumer's derive over a watched reference member once per commit (cost guard)", async () => {
		const { telemetry, counts } = await metered();
		const { host, store } = await served({ telemetry });
		const viewer = await host.get(Viewer, {}, context);
		const counted = changesOf(await store.count.watch(context));
		const tens = changesOf(await viewer.tens.watch(context));
		await store.add({ text: "a" }, context);
		await delivered();
		const before = counts()["chord.derive.computes"] ?? 0;
		for (const text of ["b", "c", "d"]) await store.add({ text }, context);
		await delivered();
		// The store's count and the viewer's tens: one compute each per commit, nothing for passing through.
		expect((counts()["chord.derive.computes"] ?? 0) - before).toBe(6);
		expect([valuesOf(counted), valuesOf(tens)]).toEqual([
			[1, 2, 3, 4],
			[10, 20, 30, 40],
		]);
		await host.close(context);
	});
});

describe("a reference keeps the last values of its attached instance's variant (final review)", () => {
	it("keeps an unread member of a remote contract served on its host when the type is removed (Astra)", async () => {
		const Type = remote("app.remote-unread", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: { full: { state: { n: int() } } },
		});
		const owner = { kind: "owner" } as const;
		const facet = defineFacet<typeof owner>((h) =>
			h.serve(Type, () => ({ variant: "full", members: { n: constant(7) } })),
		);
		const host = createHost<typeof owner>({ address: Server(), principal: owner, onError: () => {} });
		await host.load([{ name: "@app/remote-unread", facet }], context);
		const ref = await host.get(Type, {}, context);
		// `n` never read: the removal takes its last value from the instance's variant (the object is live no more).
		await host.reload([], context);
		await delivered();
		expect(ref.n.value).toBe(7);
		ref.release();
		await host.close(context);
	});
});

describe("a failed object lets its ended instance go (final review)", () => {
	it("collects the instance while a reference keeps its last value with an open watch (Astra, GC)", async () => {
		const Type = local("app.failed-gc", { version: 1, params: {}, members: { n: int() } });
		let self: Self | undefined;
		const facet = defineFacet((h) =>
			h.serve(Type, (_, declared) => {
				self = declared;
				return { n: constant(7) };
			}),
		);
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@app/failed-gc", facet }], context);
		const ref = await host.get(Type, {}, context);
		changesOf(await ref.n.watch(context));
		const instance = new WeakRef(self!);
		failLive(attempted, self!, new ChordError({ code: "unavailable", message: "boom" }));
		self = undefined;
		await flushed();
		await delivered();
		// The object stays failed (host lifetime) and its reference keeps 7: neither keeps the ended instance.
		expect(ref.n.value).toBe(7);
		await expectCollected(instance);
		ref.release();
		await host.close(context);
	});
});
