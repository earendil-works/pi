// Tests of member sources (slice 6a §1.2, §1.4): a local object's state members as references and other objects'
// derives follow them across attempts: passed on while live, frozen while failed, re-bound by name when live again.

import { describe, expect, it } from "vitest";
import { type Context, BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { arr, int, keyed, local, method, obj, remote, str } from "../../../src/next/contracts/index.ts";
import { ChordError } from "../../../src/next/data/index.ts";
import { defineState, type SingletonHandle } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type Self, type StoreSelf } from "../../../src/next/host/index.ts";
import { ChordObject } from "../../../src/next/host/object.ts";
import { resolveWatchable } from "../../../src/next/host/reference.ts";
import { constant } from "../../../src/next/state/index.ts";
import type { Source, Subscriber } from "../../../src/next/state/internal.ts";
import {
	changesOf,
	delivered,
	expectCollected,
	failLive,
	holdNextCommit,
	instancesOf,
	linked,
	loaded,
	memoryStore,
	metered,
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
	it("keep their last values and get no frames; a new watch opens at the last value (slice 6a §1.4)", async () => {
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
		expect(valuesOf(counted)).toEqual([2]);
		expect(valuesOf(listed)).toEqual([{ items: ["a", "b"] }]);
		expect(valuesOf(lately)).toEqual([2]);
		await host.close(context);
	});

	it("re-exposed from another object freeze with the re-exposing object; the provider's source goes on", async () => {
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
		expect([exposedN, exposedNote]).toEqual([[], []]);
		expect(provider.n.value).toBe(7);
		expect(valuesOf(providerN)).toEqual([7]);
		await host.close(context);
	});
});

describe("the window of a live failure", () => {
	it("members following another object's sources freeze at once, while an admitted commit of the object runs", async () => {
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
		expect([exposed.n.value, frames]).toEqual([1, []]);
		held.release();
		await change;
		await delivered();
		// The object's own admitted commit still publishes once.
		expect(valuesOf(owned)).toEqual([{ n: 5 }]);
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
		expect(valuesOf(tens)).toEqual([10, 20]);
		expect(valuesOf(counted)).toEqual([1, 2]);
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
		const View = remote("app.view", { version: 1, params: {}, variants: { v: { state: { n: obj({ n: int() }) } } } });
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
			variants: { full: { state: { n: int() } }, view: { state: { m: int() } } },
		});
		const owner = { kind: "owner" } as const;
		const host = createHost<typeof owner>({ principal: owner, onError: () => {} });
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
