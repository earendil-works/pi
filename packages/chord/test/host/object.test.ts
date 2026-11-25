import { describe, expect, it, vi } from "vitest";
import { type Context, BACKGROUND_CONTEXT as context, withoutAbortSignal } from "../../src/context/index.ts";
import { arr, bool, evolve, grantable, int, local, method, obj, remote, str } from "../../src/contracts/index.ts";
import { broken, ChordError } from "../../src/data/index.ts";
import { defineState, type SingletonHandle } from "../../src/documents/index.ts";
import { Attempt } from "../../src/host/attempt.ts";
import {
	type Admit,
	allow,
	type Ctx,
	createHost,
	defineFacet,
	deny,
	type FacetHost,
	type FacetSelf,
	type FollowObserver,
	type Host,
	type HostError,
	type Reference,
	type RefState,
	type Self,
	type StoreSelf,
	untilAborted,
} from "../../src/host/index.ts";
import { ChordObject } from "../../src/host/object.ts";
import { defineJob } from "../../src/jobs/index.ts";
import { memoryLinkPair } from "../../src/link/index.ts";
import { jsonPart, type Message } from "../../src/link/internal.ts";
import { watchStore } from "../../src/react/stores.ts";
import { defineRegistry } from "../../src/registries/index.ts";
import { constant, type Watchable } from "../../src/state/index.ts";
import { query } from "../../src/store/query.ts";
import { defineTable } from "../../src/store/table.ts";
import {
	changesOf,
	delivered,
	expectCollected,
	failLive,
	failures,
	fakeTimers,
	flushed,
	holdNextCommit,
	instancesOf,
	linked,
	loaded,
	memoryStore,
	metered,
	RawPeer,
	rawWorkers,
	rejection,
	relayed,
	restartable,
	SERVER_ADDRESS,
	Server,
	Session,
	StoreRestartable,
	statesOf,
	storeRestartable,
	type TestPrincipal,
	testCodec,
	transported,
	valuesOf,
} from "../support.ts";

const List = defineState("list", { schema: obj({ items: arr(str()) }), version: 1, initial: () => ({ items: [] }) });
const COUNTER = { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) } as const;
const Store = local("app.store", {
	version: 1,
	params: {},
	members: { count: int(), add: method(obj({ text: str() })), clear: method() },
});
const Page = local("app.page", { version: 1, params: { id: int() }, members: { label: str(), slow: method() } });

/** The store: a list document, its count, and methods to add and clear. */
function serveStore(self: Self) {
	const list = self.state(List);
	return {
		count: self.derive([list], ([l]) => l.items.length),
		add: async ({ text }: { text: string }, ctx: Context) => {
			await list.change((draft) => draft.items.push(text), ctx);
			return null;
		},
		clear: async (ctx: Context) => {
			await list.retire(ctx);
			return null;
		},
	};
}

const Svc = local("app.svc", { version: 1, params: { id: int() }, members: { n: int() } });
const Core = local("app.core", { version: 1, params: {}, members: { n: int() } });

/**
 * A factory with one native whose open throws "offline" on the attempts `fails` picks (counted from 1), and the times
 * (fake, from 0) of its attempts. `gate`, when given, holds every open that does not fail until it resolves.
 */
function flaky(fails: (attempt: number) => boolean, gate?: Promise<void>) {
	const times: number[] = [];
	const factory = (_: unknown, self: Self) => {
		times.push(Date.now());
		const attempt = times.length;
		self.open(
			async () => {
				if (fails(attempt)) throw new Error("offline");
				await gate;
				return null;
			},
			() => {},
		);
		return { n: constant(attempt) };
	};
	return { times, factory };
}

describe("identity and lifetime", () => {
	it("one object per params key; a params type lives from its first get to its last release", async () => {
		const factory = vi.fn(({ id }: { id: number }, self: Self) => {
			const store = self.get(Store, {});
			return {
				label: self.derive([store.count], ([count]) => `${id}: ${count}`),
				slow: async () => null,
			};
		});
		const { host } = await loaded((h) => {
			h.serve(Store, (_, self) => serveStore(self));
			h.serve(Page, factory);
		});
		const [a, b, c] = await Promise.all([
			host.get(Page, { id: 1 }, context),
			host.get(Page, { id: 1 }, context),
			host.get(Page, { id: 2 }, context),
		]);
		expect(factory).toHaveBeenCalledTimes(2);
		const watch = await a.label.watch(context);
		a.release();
		expect(b.label.value).toBe("1: 0");
		b.release();
		expect(await watch.closed).toEqual({ kind: "ended" });
		const again = await host.get(Page, { id: 1 }, context);
		expect(factory).toHaveBeenCalledTimes(3);
		expect([again.label.value, c.label.value]).toEqual(["1: 0", "2: 0"]);
	});

	it("keeps a type with empty params across releases", async () => {
		const factory = vi.fn((_: object, self: Self) => serveStore(self));
		const { host } = await loaded((h) => h.serve(Store, factory));
		const first = await host.get(Store, {}, context);
		await first.add({ text: "milk" }, context);
		first.release();
		const second = await host.get(Store, {}, context);
		expect(second.count.value).toBe(1);
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it("drops an ended object's documents and detaches its derives from other objects' members", async () => {
		const telemetry = await metered();
		const { host } = await loaded(
			(h) => {
				h.serve(Store, (_, self) => serveStore(self));
				h.serve(Page, ({ id }, self) => ({
					label: self.derive([self.get(Store, {}).count], ([count]) => `${id}: ${count}`),
					slow: async () => null,
				}));
			},
			{ telemetry: telemetry.telemetry },
		);
		const store = await host.get(Store, {}, context);
		const page = await host.get(Page, { id: 1 }, context);
		const watch = await page.label.watch(context);
		page.release();
		expect(await watch.closed).toEqual({ kind: "ended" });
		const before = telemetry.counts()["chord.derive.computes"];
		await store.add({ text: "x" }, context);
		expect(telemetry.counts()["chord.derive.computes"]).toBe(before);
	});
});

describe('calls for a reference (decision "References share one wire hold")', () => {
	it("run as the reference's binding's caller; a local object keeps no replica counts", async () => {
		const Who = local("app.who", { version: 1, params: {}, members: { who: method(str(), str()) } });
		const owner = { kind: "owner" } as const;
		const host = createHost<typeof owner>({ principal: owner, onError: () => {} });
		await host.load(
			[
				{
					name: "@test/who",
					facet: defineFacet<typeof owner>((h) =>
						h.serve(Who, () => ({
							who: async (_, ctx) => ctx.principal?.kind ?? "none",
						})),
					),
				},
			],
			context,
		);
		const who = await host.get(Who, {}, context);
		expect(await who.who("?", context)).toBe("owner");
		const object = attempted.map((ref) => ref.deref()).find((each) => each?.label === "app.who")!;
		expect(object.generationOf()).toBeUndefined();
		await host.close(context);
	});
});

describe("retries", () => {
	fakeTimers();

	it("retry a transient failure after 1 s, doubling up to 60 s, and start over after a success", async () => {
		const { times, factory } = flaky((attempt) => attempt <= 8 || attempt === 10);
		const { host } = await loaded((h) => h.serve(Svc, factory));
		const got = host.get(Svc, { id: 1 }, context, { readyTimeout: 1_000_000 });
		await vi.advanceTimersByTimeAsync(183_000);
		(await got).release();
		expect(times).toEqual([0, 1000, 3000, 7000, 15000, 31000, 63000, 123000, 183000]);
		// The success deleted the backoff: a new object tries at once and waits 1 s after its failure.
		const again = host.get(Svc, { id: 1 }, context);
		await vi.advanceTimersByTimeAsync(1000);
		expect((await again).n.value).toBe(11);
		expect(times.slice(9)).toEqual([183000, 184000]);
	});

	it("share one attempt among concurrent gets", async () => {
		const { times, factory } = flaky(() => false);
		const { host } = await loaded((h) => h.serve(Svc, factory));
		const refs = await Promise.all([1, 2, 3].map(() => host.get(Svc, { id: 1 }, context)));
		expect([times, refs.map(({ n }) => n.value)]).toEqual([[0], [1, 1, 1]]);
	});

	it("never retry a broken failure; a new object after its end tries at once", async () => {
		const bug = vi.fn(() => {
			throw new Error("bug");
		});
		const { host } = await loaded((h) => {
			h.serve(Svc, bug);
			h.serve(Core, bug);
		});
		expect(await rejection(host.get(Svc, { id: 1 }, context))).toEqual({
			code: "unavailable",
			message: "app.svc(1): bug",
		});
		await vi.advanceTimersByTimeAsync(120_000);
		expect(bug).toHaveBeenCalledTimes(2);
		expect(await rejection(host.get(Core, {}, context))).toEqual({ code: "unavailable", message: "app.core: bug" });
		await expect(host.get(Svc, { id: 1 }, context)).rejects.toThrow("bug");
		expect(bug).toHaveBeenCalledTimes(3);
	});

	it("end a failed object with its last reference; its backoff entry expires on its own", async () => {
		const { times, factory } = flaky(() => true);
		const { host } = await loaded((h) => h.serve(Svc, factory));
		const first = rejection(host.get(Svc, { id: 1 }, context, { readyTimeout: 500 }));
		await vi.advanceTimersByTimeAsync(500);
		expect(await first).toEqual({ code: "unavailable", message: "app.svc(1): offline" });
		await vi.advanceTimersByTimeAsync(4500);
		expect([times, vi.getTimerCount()]).toEqual([[0], 0]);
		// The entry expired: a new object tries at once and its window starts over at 1 s.
		const second = rejection(host.get(Svc, { id: 1 }, context, { readyTimeout: 1500 }));
		await vi.advanceTimersByTimeAsync(1500);
		await second;
		expect(times).toEqual([0, 5000, 6000]);
	});

	it("make a get right after a failure wait for the scheduled retry", async () => {
		const { times, factory } = flaky((attempt) => attempt === 1);
		const { host } = await loaded((h) => h.serve(Svc, factory));
		const first = rejection(host.get(Svc, { id: 1 }, context, { readyTimeout: 500 }));
		await vi.advanceTimersByTimeAsync(500);
		await first;
		const second = host.get(Svc, { id: 1 }, context);
		await vi.advanceTimersByTimeAsync(499);
		expect(times).toEqual([0]);
		await vi.advanceTimersByTimeAsync(1);
		expect((await second).n.value).toBe(2);
		expect(times).toEqual([0, 1000]);
	});

	it("start a new instance only after the previous one closed", async () => {
		const closing = Promise.withResolvers<void>();
		const factory = vi.fn((_: { id: number }, self: Self) => {
			self.open(
				async () => null,
				() => closing.promise,
			);
			return { n: constant(factory.mock.calls.length) };
		});
		const { host } = await loaded((h) => h.serve(Svc, factory));
		(await host.get(Svc, { id: 1 }, context)).release();
		const again = host.get(Svc, { id: 1 }, context);
		await flushed();
		expect(factory).toHaveBeenCalledTimes(1);
		closing.resolve();
		expect((await again).n.value).toBe(2);
	});
});

describe("parked on dependencies (dependency model §3)", () => {
	fakeTimers();
	const View = local("app.view", { version: 1, params: { id: int() }, members: { n: int() } });

	/** A view over `Type`'s `n`, and the times of its attempts. */
	function view(Type: typeof Svc | typeof Core) {
		const times: number[] = [];
		const factory = ({ id }: { id: number }, self: Self) => {
			times.push(Date.now());
			return { n: Type === Core ? self.get(Core, {}).n : self.get(Svc, { id }).n };
		};
		return { times, factory };
	}

	it("parks a dependent of a failed dependency failed { waiting } naming it, with no timer; it goes on when the dependency is live", async () => {
		const core = flaky((attempt) => attempt === 1);
		const viewer = view(Core);
		const { host, errors } = await loaded((h) => {
			h.serve(Core, core.factory);
			h.serve(View, viewer.factory);
		});
		await vi.advanceTimersByTimeAsync(500);
		const held = host.hold(View, { id: 1 }, context);
		const got = host.get(View, { id: 1 }, context);
		await flushed();
		expect(held.state.value).toEqual({
			kind: "failed",
			cause: {
				kind: "waiting",
				error: expect.objectContaining({ message: "waiting for app.core: app.core: offline" }),
			},
			retryAt: undefined,
		});
		// A parked attempt is no failure of its own: nothing is reported for the view.
		expect(failures(errors)).toEqual(["app.core: transient"]);
		// The core's own backoff retries it at 1 s; the view goes on then, its factory not run again.
		await vi.advanceTimersByTimeAsync(500);
		expect((await got).n.value).toBe(2);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(viewer.times).toEqual([500]);
		held.release();
	});

	it("keeps its references while parked; a getter rejects with the waiting cause at its deadline; releasing ends the wait", async () => {
		const svc = flaky(() => true);
		const viewer = view(Svc);
		const { host } = await loaded((h) => {
			h.serve(Svc, svc.factory);
			h.serve(View, viewer.factory);
		});
		const got = rejection(host.get(View, { id: 1 }, context, { readyTimeout: 1500 }));
		await vi.advanceTimersByTimeAsync(1500);
		expect(await got).toEqual({
			code: "unavailable",
			message: "waiting for app.svc(1): app.svc(1): offline",
		});
		await vi.advanceTimersByTimeAsync(10_000);
		// Held by the parked view, the dependency was retried at 1 s; released with it at 1.5 s, it is not any more.
		expect(svc.times).toEqual([0, 1000]);
		expect(viewer.times).toEqual([0]);
	});

	it("shows every change of a dependency: loading, failed, a new cause, loading again, live", async () => {
		let cores = 0;
		const viewer = view(Core);
		const { host } = await loaded((h) => {
			h.serve(Core, (_, self) => {
				const attempt = ++cores;
				self.open(
					async () => {
						if (attempt < 3) throw new Error(`offline ${attempt}`);
					},
					() => {},
				);
				return { n: constant(attempt) };
			});
			h.serve(View, viewer.factory);
		});
		const held = host.hold(View, { id: 1 }, context);
		await flushed();
		expect(held.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: { message: "waiting for app.core: app.core: offline 1" } },
		});
		const states = statesOf(await held.state.watch(context));
		await vi.advanceTimersByTimeAsync(10_000);
		// The core's retries at 1 s and 3 s: each attempt shows as loading, each failure as a new cause.
		expect(states).toEqual(["loading", "failed: waiting for app.core: app.core: offline 2", "loading", "live"]);
		expect(viewer.times).toEqual([0]);
		held.release();
	});

	it("passes a retry on to its broken dependency, once through a diamond", async () => {
		const Top = local("app.top", { version: 1, params: {}, members: { n: int() } });
		const Left = local("app.left", { version: 1, params: { id: int() }, members: { n: int() } });
		let cores = 0;
		const { host } = await loaded((h) => {
			h.serve(Core, () => {
				if (++cores === 1) throw new Error("bug");
				return { n: constant(cores) };
			});
			h.serve(Left, (_, self) => ({ n: self.get(Core, {}).n }));
			h.serve(Top, (_, self) => {
				const a = self.get(Left, { id: 1 }).n;
				const b = self.get(Left, { id: 2 }).n;
				return { n: self.derive([a, b], ([x, y]) => x + y) };
			});
		});
		const top = host.hold(Top, {}, context);
		await flushed();
		expect(top.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: { message: "waiting for app.left(1): app.core: bug" } },
		});
		await vi.advanceTimersByTimeAsync(60_000);
		// A broken dependency is not retried by any timer.
		expect(cores).toBe(1);
		top.retry();
		await flushed();
		expect(cores).toBe(2);
		expect(top.state.value).toEqual({ kind: "live" });
		expect(top.n.value).toBe(4);
		top.release();
	});

	it("walks a diamond on one host once: a shared parked dependency passes a retry on once (audit A5)", async () => {
		const Top = local("app.top", { version: 1, params: {}, members: { n: int() } });
		const Left = local("app.left", { version: 1, params: { id: int() }, members: { n: int() } });
		const Mid = local("app.mid", { version: 1, params: {}, members: { n: int() } });
		let cores = 0;
		const { host } = await loaded((h) => {
			h.serve(Core, () => {
				if (++cores === 1) throw new Error("bug");
				return { n: constant(cores) };
			});
			h.serve(Mid, (_, self) => ({ n: self.get(Core, {}).n }));
			h.serve(Left, (_, self) => ({ n: self.get(Mid, {}).n }));
			h.serve(Top, (_, self) => {
				const a = self.get(Left, { id: 1 }).n;
				const b = self.get(Left, { id: 2 }).n;
				return { n: self.derive([a, b], ([x, y]) => x + y) };
			});
		});
		const top = host.hold(Top, {}, context);
		await flushed();
		const passed = vi.spyOn(Attempt.prototype, "retryDependencies");
		try {
			top.retry();
			// Top, both lefts, and the shared mid once (its second visit through the other left is ignored).
			expect(passed).toHaveBeenCalledTimes(4);
		} finally {
			passed.mockRestore();
		}
		await flushed();
		expect([cores, top.n.value]).toEqual([2, 4]);
		top.release();
	});

	it("fails every object of a cycle broken; none is retried", async () => {
		const Ping = local("app.ping", { version: 1, params: {}, members: { n: int() } });
		const Pong = local("app.pong", { version: 1, params: {}, members: { n: int() } });
		const factories = { ping: vi.fn(), pong: vi.fn() };
		const { host, errors } = await loaded((h) => {
			h.serve(Ping, (_, self) => {
				factories.ping();
				return { n: self.get(Pong, {}).n };
			});
			h.serve(Pong, (_, self) => {
				factories.pong();
				return { n: self.get(Ping, {}).n };
			});
		});
		expect(failures(errors).sort()).toEqual(["app.ping: broken", "app.pong: broken"]);
		await vi.advanceTimersByTimeAsync(120_000);
		expect([factories.ping.mock.calls.length, factories.pong.mock.calls.length]).toEqual([1, 1]);
		expect(await rejection(host.get(Pong, {}, context))).toEqual({
			code: "invalid",
			reason: "cycle",
			message: "dependency cycle: app.ping → app.pong → app.ping",
		});
	});
});

