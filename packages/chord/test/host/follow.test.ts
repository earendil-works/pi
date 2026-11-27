// Tests of `self.follow` (slice 6b §3, D9, R4): a source over another runtime's synchronous observer, attached during
// activation, its calls marked in the running batch or grouped into one batch outside it, its ends; and of
// `self.follow(over, attach)` (ERNDL-1191), attached again to each runtime a registry gives, with the races p3's
// plugin-side follower met in review (Opus, Astra, Fable).

import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { type Context, BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { int, local, obj, str } from "../../src/contracts/index.ts";
import { ChordError } from "../../src/data/index.ts";
import { applyImmutable, type Op } from "../../src/delta/index.ts";
import { FollowSource } from "../../src/host/follow.ts";
import type { ChordHost } from "../../src/host/host.ts";
import {
	createHost,
	defineFacet,
	type FacetHost,
	type FollowAttach,
	type FollowObserver,
	type HostError,
} from "../../src/host/index.ts";
import { defineRegistry } from "../../src/registries/index.ts";
import { Batch } from "../../src/state/batch.ts";
import { constant } from "../../src/state/index.ts";
import type { NativeWatchable, Watchable, WatchEnd } from "../../src/watch.ts";
import { changesOf, delivered, expectCollected, instancesOf, loaded, metered, valuesOf, waitLive } from "../support.ts";

const followed = instancesOf(FollowSource, "attach");

type Count = { readonly n: number };

/** A runtime with synchronous observers, as Durable's views have them. */
class Runtime {
	value: Count;
	readonly observers = new Set<FollowObserver<Count>>();
	attachments = 0;
	detached = 0;
	/** Resolves the next attachment when set (an attachment that takes time). */
	gate: Promise<void> | undefined;
	absent = false;
	/** What its attachments reject with, when set (a runtime that cannot be observed). */
	rejects: Error | undefined;

	constructor(n = 0) {
		this.value = { n };
	}

	readonly attach: FollowAttach<Count> = async (observer) => {
		this.observers.add(observer);
		this.attachments++;
		await this.gate;
		if (this.rejects !== undefined) {
			this.observers.delete(observer);
			throw this.rejects;
		}
		if (this.absent) return undefined;
		return {
			value: this.value,
			detach: () => {
				this.observers.delete(observer);
				this.detached++;
			},
		};
	};

	/** One change: every observer advanced with its ops. */
	set(n: number, retired = false): void {
		const ops: Op[] = [["s", ["n"], n]];
		this.value = { n };
		for (const observer of this.observers)
			observer.advance({ kind: "value", value: this.value, ops, retired }, context);
	}

	end(end: WatchEnd): void {
		for (const observer of [...this.observers]) observer.end(end);
		this.observers.clear();
	}
}

const View = local("app.view", { version: 1, params: {}, members: { a: obj({ n: int() }), sum: int() } });

/** Serves `View`, following `a` and `b`, its `sum` a derive over both (its computes counted). */
async function served(a = new Runtime(), b = new Runtime()) {
	let computes = 0;
	const { host, errors } = await loaded((h) =>
		h.serve(View, (_, self) => {
			const left = self.follow(a.attach);
			const right = self.follow(b.attach);
			const sum = self.derive([left, right], ([x, y]) => {
				computes++;
				return x.n + y.n;
			});
			return { a: left, sum };
		}),
	);
	const view = await host.get(View, {}, context);
	const batch = (host as unknown as ChordHost).batch;
	return { host, errors, view, a, b, batch, computes: () => computes };
}

describe("calls", () => {
	it("inside a running batch: one frame per commit, and a derive over two views computes once with both", async () => {
		const { view, a, b, batch, computes } = await served();
		const calls = changesOf(await view.a.watch(context));
		const sums = changesOf(await view.sum.watch(context));
		const before = computes();
		batch.commit(() => {
			a.set(1);
			a.set(2);
			b.set(10);
		}, context);
		await delivered();
		expect(calls).toEqual([
			{
				kind: "value",
				value: { n: 2 },
				ops: [
					["s", ["n"], 1],
					["s", ["n"], 2],
				],
				retired: false,
			},
		]);
		expect(valuesOf(sums)).toEqual([12]);
		expect(computes() - before).toBe(1);
	});

	it("outside any batch: queued and applied in one batch on the next microtask", async () => {
		const { view, a, b, computes } = await served();
		const sums = changesOf(await view.sum.watch(context));
		const before = computes();
		a.set(1);
		b.set(2);
		expect(view.a.value).toEqual({ n: 0 });
		await delivered();
		expect(view.a.value).toEqual({ n: 1 });
		expect(valuesOf(sums)).toEqual([3]);
		expect(computes() - before).toBe(1);
	});

	it("before the attachment resolved: applied in order on its value", async () => {
		const a = new Runtime();
		const gate = Promise.withResolvers<void>();
		a.gate = gate.promise;
		const serving = served(a);
		await delivered();
		a.set(5);
		a.set(6);
		gate.resolve();
		const { view } = await serving;
		expect(view.a.value).toEqual({ n: 6 });
	});

	it("a failed call fails the member until the next value, which replaces it whole (decision 140)", async () => {
		const { host, view, a } = await served();
		const calls = changesOf(await view.a.watch(context));
		for (const observer of a.observers) observer.advance({ kind: "failed", error: new Error("lost") }, context);
		await delivered();
		expect(() => view.a.value).toThrow("lost");
		a.set(4);
		await delivered();
		expect(calls).toEqual([{ kind: "failed", error: new Error("lost") }, replaced(4)]);
		expect(view.state.value).toEqual({ kind: "live" });
		await host.close(context);
	});
});

describe("types", () => {
	it("infers the value type from the attachment, without a type argument", async () => {
		const runtime = new Runtime();
		// A runtime's own observe, as Durable's `observeConversation` is: typed by its value, not by Chord's observer.
		const observe = (observer: FollowObserver<Count>) => runtime.attach(observer, context);
		await loaded((h) =>
			h.serve(View, (_, self) => {
				const a = self.follow((observer) => observe(observer));
				expectTypeOf(a).toEqualTypeOf<Watchable<Count>>();
				return { a, sum: self.derive([a], ([x]) => x.n) };
			}),
		);
	});
});

describe("activation", () => {
	it("an absent address fails the activation transient; a failed activation detaches what attached", async () => {
		const a = new Runtime();
		const b = new Runtime();
		b.absent = true;
		const { host, errors } = await loaded((h) =>
			h.serve(View, (_, self) => ({ a: self.follow(a.attach), sum: self.derive([self.follow(b.attach)], () => 0) })),
		);
		await expect(host.get(View, {}, context, { readyTimeout: 50 })).rejects.toThrow("followed address is absent");
		expect(errors.find((error) => error.kind === "activation_failed")).toMatchObject({
			failure: { kind: "transient" },
		});
		await delivered();
		expect([a.attachments, a.detached]).toEqual([a.attachments, a.attachments]);
		await host.close(context);
	});
});

describe("ends (R4)", () => {
	it("failed: the live object fails transient once, reported, and its retry attaches again", async () => {
		const { host, errors, view, a, b } = await served();
		a.end({ kind: "failed", error: new ChordError({ code: "unavailable", message: "session failed" }) });
		b.end({ kind: "failed", error: new ChordError({ code: "unavailable", message: "session failed" }) });
		expect(view.state.value).toMatchObject({ kind: "failed", cause: { kind: "transient" } });
		expect((view.state.value as { retryAt?: number }).retryAt).toBeGreaterThan(0);
		expect(errors.filter((error) => error.kind === "object_failed")).toHaveLength(1);
		expect(view.a.value).toEqual({ n: 0 });
		await delivered();
		view.retry();
		await delivered();
		await delivered();
		expect(view.state.value).toEqual({ kind: "live" });
		expect([a.attachments, a.detached, b.attachments]).toEqual([2, 1, 2]);
		a.set(3);
		await delivered();
		expect(view.a.value).toEqual({ n: 3 });
		await host.close(context);
	});

	it("ended: final; a queued retirement reaches the watch first, the value stays, a new watch ends at once", async () => {
		const { host, errors, view, a } = await served();
		const watch = await view.a.watch(context);
		const calls = changesOf(watch);
		a.set(4, true);
		a.end({ kind: "ended" });
		expect(await watch.closed).toEqual({ kind: "ended" });
		expect(calls).toMatchObject([{ kind: "value", value: { n: 4 }, retired: true }]);
		expect(view.a.value).toEqual({ n: 4 });
		const late = await view.a.watch(context);
		expect(late.value).toEqual({ n: 4 });
		expect(await late.closed).toEqual({ kind: "ended" });
		expect(errors).toEqual([]);
		expect(view.state.value).toEqual({ kind: "live" });
		await host.close(context);
	});
});

describe("ends during activation and in one batch (review regressions)", () => {
	it("an end before the attachment resolved keeps the attachment's value on the source", async () => {
		const source = new FollowSource(
			async (observer) => {
				observer.end({ kind: "ended" });
				return { value: { n: 7 }, detach() {} };
			},
			{ label: "early end", context, ended() {} },
			new Batch(() => {}, undefined),
		);
		await source.attach(context);
		expect(source.value).toEqual({ n: 7 });
	});

	it.each([
		["ended", { kind: "ended" } as const],
		["failed", { kind: "failed", error: new Error("early failure") } as const],
	])("an %s end before the attachment resolved fails the activation transient", async (_, end) => {
		const a = new Runtime();
		const gate = Promise.withResolvers<void>();
		a.gate = gate.promise;
		// Loading activates the object (local, empty params): its follow attaches meanwhile.
		const loading = loaded((h) =>
			h.serve(View, (_, self) => {
				const left = self.follow(a.attach);
				return { a: left, sum: self.derive([left], ([x]) => x.n) };
			}),
		);
		await delivered();
		a.end(end);
		gate.resolve();
		const { host, errors } = await loading;
		await delivered();
		expect(errors.find((error) => error.kind === "activation_failed")).toMatchObject({
			failure: { kind: "transient" },
		});
		await host.close(context);
		expect(a.detached).toBe(a.attachments);
	});

	it("an end while the object activates (after its sources attached) fails the activation transient", async () => {
		const a = new Runtime();
		let ended = false;
		const { host, errors } = await loaded((h) =>
			h.serve(View, (_, self) => {
				const left = self.follow(a.attach);
				// The activation computes the derives after the follows attached: the runtime ends then.
				const sum = self.derive([left], ([x]) => {
					if (!ended) {
						ended = true;
						a.end({ kind: "ended" });
					}
					return x.n;
				});
				return { a: left, sum };
			}),
		);
		await expect(host.get(View, {}, context, { readyTimeout: 50 })).rejects.toThrow();
		expect(ended).toBe(true);
		expect(errors.find((error) => error.kind === "activation_failed")).toMatchObject({
			failure: { kind: "transient" },
		});
		await host.close(context);
	});

	it("a retirement and an end inside one batch: the watch gets the retirement, then ends", async () => {
		const batch = new Batch(() => {}, undefined);
		let observer: FollowObserver<unknown> | undefined;
		const source = new FollowSource(
			async (attached) => {
				observer = attached;
				return { value: { n: 7 }, detach() {} };
			},
			{ label: "retirement", context, ended() {} },
			batch,
		);
		await source.attach(context);
		const watch = await source.watch(context);
		const calls = changesOf(watch);
		batch.commit(() => {
			observer!.advance({ kind: "value", value: { n: 7 }, ops: [], retired: true }, context);
			observer!.end({ kind: "ended" });
		}, context);
		expect(await watch.closed).toEqual({ kind: "ended" });
		expect(calls).toEqual([{ kind: "value", value: { n: 7 }, ops: [], retired: true }]);
	});

	it("a call and an end outside a batch with nothing watching: a later watch opens at the value and ends", async () => {
		let observer: FollowObserver<unknown> | undefined;
		const source = new FollowSource(
			async (attached) => {
				observer = attached;
				return { value: { n: 0 }, detach() {} };
			},
			{ label: "unwatched", context, ended() {} },
			new Batch(() => {}, undefined),
		);
		await source.attach(context);
		observer!.advance({ kind: "value", value: { n: 1 }, ops: [["s", ["n"], 1]], retired: true }, context);
		observer!.end({ kind: "ended" });
		await delivered();
		const watch = await source.watch(context);
		expect(watch.value).toEqual({ n: 1 });
		expect(await watch.closed).toEqual({ kind: "ended" });
		source.detach();
	});

	it("an end outside a batch after calls of two views: the views of one commit are delivered together", async () => {
		const { host, view, a, b, computes } = await served();
		const sums = changesOf(await view.sum.watch(context));
		const before = computes();
		a.set(1, true);
		b.set(2);
		a.end({ kind: "ended" });
		await delivered();
		expect(valuesOf(sums)).toEqual([3]);
		expect(computes() - before).toBe(1);
		await host.close(context);
	});
});

/** The runtime followed now, as a registry gives it (p3's harness): `undefined` while there is none. */
const Runtimes = defineRegistry<Runtime | undefined, Runtime | undefined>("app.runtimes", { version: 1 });

/** The host-lifetime object contributing the runtime given now (a harness plugin's object). */
const Giver = local("app.giver", { version: 1, params: {}, members: {} });

/** An object following the runtime given now: ended with its last reference (non-empty params). */
const Follower = local("app.follower", { version: 1, params: { id: str() }, members: { a: obj({ n: int() }) } });

/**
 * A host serving `Runtimes` (its first contribution's value), `Giver` with `first` given, and `Follower` over the
 * registry; `give` replaces the runtime given, as a reload of the runtime's plugin does (`undefined`: withdrawn).
 */
async function overRuntimes(first: Runtime | undefined) {
	// The first runtime given is let go of once given: a factory keeps what it reads.
	const control: { first: Runtime | undefined; give?: (runtime: Runtime | undefined) => void } = { first };
	const { host, errors } = await loaded(
		(h) => {
			h.serve(Runtimes, { compose: (table) => table[0]?.value });
			h.serve(Giver, (_, self) => {
				const given = self.writable(control.first);
				self.contribute(Runtimes, given);
				control.give = (runtime) => given.set(runtime);
				return {};
			});
			h.serve(Follower, (_, self) => {
				const runtimes = self.registry(Runtimes);
				self.retryOn(runtimes);
				const a = self.follow(runtimes, (runtime, observer, ctx) => runtime.attach(observer, ctx));
				expectTypeOf(a).toEqualTypeOf<Watchable<Count>>();
				return { a };
			});
		},
		{ readyTimeout: 500 },
	);
	control.first = undefined;
	const give = (runtime: Runtime | undefined) => control.give!(runtime);
	return { host, errors, give, hold: () => host.hold(Follower, { id: "1" }, context) };
}

/** A runtime whose next attachment waits for `open()`. */
function gated(n = 0): { readonly runtime: Runtime; open(): void } {
	const runtime = new Runtime(n);
	const gate = Promise.withResolvers<void>();
	runtime.gate = gate.promise;
	return { runtime, open: () => gate.resolve() };
}

/** The ops of a replacement with `n`. */
const replaced = (n: number) => ({ kind: "value", value: { n }, ops: [["r", { n }]], retired: false });

/** The registry's second contributor (a registry recomposing for another contribution). */
const Giver2 = local("app.giver2", { version: 1, params: {}, members: {} });

/**
 * Two plugins on one host: the giver opens its runtime as a native and contributes a plain object over it (as p3's
 * harness), its close ending the runtime's observers `failed`; the follower follows over the registry.
 */
async function twoPlugins(log: string[]) {
	const runtimes: Runtime[] = [];
	const giver = (n: number) =>
		defineFacet((h) => {
			h.serve(Runtimes, { compose: (table) => table[0]?.value });
			h.serve(Giver, (_, self) => {
				const native = self.open(
					async () => {
						const runtime = new Runtime(n);
						runtimes.push(runtime);
						log.push(`open ${n}`);
						return runtime;
					},
					async (runtime) => {
						log.push(`close ${runtime.value.n}`);
						runtime.end({ kind: "failed", error: new Error("session closed") });
					},
				);
				const given = {
					attach: (observer: FollowObserver<unknown>, ctx: Context) => native.value.attach(observer, ctx),
				};
				// The contribution only needs the runtime's `attach`.
				self.contribute(Runtimes, given as unknown as Runtime);
				return {};
			});
		});
	const errors: HostError[] = [];
	const host = createHost({ onError: (error) => errors.push(error), readyTimeout: 1_000 });
	// One facet for both loads: only the giver's plugin changes.
	const following = { name: "@test/follower", facet: follower() };
	await host.load([{ name: "@test/giver", facet: giver(0) }, following], context);
	const reload = (n: number) => host.reload([{ name: "@test/giver", facet: giver(n) }, following], context);
	return { host, errors, runtimes, reload };
}

/** The follower's plugin: `Follower` over `Runtimes`, retried on it. */
function follower() {
	return defineFacet((h) =>
		h.serve(Follower, (_, self) => {
			const runtimes = self.registry(Runtimes);
			self.retryOn(runtimes);
			return { a: self.follow(runtimes, (runtime, observer, ctx) => runtime.attach(observer, ctx)) };
		}),
	);
}

describe("over a changing source: activation (ERNDL-1191)", () => {
	it("waits for a first value while it activates, under the activation's deadline", async () => {
		const { host, errors, give, hold } = await overRuntimes(undefined);
		const ref = hold();
		await delivered();
		expect(ref.state.value.kind).toBe("loading");
		give(new Runtime(5));
		await waitLive(ref);
		expect(ref.a.value).toEqual({ n: 5 });
		expect(errors).toEqual([]);
		await host.close(context);
	});

	// Fable S1; Astra "replacement completing during the first attach is not lost" (round 3: its early calls never show).
	it("replaced while the first attachment attaches: the newest is followed, the first detached once it resolves", async () => {
		const a = gated();
		const { host, errors, give, hold } = await overRuntimes(a.runtime);
		const ref = hold();
		await delivered();
		a.runtime.set(5);
		const b = new Runtime(20);
		give(b);
		await delivered();
		a.open();
		await waitLive(ref);
		expect(ref.a.value).toEqual({ n: 20 });
		b.set(21);
		await delivered();
		expect(ref.a.value).toEqual({ n: 21 });
		expect([a.runtime.attachments, a.runtime.detached, b.attachments]).toEqual([1, 1, 1]);
		expect(errors).toEqual([]);
		await host.close(context);
	});

	// Astra round 2 (1): a superseded first attachment rejecting failed a normal reload's activation.
	it("a superseded first attachment that rejects fails nothing", async () => {
		const a = gated();
		a.runtime.rejects = new Error("session closed");
		const { host, errors, give, hold } = await overRuntimes(a.runtime);
		const ref = hold();
		await delivered();
		give(new Runtime(30));
		a.open();
		await waitLive(ref);
		expect(ref.a.value).toEqual({ n: 30 });
		expect(errors).toEqual([]);
		await host.close(context);
	});

	// Astra, round 1 of this change (M1): a value given between the first wait waking and its attachment was lost.
	it("does not attach a value replaced between the first wait waking and starting the attachment", async () => {
		const { host, give, hold } = await overRuntimes(undefined);
		const ref = hold();
		try {
			await delivered();
			const a = new Runtime(1),
				b = new Runtime(2);
			give(a);
			await Promise.resolve();
			await Promise.resolve();
			give(b);
			await waitLive(ref);
			expect([ref.a.value, b.attachments, a.observers.size]).toEqual([{ n: 2 }, 1, 0]);
		} finally {
			await host.close(context);
		}
	});

	// Astra, round 1 of this change (M1): a stalled first attachment held up a healthy successor until the deadline.
	it("a healthy replacement can activate before a superseded first attachment returns", async () => {
		const a = gated(1),
			b = new Runtime(2);
		const { host, errors, give, hold } = await overRuntimes(a.runtime);
		const ref = hold();
		try {
			await delivered();
			expect(a.runtime.attachments).toBe(1);
			give(b);
			await new Promise((resolve) => setTimeout(resolve, 550)); // readyTimeout is 500ms.
			expect([ref.state.value.kind, b.attachments, errors.map((e) => e.kind)]).toEqual(["live", 1, []]);
		} finally {
			a.open();
			await host.close(context);
		}
	});

	// Astra, round 1 of this change (M4): a failure while the attempt still activates went live as `follow_failed`.
	it("an already attached member failing while another follow still activates fails the activation", async () => {
		const a = new Runtime(1),
			block = gated(2);
		const { host, errors } = await loaded((h) =>
			h.serve(Follower, (_, self) => {
				const current = self.writable(a);
				const view = self.follow(current, (runtime, observer, ctx) => runtime.attach(observer, ctx));
				self.follow(block.runtime.attach);
				return { a: view };
			}),
		);
		try {
			const ref = host.hold(Follower, { id: "1" }, context);
			await delivered();
			expect([ref.state.value.kind, block.runtime.attachments]).toEqual(["loading", 1]);
			a.end({ kind: "failed", error: new Error("lost A") });
			block.open();
			await delivered();
			expect([ref.state.value.kind, errors.map((e) => e.kind)]).toEqual(["failed", ["activation_failed"]]);
		} finally {
			block.open();
			await host.close(context);
		}
	});
});

describe("over a changing source: replacement", () => {
	// The issue's test 1; p3: the transcript's swap case.
	it("a replaced source: its holders get one replacement, the object stays live, nothing is reported", async () => {
		const a = new Runtime();
		const { host, errors, give, hold } = await overRuntimes(a);
		const ref = hold();
		await waitLive(ref);
		const calls = changesOf(await ref.a.watch(context));
		a.set(1);
		await delivered();
		const b = new Runtime(10);
		give(b);
		await delivered();
		b.set(11);
		await delivered();
		expect(calls).toEqual([
			{ kind: "value", value: { n: 1 }, ops: [["s", ["n"], 1]], retired: false },
			replaced(10),
			{ kind: "value", value: { n: 11 }, ops: [["s", ["n"], 11]], retired: false },
		]);
		expect([a.detached, a.observers.size, b.attachments]).toEqual([1, 0, 1]);
		expect(ref.state.value).toEqual({ kind: "live" });
		expect(errors).toEqual([]);
		await host.close(context);
	});

	// Opus, round 1 of this change (S3): the issue's test 1 as p3 meets it, a reload of the giver's plugin.
	it("a real reload of the giver's plugin (its native closed with a failed end): one replacement, nothing reported", async () => {
		const log: string[] = [];
		const { host, errors, runtimes, reload } = await twoPlugins(log);
		const ref = host.hold(Follower, { id: "1" }, context);
		await waitLive(ref);
		const calls = changesOf(await ref.a.watch(context));
		runtimes[0]!.set(1);
		await delivered();
		await reload(10);
		await delivered();
		runtimes[1]!.set(11);
		await delivered();
		expect(log).toEqual(["open 0", "close 1", "open 10"]);
		expect(calls).toEqual([
			{ kind: "value", value: { n: 1 }, ops: [["s", ["n"], 1]], retired: false },
			replaced(10),
			{ kind: "value", value: { n: 11 }, ops: [["s", ["n"], 11]], retired: false },
		]);
		expect([errors, ref.state.value, runtimes[0]!.observers.size, runtimes[1]!.attachments]).toEqual([
			[],
			{ kind: "live" },
			0,
			1,
		]);
		await host.close(context);
	});

	// The issue's test 2; Opus M1, Fable S2, Astra "a new frame before the replacement attachment resolves".
	it("calls while it attaches again are held: one replacement with the newest value, then the later calls", async () => {
		const { host, errors, give, hold } = await overRuntimes(new Runtime());
		const ref = hold();
		await waitLive(ref);
		const calls = changesOf(await ref.a.watch(context));
		const b = gated(10);
		give(b.runtime);
		await delivered();
		b.runtime.set(11);
		b.runtime.set(12);
		await delivered();
		expect([calls, ref.a.value]).toEqual([[], { n: 0 }]);
		b.open();
		await delivered();
		b.runtime.set(13);
		await delivered();
		expect(calls).toEqual([
			replaced(12),
			{ kind: "value", value: { n: 13 }, ops: [["s", ["n"], 13]], retired: false },
		]);
		expect(errors).toEqual([]);
		await host.close(context);
	});

	// Astra, round 1 of this change (S1): a pending attachment kept every value it was given.
	it("a held attachment retains only the newest snapshot", async () => {
		const b = gated(2);
		const { host, give, hold } = await overRuntimes(new Runtime());
		const ref = hold();
		try {
			await waitLive(ref);
			give(b.runtime);
			await delivered();
			const old: WeakRef<Count>[] = [];
			for (let i = 0; i < 32; i++) {
				b.runtime.set(i);
				old.push(new WeakRef(b.runtime.value));
			}
			b.runtime.set(33);
			await expectCollected(...old);
		} finally {
			b.open();
			await host.close(context);
		}
	});

	// Astra round 1 (3) and round 2 (2); Opus "skips a superseded replacement's successful attachment".
	it.each(["resolves", "rejects"])(
		"an attachment overtaken while it attaches never shows when it %s, and the newest is followed",
		async (outcome) => {
			const { host, errors, give, hold } = await overRuntimes(new Runtime());
			const ref = hold();
			await waitLive(ref);
			const calls = changesOf(await ref.a.watch(context));
			const b = gated(10);
			if (outcome === "rejects") b.runtime.rejects = new Error("session closed");
			give(b.runtime);
			await delivered();
			const c = gated(20);
			give(c.runtime);
			await delivered();
			b.open();
			await delivered();
			expect([calls, ref.a.value]).toEqual([[], { n: 0 }]);
			c.open();
			await delivered();
			expect(calls).toEqual([replaced(20)]);
			expect([b.runtime.observers.size, c.runtime.attachments]).toEqual([0, 1]);
			expect(errors).toEqual([]);
			await host.close(context);
		},
	);

	// Astra, round 1 of this change: counted work of many changes before the attachment starts.
	it("rapid changes before attach starts only attach the newest; writing the same identity does no work", async () => {
		const a = new Runtime(0),
			rest = Array.from({ length: 128 }, (_, i) => new Runtime(1 + i));
		const { host, give, hold } = await overRuntimes(a);
		try {
			const ref = hold();
			await waitLive(ref);
			for (const next of rest) give(next);
			await delivered();
			for (let i = 0; i < 128; i++) give(rest.at(-1));
			await delivered();
			expect([a.detached, rest.reduce((n, r) => n + r.attachments, 0), ref.a.value]).toEqual([1, 1, { n: 128 }]);
		} finally {
			await host.close(context);
		}
	});

	// Opus, round 1 of this change (S1): a registry recovering with the same value attached it again.
	it("a registry that fails and recovers with the same value: no second attachment, no frame", async () => {
		const a = new Runtime(3);
		const control: { fail: boolean; poke?: (n: number) => void } = { fail: false };
		const { host, errors } = await loaded((h) => {
			h.serve(Runtimes, {
				compose: (table) => {
					if (control.fail) throw new Error("compose failed");
					return table.find((entry) => entry.value === a)?.value;
				},
			});
			h.serve(Giver, (_, self) => {
				self.contribute(Runtimes, self.writable<Runtime | undefined>(a));
				return {};
			});
			h.serve(Giver2, (_, self) => {
				const other = self.writable<Runtime | undefined>(undefined);
				self.contribute(Runtimes, other);
				control.poke = (n) => other.set(new Runtime(n));
				return {};
			});
			h.serve(Follower, (_, self) => ({
				a: self.follow(self.registry(Runtimes), (runtime, observer, ctx) => runtime.attach(observer, ctx)),
			}));
		});
		const ref = host.hold(Follower, { id: "1" }, context);
		await waitLive(ref);
		const calls = changesOf(await ref.a.watch(context));
		control.fail = true;
		control.poke!(1);
		await delivered();
		control.fail = false;
		control.poke!(2);
		await delivered();
		expect([a.attachments, calls, errors.map((error) => error.kind)]).toEqual([1, [], ["registry_failed"]]);
		await host.close(context);
	});

	// Astra "a late end from the old harness cannot end the new one".
	it("a late end and late calls of a replaced runtime's observer change nothing", async () => {
		const a = new Runtime();
		const { host, errors, give, hold } = await overRuntimes(a);
		const ref = hold();
		await waitLive(ref);
		const [old] = a.observers;
		give(new Runtime(10));
		await delivered();
		old!.advance({ kind: "value", value: { n: 99 }, ops: [["s", ["n"], 99]], retired: false }, context);
		old!.end({ kind: "failed", error: new Error("session closed") });
		await delivered();
		expect([ref.a.value, ref.state.value]).toEqual([{ n: 10 }, { kind: "live" }]);
		expect(errors).toEqual([]);
		await host.close(context);
	});

	it("an end in the batch that replaced its runtime, before the source's call came, changes nothing", async () => {
		const a = new Runtime();
		const { host, errors, give, hold } = await overRuntimes(a);
		const ref = hold();
		await waitLive(ref);
		const batch = (host as unknown as ChordHost).batch;
		// As Durable's close inside a commit that also withdrew it: the end comes before the registry's frame.
		batch.commit(() => {
			give(new Runtime(10));
			a.end({ kind: "failed", error: new Error("session closed") });
		}, context);
		await delivered();
		expect([ref.a.value, errors]).toEqual([{ n: 10 }, []]);
		await host.close(context);
	});

	// Astra, round 1 of this change (M3): a withdrawn runtime's call in the withdrawal's batch wrote the view.
	it("an old runtime's value call in the withdrawal batch cannot publish after it was withdrawn", async () => {
		const a = new Runtime(1);
		const { host, give, hold } = await overRuntimes(a);
		const ref = hold();
		try {
			await waitLive(ref);
			const calls = changesOf(await ref.a.watch(context));
			const batch = (host as unknown as ChordHost).batch;
			batch.commit(() => {
				give(undefined);
				a.set(99);
			}, context);
			await delivered();
			expect([ref.a.value, calls]).toEqual([{ n: 1 }, []]);
		} finally {
			await host.close(context);
		}
	});

	// Astra "an in-flight reader frame over a link folds a replacement and its later frames correctly".
	it("a busy watch gets the replacement and the calls after it folded, which take its value to the newest", async () => {
		const a = new Runtime();
		const { host, give, hold } = await overRuntimes(a);
		const ref = hold();
		await waitLive(ref);
		const watch = await ref.a.watch(context);
		const busy = Promise.withResolvers<void>();
		let mirror: Count = watch.value;
		let first = true;
		watch.start(async (call) => {
			if (call.kind !== "value") return;
			mirror = applyImmutable(mirror, call.ops);
			if (first) {
				first = false;
				await busy.promise;
			}
		});
		a.set(1);
		await delivered();
		const b = new Runtime(10);
		give(b);
		await delivered();
		b.set(11);
		await delivered();
		const c = new Runtime(20);
		give(c);
		await delivered();
		c.set(21);
		await delivered();
		busy.resolve();
		await delivered();
		expect([mirror, ref.a.value]).toEqual([{ n: 21 }, { n: 21 }]);
		await watch.stop();
		await host.close(context);
	});

	// Opus, round 1 of this change (S3): a reload of the follower's plugin while it attaches again.
	it("the follower's plugin reloaded while it attaches again: the old attempt's attachment is detached, the new one follows", async () => {
		const control: { give?: (runtime: Runtime | undefined) => void } = {};
		const giver = defineFacet((h) => {
			h.serve(Runtimes, { compose: (table) => table[0]?.value });
			h.serve(Giver, (_, self) => {
				const given = self.writable<Runtime | undefined>(new Runtime(0));
				self.contribute(Runtimes, given);
				control.give = (runtime) => given.set(runtime);
				return {};
			});
		});
		const errors: HostError[] = [];
		const host = createHost({ onError: (error) => errors.push(error), readyTimeout: 1_000 });
		const plugins = [
			{ name: "@test/giver", facet: giver },
			{ name: "@test/follower", facet: follower() },
		];
		await host.load(plugins, context);
		const ref = host.hold(Follower, { id: "1" }, context);
		await waitLive(ref);
		const b = gated(10);
		control.give!(b.runtime);
		await delivered();
		const reloading = host.reload([plugins[0]!, { name: "@test/follower", facet: follower() }], context);
		await delivered();
		b.open();
		await reloading;
		await delivered();
		b.runtime.set(11);
		await delivered();
		expect([errors, ref.a.value, b.runtime.attachments - b.runtime.detached, b.runtime.observers.size]).toEqual([
			[],
			{ n: 11 },
			1,
			1,
		]);
		await host.close(context);
		expect(b.runtime.observers.size).toBe(0);
	});
});

describe("over a changing source: failure and retry (decision 131)", () => {
	// The issue's test 3; Opus M2, Fable S3 ("fails the follow when the next harness cannot be observed").
	it("an attachment that rejects fails the member once, the object stays live, and the backoff's retry follows", async () => {
		const { host, errors, give, hold } = await overRuntimes(new Runtime());
		const ref = hold();
		await waitLive(ref);
		const calls = changesOf(await ref.a.watch(context));
		const b = new Runtime(10);
		b.rejects = new Error("no observation");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		give(b);
		await vi.advanceTimersByTimeAsync(0);
		expect(valuesOf(calls)).toEqual([{ failed: "no observation" }]);
		expect(() => ref.a.value).toThrow("no observation");
		expect(ref.state.value).toEqual({ kind: "live" });
		expect(errors).toMatchObject([{ kind: "follow_failed", object: "app.follower(1)" }]);
		b.rejects = undefined;
		await vi.advanceTimersByTimeAsync(999);
		expect(b.attachments).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		vi.useRealTimers();
		await delivered();
		expect(calls.slice(1)).toEqual([replaced(10)]);
		expect(b.attachments).toBe(2);
		expect(errors).toHaveLength(1);
		await host.close(context);
	});

	it("a failed member attaches again at once on the next value of its source, with no second report", async () => {
		const { host, errors, give, hold } = await overRuntimes(new Runtime());
		const ref = hold();
		await waitLive(ref);
		const calls = changesOf(await ref.a.watch(context));
		const b = new Runtime(10);
		b.rejects = new Error("no observation");
		give(b);
		await delivered();
		give(new Runtime(20));
		await delivered();
		expect(valuesOf(calls)).toEqual([{ failed: "no observation" }, { n: 20 }]);
		expect(calls[1]).toEqual(replaced(20));
		expect(errors.map((error) => error.kind)).toEqual(["follow_failed"]);
		await host.close(context);
	});

	// Decision 131 (main session); Opus S1, Astra "a genuine end from the still-given harness fails the follower".
	it("a failed end of the runtime still given fails the member, not the object, and its retry attaches again", async () => {
		const a = new Runtime(3);
		const { host, errors, hold } = await overRuntimes(a);
		const ref = hold();
		await waitLive(ref);
		const calls = changesOf(await ref.a.watch(context));
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		a.end({ kind: "failed", error: new Error("session failed") });
		await vi.advanceTimersByTimeAsync(0);
		expect(valuesOf(calls)).toEqual([{ failed: "session failed" }]);
		expect(ref.state.value).toEqual({ kind: "live" });
		expect(errors.map((error) => error.kind)).toEqual(["follow_failed"]);
		await vi.advanceTimersByTimeAsync(1_000);
		vi.useRealTimers();
		await delivered();
		expect(calls.slice(1)).toEqual([replaced(3)]);
		expect([a.attachments, a.detached]).toEqual([2, 1]);
		await host.close(context);
	});

	it("an ended end of the runtime still given keeps the value, the watches open, until the next value attaches", async () => {
		const a = new Runtime(3);
		const { host, errors, give, hold } = await overRuntimes(a);
		const ref = hold();
		await waitLive(ref);
		const watch = await ref.a.watch(context);
		const calls = changesOf(watch);
		a.end({ kind: "ended" });
		await delivered();
		expect([calls, ref.a.value, a.detached]).toEqual([[], { n: 3 }, 1]);
		give(new Runtime(4));
		await delivered();
		expect(calls).toEqual([replaced(4)]);
		expect(errors).toEqual([]);
		await watch.stop();
		await host.close(context);
	});

	// Astra, round 1 of this change (M2): a recovery failing before its replacement published showed a healthy member.
	it("a recovery which itself ends failed before its frame flushes is not shown healthy", async () => {
		const a = new Runtime(1),
			b = gated(2);
		const { host, give, hold } = await overRuntimes(a);
		const ref = hold();
		try {
			await waitLive(ref);
			const calls = changesOf(await ref.a.watch(context));
			a.end({ kind: "failed", error: new Error("lost A") });
			await delivered();
			expect(() => ref.a.value).toThrow("lost A");
			give(b.runtime);
			await delivered();
			b.open();
			await Promise.resolve();
			await Promise.resolve();
			b.runtime.end({ kind: "failed", error: new Error("lost B") });
			await delivered();
			expect(b.runtime.observers.size).toBe(0);
			expect(calls.at(-1)?.kind).toBe("failed");
			expect(() => ref.a.value).toThrow();
		} finally {
			await host.close(context);
		}
	});

	// Astra, round 1 of this change (M5): a runtime's end ran the plugin's detach inside the commit.
	it("a failed end inside a batch runs the plugin's detach outside that batch", async () => {
		const Token = local("app.token", { version: 1, params: { id: str() }, members: {} });
		let end: () => void = () => {};
		const { host, errors } = await loaded((h) => {
			h.serve(Token, () => ({}));
			h.serve(Follower, (_, self) => {
				const current = self.writable(1);
				return {
					a: self.follow(current, async (n, observer, ctx) => {
						const ref = await host.get(Token, { id: "one" }, ctx);
						end = () => observer.end({ kind: "failed", error: new Error("lost runtime") });
						return { value: { n }, detach: () => ref.release() };
					}),
				};
			});
		});
		try {
			const ref = await host.get(Follower, { id: "1" }, context);
			expect(() => (host as unknown as ChordHost).batch.commit(end, context)).not.toThrow();
			await delivered();
			expect(() => ref.a.value).toThrow("lost runtime");
			expect(errors.map((e) => e.kind)).toEqual(["follow_failed"]);
		} finally {
			await host.close(context);
		}
	});
});

describe("over a changing source: withdrawal and release", () => {
	// Astra must 5: a withdrawn harness with no successor stayed reachable from the follower.
	it("withdrawn: the last value stays, nothing is followed, and the withdrawn runtime is collected", async () => {
		let a: Runtime | undefined = new Runtime();
		const weak = new WeakRef(a);
		const { host, errors, give, hold } = await overRuntimes(a);
		const ref = hold();
		await waitLive(ref);
		const calls = changesOf(await ref.a.watch(context));
		a.set(3);
		a = undefined;
		await delivered();
		give(undefined);
		await delivered();
		await expectCollected(weak);
		expect([valuesOf(calls), ref.a.value, ref.state.value]).toEqual([[{ n: 3 }], { n: 3 }, { kind: "live" }]);
		give(new Runtime(4));
		await delivered();
		expect(calls[1]).toEqual(replaced(4));
		expect(errors).toEqual([]);
		await host.close(context);
	});

	// Astra must 4: a reader dropped during the first attach kept an observer.
	it("released during its first attachment: the attachment is detached once it resolves, no frame follows", async () => {
		const a = gated();
		const { host, hold } = await overRuntimes(a.runtime);
		const ref = hold();
		await delivered();
		const released = ref.release();
		await delivered();
		a.open();
		await released;
		await delivered();
		expect([a.runtime.attachments, a.runtime.detached, a.runtime.observers.size]).toEqual([1, 1, 0]);
		await host.close(context);
	});

	it("released while it attaches again: the new attachment is detached once it resolves", async () => {
		const a = new Runtime();
		const { host, give, hold } = await overRuntimes(a);
		const ref = hold();
		await waitLive(ref);
		const b = gated(10);
		give(b.runtime);
		await delivered();
		await ref.release();
		b.open();
		await delivered();
		expect([a.detached, b.runtime.attachments, b.runtime.detached, b.runtime.observers.size]).toEqual([1, 1, 1, 0]);
		await host.close(context);
	});

	// Astra, round 1 of this change (M4): an attachment aborted by the release reported and retried during teardown.
	it("a re-attachment aborted by release neither reports nor retries during teardown", async () => {
		const closing = Promise.withResolvers<void>(),
			finishClose = Promise.withResolvers<void>(),
			attaching = Promise.withResolvers<void>();
		let replace: () => void = () => {},
			count = 0;
		const { host, errors } = await loaded((h) =>
			h.serve(Follower, (_, self) => {
				const source = self.writable(0);
				replace = () => source.set(1);
				self.open(
					async () => 1,
					async () => {
						closing.resolve();
						await finishClose.promise;
					},
				);
				const a = self.follow(source, async (n, _, ctx) => {
					if (n === 0) return { value: { n }, detach() {} };
					count++;
					attaching.resolve();
					const signal = ctx.abortSignal!;
					signal.throwIfAborted();
					return new Promise<never>((_, reject) =>
						signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
					);
				});
				return { a };
			}),
		);
		try {
			const ref = await host.get(Follower, { id: "1" }, context);
			replace();
			await attaching.promise;
			ref.release();
			await closing.promise;
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			await vi.advanceTimersByTimeAsync(60_000);
			vi.useRealTimers();
			expect([count, errors.map((e) => e.kind)]).toEqual([1, []]);
		} finally {
			finishClose.resolve();
			await host.close(context);
		}
	});
});

describe("over a changing source: declaration and counts", () => {
	it("follows registry values and writables only: another source breaks the factory", async () => {
		const { host } = await loaded((h) =>
			h.serve(View, (_, self) => {
				const a = self.follow(new Runtime().attach);
				const sum = self.derive([a], ([x]) => x.n);
				self.follow(sum as unknown as NativeWatchable<Runtime>, (runtime, observer, ctx) =>
					runtime.attach(observer, ctx),
				);
				return { a, sum };
			}),
		);
		await expect(host.get(View, {}, context)).rejects.toThrow("follows registry values and writables");
		await host.close(context);
	});

	it("a reload whose follow is over another source keeps the old code", async () => {
		const plain = (h: FacetHost) =>
			h.serve(View, (_, self) => {
				const a = self.follow(new Runtime().attach);
				return { a, sum: self.derive([a], ([x]) => x.n) };
			});
		const { host } = await loaded(plain);
		const result = await host.reload(
			[
				{
					name: "@test/app",
					facet: defineFacet((h) =>
						h.serve(View, (_, self) => {
							const a = self.follow(new Runtime().attach);
							const sum = self.derive([a], ([x]) => x.n);
							// Staging checks what it has as it is served (a writable and a derive are inert there): a constant.
							self.follow(constant(0) as unknown as NativeWatchable<Runtime>, (runtime, observer, ctx) =>
								runtime.attach(observer, ctx),
							);
							return { a, sum };
						}),
					),
				},
			],
			context,
		);
		expect(result.plugins.changed).toEqual([]);
		expect(result.failed).toMatchObject([{ plugin: "@test/app" }]);
		expect(String((result.failed[0] as { error: unknown }).error)).toContain("follows registry values and writables");
		await host.close(context);
	});

	it("counts its attachments: one per new value it attached to, one per retry", async () => {
		const { telemetry } = await metered();
		const control: { give?: (runtime: Runtime | undefined) => void } = {};
		const { host } = await loaded(
			(h) => {
				h.serve(Runtimes, { compose: (table) => table[0]?.value });
				h.serve(Giver, (_, self) => {
					const given = self.writable<Runtime | undefined>(new Runtime());
					self.contribute(Runtimes, given);
					control.give = (runtime) => given.set(runtime);
					return {};
				});
				h.serve(Follower, (_, self) => ({
					a: self.follow(self.registry(Runtimes), (runtime, observer, ctx) => runtime.attach(observer, ctx)),
				}));
			},
			{ telemetry },
		);
		const ref = host.hold(Follower, { id: "1" }, context);
		await waitLive(ref);
		const b = new Runtime(1);
		b.rejects = new Error("no observation");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		control.give!(b);
		await vi.advanceTimersByTimeAsync(0);
		b.rejects = undefined;
		await vi.advanceTimersByTimeAsync(1_000);
		vi.useRealTimers();
		const attaches = telemetry.getMetrics().filter((metric) => metric.name === "chord.follow.attaches");
		const by = (reason: string) =>
			attaches.filter((metric) => metric.attributes?.reason === reason).reduce((n, metric) => n + metric.value, 0);
		expect([by("value"), by("retry"), b.attachments]).toEqual([2, 1, 2]);
		await host.close(context);
	});
});

describe("GC", () => {
	it("a source its runtime ended is still detached at the object's end, then collected", async () => {
		const a = new Runtime();
		const { host } = await served(a);
		a.end({ kind: "ended" });
		await delivered();
		expect(a.detached).toBe(0);
		await host.close(context);
		expect(a.detached).toBe(1);
		await expectCollected(...followed.splice(0));
	});

	it("an ended object's source over a changing source is collected, unsubscribed, its retry dropped", async () => {
		const a = new Runtime();
		const { host, give, hold } = await overRuntimes(a);
		const ref = hold();
		await waitLive(ref);
		const b = new Runtime();
		b.rejects = new Error("no observation");
		give(b);
		await delivered();
		await ref.release();
		await delivered();
		await expectCollected(...followed.splice(0));
		expect([a.observers.size, b.attachments]).toEqual([0, 1]);
		await host.close(context);
	});

	it("an ended object's followed sources are collected, and their observers detached", async () => {
		const a = new Runtime();
		const { host } = await served(a);
		await host.close(context);
		expect(a.observers.size).toBe(0);
		await expectCollected(...followed.splice(0));
	});
});