describe("cycle checks", () => {
	it("stay linear on shared dependencies (a layered graph, every object depending on the whole next layer)", async () => {
		const Layer = local("app.layer", {
			version: 1,
			params: { layer: int(), index: int() },
			members: { depth: int() },
		});
		const layers = 28;
		const { host } = await loaded((h) =>
			h.serve(Layer, ({ layer }, self) => {
				if (layer === layers) return { depth: constant(0) };
				const next = [0, 1].map((index) => self.get(Layer, { layer: layer + 1, index }).depth);
				return { depth: self.derive(next, ([a]) => (a as number) + 1) };
			}),
		);
		const telemetry = await metered();
		const top = await host.get(Layer, { layer: 0, index: 0 }, telemetry.context);
		expect(top.depth.value).toBe(layers);
		// 55 objects, 2 waits each: a search per wait visits at most every object once (an exponential one 2^28 chains).
		expect(telemetry.counts()["chord.cycle.visits"]).toBeLessThanOrEqual(2 * 55 * 55);
	});
});

describe("GC", () => {
	it("collects an ended object with its documents, derives and watches", async () => {
		const refs: WeakRef<object>[] = [];
		const { host } = await loaded((h) => {
			h.serve(Store, (_, self) => serveStore(self));
			h.serve(Page, (_, self) => {
				const list = self.state(List);
				const label = self.derive([list, self.get(Store, {}).count], ([l, c]) => `${l.items.length}/${c}`);
				refs.push(new WeakRef(self), new WeakRef(list), new WeakRef(label));
				return { label, slow: async () => null };
			});
		});
		const store = await host.get(Store, {}, context);
		await (async () => {
			const page = await host.get(Page, { id: 1 }, context);
			const watch = await page.label.watch(context);
			refs.push(new WeakRef(watch), new WeakRef(page));
			page.release();
		})();
		await store.add({ text: "x" }, context);
		await delivered();
		await expectCollected(...refs);
	});

	it("keeps nothing in a released reference or a stopped watch", async () => {
		const { host } = await loaded((h) => h.serve(Store, (_, self) => serveStore(self)));
		const store = await host.get(Store, {}, context);
		const held = await host.get(Store, {}, context);
		const refs = await (async () => {
			const watch = await store.count.watch(context);
			await watch.stop();
			const reference = await host.get(Store, {}, context);
			const watched: Watchable<number> = reference.count;
			await watched.watch(context);
			reference.release();
			return [new WeakRef(watch), new WeakRef(reference)];
		})();
		await held.add({ text: "x" }, context);
		await expectCollected(...refs);
	});
});

describe("GC of released references", () => {
	it("keeps neither the declaring object nor the host in a released self.get reference", async () => {
		const { reference, refs } = await (async () => {
			const refs: WeakRef<object>[] = [];
			let declared: unknown;
			const { host } = await loaded((h) => {
				h.serve(Store, (_, self) => serveStore(self));
				h.serve(Page, (_, self) => {
					declared = self.get(Store, {});
					refs.push(new WeakRef(self));
					return { label: constant(""), slow: async () => null };
				});
			});
			(await host.get(Page, { id: 1 }, context)).release();
			await flushed();
			refs.push(new WeakRef(host));
			return { reference: declared, refs };
		})();
		await expectCollected(...refs);
		expect(reference).toBeDefined();
	});
});

describe("GC of failed objects", () => {
	fakeTimers();

	it("collects one after its last reference while its backoff entry exists; the entry expires on its own", async () => {
		const refs: WeakRef<object>[] = [];
		const { host, errors } = await loaded((h) => {
			h.serve(Store, (_, self) => serveStore(self));
			h.serve(Page, (_, self) => {
				const list = self.state(List);
				const label = self.derive([list, self.get(Store, {}).count], ([l, c]) => `${l.items.length}/${c}`);
				const native = self.open(
					async () => ({ buffer: new Uint8Array(16) }),
					() => {},
				);
				self.open(
					async () => {
						throw new Error("offline");
					},
					() => {},
				);
				const slow = async () => null;
				refs.push(new WeakRef(self), new WeakRef(list), new WeakRef(label), new WeakRef(native), new WeakRef(slow));
				return { label, slow };
			});
		});
		const got = rejection(host.get(Page, { id: 1 }, context, { readyTimeout: 100 }));
		await vi.advanceTimersByTimeAsync(100);
		await got;
		expect(vi.getTimerCount()).toBe(1);
		// The reports' errors keep their stack frames' receivers until formatted (V8): an app logs and drops them.
		errors.length = 0;
		await expectCollected(...refs);
		await vi.advanceTimersByTimeAsync(900);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("GC of a parked chain", () => {
	it("collects a chain parked on a type not served, released from its top: objects, attempts and index entries", async () => {
		const Top = local("app.top", { version: 1, params: { id: int() }, members: { n: int() } });
		const Mid = local("app.mid", { version: 1, params: { id: int() }, members: { n: int() } });
		const Missing = local("app.missing", { version: 1, params: {}, members: { n: int() } });
		const refs: WeakRef<object>[] = [];
		const { host } = await loaded((h) => {
			h.serve(Mid, (_, self) => {
				refs.push(new WeakRef(self));
				return { n: self.get(Missing, {}).n };
			});
			h.serve(Top, ({ id }, self) => {
				refs.push(new WeakRef(self));
				return { n: self.get(Mid, { id }).n };
			});
		});
		const top = host.hold(Top, { id: 1 }, context);
		await flushed();
		expect(top.state.value).toMatchObject({
			kind: "failed",
			cause: {
				kind: "waiting",
				error: { message: "waiting for app.mid(1): app.missing is not served here" },
			},
		});
		top.release();
		await flushed();
		expect(refs).toHaveLength(2);
		await expectCollected(...refs);
		expect(host).toBeDefined();
	});
});

describe("ref.retry()", () => {
	fakeTimers();

	it("skips a transient failure's backoff window: an attempt now", async () => {
		const { times, factory } = flaky((attempt) => attempt === 1);
		const { host } = await loaded((h) => h.serve(Svc, factory));
		const svc = host.hold(Svc, { id: 1 }, context);
		await flushed();
		expect(svc.state.value.kind).toBe("failed");
		vi.advanceTimersByTime(200);
		svc.retry();
		await flushed();
		expect([times, svc.state.value, svc.n.value]).toEqual([[0, 200], { kind: "live" }, 2]);
	});

	it("starts an object waiting for its identity's backoff window at once", async () => {
		const { times, factory } = flaky((attempt) => attempt === 1);
		const { host } = await loaded((h) => h.serve(Svc, factory));
		const first = host.hold(Svc, { id: 1 }, context);
		await flushed();
		// The failed object ends with its reference; its identity's window (1 s) still runs.
		first.release();
		vi.advanceTimersByTime(100);
		const second = host.hold(Svc, { id: 1 }, context);
		await flushed();
		expect([times, second.state.value]).toEqual([[0], { kind: "loading" }]);
		second.retry();
		await flushed();
		expect([times, second.state.value]).toEqual([[0, 100], { kind: "live" }]);
	});

	it("is ignored while an attempt runs and once live (race 11)", async () => {
		const gate = Promise.withResolvers<void>();
		const { times, factory } = flaky((attempt) => attempt === 1, gate.promise);
		const { host } = await loaded((h) => h.serve(Svc, factory));
		const svc = host.hold(Svc, { id: 1 }, context);
		await flushed();
		svc.retry();
		svc.retry();
		await flushed();
		expect(times).toEqual([0, 0]);
		gate.resolve();
		await flushed();
		svc.retry();
		await vi.advanceTimersByTimeAsync(5_000);
		expect([times, svc.state.value]).toEqual([[0, 0], { kind: "live" }]);
	});

	it("renews a broken object for every reference (race 13)", async () => {
		let fixed = false;
		const factory = vi.fn((_: { id: number }, self: Self) => {
			self.open(
				async () => {
					if (!fixed) throw broken(new Error("no configuration"));
				},
				() => {},
			);
			return { n: constant(1) };
		});
		const { host } = await loaded((h) => h.serve(Svc, factory));
		const one = host.hold(Svc, { id: 1 }, context);
		const two = host.hold(Svc, { id: 1 }, context);
		await vi.advanceTimersByTimeAsync(120_000);
		expect([one.state.value.kind, two.state.value.kind, factory.mock.calls.length]).toEqual(["failed", "failed", 1]);
		fixed = true;
		one.retry();
		expect(two.state.value).toEqual({ kind: "loading" });
		await flushed();
		expect([one.state.value, two.state.value]).toEqual([{ kind: "live" }, { kind: "live" }]);
	});
});

describe("linger", () => {
	fakeTimers();
	const Tally = local("app.tally", { version: 1, params: { id: int() }, members: { n: int(), bump: method() } });
	const N = defineState("n", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });

	/** Serves `Tally` with `linger`: a document, a derive that fails at 2, a native whose closes `closes` records. */
	async function tallies(linger: number, open: () => Promise<void> = async () => {}) {
		const closes: string[] = [];
		const factory = vi.fn(({ id }: { id: number }, self: Self) => {
			const doc = self.state(N);
			self.open(open, (_, reason) => void closes.push(`${id} ${reason.kind}`));
			return {
				n: self.derive([doc], ([{ n }]) => {
					if (n === 2) throw new Error("two");
					return n;
				}),
				bump: async (ctx: Context) => {
					await doc.change((draft) => {
						draft.n++;
					}, ctx);
					return null;
				},
			};
		});
		const { host } = await loaded((h) => h.serve(Tally, factory, { linger }));
		return { host, factory, closes };
	}

	it("keeps a live object live for linger after its last release: a get within it reuses it, with its documents", async () => {
		const { host, factory, closes } = await tallies(500);
		const first = await host.get(Tally, { id: 1 }, context);
		await first.bump(context);
		first.release();
		await vi.advanceTimersByTimeAsync(499);
		const second = await host.get(Tally, { id: 1 }, context);
		expect([second.n.value, factory.mock.calls.length, closes]).toEqual([1, 1, []]);
		second.release();
		await vi.advanceTimersByTimeAsync(500);
		expect(closes).toEqual(["1 end"]);
		expect((await host.get(Tally, { id: 1 }, context)).n.value).toBe(0);
		expect(factory).toHaveBeenCalledTimes(2);
	});

	it("a reuse cancels the expiry: the holder count decides, a later release starts a new window (race 8)", async () => {
		const { host, closes } = await tallies(500);
		(await host.get(Tally, { id: 1 }, context)).release();
		await vi.advanceTimersByTimeAsync(499);
		const held = await host.get(Tally, { id: 1 }, context);
		await vi.advanceTimersByTimeAsync(5_000);
		held.release();
		await vi.advanceTimersByTimeAsync(499);
		expect(closes).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(closes).toEqual(["1 end"]);
	});

	it("only a live object lingers: an activating or failed one ends with its last reference (race 9)", async () => {
		const gate = Promise.withResolvers<void>();
		const activating = await tallies(500, () => gate.promise);
		const opening = activating.host.hold(Tally, { id: 1 }, context);
		await flushed();
		opening.release();
		gate.resolve();
		await flushed();
		// Its open's late value was closed at once.
		expect(activating.closes).toEqual(["1 end"]);
		const failing = await tallies(500, async () => {
			throw broken(new Error("no configuration"));
		});
		const failed = failing.host.hold(Tally, { id: 1 }, context);
		await flushed();
		failed.release();
		failing.host.hold(Tally, { id: 1 }, context);
		await flushed();
		expect(failing.factory).toHaveBeenCalledTimes(2);
	});

	it("a failed state member does not end a lingering object", async () => {
		const { host, factory, closes } = await tallies(500);
		const tally = await host.get(Tally, { id: 1 }, context);
		await tally.bump(context);
		await tally.bump(context);
		expect(() => tally.n.value).toThrow("two");
		tally.release();
		await vi.advanceTimersByTimeAsync(400);
		await host.get(Tally, { id: 1 }, context);
		expect([factory.mock.calls.length, closes]).toEqual([1, []]);
	});

	it("host.close ends a lingering object at once", async () => {
		const { host, closes } = await tallies(60_000);
		(await host.get(Tally, { id: 1 }, context)).release();
		await host.close(context);
		expect([closes, vi.getTimerCount()]).toEqual([["1 close"], 0]);
	});

	it("a lingering object is collected after its expiry", async () => {
		const refs: WeakRef<object>[] = [];
		const { host } = await loaded((h) =>
			h.serve(
				Svc,
				({ id }, self) => {
					refs.push(new WeakRef(self));
					return { n: constant(id) };
				},
				{ linger: 100 },
			),
		);
		(await host.get(Svc, { id: 1 }, context)).release();
		await vi.advanceTimersByTimeAsync(100);
		vi.useRealTimers();
		await expectCollected(...refs);
	});
});

/** Every object attempted in this file, weakly: the objects of the cycles among them. */
const attempted = instancesOf(ChordObject, "attempt");

/** On the server: its activation holds `Far` on the session's worker. */
const Near = remote("app.near", {
	version: 1,
	params: { session: str() },
	hostAddress: () => Server(),
	state: { n: int() },
});

/** On the session's worker: its activation holds `Near` back on the server, or, with `local`, `Middle`. */
const Far = remote("app.far", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	state: { n: int() },
});

/** On the server, held by `Far`: its activation holds `Hub` on its own host (a cycle closed on one host). */
const Middle = remote("app.middle", {
	version: 1,
	params: { session: str() },
	hostAddress: () => Server(),
	state: { n: int() },
});

/** On the server, a local type (no principal in its identity): its activation holds `Far` as the host. */
const Hub = local("app.hub", { version: 1, params: { session: str() }, members: { n: int() } });

/** `Loop({ here, there })` lives on `here`'s worker and holds `Loop({ here: there, there: here })`. */
const Loop = remote("app.loop", {
	version: 1,
	params: { here: str(), there: str() },
	hostAddress: ({ here }) => Session({ id: here }),
	state: { n: int() },
});

/** A tab, a server and its workers over trusted route links, serving the cycle types (`Far` holds `back`). */
async function cyclic(back: "near" | "middle" = "near", trusted = true) {
	return relayed({
		trusted,
		server: (h) => {
			h.serve(Near, ({ session }, _principal, self) => ({ n: self.get(Far, { session }).n }));
			h.serve(Middle, ({ session }, _principal, self) => ({ n: self.get(Hub, { session }).n }));
			h.serve(Hub, ({ session }, self) => ({ n: self.get(Far, { session }).n }));
		},
		worker: (h) => {
			h.serve(Far, ({ session }, _principal, self) => ({
				n: back === "near" ? self.get(Near, { session }).n : self.get(Middle, { session }).n,
			}));
			h.serve(Loop, ({ here, there }, _principal, self) => ({ n: self.get(Loop, { here: there, there: here }).n }));
		},
	});
}

describe("cycles across hosts (Q5)", () => {
	it("refuse a hold whose chain names the activation it would bind: server → worker → server", async () => {
		const { tab, errors } = await cyclic();
		const error = await rejection(tab.get(Near, { session: "S1" }, context));
		// The worker's hold back acts as the worker (upward boundary): it meets the cycle one turn later, at that
		// principal's `Near`.
		const message = "dependency cycle: app.near(S1) → … → app.near(S1)";
		expect(error).toEqual({ code: "invalid", reason: "cycle", message });
		// Proposal: every object on the cycle fails broken with the same error, none transient (nothing retries it).
		const failed = new Set(failures([...errors.server, ...errors.worker]));
		expect([...failed].sort()).toEqual(["app.far(S1): broken", "app.near(S1): broken"]);
	});

	it("find a cycle closed on one host through another: server → worker → server, then a local get", async () => {
		const { server } = await cyclic("middle");
		const error = await rejection(server.get(Hub, { session: "S1" }, context));
		expect(error).toEqual({
			code: "invalid",
			reason: "cycle",
			message: "dependency cycle: app.hub(S1) → … → app.middle(S1) → app.hub(S1)",
		});
	});

	it("carry the chain through a relay (race 7): worker → server → worker → server → worker", async () => {
		const { tab, errors } = await cyclic();
		const error = await rejection(tab.get(Loop, { here: "S1", there: "S2" }, context));
		expect(error).toMatchObject({ code: "invalid", reason: "cycle" });
		expect([...new Set(failures(errors.worker))].sort()).toEqual([
			"app.loop(S1|S2): broken",
			"app.loop(S2|S1): broken",
		]);
	});

	it("drop the chain from holds arriving on untrusted links, and send none for holds made outside an activation", async () => {
		const workers: RawPeer[] = [];
		const relay = await relayed({ resolve: rawWorkers(workers) });
		const [a, b] = memoryLinkPair();
		relay.server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
		const tab = new RawPeer(b);
		const forged = "0190f5a2-7c3e-7d4a-9b1c-2d3e4f5a6b7c";
		tab.send({ ...farHold(0), chain: [forged] });
		await transported();
		await transported();
		const held = await workers[0]!.next("hold");
		expect(held.chain).toBeUndefined();
		relay.tab.hold(Far, { session: "S1" }, context);
		expect((await workers[0]!.next("hold")).chain).toBeUndefined();
	});

	it("never match a restarted object: its new instance has a new id (race 8)", async () => {
		// The raw worker holds `Near` on the server itself (as the worker), whose activation holds `Far` back with its
		// chain. The raw worker never binds `Far`.
		const { worker } = await nearBehindRawWorker();
		const chainOf = async () => (await worker.next("hold")).chain!;
		worker.send(nearHold(0));
		const [old] = await chainOf();
		// Released: that instance ends. The next hold makes a new instance with a new id.
		worker.send({ kind: "release", hold: 0 });
		worker.send(nearHold(1));
		const [renewed] = await chainOf();
		expect(renewed).not.toBe(old);
		// A hold naming the old instance binds to the new one (it is pending there); one naming the new one is a cycle.
		worker.send({ ...nearHold(2), chain: [old!] });
		worker.send({ ...nearHold(3), chain: [renewed!] });
		const failed = await worker.next("failed");
		expect(failed).toMatchObject({
			hold: 3,
			cause: { kind: "broken", error: { kind: "chord", error: { reason: "cycle" } } },
		});
		await transported();
		expect(worker.received.filter((message) => message.kind === "failed")).toEqual([]);
	});

	it("keep the last 32 entries of a longer chain: the oldest is dropped (a longer cycle goes undetected)", async () => {
		const { worker } = await nearBehindRawWorker();
		const forged = Array.from(
			{ length: 32 },
			(_, index) => `0190f5a2-7c3e-7d4a-9b1c-${String(index).padStart(12, "0")}`,
		);
		worker.send({ ...nearHold(0), chain: forged });
		const { chain } = await worker.next("hold");
		expect(chain).toHaveLength(32);
		expect(chain!.slice(0, 31)).toEqual(forged.slice(1));
		expect(forged).not.toContain(chain![31]);
	});

	it("miss a cycle entering an activation that started already (documented limitation): both wait, transient", async () => {
		const { relay, worker } = await nearBehindRawWorker();
		// The server's `Near` activates for the tab and holds `Far` with its chain.
		const getting = rejection(relay.tab.get(Near, { session: "S1" }, context, { readyTimeout: 100 }));
		const { chain } = await worker.next("hold");
		// The worker's own activation, started at the same moment, holds that `Near` back with a chain of its own.
		worker.send({ ...nearHold(0), chain: ["0190f5a2-7c3e-7d4a-9b1c-000000000001"] });
		await transported();
		expect(chain).toHaveLength(1);
		expect(worker.received.filter((message) => message.kind === "failed")).toEqual([]);
		expect(await getting).toMatchObject({ code: "unavailable" });
	});

	it("keep no object, and so no chain, once released (GC)", async () => {
		const refs = await (async () => {
			const made = attempted.length;
			const { tab, server } = await cyclic();
			await rejection(tab.get(Near, { session: "S1" }, context));
			await transported();
			const refs = attempted.slice(made);
			expect(refs.length).toBeGreaterThanOrEqual(4);
			await tab.close(context);
			await server.close(context);
			return refs;
		})();
		await expectCollected(...refs);
	});
});

/**
 * A server serving `Near` (its activation holds `Far`) and a raw worker for S1 over a trusted route link, made by a
 * first hold of `Far` and with that hold taken.
 */
async function nearBehindRawWorker() {
	const workers: RawPeer[] = [];
	const relay = await relayed({
		resolve: rawWorkers(workers, { trusted: true }),
		server: (h) => h.serve(Near, ({ session }, _principal, self) => ({ n: self.get(Far, { session }).n })),
	});
	relay.tab.hold(Far, { session: "S1" }, context);
	const worker = await (async () => {
		for (let tries = 0; workers[0] === undefined && tries < 10; tries++) await transported();
		return workers[0]!;
	})();
	await worker.next("hold");
	return { relay, worker };
}

/** A hold of `Far` for S1, as a tab sends it. */
function farHold(hold: number): Extract<Message, { kind: "hold" }> {
	const { name: type, version, fingerprint } = Far;
	const address = { kind: "session", params: { id: "S1" } };
	return { kind: "hold", hold, type, version, fingerprint, params: jsonPart({ session: "S1" }), address };
}

/** A hold of `Near` for S1, as a worker sends it to the server. */
function nearHold(hold: number): Extract<Message, { kind: "hold" }> {
	const { name: type, version, fingerprint } = Near;
	return {
		kind: "hold",
		hold,
		type,
		version,
		fingerprint,
		params: jsonPart({ session: "S1" }),
		address: SERVER_ADDRESS,
	};
}

describe("a failed activation's cleanup (audit)", () => {
	it("closes the natives that opened before it releases its references: a close may use them", async () => {
		const Dependent = local("app.dependent", { version: 1, params: { id: int() }, members: { n: int() } });
		const seen: unknown[] = [];
		const { host, errors } = await loaded((h) => {
			h.serve(Core, () => ({ n: constant(5) }));
			h.serve(Dependent, (_, self) => {
				const core = self.get(Core, {});
				self.open(
					async () => null,
					() => {
						try {
							seen.push(core.n.value);
						} catch (error) {
							seen.push(String(error));
						}
					},
				);
				self.open(
					async () => {
						throw broken(new Error("open failed"));
					},
					() => {},
				);
				return { n: core.n };
			});
		});
		await expect(host.get(Dependent, { id: 1 }, context)).rejects.toThrow("open failed");
		await flushed();
		expect(errors.find(({ kind }) => kind === "activation_failed")).toMatchObject({ failure: { kind: "broken" } });
		expect(seen).toEqual([5]);
		await host.close(context);
	});
});

describe("a live object failing (slice 6a §1.4)", () => {
	it("fails broken: calls reject with the cause, one object_failed report, natives close, then references go", async () => {
		const events: string[] = [];
		let list: Watchable<unknown> | undefined;
		const { reference, fail, errors } = await restartable(
			attempted,
			(_, self) => {
				list = self.state(List);
				const core = self.get(Core, {});
				self.open(
					async () => null,
					() => {
						events.push(`close sees core ${core.n.value}`);
					},
				);
			},
			{ serve: (h) => h.serve(Core, () => ({ n: constant(1) })) },
		);
		const states: string[] = [];
		(await reference.state.watch(context)).start(async (call) => {
			if (call.kind === "value") states.push(call.value.kind);
		});
		fail();
		const touched = rejection(reference.touch(context));
		expect(await touched).toMatchObject({ code: "unavailable", message: "boom" });
		expect(errors).toEqual([expect.objectContaining({ kind: "object_failed", object: "app.restartable(1)" })]);
		// A failure of the sealed attempt is ignored.
		fail();
		await flushed();
		expect(events).toEqual(["close sees core 1"]);
		expect(errors.length).toBe(1);
		expect(list!.value).toEqual({ items: [] });
		await delivered();
		expect(states).toEqual(["failed"]);
	});

	it("keeps its state members' last values for same-host reads; a live dependent's derive over them stays live", async () => {
		const Viewer = local("app.count-viewer", { version: 1, params: {}, members: { tens: int() } });
		let store: Self | undefined;
		const { host, errors } = await loaded((h) => {
			h.serve(Store, (_, self) => {
				store = self;
				return serveStore(self);
			});
			h.serve(Viewer, (_, self) => ({ tens: self.derive([self.get(Store, {}).count], ([n]) => n * 10) }));
		});
		const ref = await host.get(Store, {}, context);
		await ref.add({ text: "a" }, context);
		const viewer = await host.get(Viewer, {}, context);
		const tens = changesOf(await viewer.tens.watch(context));
		// A change committed in the turn of the failure: the frozen member computes it.
		await ref.add({ text: "b" }, context);
		failLive(attempted, store!, new ChordError({ code: "unavailable", message: "boom" }));
		expect(ref.count.value).toBe(2);
		expect(await rejection(ref.add({ text: "c" }, context))).toMatchObject({ message: "boom" });
		expect(viewer.state.value).toEqual({ kind: "live" });
		expect(viewer.tens.value).toBe(20);
		await delivered();
		expect(valuesOf(tens)).toEqual([20]);
		expect(errors.map(({ kind }) => kind)).toEqual(["object_failed"]);
		// A retry takes the new attempt's members.
		ref.retry();
		(await host.get(Store, {}, context)).release();
		expect(ref.count.value).toBe(2);
		await host.close(context);
	});

	it("lets a commit admitted before the failure adopt and publish once, derives and dependents included", async () => {
		const Counter = defineState("counter", { ...COUNTER, persist: true, checkpointWhen: () => false });
		const Doubled = local("app.doubled", { version: 1, params: {}, members: { double: int() } });
		const Viewer = local("app.double-viewer", { version: 1, params: {}, members: { tens: int() } });
		const store = await memoryStore();
		let self: Self | undefined;
		let counter: SingletonHandle<{ n: number }> | undefined;
		const { host } = await loaded(
			(h) => {
				h.serve(Doubled, (_, s) => {
					self = s;
					counter = s.state(Counter);
					return { double: s.derive([counter], ([c]) => c.n * 2) };
				});
				h.serve(Viewer, (_, s) => ({ tens: s.derive([s.get(Doubled, {}).double], ([n]) => n * 10) }));
			},
			{ store },
		);
		const ref = await host.get(Doubled, {}, context);
		const viewer = await host.get(Viewer, {}, context);
		const doubles = changesOf(await ref.double.watch(context));
		const tens = changesOf(await viewer.tens.watch(context));
		const held = holdNextCommit(store);
		const change = counter!.change((draft) => {
			draft.n = 1;
		}, context);
		await held.entered;
		failLive(attempted, self!, new ChordError({ code: "unavailable", message: "boom" }));
		held.release();
		await change;
		await delivered();
		expect(ref.state.value.kind).toBe("failed");
		expect([counter!.value, ref.double.value, viewer.tens.value]).toEqual([{ n: 1 }, 2, 20]);
		// The admitted commit publishes once; then the reference's member holds it (the failure once). A derive over it
		// keeps its last value.
		expect(valuesOf(doubles)).toEqual([2, { failed: "boom" }]);
		expect(valuesOf(tens)).toEqual([20]);
		await host.close(context);
		await store.close(context);
	});

	it("starts a retry's factory only once a commit admitted before the failure adopted", async () => {
		const V1 = defineState("counter", { ...COUNTER, persist: true, checkpointWhen: () => false });
		const V2 = defineState("counter", {
			schema: obj({ m: int() }),
			version: 2,
			initial: () => ({ m: 0 }),
			migrate: (old) => ({ m: (old as { n: number }).n }),
			persist: true,
			checkpointWhen: () => false,
		});
		const store = await memoryStore();
		const counters: SingletonHandle<{ n: number } | { m: number }>[] = [];
		const { host, reference, attempts } = await storeRestartable(
			attempted,
			(attempt, self) => void counters.push(self.state(attempt === 1 ? V1 : V2)),
			{ store, closeTimeout: 5 },
		);
		const v1 = counters[0] as SingletonHandle<{ n: number }>;
		await v1.change((draft) => {
			draft.n = 1;
		}, context);
		const held = holdNextCommit(store);
		const change = v1.change((draft) => {
			draft.n = 2;
		}, context);
		await held.entered;
		failLive(attempted, attempts[0]!, new ChordError({ code: "unavailable", message: "boom" }));
		// Past the drain: only the admitted step holds the retry.
		await new Promise((resolve) => setTimeout(resolve, 20));
		reference.retry();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(counters).toHaveLength(1);
		held.release();
		await change;
		(await host.get(StoreRestartable, {}, context)).release();
		expect(counters[1]!.value).toEqual({ m: 2 });
		await host.close(context);
		await store.close(context);
	});

	it("is recovered by ref.retry(): a new attempt, the documents as they were", async () => {
		const lists: SingletonHandle<{ items: string[] }>[] = [];
		const { restart } = await restartable(attempted, (_, self) => {
			lists.push(self.state(List));
		});
		await lists[0]!.change((draft) => void draft.items.push("a"), context);
		await restart();
		expect(lists[1]!.value).toEqual({ items: ["a"] });
	});
});

/** Reloads `host`'s plugin `@test/app` (as `loaded` names it) with a facet whose setup is `setup`. */
function reloadApp(host: Host, setup: (host: FacetHost, self: FacetSelf) => void) {
	return host.reload([{ name: "@test/app", facet: defineFacet(setup) }], context);
}

/** A local object with empty params: a counter document, `bump` (which waits for `gate` when given) and `label`. */
const Pure = local("app.pure", {
	version: 1,
	params: {},
	members: { n: int(), label: str(), bump: method(undefined, int()) },
});

/** Serves `Pure` labelled `label`; `bump` adds `by`, first awaiting `gates.shift()` when one is queued. */
function servePure(h: FacetHost, label: string, by: number, gates: Promise<void>[] = []): void {
	h.serve(Pure, (_, self) => {
		const doc = self.state(defineState("pure", COUNTER));
		return {
			n: self.derive([doc], ([d]) => d.n),
			label: constant(label),
			bump: async (ctx: Context) => {
				await gates.shift();
				await doc.change((draft) => {
					draft.n += by;
				}, ctx);
				return doc.value.n;
			},
		};
	});
}

describe('reload: fates (decision "Reload restarts every affected object")', () => {
	it("restarts a live object: its documents kept, new code for new calls", async () => {
		const { host } = await loaded((h) => servePure(h, "v1", 1));
		const pure = await host.get(Pure, {}, context);
		await pure.bump(context);
		const objects = instancesOf(ChordObject, "reloadFate");
		const report = await reloadApp(host, (h) => servePure(h, "v2", 10));
		expect(report.objects).toEqual([{ object: "app.pure", kind: "restarted" }]);
		expect(objects).toHaveLength(1);
		await flushed();
		expect(pure.state.value).toEqual({ kind: "live" });
		expect(pure.label.value).toBe("v2");
		expect(await pure.bump(context)).toBe(11);
		await host.close(context);
	});

	it("shows the old attempt live while it drains, closes its natives with reason reload, then opens the new ones", async () => {
		const closes: string[] = [];
		const serve = (h: FacetHost, label: string, gates: Promise<void>[] = []) =>
			h.serve(Pure, (_, self) => {
				const doc = self.state(defineState("pure", COUNTER));
				self.open(
					async () => label,
					(value, reason) => void closes.push(`${value} ${reason.kind}`),
				);
				return {
					n: self.derive([doc], ([d]) => d.n),
					label: constant(label),
					bump: async (ctx: Context) => {
						await gates.shift();
						await doc.change((draft) => {
							draft.n += 1;
						}, ctx);
						closes.push(`bump done on ${label}`);
						return doc.value.n;
					},
				};
			});
		const gate = Promise.withResolvers<void>();
		const { host } = await loaded((h) => serve(h, "v1", [gate.promise]));
		const pure = await host.get(Pure, {}, context);
		const running = pure.bump(context);
		await flushed();
		const report = await reloadApp(host, (h) => serve(h, "v2"));
		expect(report.objects).toEqual([{ object: "app.pure", kind: "restarted" }]);
		// The old attempt binds this reference's version: it sees it live while it drains (rule 5).
		expect(pure.state.value).toEqual({ kind: "live" });
		// A new call waits at the gate until the new attempt is live.
		const waiting = pure.bump(context);
		await flushed();
		expect(closes).toEqual([]);
		gate.resolve();
		expect(await running).toBe(1);
		expect(await waiting).toBe(2);
		expect(closes).toEqual(["bump done on v1", "v1 reload", "bump done on v2"]);
		expect(pure.label.value).toBe("v2");
		await host.close(context);
	});

	it("ends the objects of a removed type: its holders wait not_served, and bind again when it is served again", async () => {
		const { host, errors } = await loaded((h) => servePure(h, "v1", 1));
		const pure = host.hold(Pure, {}, context);
		await flushed();
		await pure.bump(context);
		const label = await pure.label.watch(context);
		const frames = changesOf(label);
		const report = await host.reload([], context);
		expect(report).toEqual({
			plugins: { added: [], changed: [], removed: ["@test/app"] },
			failed: [],
			objects: [{ object: "app.pure", kind: "ended" }],
		});
		expect(pure.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: { code: "unavailable", message: "app.pure is not served here" } },
		});
		// The member keeps its last value while waiting.
		expect(pure.label.value).toBe("v1");
		await host.reload([{ name: "@test/app", facet: defineFacet((h) => servePure(h, "v2", 1)) }], context);
		await flushed();
		expect(pure.state.value).toEqual({ kind: "live" });
		// A new object: in-memory documents went with the old one.
		expect(pure.n.value).toBe(0);
		await delivered();
		// The removal's failure once, then the new object's value, whole.
		expect(valuesOf(frames)).toEqual([{ failed: "app.pure is not served here" }, "v2"]);
		expect(failures(errors)).toEqual([]);
		await host.close(context);
	});

	it("a live local dependent of a removed type keeps its last value; served again, its derive heals (one frame)", async () => {
		const Panel = local("app.panel", { version: 1, params: {}, members: { text: str() } });
		const panel = defineFacet((h) =>
			h.serve(Panel, (_, self) => {
				const pure = self.get(Pure, {});
				return { text: self.derive([pure.label], ([label]) => `panel ${label}`) };
			}),
		);
		const host = createHost({ onError: () => {} });
		await host.load(
			[
				{ name: "@test/app", facet: defineFacet((h) => servePure(h, "v1", 1)) },
				{ name: "@test/panel", facet: panel },
			],
			context,
		);
		const view = await host.get(Panel, {}, context);
		const text = changesOf(await view.text.watch(context));
		await host.reload([{ name: "@test/panel", facet: panel }], context);
		expect(view.state.value).toEqual({ kind: "live" });
		expect(view.text.value).toBe("panel v1");
		await host.reload(
			[
				{ name: "@test/app", facet: defineFacet((h) => servePure(h, "v2", 1)) },
				{ name: "@test/panel", facet: panel },
			],
			context,
		);
		await flushed();
		expect(view.text.value).toBe("panel v2");
		await delivered();
		expect(valuesOf(text)).toEqual(["panel v2"]);
		await host.close(context);
	});

	it("retries a failed object on the new code", async () => {
		const { host } = await loaded((h) =>
			h.serve(Pure, () => {
				throw new Error("bug");
			}),
		);
		const pure = host.hold(Pure, {}, context);
		await flushed();
		expect(pure.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken" } });
		const report = await reloadApp(host, (h) => servePure(h, "fixed", 1));
		expect(report.objects).toEqual([{ object: "app.pure", kind: "retried" }]);
		await flushed();
		expect(pure.state.value).toEqual({ kind: "live" });
		expect(pure.label.value).toBe("fixed");
		await host.close(context);
	});

	it("reports a restart parked whose new factory needs a missing dependency; it goes live once that is served", async () => {
		const Dep = local("app.dep", { version: 1, params: {}, members: { name: str() } });
		const { host } = await loaded((h) => servePure(h, "v1", 1));
		const pure = await host.get(Pure, {}, context);
		const needsDep = (h: FacetHost) =>
			h.serve(Pure, (_, self) => {
				const dep = self.get(Dep, {});
				return {
					n: constant(0),
					label: self.derive([dep.name], ([name]) => `with ${name}`),
					bump: async () => 0,
				};
			});
		const report = await reloadApp(host, needsDep);
		expect(report.objects).toEqual([
			{
				object: "app.pure",
				kind: "parked",
				cause: { kind: "waiting", error: expect.objectContaining({ message: expect.stringContaining("app.dep") }) },
			},
		]);
		expect(pure.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		expect(await rejection(pure.bump(context))).toMatchObject({ code: "unavailable" });
		await host.reload(
			[
				{ name: "@test/app", facet: defineFacet(needsDep) },
				{ name: "@test/dep", facet: defineFacet((h) => h.serve(Dep, () => ({ name: constant("dep") }))) },
			],
			context,
		);
		await flushed();
		expect(pure.state.value).toEqual({ kind: "live" });
		expect(pure.label.value).toBe("with dep");
		await host.close(context);
	});
});

describe("reload: a restart's readiness while the old attempt drains", () => {
	it("shows a failed request while it lasts: a request that recovers shows the object live again, new calls wait", async () => {
		const Flaky = local("app.flaky", { version: 1, params: { id: int() }, members: { name: str() } });
		let failing = true;
		const flaky = defineFacet((h) =>
			h.serve(Flaky, (_, self) => {
				self.open(
					async () => {
						if (failing) throw new Error("flaky is down");
						return null;
					},
					() => {},
				);
				return { name: constant("flaky") };
			}),
		);
		const gate = Promise.withResolvers<void>();
		const gates = [gate.promise];
		const host = createHost({ onError: () => {} });
		await host.load(
			[
				{ name: "@test/app", facet: defineFacet((h) => servePure(h, "v1", 1, gates)) },
				{ name: "@test/flaky", facet: flaky },
			],
			context,
		);
		const pure = await host.get(Pure, {}, context);
		const down = host.hold(Flaky, { id: 1 }, context);
		await vi.waitFor(() => expect(down.state.value.kind).toBe("failed"));
		const running = pure.bump(context);
		await flushed();
		const needsFlaky = (h: FacetHost) =>
			h.serve(Pure, (_, self) => {
				self.get(Flaky, { id: 1 });
				return { n: constant(0), label: constant("v2"), bump: async () => 2 };
			});
		await host.reload(
			[
				{ name: "@test/app", facet: defineFacet(needsFlaky) },
				{ name: "@test/flaky", facet: flaky },
			],
			context,
		);
		// The successor's request failed: holders see it while it lasts (old work still runs on the old attempt).
		expect(pure.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		failing = false;
		down.retry();
		await vi.waitFor(() => expect(down.state.value.kind).toBe("live"));
		// Recovered during the drain: the old attempt is shown again, and a new call waits for the new code.
		expect(pure.state.value).toEqual({ kind: "live" });
		const next = pure.bump(context);
		gate.resolve();
		expect(await running).toBe(1);
		expect(await next).toBe(2);
		expect(pure.label.value).toBe("v2");
		down.release();
		await host.close(context);
	});
});

describe("reload: a restart's old attempt (rules 1-4)", () => {
	it("lets a running call finish on the old attempt's handles; a new call waits at the gate for the new code", async () => {
		const gate = Promise.withResolvers<void>();
		const { host } = await loaded((h) => servePure(h, "v1", 1, [gate.promise]));
		const pure = await host.get(Pure, {}, context);
		const old = pure.bump(context);
		await flushed();
		await reloadApp(host, (h) => servePure(h, "v2", 10));
		// The old call commits through its old handle after the commit.
		gate.resolve();
		expect(await old).toBe(1);
		expect(await pure.bump(context)).toBe(11);
		await host.close(context);
	});

	it("old work writes a document whose version the reload raises; the new code migrates what it wrote", async () => {
		const V1 = defineState("doc", COUNTER);
		const V2 = defineState("doc", {
			schema: obj({ n: int(), unit: str() }),
			version: 2,
			initial: () => ({ n: 0, unit: "" }),
			migrate: (old) => ({ n: old.n as number, unit: "pcs" }),
		});
		const gate = Promise.withResolvers<void>();
		const serve = (h: FacetHost, definition: typeof V1 | typeof V2, gates: Promise<void>[]) =>
			h.serve(Pure, (_, self) => {
				const doc = self.state(definition as typeof V1);
				return {
					n: self.derive([doc], ([d]) => d.n),
					label: self.derive([doc], ([d]) => JSON.stringify(d)),
					bump: async (ctx: Context) => {
						await gates.shift();
						await doc.change((draft) => {
							draft.n += 1;
						}, ctx);
						return doc.value.n;
					},
				};
			});
		const { host } = await loaded((h) => serve(h, V1, [Promise.resolve(), gate.promise]));
		const pure = await host.get(Pure, {}, context);
		await pure.bump(context);
		const old = pure.bump(context);
		await flushed();
		await reloadApp(host, (h) => serve(h, V2, []));
		await flushed();
		// The new factory has not run: the old attempt's documents are as the old code declared them.
		expect(pure.label.value).toBe('{"n":1}');
		gate.resolve();
		expect(await old).toBe(2);
		await flushed();
		expect(pure.label.value).toBe('{"n":2,"unit":"pcs"}');
		expect(await pure.bump(context)).toBe(3);
		await host.close(context);
	});

	it("binds the new attempt's requests before releasing the old one's: a dependency held only by it never ends", async () => {
		const Dep = local("app.dep", {
			version: 1,
			params: { id: int() },
			members: { n: int(), set: method(obj({ n: int() })) },
		});
		const dep = defineFacet((h) =>
			h.serve(Dep, (_, self) => {
				const doc = self.state(defineState("dep", COUNTER));
				return {
					n: self.derive([doc], ([d]) => d.n),
					set: async ({ n }: { n: number }, ctx: Context) => {
						await doc.change((draft) => {
							draft.n = n;
						}, ctx);
						return null;
					},
				};
			}),
		);
		const app = (label: string) =>
			defineFacet((h) =>
				h.serve(Pure, (_, self) => {
					const held = self.get(Dep, { id: 1 });
					return {
						n: self.derive([held.n], ([n]) => n),
						label: constant(label),
						bump: async (ctx: Context) => {
							await held.set({ n: 7 }, ctx);
							return 7;
						},
					};
				}),
			);
		const host = createHost({ onError: () => {} });
		await host.load(
			[
				{ name: "@test/app", facet: app("v1") },
				{ name: "@test/dep", facet: dep },
			],
			context,
		);
		const pure = await host.get(Pure, {}, context);
		await pure.bump(context);
		await host.reload(
			[
				{ name: "@test/app", facet: app("v2") },
				{ name: "@test/dep", facet: dep },
			],
			context,
		);
		await flushed();
		// The dependency's in-memory document is still there: its object never ended in between.
		expect(pure.label.value).toBe("v2");
		expect(pure.n.value).toBe(7);
		await host.close(context);
	});

	it("re-binds members by name (one frame from the last value) and rebuilds internal derives", async () => {
		const { host } = await loaded((h) => servePure(h, "v1", 1));
		const pure = await host.get(Pure, {}, context);
		const label = changesOf(await pure.label.watch(context));
		const n = changesOf(await pure.n.watch(context));
		await pure.bump(context);
		await reloadApp(host, (h) => servePure(h, "v2", 1));
		await delivered();
		expect(label).toEqual([{ kind: "value", value: "v2", ops: [["r", "v2"]], retired: false }]);
		// Its derive over the same document gave the same value: no frame besides the commit's.
		expect(valuesOf(n)).toEqual([1]);
		await host.close(context);
	});

	it("stops its routines at once; their calls drain before the new ones start", async () => {
		const events: string[] = [];
		const release = Promise.withResolvers<void>();
		const serve = (h: FacetHost, label: string) =>
			h.serve(Pure, (_, self) => {
				self.onLive(async (ctx) => {
					events.push(`${label} started`);
					await untilAborted(ctx);
					if (label === "v1") await release.promise;
					events.push(`${label} stopped`);
				});
				return { n: constant(0), label: constant(label), bump: async () => 0 };
			});
		const { host } = await loaded((h) => serve(h, "v1"));
		await host.get(Pure, {}, context);
		await flushed();
		await reloadApp(host, (h) => serve(h, "v2"));
		await flushed();
		expect(events).toEqual(["v1 started"]);
		release.resolve();
		await flushed();
		expect(events).toEqual(["v1 started", "v1 stopped", "v2 started"]);
		await host.close(context);
	});

	it("starts a writable at its new initial value and replaces the contributions in one batch", async () => {
		const Tools = defineRegistry<string[], string[]>("app.tools", { version: 1 });
		const compositions: string[][] = [];
		const registry = defineFacet((h) =>
			h.serve(Tools, {
				compose: (table) => {
					const value = table.flatMap((entry) => entry.value);
					compositions.push(value);
					return value;
				},
			}),
		);
		const app = (tool: string) =>
			defineFacet((h) =>
				h.serve(Pure, (_, own) => {
					const tools = own.writable([tool]);
					(own as unknown as StoreSelf).contribute(Tools, tools);
					return { n: constant(0), label: constant(tool), bump: async () => tools.value.length };
				}),
			);
		const host = createHost({ onError: () => {} });
		await host.load(
			[
				{ name: "@test/app", facet: app("a") },
				{ name: "@test/tools", facet: registry },
			],
			context,
		);
		const tools = await host.registry(Tools, context);
		expect(tools.value).toEqual(["a"]);
		compositions.length = 0;
		await host.reload(
			[
				{ name: "@test/app", facet: app("b") },
				{ name: "@test/tools", facet: registry },
			],
			context,
		);
		await flushed();
		expect(tools.value).toEqual(["b"]);
		// One composition with the new table, never one without a contribution in between.
		expect(compositions).toEqual([["b"]]);
		await host.close(context);
	});
});

describe("reload: a stuck routine call past the drain", () => {
	fakeTimers();

	it("an old routine call stuck past the reload drain bound: drain_timeout, the old attempt sealed, its commit refused", async () => {
		const stuck = Promise.withResolvers<void>();
		let late: Promise<unknown> | undefined;
		const errors: HostError[] = [];
		const serve = (h: FacetHost, label: string) =>
			h.serve(Pure, (_, self) => {
				const doc = self.state(defineState("pure", COUNTER));
				self.onLive(async (ctx) => {
					if (label !== "v1") return;
					await stuck.promise;
					late = rejection(
						self.tx(async (tx) => {
							(await tx.draft(doc)).n = 99;
						}, ctx),
					);
				});
				return { n: self.derive([doc], ([d]) => d.n), label: constant(label), bump: async () => 0 };
			});
		const host = createHost({ closeTimeout: 1_000, onError: (error) => errors.push(error) });
		await host.load([{ name: "@test/app", facet: defineFacet((h) => serve(h, "v1")) }], context);
		const pure = await host.get(Pure, {}, context);
		await reloadApp(host, (h) => serve(h, "v2"));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(errors.map(({ kind }) => kind)).toContain("drain_timeout");
		stuck.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(await late).toMatchObject({ code: "released" });
		expect(pure.n.value).toBe(0);
		await host.close(context);
	});
});

/** The provider of the old-work shapes: `work` reaches back into the plugin after its gate; `x` answers at once. */
const Provider = local("app.provider", {
	version: 1,
	params: {},
	members: { work: method(undefined, str()), x: method(undefined, str()) },
});

/** `Provider` raised by a reload: a new member, `accepts` keeping version 1. */
const ProviderV2 = evolve(Provider, (e) => e.addState("extra", str()));

/** The dependent of the old-work shapes: it holds the provider; `ping` may call it back. */
const Dependent = local("app.dependent", {
	version: 1,
	params: {},
	members: { ping: method(undefined, str()), slow: method(undefined, str()) },
});

/** `Dependent` raised by a reload: a new member, `accepts` keeping version 1. */
const DependentV2 = evolve(Dependent, (e) => e.addState("extra", str()));

/** A third object the shapes create or chain through: it holds the provider. */
const Third = local("app.third", { version: 1, params: { id: str() }, members: { ping: method(undefined, str()) } });

/** How a shape's plugin behaves: what `work` does after its gate, what `ping` does, which contracts the reload raises. */
type Shape = {
	readonly work: (ctx: Ctx, code: string) => Promise<string>;
	readonly ping?: (provider: Reference<typeof Provider>, ctx: Ctx, code: string) => Promise<string>;
	readonly slow?: (provider: Reference<typeof Provider>, ctx: Ctx, code: string) => Promise<string>;
	readonly raise?: "provider" | "both";
};

/** The shape's plugin at `code` (`v1`, then `v2` for the reload); `work` and `slow` first await `gates.shift()`. */
function shapePlugin(code: string, shape: Shape, gates: Promise<void>[]) {
	const raised = code !== "v1";
	const P = raised && shape.raise !== undefined ? ProviderV2 : Provider;
	const D = raised && shape.raise === "both" ? DependentV2 : Dependent;
	const extra = P === ProviderV2 ? { extra: constant("x") } : {};
	return defineFacet((h) => {
		h.serve(
			P as typeof Provider,
			() => ({
				...extra,
				work: async (ctx: Ctx) => {
					await gates.shift();
					return shape.work(ctx, code);
				},
				x: async () => `${code} x`,
			}),
			P === ProviderV2 ? { accepts: { 1: {} } } : {},
		);
		h.serve(
			D as typeof Dependent,
			(_, self) => {
				const provider = self.get(P as typeof Provider, {});
				return {
					...(D === DependentV2 ? { extra: constant("x") } : {}),
					ping: async (ctx: Ctx) => (shape.ping === undefined ? `${code} ping` : shape.ping(provider, ctx, code)),
					slow: async (ctx: Ctx) => {
						await gates.shift();
						return shape.slow === undefined ? `${code} slow` : shape.slow(provider, ctx, code);
					},
				};
			},
			D === DependentV2 ? { accepts: { 1: {} } } : {},
		);
		h.serve(Third, (_, self) => {
			self.get(P as typeof Provider, {});
			return { ping: async () => `${code} third` };
		});
	});
}

/**
 * Loads the shape, starts the provider's `work` (held at a gate), reloads to `v2` and opens the gate: resolves with
 * `work`'s answer (or its error's message) and how long it took after the gate opened.
 */
async function runShape(shape: Shape, options: { readonly before?: (host: Host) => Promise<void> } = {}) {
	const gates: Promise<void>[] = [];
	const gate = Promise.withResolvers<void>();
	const host = createHost({ onError: () => {} });
	await host.load([{ name: "@test/app", facet: shapePlugin("v1", shape, gates) }], context);
	const provider = await host.get(Provider, {}, context);
	await host.get(Dependent, {}, context);
	await options.before?.(host);
	gates.push(gate.promise);
	const work = provider.work(context).catch((error: Error) => `rejected: ${error.message}`);
	await flushed();
	await host.reload([{ name: "@test/app", facet: shapePlugin("v2", shape, gates) }], context);
	const opened = performance.now();
	gate.resolve();
	const answer = await work;
	const took = performance.now() - opened;
	await host.close(context);
	return { answer, took };
}

describe('reload: old work finishes on old code (decision "Reload restarts every affected object")', () => {
	it("a provider's running call reaches its dependent through ctx.get while both restart: no stall", async () => {
		const { answer, took } = await runShape({
			work: async (ctx, code) => `${code} work -> ${await (await ctx.get(Dependent, {})).ping(ctx)}`,
		});
		// The dependent's new attempt binds the provider's open old attempt (rule 5) and goes live.
		expect(answer).toBe("v1 work -> v2 ping");
		expect(took).toBeLessThan(1_000);
	});

	it("a chain of three: the work reaches an object whose new attempt needs the dependent, which needs the provider", async () => {
		const { answer } = await runShape({
			work: async (ctx, code) => `${code} work -> ${await (await ctx.get(Third, { id: "a" })).ping(ctx)}`,
		});
		expect(answer).toBe("v1 work -> v2 third");
	});

	it("re-entry: work → dependent → the provider again runs on the provider's old attempt", async () => {
		const { answer } = await runShape({
			work: async (ctx, code) => `${code} work -> ${await (await ctx.get(Dependent, {})).ping(ctx)}`,
			ping: async (provider, ctx, code) => `${code} ping -> ${await provider.x(ctx)}`,
		});
		expect(answer).toBe("v1 work -> v2 ping -> v1 x");
	});

	it("self re-entry: work → ctx.get of its own object runs on its old attempt", async () => {
		const { answer } = await runShape({
			work: async (ctx, code) => `${code} work -> ${await (await ctx.get(Provider, {})).x(ctx)}`,
		});
		expect(answer).toBe("v1 work -> v1 x");
	});

	it("mutual drains: the provider's call reaches the dependent while the dependent's call reaches the provider", async () => {
		const gates: Promise<void>[] = [];
		const shape: Shape = {
			work: async (ctx, code) => `${code} work -> ${await (await ctx.get(Dependent, {})).ping(ctx)}`,
			slow: async (provider, ctx, code) => `${code} slow -> ${await provider.x(ctx)}`,
		};
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@test/app", facet: shapePlugin("v1", shape, gates) }], context);
		const provider = await host.get(Provider, {}, context);
		const dependent = await host.get(Dependent, {}, context);
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		gates.push(first.promise, second.promise);
		const work = provider.work(context);
		const slow = dependent.slow(context);
		await flushed();
		await host.reload([{ name: "@test/app", facet: shapePlugin("v2", shape, gates) }], context);
		second.resolve();
		first.resolve();
		expect(await slow).toBe("v1 slow -> v1 x");
		expect(await work).toMatch(/^v1 work -> v[12] ping$/);
		await host.close(context);
	});

	it("the reload raises the provider's version and the dependent's new code needs it: the work runs on the dependent's old attempt", async () => {
		const { answer, took } = await runShape({
			raise: "provider",
			work: async (ctx, code) => `${code} work -> ${await (await ctx.get(Dependent, {})).ping(ctx)}`,
		});
		// The dependent's successor waits for the provider's: its old attempt stays open for old work (rule 3).
		expect(answer).toBe("v1 work -> v1 ping");
		expect(took).toBeLessThan(1_000);
	});

	it("both versions raised (with accepts): old work's getter at the old version binds the dependent's open old attempt", async () => {
		const { answer } = await runShape({
			raise: "both",
			work: async (ctx, code) => `${code} work -> ${await (await ctx.get(Dependent, {})).ping(ctx)}`,
		});
		expect(answer).toBe("v1 work -> v1 ping");
	});

	it("old work asking for a version the new code dropped, with no old attempt serving it, fails at once", async () => {
		const Dropped = local("app.dropped", { version: 1, params: {}, members: { ping: method(undefined, str()) } });
		const Raised = local("app.dropped", {
			version: 2,
			params: {},
			members: { ping: method(undefined, str()), n: int() },
		});
		const app = (code: string, gate: Promise<void>) =>
			defineFacet((h) => {
				h.serve(Provider, () => ({
					work: async (ctx: Ctx) => {
						await gate;
						return (await ctx.get(Dropped, {})).ping(ctx);
					},
					x: async () => code,
				}));
				if (code === "v1") h.serve(Dropped, () => ({ ping: async () => "v1 ping" }));
				else h.serve(Raised, () => ({ ping: async () => "v2 ping", n: constant(0) }));
			});
		const gate = Promise.withResolvers<void>();
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@test/app", facet: app("v1", gate.promise) }], context);
		const provider = await host.get(Provider, {}, context);
		const work = rejection(provider.work(context));
		await flushed();
		await host.reload([{ name: "@test/app", facet: app("v2", gate.promise) }], context);
		const opened = performance.now();
		gate.resolve();
		// No object of the dropped version is open: old work never waits for a code update (rule 2).
		expect(await work).toMatchObject({ code: "contract_mismatch" });
		expect(performance.now() - opened).toBeLessThan(1_000);
		await host.close(context);
	});

	it("old work creating an object that did not exist: it starts on the new code and binds the provider's open old attempt", async () => {
		const { answer } = await runShape({
			work: async (ctx, code) => `${code} work -> ${await (await ctx.get(Third, { id: "fresh" })).ping(ctx)}`,
		});
		expect(answer).toBe("v1 work -> v2 third");
	});

	it("a root given the method's ctx (without its signal) is old work; one without it is new work", async () => {
		let host: Host | undefined;
		const viaRoot = (scope: (ctx: Ctx) => Context): Shape => ({
			work: async (ctx, code) => {
				const answer = await host!.root(async (root) => (await root.get(Provider, {})).x(root), scope(ctx));
				return `${code} work -> ${answer}`;
			},
		});
		const run = async (shape: Shape) => {
			const gates: Promise<void>[] = [];
			const gate = Promise.withResolvers<void>();
			host = createHost({ reloadDrainTimeout: 300, onError: () => {} });
			await host.load([{ name: "@test/app", facet: shapePlugin("v1", shape, gates) }], context);
			const provider = await host.get(Provider, {}, context);
			gates.push(gate.promise);
			const work = provider.work(context).catch((error: Error) => `rejected: ${error.message}`);
			await flushed();
			await host.reload([{ name: "@test/app", facet: shapePlugin("v2", shape, gates) }], context);
			gate.resolve();
			const answer = await work;
			await host.close(context);
			return answer;
		};
		expect(await run(viaRoot((ctx) => withoutAbortSignal(ctx)))).toBe("v1 work -> v1 x");
		// Without the ctx the root's call is new work: it waits for the provider's new attempt, which waits for this
		// call's drain, until the reload drain bound cuts the call.
		expect(await run(viaRoot(() => context))).toMatch(/^rejected: .*replaced by a reload/);
	});

	it("a call routed to an old attempt after its drain began joins the drain: it is not cut at the seal", async () => {
		const gates: Promise<void>[] = [];
		const long = Promise.withResolvers<void>();
		const shape: Shape = {
			raise: "provider",
			work: async (ctx, code) => `${code} work -> ${await (await ctx.get(Dependent, {})).slow(ctx)}`,
		};
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@test/app", facet: shapePlugin("v1", shape, gates) }], context);
		const provider = await host.get(Provider, {}, context);
		await host.get(Dependent, {}, context);
		const gate = Promise.withResolvers<void>();
		gates.push(gate.promise, long.promise);
		const work = provider.work(context);
		await flushed();
		await host.reload([{ name: "@test/app", facet: shapePlugin("v2", shape, gates) }], context);
		gate.resolve();
		// The dependent's old attempt runs the routed `slow` while its successor waits for the provider's.
		await new Promise((resolve) => setTimeout(resolve, 50));
		long.resolve();
		expect(await work).toBe("v1 work -> v1 slow");
		await host.close(context);
	});

	it("old work starts a job, writes documents and tables and reads a live query on the old code; the new factory runs after", async () => {
		const store = await memoryStore();
		const opened: string[] = [];
		const latch = Promise.withResolvers<void>();
		const Notes1 = defineState("notes", {
			schema: obj({ list: arr(str()) }),
			version: 1,
			initial: () => ({ list: [] }),
			persist: true,
			checkpointWhen: () => true,
		});
		const Notes2 = defineState("notes", {
			schema: obj({ list: arr(str()), count: int() }),
			version: 2,
			initial: () => ({ list: [], count: 0 }),
			migrate: (old) => ({ list: old.list as string[], count: (old.list as string[]).length }),
			persist: true,
			checkpointWhen: () => true,
		});
		const Job1 = defineJob("app.job", { version: 1, args: obj({ text: str() }), result: str() });
		const Job2 = defineJob("app.job", {
			version: 2,
			args: obj({ text: str(), priority: int() }),
			result: str(),
			accepts: { 1: { args: (old: { text: string }) => ({ ...old, priority: 0 }), result: (result) => result } },
		});
		const Items = defineTable("items", { version: 1, columns: { id: int(), text: str() }, key: ["id"] });
		const Store = local("app.store", {
			version: 1,
			params: {},
			members: {
				rows: arr(obj({ id: int(), text: str() })),
				work: method(undefined, str()),
				read: method(undefined, str()),
			},
		});
		const v1 = defineFacet((h) =>
			h.serve(Store, (_, self) => {
				self.open(
					async () => void opened.push("v1"),
					() => {},
				);
				const notes = self.state(Notes1);
				const job = self.job(Job1, { run: async ({ text }) => `v1 ran ${text}` });
				const items = self.table(Items);
				const rows = self.query(
					items,
					query(Items).orderBy((item) => item.id, "desc"),
					10,
				);
				return {
					rows,
					work: async (ctx: Ctx) => {
						await latch.promise;
						await notes.change((draft) => void draft.list.push("old"), ctx);
						await self.tx(async (tx) => tx.put(items, { id: 1, text: "old" }), ctx);
						const outcome = await (await job.start({ text: "a" }, ctx)).outcome(ctx);
						const result = outcome.kind === "done" ? outcome.result : outcome.error.kind;
						return `v1: ${notes.value.list.join(",")} | ${JSON.stringify(rows.value)} | ${result}`;
					},
					read: async () => `v1: ${JSON.stringify(notes.value)}`,
				};
			}),
		);
		const v2 = defineFacet((h) =>
			h.serve(Store, (_, self) => {
				self.open(
					async () => void opened.push("v2"),
					() => {},
				);
				const notes = self.state(Notes2);
				self.job(Job2, { run: async ({ text, priority }) => `v2 ran ${text} ${priority}` });
				const items = self.table(Items);
				return {
					rows: self.query(
						items,
						query(Items).orderBy((item) => item.id, "desc"),
						10,
					),
					work: async () => "v2",
					read: async () => `v2: ${JSON.stringify(notes.value)}`,
				};
			}),
		);
		const host = createHost({ store, onError: () => {} });
		await host.load([{ name: "@test/app", facet: v1 }], context);
		const reference = await host.get(Store, {}, context);
		const working = reference.work(context);
		await flushed();
		await host.reload([{ name: "@test/app", facet: v2 }], context);
		await flushed();
		expect(opened).toEqual(["v1"]);
		latch.resolve();
		expect(await working).toBe('v1: old | [{"id":1,"text":"old"}] | v1 ran a');
		expect(await reference.read(context)).toBe('v2: {"list":["old"],"count":1}');
		expect(opened).toEqual(["v1", "v2"]);
		await host.close(context);
		await store.close(context);
	});
});

describe("reload: the reload drain bound", () => {
	fakeTimers();

	it("cuts a call still running at reloadDrainTimeout (released), reports drain_timeout, then the new code serves", async () => {
		const stuck = Promise.withResolvers<void>();
		const { host, errors } = await loaded((h) => servePure(h, "v1", 1, [stuck.promise]), {
			reloadDrainTimeout: 2_000,
		});
		const pure = await host.get(Pure, {}, context);
		const old = rejection(pure.bump(context));
		await vi.advanceTimersByTimeAsync(0);
		await reloadApp(host, (h) => servePure(h, "v2", 10));
		await vi.advanceTimersByTimeAsync(1_999);
		expect(errors.map(({ kind }) => kind)).not.toContain("drain_timeout");
		await vi.advanceTimersByTimeAsync(1);
		expect(errors.map(({ kind }) => kind)).toContain("drain_timeout");
		expect(await old).toMatchObject({ code: "released" });
		await vi.advanceTimersByTimeAsync(0);
		expect(pure.label.value).toBe("v2");
		stuck.resolve();
		await host.close(context);
	});

	it("is at most closeTimeout", () => {
		const host = createHost({ closeTimeout: 1_000, reloadDrainTimeout: 5_000, onError: () => {} });
		expect((host as unknown as { readonly timeouts: { readonly reload: number } }).timeouts.reload).toBe(1_000);
	});
});

describe("reload: GC", () => {
	const attempts = instancesOf(Attempt, "activate");

	it("collects a restart's old attempt and its closures once it ended", async () => {
		const gate = Promise.withResolvers<void>();
		const { host } = await loaded((h) => servePure(h, "v1", 1, [gate.promise]));
		const pure = await host.get(Pure, {}, context);
		const old = pure.bump(context);
		const from = attempts.length - 1;
		await reloadApp(host, (h) => servePure(h, "v2", 1));
		gate.resolve();
		await old;
		await flushed();
		await expectCollected(attempts[from]!);
		expect(pure.state.value).toEqual({ kind: "live" });
		await host.close(context);
	});

	it("collects a removed type's objects, its provider, its registry entries and the old facet's code", async () => {
		const Names = defineRegistry<string, string[]>("app.names", { version: 1 });
		const objects = instancesOf(ChordObject, "remove");
		const host = createHost({ onError: () => {} });
		/** Loads the plugin; only the host keeps its facet. */
		const load = (): [WeakRef<object>, Promise<unknown>] => {
			const made = defineFacet((h, self) => {
				servePure(h, "v1", 1);
				h.serve(Names, { compose: (table) => table.map(({ value }) => value) });
				self.contribute(Names, "x");
			});
			return [new WeakRef(made), host.load([{ name: "@test/app", facet: made }], context)];
		};
		const [facet, loading] = load();
		await loading;
		await host.get(Pure, {}, context).then((pure) => pure.release());
		await host.reload([], context);
		await flushed();
		expect(objects).toHaveLength(1);
		await expectCollected(objects[0]!, facet);
		await host.close(context);
	});
});

describe("reload: a parked attempt's handover (fix round 1)", () => {
	it("keeps a dependency held only by a parked attempt alive through reload", async () => {
		const A = local("astra.a", { version: 1, params: {}, members: {} });
		const Dep = local("astra.dep", { version: 1, params: { id: int() }, members: {} });
		const Missing = local("astra.missing", { version: 1, params: {}, members: {} });
		let opens = 0;
		let closes = 0;
		const host = createHost({ onError: () => {} });
		const depFacet = defineFacet((h) =>
			h.serve(Dep, (_, self) => {
				self.open(
					async () => {
						opens++;
					},
					() => {
						closes++;
					},
				);
				return {};
			}),
		);
		const aFacet = () =>
			defineFacet((h) =>
				h.serve(A, (_, self) => {
					self.get(Dep, { id: 1 });
					self.get(Missing, {});
					return {};
				}),
			);
		await host.load(
			[
				{ name: "@astra/dep", facet: depFacet },
				{ name: "@astra/a", facet: aFacet() },
			],
			context,
		);
		await flushed();
		expect(opens).toBe(1);
		await host.reload(
			[
				{ name: "@astra/dep", facet: depFacet },
				{ name: "@astra/a", facet: aFacet() },
			],
			context,
		);
		await flushed();
		const counts = { opens, closes };
		await host.close(context);
		expect(counts).toEqual({ opens: 1, closes: 0 });
	});

	it("binds replacement requests before releasing the parked predecessor's", async () => {
		const A = local("sol.parked", { version: 1, params: {}, members: {} });
		const B = local("sol.native", { version: 1, params: { id: int() }, members: {} });
		const Missing = local("sol.missing", { version: 1, params: {}, members: {} });
		let opens = 0;
		let closes = 0;
		const b = defineFacet((h) =>
			h.serve(B, (_, self) => {
				self.open(
					async () => ++opens,
					() => {
						closes++;
					},
				);
				return {};
			}),
		);
		const a = () =>
			defineFacet((h) =>
				h.serve(A, (_, self) => {
					self.get(B, { id: 1 });
					self.get(Missing, {});
					return {};
				}),
			);
		const host = createHost({ onError: () => {} });
		try {
			await host.load(
				[
					{ name: "@sol/b", facet: b },
					{ name: "@sol/a", facet: a() },
				],
				context,
			);
			expect({ opens, closes }).toEqual({ opens: 1, closes: 0 });
			await host.reload(
				[
					{ name: "@sol/b", facet: b },
					{ name: "@sol/a", facet: a() },
				],
				context,
			);
			await delivered();
			expect({ opens, closes }).toEqual({ opens: 1, closes: 0 });
		} finally {
			await host.close(context);
		}
	});
});

describe("reload: two reloads in a row", () => {
	it("the second does not wait for the first's old call, which finishes on its old code; the last code serves", async () => {
		const gate = Promise.withResolvers<void>();
		const { host, errors } = await loaded((h) => servePure(h, "v1", 1, [gate.promise]), { closeTimeout: 60_000 });
		const pure = await host.get(Pure, {}, context);
		const old = pure.bump(context);
		await flushed();
		await reloadApp(host, (h) => servePure(h, "v2", 10));
		let resolved = false;
		const second = reloadApp(host, (h) => servePure(h, "v3", 100)).then(() => {
			resolved = true;
		});
		await flushed();
		// Its report does not wait for the old attempt's drain: resolved within a few turns.
		expect(resolved).toBe(true);
		await second;
		// The old attempt still runs v1's call: the reference sees it live meanwhile.
		expect(pure.label.value).toBe("v1");
		gate.resolve();
		expect(await old).toBe(1);
		expect(await pure.bump(context)).toBe(101);
		expect(pure.label.value).toBe("v3");
		expect(errors).toEqual([]);
		await host.close(context);
	});
});

describe("reload: a reference detaching from a parked restart's old attempt (Opus G1)", () => {
	it("follows the old instance while its call drains, then keeps its last value with the failure once", async () => {
		const Missing = local("app.missing", { version: 1, params: {}, members: {} });
		const gate = Promise.withResolvers<void>();
		const { host } = await loaded((h) => servePure(h, "v1", 1, [gate.promise]), { closeTimeout: 60_000 });
		const pure = await host.get(Pure, {}, context);
		const calls = changesOf(await pure.n.watch(context));
		const bumping = pure.bump(context);
		await flushed();
		const parked = defineFacet((h) =>
			h.serve(Pure, (_, self) => {
				self.get(Missing, {});
				return { n: constant(9), label: constant("v2"), bump: async () => 0 };
			}),
		);
		const report = await host.reload([{ name: "@test/app", facet: parked }], context);
		expect(report.objects[0]).toMatchObject({ kind: "parked" });
		expect(pure.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		// The old attempt's call still commits: the reference follows it until it ended.
		gate.resolve();
		expect(await bumping).toBe(1);
		await delivered();
		expect([pure.n.value, calls.map((call) => call.kind), valuesOf(calls)[0]]).toEqual([1, ["value", "failed"], 1]);
		await host.close(context);
	});
});

describe("a live failure: an older version's mapping follows the admitted commits (final review)", () => {
	it("stops an older reference after its instance's admitted final commit published (Astra, G1)", async () => {
		const V1 = local("app.admitted", { version: 1, params: {}, members: { n: int() } });
		const V2 = evolve(V1, (e) => e.state("n", obj({ n: int() })));
		const State = defineState("state", {
			version: 1,
			schema: obj({ n: int() }),
			initial: () => ({ n: 0 }),
			persist: true,
			checkpointWhen: () => false,
		});
		const store = await memoryStore();
		let own: SingletonHandle<{ n: number }> | undefined;
		let self: StoreSelf | undefined;
		const facet = defineFacet((h) =>
			h.serve(
				V2,
				(_, declared) => {
					self = declared;
					own = declared.state(State);
					return { n: own };
				},
				{ accepts: { 1: { state: { n: (value) => value.n } } } },
			),
		);
		const host = createHost({ store, onError: () => {} });
		await host.load([{ name: "@app/admitted", facet }], context);
		const old = await host.get(V1, {}, context);
		const current = await host.get(V2, {}, context);
		const calls = changesOf(await old.n.watch(context));
		// A commit admitted before the failure: v1's mapping and v2's member both get it, then the failure.
		const held = holdNextCommit(store);
		const change = own!.change((draft) => {
			draft.n = 5;
		}, context);
		await held.entered;
		failLive(attempted, self!, new ChordError({ code: "unavailable", message: "boom" }));
		held.release();
		await change;
		await delivered();
		expect({ old: old.n.value, current: current.n.value, calls: valuesOf(calls) }).toEqual({
			old: 5,
			current: { n: 5 },
			calls: [5, { failed: "boom" }],
		});
		old.release();
		current.release();
		await host.close(context);
		await store.close(context);
	});
});

describe("a native restart: references take their last values after the admitted commits (final review)", () => {
	it("keeps the value of a commit admitted before the restart's seal while the new instance opens (Sol, G1)", async () => {
		const Type = local("app.restart-admitted", { version: 1, params: {}, members: { x: obj({ n: int() }) } });
		const Doc = defineState("doc", {
			version: 1,
			schema: obj({ n: int() }),
			initial: () => ({ n: 0 }),
			persist: true,
			checkpointWhen: () => false,
		});
		const facet = (open: () => Promise<number>) =>
			defineFacet((h) =>
				h.serve(Type, (_, self) => {
					counter = self.state(Doc);
					self.open(open, () => {});
					return { x: counter };
				}),
			);
		const store = await memoryStore();
		const host = createHost({ store, onError: () => {} });
		const opening = Promise.withResolvers<number>();
		let counter: SingletonHandle<{ n: number }> | undefined;
		await host.load([{ name: "@app/restart", facet: facet(async () => 0) }], context);
		const ref = await host.get(Type, {}, context);
		// A commit admitted to the store (no running call's promise), then a restart whose new native stays opening.
		const held = holdNextCommit(store);
		const outgoing = counter!;
		const change = outgoing.change((draft) => {
			draft.n = 1;
		}, context);
		await held.entered;
		await host.reload([{ name: "@app/restart", facet: facet(() => opening.promise) }], context);
		await delivered();
		held.release();
		await change;
		await delivered();
		expect([ref.state.value.kind, ref.x.value]).toEqual(["loading", { n: 1 }]);
		opening.resolve(1);
		await host.close(context);
		await store.close(context);
	});
});

describe("versions and grants together (review round 2, granttest F3 and F5)", () => {
	/** What the admission says, for every principal: denied, or allowed with `granted`. */
	const Gate = local("test.gate", {
		version: 1,
		params: {},
		members: { mode: str(), set: method(str()) },
	});
	const Tick = obj({ y: int() });
	/** v1: a plain `s`, a grantable event `e0`; v2 adds `t` and changes `e0`, which v1's consumers are refused. */
	const V1 = remote("test.versioned", {
		version: 1,
		params: {},
		hostAddress: () => Server(),
		state: { s: str() },
		events: { e0: grantable(Tick) },
	});
	const V2 = evolve(V1, (e) => e.addState("t", str()).event("e0", obj({ y: str() })));

	/** The gate's plugin, loaded once: the versioned provider's reloads keep its mode. */
	const gate = defineFacet<TestPrincipal>((h) =>
		h.serve(Gate, (_, self) => {
			const mode = self.writable("e0");
			return {
				mode: self.derive([mode], ([value]) => value),
				set: async (next) => {
					mode.set(next);
					return null;
				},
			};
		}),
	);
	const admit: Admit<typeof V1, TestPrincipal> = (_params, _principal, self) =>
		self.derive([self.get(Gate, {}).mode], ([mode]) =>
			mode === "deny" ? deny("no access") : allow({ granted: mode === "e0" ? (["e0"] as const) : [] }),
		);
	/** How v2 serves v1's `e0`: refused, mapped; `slow`: its objects open a native that takes a few milliseconds. */
	type Serving = { readonly e0: "refuse" | "map"; readonly slow: boolean };
	/** `version`'s provider admitting by the gate (v2 accepting v1 with `e0` as `serving` says). */
	const facet = (version: 1 | 2, serving: Serving) =>
		defineFacet<TestPrincipal>((h) => {
			if (version === 1) {
				h.serve(V1, (_p, _principal, _admitted, self) => ({ s: constant("s"), e0: () => self.events() }), {
					admit,
				});
				return;
			}
			h.serve(
				V2,
				(_p, _principal, _admitted, self) => {
					if (serving.slow)
						self.open(
							() => new Promise((resolve) => setTimeout(resolve, 5)),
							() => {},
						);
					return { s: constant("s"), t: constant("t"), e0: () => self.events() };
				},
				{
					// The same decisions: v2's grantable names are v1's.
					admit: admit as unknown as Admit<typeof V2, TestPrincipal>,
					accepts: { 1: { events: { e0: serving.e0 === "refuse" ? "refuse" : ({ y }) => ({ y: y.length }) } } },
				},
			);
		});
	/** The server's plugins: the gate and `version`'s provider (v2 refusing v1's `e0` unless `serving` says else). */
	const plugins = (version: 1 | 2, serving: Serving = { e0: "refuse", slow: false }) => [
		{ name: "@test/gate", facet: gate },
		{ name: "@test/app", facet: facet(version, serving) },
	];

	/** A reference's state, shortly: its kind, and the cause's kind and code when failed. */
	const shown = (ref: { readonly state: { readonly value: RefState } }) => {
		const state = ref.state.value;
		return state.kind === "failed" ? `failed ${state.cause.kind} ${state.cause.error.code}` : state.kind;
	};

	for (const where of ["on its host", "over a link"] as const) {
		it(`a denied holder of a version the provider no longer binds waits contract_mismatch (F3, ${where})`, async () => {
			const { server, client } = await linked(() => {});
			await server.reload(plugins(2), context);
			await (await server.get(Gate, {}, context)).set("deny", context);
			const holder = where === "on its host" ? server : client;
			const ref = holder.hold(V2, {}, context);
			await vi.waitFor(() => expect(shown(ref)).toBe("failed denied forbidden"));
			await server.reload(plugins(1), context);
			await flushed();
			expect(shown(ref)).toBe("failed waiting contract_mismatch");
			await client.close(context);
			await server.close(context);
		});

		for (const slow of [false, true]) {
			const opening = slow ? ", slow to open" : "";
			it(`a denied holder waits contract_mismatch once a reload refuses its version a member (G1${opening}, ${where})`, async () => {
				const { server, client } = await linked(() => {});
				await server.reload(plugins(2, { e0: "map", slow }), context);
				const holder = where === "on its host" ? server : client;
				const ref = holder.hold(V1, {}, context);
				await vi.waitFor(() => expect(shown(ref)).toBe("live"));
				await (await server.get(Gate, {}, context)).set("deny", context);
				await vi.waitFor(() => expect(shown(ref)).toBe("failed denied forbidden"));
				// The provider refuses v1 a member now: the denial is no answer for its holder, as for a fresh hold.
				await server.reload(plugins(2, { e0: "refuse", slow }), context);
				await vi.waitFor(() => expect(shown(ref)).toBe("failed waiting contract_mismatch"));
				const fresh = holder.hold(V1, {}, context);
				await vi.waitFor(() => expect(shown(fresh)).toBe("failed waiting contract_mismatch"));
				await client.close(context);
				await server.close(context);
			});
		}

		it(`a fresh holder refused a member waits contract_mismatch on a denied object (final check, Astra 3, ${where})`, async () => {
			const { server, client } = await linked(() => {});
			await server.reload(plugins(2), context);
			await (await server.get(Gate, {}, context)).set("deny", context);
			const holder = where === "on its host" ? server : client;
			const current = holder.hold(V2, {}, context);
			await vi.waitFor(() => expect(shown(current)).toBe("failed denied forbidden"));
			// Refusals are static per provider and version: the denial is no answer for v1.
			const older = holder.hold(V1, {}, context);
			await vi.waitFor(() => expect(shown(older)).toBe("failed waiting contract_mismatch"));
			await client.close(context);
			await server.close(context);
		});

		it(`a holder refused a grantable member waits for a publication, granted it or not (F5, static: (B), ${where})`, async () => {
			const { server, client } = await linked(() => {});
			await server.reload(plugins(2), context);
			const holder = where === "on its host" ? server : client;
			const ref = holder.hold(V1, {}, context);
			await vi.waitFor(() => expect(shown(ref)).toBe("failed waiting contract_mismatch"));
			// Refusals are static per provider and version: the grant going changes nothing for it.
			await (await server.get(Gate, {}, context)).set("none", context);
			await delivered();
			expect(shown(ref)).toBe("failed waiting contract_mismatch");
			// A publication whose provider takes v1 as it is binds it.
			await server.reload(plugins(1), context);
			await vi.waitFor(() => expect(shown(ref)).toBe("live"));
			// Bound, granted nothing: the gate says none.
			expect([[...ref.granted], ref.e0]).toEqual([[], undefined]);
			await client.close(context);
			await server.close(context);
		});
	}
});

describe("a version refused while its object lives (review round 3, Astra 1, 3 and 4)", () => {
	const holding = instancesOf(ChordObject, "hold");

	it("a call that waited at the reload's gate does not run when the new code refuses its version", async () => {
		const V1 = local("test.gated", {
			version: 1,
			params: {},
			members: { title: str(), work: method(), act: method(undefined, str()) },
		});
		const V2 = evolve(V1, (e) => e.removeState("title"));
		const gate = Promise.withResolvers<void>();
		const ran = vi.fn(async () => "new");
		const v1 = defineFacet((h) =>
			h.serve(V1, () => ({
				title: constant("x"),
				work: async () => {
					await gate.promise;
					return null;
				},
				act: async () => "old",
			})),
		);
		const v2 = defineFacet((h) =>
			h.serve(V2, () => ({ work: async () => null, act: ran }), { accepts: { 1: { state: { title: "refuse" } } } }),
		);
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "test", facet: v1 }], context);
		const ref = await host.get(V1, {}, context);
		// A call of v1 holds the restart's old attempt open; one made meanwhile waits at the gate.
		const working = ref.work(context);
		await flushed();
		const reloading = host.reload([{ name: "test", facet: v2 }], context);
		await vi.waitFor(() => expect(holding.at(-1)!.deref()!.openOldAttempt).toBeDefined());
		expect(ref.state.value.kind).toBe("live");
		const acting = rejection(ref.act(context));
		await flushed();
		gate.resolve();
		await working;
		await reloading;
		await vi.waitFor(() => expect(ref.state.value.kind).toBe("failed"));
		expect([await acting, ran.mock.calls.length]).toEqual([
			expect.objectContaining({ code: "contract_mismatch" }),
			0,
		]);
		await host.close(context);
	});

	it("shows one state while its refusal stands: two snapshots are the same object", async () => {
		const V1 = local("test.stable", { version: 1, params: {}, members: { x: str() } });
		const V2 = evolve(V1, (e) => e.removeState("x"));
		const host = createHost({ onError: () => {} });
		const facet = defineFacet((h) => h.serve(V2, () => ({}), { accepts: { 1: { state: { x: "refuse" } } } }));
		await host.load([{ name: "test", facet }], context);
		const older = host.hold(V1, {}, context);
		await vi.waitFor(() => expect(older.state.value.kind).toBe("failed"));
		const store = watchStore(older.state);
		expect(Object.is(store.snapshot(), store.snapshot())).toBe(true);
		await host.close(context);
	});

	it("a denied object whose holders a reload unbound for their version ends once the last is gone", async () => {
		const V1 = remote("test.denied-versions", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			flags: { x: "x" },
		});
		const V2 = evolve(V1, (e) => e.addState("v", str()));
		const host = createHost({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		const denying = { admit: () => constant(deny("no")) };
		const two = defineFacet((h) => h.serve(V2, () => ({ v: constant("two") }), denying));
		const one = defineFacet((h) => h.serve(V1, () => ({}), denying));
		await host.load([{ name: "test", facet: two }], context);
		const ref = host.hold(V2, {}, context);
		await vi.waitFor(() => expect(ref.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } }));
		const object = holding.at(-1)!.deref()!;
		await host.reload([{ name: "test", facet: one }], context);
		await vi.waitFor(() => expect(ref.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } }));
		ref.release();
		await flushed();
		expect(object.state.kind).toBe("ended");
		await host.close(context);
	});
});

const IdentityV1 = remote("test.ticks", {
	version: 1,
	params: {},
	hostAddress: Server,
	state: { s1: grantable(str()) },
	events: { e0: obj({ y: int() }) },
});
const IdentityV2 = evolve(IdentityV1, (e) => e.event("e0", obj({ y: str() })));
const IDENTITY_REFUSED = 'failed: test.ticks v1: member "e0" is refused by its provider';

/** The server's plugin: `V2` accepting v1 with `e0` refused; `text` makes each load another instance. */
const identityPlugins = (text: string) => [
	{
		name: "test",
		facet: defineFacet<TestPrincipal>((h) =>
			h.serve(IdentityV2, (_p, _principal, _admitted, self) => ({ s1: () => constant(text), e0: self.events() }), {
				admit: () => constant(allow({ granted: ["s1"] })),
				accepts: { 1: { events: { e0: "refuse" } } },
			}),
		),
	},
];

describe("a holder refused at its version: one state, refused once per reload (review round 2, Fable)", () => {
	for (const where of ["on its host", "over a link"] as const) {
		it(`reads one state object, and is refused at most once more when the next instance refuses it the same (${where})`, async () => {
			const { server, client } = await linked(() => {});
			await server.reload(identityPlugins("a"), context);
			const older = (where === "on its host" ? server : client).hold(IdentityV1, {}, context);
			await expect.poll(() => older.state.value.kind).toBe("failed");
			// A native watch compares states by identity (`ref-state.ts`), as React's external store does.
			expect(older.state.value).toBe(older.state.value);
			const states = statesOf(await older.state.watch(context));
			await flushed();
			const before = states.length;
			await server.reload(identityPlugins("b"), context);
			await flushed();
			await flushed();
			// It waits unbound and is placed again by the reload: on its host refused at once, the same state (no frame);
			// over a link its hold is placed again as main had it (`loading`, then the same refusal).
			expect(states.slice(before)).toEqual(where === "on its host" ? [] : ["loading", IDENTITY_REFUSED]);
			expect(older.state.value).toMatchObject({ cause: { error: { message: IDENTITY_REFUSED.slice(8) } } });
			await client.close(context);
			await server.close(context);
		});
	}
});

describe("a holder refused a member (review round 2, Sol)", () => {
	it("keeps the same state snapshot while an accepted version is refused a member", async () => {
		const V1 = remote("test.stable-refusal", {
			version: 1,
			params: {},
			hostAddress: Server,
			events: { e: grantable(str()) },
		});
		const V2 = evolve(V1, (edit) => edit.event("e", obj({ text: str() })));
		const host = createHost({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		try {
			await host.load(
				[
					{
						name: "test",
						facet: defineFacet((h) => {
							h.serve(V2, (_, _principal, _admitted, self) => ({ e: () => self.events() }), {
								admit: () => constant(allow({ granted: ["e"] })),
								accepts: { 1: { events: { e: "refuse" } } },
							});
						}),
					},
				],
				context,
			);
			const held = host.hold(V1, {}, context);
			await expect.poll(() => held.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
			const first = held.state.value;
			expect(held.state.value === first).toBe(true);
		} finally {
			await host.close(context);
		}
	});

	it("does not run a call parked at a reload gate when the successor refuses the caller’s binding", async () => {
		const V1 = remote("test.gated-refusal", {
			version: 1,
			params: {},
			hostAddress: Server,
			events: { e: str() },
			methods: { drain: method(), run: method() },
		});
		const V2 = evolve(V1, (edit) => edit.event("e", obj({ text: str() })));
		const host = createHost({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		const unblock = Promise.withResolvers<void>();
		let called = 0;
		const old = defineFacet((h) =>
			h.serve(V1, (_, _principal, self) => ({
				e: self.events(),
				drain: async () => {
					await unblock.promise;
					return null;
				},
				run: async () => null,
			})),
		);
		const next = defineFacet((h) =>
			h.serve(
				V2,
				(_, _principal, self) => ({
					e: self.events(),
					drain: async () => null,
					run: async () => {
						called++;
						return null;
					},
				}),
				{ accepts: { 1: { events: { e: "refuse" } } } },
			),
		);
		try {
			await host.load([{ name: "test", facet: old }], context);
			const held = await host.get(V1, {}, context);
			const running = held.drain(context);
			await host.reload([{ name: "test", facet: next }], context);
			expect(held.state.value.kind).toBe("live");
			const parked = held.run(context).then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			);
			unblock.resolve();
			await running;
			await expect(parked).resolves.toMatchObject({ error: { code: "contract_mismatch" } });
			expect(called).toBe(0);
		} finally {
			unblock.resolve();
			await host.close(context);
		}
	});

	it("tells the local watcher and peer what a refused binding shows while its successor opens", async () => {
		const V1 = remote("test.loading-refusal", { version: 1, params: {}, hostAddress: Server, events: { e: str() } });
		const V2 = evolve(V1, (edit) => edit.event("e", obj({ text: str() })));
		const { client, server } = await linked((h) =>
			h.serve(V2, (_, _principal, self) => ({ e: self.events() }), {
				accepts: { 1: { events: { e: "refuse" } } },
			}),
		);
		const open = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		try {
			const sameHost = server.hold(V1, {}, context);
			const peer = client.hold(V1, {}, context);
			await expect.poll(() => [sameHost.state.value.kind, peer.state.value.kind]).toEqual(["failed", "failed"]);
			const watch = await sameHost.state.watch(context);
			const seen: string[] = [];
			watch.start(async (call) => {
				if (call.kind === "value") seen.push(call.value.kind);
			});
			await server.reload(
				[
					{
						name: "@test/notes",
						facet: defineFacet((h) => {
							h.serve(
								V2,
								(_, _principal, self) => {
									self.open(
										async () => {
											started.resolve();
											await open.promise;
										},
										() => {},
									);
									return { e: self.events() };
								},
								{ accepts: { 1: { events: { e: "refuse" } } } },
							);
						}),
					},
				],
				context,
			);
			await started.promise;
			await flushed();
			expect([peer.state.value.kind, seen.at(-1) ?? "failed"]).toEqual([
				sameHost.state.value.kind,
				sameHost.state.value.kind,
			]);
		} finally {
			open.resolve();
			await client.close(context);
			await server.close(context);
		}
	});

	it("a holder refused by an instance gains no last value when that instance fails", async () => {
		const V1 = remote("test.refused-failure", {
			version: 1,
			params: {},
			hostAddress: Server,
			state: { text: str() },
			events: { e: str() },
		});
		const V2 = evolve(V1, (edit) => edit.event("e", obj({ text: str() })));
		const host = createHost({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		let followed: FollowObserver<string> | undefined;
		try {
			await host.load(
				[
					{
						name: "test",
						facet: defineFacet((h) =>
							h.serve(
								V2,
								(_, _principal, self) => ({
									text: self.follow(async (observer: FollowObserver<string>) => {
										followed = observer;
										return { value: "current", detach: () => {} };
									}),
									e: self.events(),
								}),
								{ accepts: { 1: { events: { e: "refuse" } } } },
							),
						),
					},
				],
				context,
			);
			const current = await host.get(V2, {}, context);
			expect(current.text.value).toBe("current");
			const old = host.hold(V1, {}, context);
			expect(() => old.text.value).toThrow();
			followed!.end({ kind: "failed", error: new Error("runtime ended") });
			await flushed();
			// Refused, it waits unbound: the object's failure is not its own, and it took no value from that instance.
			expect(old.state.value).toMatchObject({ kind: "failed" });
			expect(() => old.text.value).toThrow();
		} finally {
			await host.close(context);
		}
	});

	it("ends a denied object when its last holder leaves for version mismatch", async () => {
		const Check = local("test.admission-check", { version: 1, params: { id: str() }, members: { ready: str() } });
		const V1 = remote("test.denied-removal", {
			version: 1,
			params: {},
			hostAddress: Server,
			flags: { write: "Write" },
		});
		const V2 = evolve(V1, (edit) => edit.addState("extra", str()));
		const host = createHost({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		let closed = 0;
		const dependency = defineFacet((h) => {
			h.serve(Check, (_, self) => {
				self.open(
					async () => null,
					() => {
						closed++;
					},
				);
				return { ready: constant("ready") };
			});
		});
		const withV2 = defineFacet((h) =>
			h.serve(V2, () => ({ extra: constant("extra") }), {
				admit: (_, _principal, self) =>
					self.derive([self.get(Check, { id: "one" }).ready], () => deny("no access")),
			}),
		);
		const withV1 = defineFacet((h) =>
			h.serve(V1, () => ({}), {
				admit: (_, _principal, self) =>
					self.derive([self.get(Check, { id: "one" }).ready], () => deny("no access")),
			}),
		);
		try {
			await host.load(
				[
					{ name: "dependency", facet: dependency },
					{ name: "provider", facet: withV2 },
				],
				context,
			);
			const held = host.hold(V2, {}, context);
			await expect.poll(() => held.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
			await host.reload(
				[
					{ name: "dependency", facet: dependency },
					{ name: "provider", facet: withV1 },
				],
				context,
			);
			await expect
				.poll(() => held.state.value)
				.toMatchObject({ kind: "failed", cause: { kind: "waiting", error: { code: "contract_mismatch" } } });
			await expect.poll(() => closed).toBe(1);
		} finally {
			await host.close(context);
		}
	});
});

describe("a refused older consumer waits unbound as before slice 15 (review round 2, Opus)", () => {
	it("is reported unbound_long, is no holder and keeps nothing lingering, on its host and over a link", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: 0 });
		try {
			const V1 = remote("test.refused-old", {
				version: 1,
				params: {},
				hostAddress: Server,
				state: { s: str(), old: str() },
			});
			const V2 = evolve(V1, (e) => e.removeState("old"));
			const { server, client, errors } = await linked((h) =>
				h.serve(V2, () => ({ s: constant("s") }), { accepts: { 1: { state: { old: "refuse" } } } }),
			);
			const local = server.hold(V1, {}, context);
			const remoteRef = client.hold(V1, {}, context);
			await vi.advanceTimersByTimeAsync(6_500);
			expect([local.state.value.kind, remoteRef.state.value.kind]).toEqual(["failed", "failed"]);
			expect(errors.server.map((error) => error.kind)).toEqual(["unbound_long", "unbound_long"]);
			// No holder: nobody is listed, so the object keeps nothing lingering for them.
			const presence = await Promise.all(
				[V1, V2].map(async (Type) => (await server.references(Type).watch(context)).value),
			);
			expect(presence).toEqual([[], []]);
			await client.close(context);
			await server.close(context);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("refusals are static per provider and version (final review, Astra and Sol)", () => {
	const held = instancesOf(ChordObject, "hold");
	const FinalGate = local("test.finalgate", {
		version: 1,
		params: { id: str() },
		members: { mode: str(), set: method(str()) },
	});
	const V1 = remote("test.final4", {
			version: 1,
			params: { id: str() },
			hostAddress: () => Server(),
			events: { e: grantable(str()) },
		}),
		V2 = evolve(V1, (e) => e.event("e", obj({ v: str() }))),
		V3 = evolve(V2, (e) => e.addState("n", int()));
	const setup = (h: FacetHost<TestPrincipal>) => {
		h.serve(FinalGate, (_, self) => {
			const mode = self.writable("e");
			return {
				mode: self.derive([mode], ([v]) => v),
				set: async (v: string) => {
					mode.set(v);
					return null;
				},
			};
		});
		h.serve(V2, (_p, _who, _data, self) => ({ e: () => self.events() }), {
			accepts: { 1: { events: { e: "refuse" } } },
			linger: 60_000,
			admit: (params, _who, self) =>
				self.derive([self.get(FinalGate, { id: params.id }).mode], ([v]) =>
					allow({ granted: v === "none" ? [] : (["e"] as const) }),
				),
		});
	};
	it("a refused hold arriving during linger waits for a publication, whatever the gate says (static refusals)", async () => {
		const { server, client } = await linked(setup);
		try {
			const params = { id: "A" },
				gate = await server.get(FinalGate, params, context),
				curr = await server.get(V2, params, context);
			curr.release();
			expect(server.activity.value.lingering).toBe(1);
			const old = server.hold(V1, params, context);
			await vi.waitFor(() => expect(old.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } }));
			// Refused, it holds nothing: the object lingers on, its timer running.
			expect(server.activity.value.lingering).toBe(1);
			await gate.set("none", context);
			await delivered();
			await delivered();
			// Refusals are static ((B)): the grant going changes nothing for it.
			expect(old.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		} finally {
			await client.close(context);
			await server.close(context);
		}
	});
	it("a decision on A does not make an unrelated unsupported wire version of B flap", async () => {
		const { server, client } = await linked(setup);
		try {
			const wrong = client.hold(V3, { id: "B" }, context);
			await vi.waitFor(() => expect(wrong.state.value.kind).toBe("failed"));
			const frames = statesOf(await wrong.state.watch(context));
			await delivered();
			const at = frames.length;
			const p = { id: "A" },
				gate = await server.get(FinalGate, p, context),
				a = server.hold(V1, p, context);
			await vi.waitFor(() => expect(a.state.value.kind).toBe("failed"));
			await gate.set("none", context);
			await delivered();
			await delivered();
			expect(frames.slice(at)).toEqual([]);
		} finally {
			await client.close(context);
			await server.close(context);
		}
	});

	it("a link closing on the presence departure cannot leave a released hold in the refused set", async () => {
		const V1 = remote("test.closer", { version: 1, params: {}, hostAddress: Server, state: { x: str() } }),
			V2 = evolve(V1, (e) => e.removeState("x")),
			Watcher = remote("test.watcher4", { version: 1, params: {}, hostAddress: Server, state: { count: int() } });
		const server = createHost({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		const watcher = {
			name: "watch",
			facet: defineFacet((h) =>
				h.serve(Watcher, (_, _p, self) => ({ count: self.derive([h.references(V1)], ([refs]) => refs.length) })),
			),
		};
		const one = { name: "test", facet: defineFacet((h) => h.serve(V1, () => ({ x: constant("old") }))) };
		const two = {
			name: "test",
			facet: defineFacet((h) => h.serve(V2, () => ({}), { accepts: { 1: { state: { x: "refuse" } } } })),
		};
		let armed = false;
		try {
			await server.load([watcher, one], context);
			const [a, b] = memoryLinkPair();
			const codec = testCodec();
			server.accept(
				{
					send(bytes) {
						const m = codec.decode(bytes);
						if (armed && m.kind === "state" && m.holds.some((h) => h.hold === 0)) a.close();
						else a.send(bytes);
					},
					close: () => a.close(),
					onClose: (fn) => a.onClose(fn),
					onMessage: (fn) => a.onMessage(fn),
				},
				{ principal: { kind: "owner" }, codec },
				context,
			);
			const peer = new RawPeer(b);
			for (const [id, type] of [Watcher, V1].entries()) {
				peer.send({
					kind: "hold",
					hold: id,
					type: type.name,
					version: type.version,
					fingerprint: type.fingerprint,
					address: SERVER_ADDRESS,
					params: "{}",
				});
				await peer.next("bound");
				await transported();
			}
			const obj = held.at(-1)!.deref()!;
			expect(obj.served.contract.name).toBe(V1.name);
			armed = true;
			await server.reload([watcher, two], context);
			await transported();
			expect(peer.closed).toBe(true);
			expect(obj.state.kind).toBe("ended");
		} finally {
			await server.close(context);
		}
	});

	it("an unbound waiter does not keep a removed provider object", async () => {
		const V1 = local("test.gcrefused", { version: 1, params: { id: str() }, members: { x: str() } });
		const V2 = evolve(V1, (e) => e.removeState("x"));
		const host = createHost({ onError: () => {} });
		let waiting: Reference<typeof V1> | undefined;
		try {
			await host.load(
				[
					{
						name: "test",
						facet: defineFacet((h) => h.serve(V2, () => ({}), { accepts: { 1: { state: { x: "refuse" } } } })),
					},
				],
				context,
			);
			const ref = host.hold(V1, { id: "a" }, context);
			waiting = ref;
			await vi.waitFor(() => expect(ref.state.value.kind).toBe("failed"));
			// The object its hold was refused by, made for it.
			const object = held.at(-1)!;
			await host.reload([], context);
			await delivered();
			await flushed();
			// Collected while its refused waiter still waits: the waiter keeps nothing of it.
			let retained = false;
			try {
				await expectCollected(object);
			} catch {
				retained = true;
			}
			ref.release();
			await flushed();
			await expectCollected(object);
			expect(retained).toBe(false);
		} finally {
			waiting?.release();
			await host.close(context);
		}
	});
	it("a quiet placement into a new loading object announces loading to the wire", async () => {
		const one = remote("test.quiet4", { version: 1, params: {}, hostAddress: Server, state: { x: str() } }),
			two = evolve(one, (e) => e.removeState("x"));
		const { server, client } = await linked((h) =>
			h.serve(two, () => ({}), { accepts: { 1: { state: { x: "refuse" } } } }),
		);
		const opening = Promise.withResolvers<void>();
		try {
			const local = server.hold(one, {}, context),
				peer = client.hold(one, {}, context);
			await vi.waitFor(() => expect([local.state.value.kind, peer.state.value.kind]).toEqual(["failed", "failed"]));
			await server.reload([], context);
			const p = server.reload(
				[
					{
						name: "test",
						facet: defineFacet((h) =>
							h.serve(one, (_, _p, self) => {
								self.open(
									async () => {
										await opening.promise;
										return 0;
									},
									() => {},
								);
								return { x: constant("now") };
							}),
						),
					},
				],
				context,
			);
			await delivered();
			await delivered();
			const states = [local.state.value.kind, peer.state.value.kind];
			opening.resolve();
			await p;
			await vi.waitFor(() => expect([local.state.value.kind, peer.state.value.kind]).toEqual(["live", "live"]));
			expect(states).toEqual(["loading", "loading"]);
		} finally {
			opening.resolve();
			await client.close(context);
			await server.close(context);
		}
	});
	// Refused waiters are placed only at their own object's next decision or at publication.

	it("an object's new grant does not reset another request's unbound_long deadline", async () => {
		const Change = local("test.reconsider.change", {
			version: 1,
			params: {},
			members: { value: bool(), change: method() },
		});
		const V1 = remote("test.reconsider", {
			version: 1,
			params: { id: str() },
			hostAddress: () => Server(),
			events: { e: str() },
			flags: { select: "Select" },
		});
		const V2 = evolve(V1, (e) => e.event("e", obj({ x: str() })));
		const V3 = evolve(V2, (e) => e.addState("title", str()));
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: 0 });
		const errors: HostError[] = [];
		const host = createHost({
			address: Server(),
			principal: { kind: "server" },
			onError: (error) => errors.push(error),
		});
		try {
			await host.load(
				[
					{
						name: "test",
						facet: defineFacet((h) => {
							h.serve(Change, (_, self) => {
								const value = self.writable(false);
								return {
									value: self.derive([value], ([v]) => v),
									change: async () => {
										value.set(true);
										return null;
									},
								};
							});
							h.serve(V2, (_, _principal, _admitted, self) => ({ e: self.events() }), {
								admit: ({ id }, _principal, self) =>
									self.derive([self.get(Change, {}).value], ([v]) =>
										allow({ granted: id === "a" && v ? (["select"] as const) : [] }),
									),
								accepts: { 1: { events: { e: "refuse" } } },
							});
						}),
					},
				],
				context,
			);
			const a = host.hold(V1, { id: "a" }, context);
			const b = host.hold(V3, { id: "b" }, context);
			await flushed();
			expect([a.state.value.kind, b.state.value.kind]).toEqual(["failed", "failed"]);
			await vi.advanceTimersByTimeAsync(4000);
			await (await host.get(Change, {}, context)).change(context);
			await vi.advanceTimersByTimeAsync(1001);
			expect(errors).toContainEqual(
				expect.objectContaining({
					kind: "unbound_long",
					since: 0,
					error: expect.objectContaining({ message: expect.stringMatching(/v3/) }),
				}),
			);
		} finally {
			await host.close(context);
			vi.useRealTimers();
		}
	});

	it("a wire waiter placed quietly on a newly served object gets the loading transition", async () => {
		const V1 = remote("test.quiet-replacement", {
			version: 1,
			params: {},
			hostAddress: Server,
			events: { e: str() },
		});
		const V2 = evolve(V1, (e) => e.event("e", obj({ x: str() })));
		const { client, server } = await linked((h) =>
			h.serve(V2, (_, _p, self) => ({ e: self.events() }), { accepts: { 1: { events: { e: "refuse" } } } }),
		);
		const gate = Promise.withResolvers<void>();
		const opened = Promise.withResolvers<void>();
		try {
			const local = server.hold(V1, {}, context);
			const peer = client.hold(V1, {}, context);
			await expect.poll(() => [local.state.value.kind, peer.state.value.kind]).toEqual(["failed", "failed"]);
			await server.reload([], context);
			await server.reload(
				[
					{
						name: "@test/notes",
						facet: defineFacet((h) =>
							h.serve(V1, (_, _p, self) => {
								self.open(
									async () => {
										opened.resolve();
										await gate.promise;
									},
									() => {},
								);
								return { e: self.events() };
							}),
						),
					},
				],
				context,
			);
			await opened.promise;
			await flushed();
			expect([local.state.value.kind, peer.state.value.kind]).toEqual(["loading", "loading"]);
		} finally {
			gate.resolve();
			await client.close(context);
			await server.close(context);
		}
	});
});

describe("a restart's old attempt and the versions it refuses (final check, Astra 1 and 2, Sol)", () => {
	/** v2 removed v1's `gone`: its provider maps it for v1 or refuses it (and so v1). */
	const V1 = local("test.restart-refusal", {
		version: 1,
		params: {},
		members: { x: str(), gone: str(), work: method(undefined, str()) },
	});
	const V2 = evolve(V1, (e) => e.removeState("gone"));
	/** A v2 provider showing `text` as `x`, v1's `gone` as `gone` says; `work` waits for `gate`, then runs `then`. */
	const provider = (
		text: string,
		gone: "refuse" | "map",
		gate: Promise<void>,
		then: (ctx: Ctx) => Promise<string> = async () => "ok",
	) =>
		defineFacet((h) =>
			h.serve(
				V2,
				() => ({
					x: constant(text),
					work: async (ctx) => {
						await gate;
						return then(ctx);
					},
				}),
				{ accepts: { 1: { state: { gone: gone === "refuse" ? "refuse" : () => "mapped" } } } },
			),
		);

	it("a getter old work makes in the drain uses the old attempt that serves its version (Astra 1)", async () => {
		const gate = Promise.withResolvers<void>();
		const readsV1 = async (ctx: Ctx) => (await ctx.get(V1, {})).x.value;
		const host = createHost({ onError: () => {} });
		try {
			await host.load([{ name: "test", facet: provider("old", "map", gate.promise, readsV1) }], context);
			const working = (await host.get(V2, {}, context)).work(context);
			await flushed();
			// The successor refuses v1; the old attempt, still draining, maps it.
			await host.reload([{ name: "test", facet: provider("new", "refuse", gate.promise) }], context);
			gate.resolve();
			expect(await working).toBe("old");
		} finally {
			gate.resolve();
			await host.close(context);
		}
	});

	it("a version the old attempt refuses reads nothing of it while the successor that serves it waits (Astra 2, Sol)", async () => {
		const gate = Promise.withResolvers<void>();
		const host = createHost({ onError: () => {} });
		try {
			await host.load([{ name: "test", facet: provider("old", "refuse", gate.promise) }], context);
			const working = (await host.get(V2, {}, context)).work(context);
			await flushed();
			const ref = host.hold(V1, {}, context);
			expect(ref.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
			// The successor maps v1; the drain keeps the old attempt open, which refuses v1 every member.
			await host.reload([{ name: "test", facet: provider("new", "map", gate.promise) }], context);
			expect(ref.state.value.kind).toBe("loading");
			expect(() => ref.x.value).toThrow(expect.objectContaining({ code: "not_ready" }));
			gate.resolve();
			await working;
			await vi.waitFor(() => expect(ref.x.value).toBe("new"));
		} finally {
			gate.resolve();
			await host.close(context);
		}
	});
});
