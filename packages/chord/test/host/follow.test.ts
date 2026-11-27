// Tests of `self.follow` (slice 6b §3, D9, R4): a source over another runtime's synchronous observer, attached during
// activation, its calls marked in the running batch or grouped into one batch outside it, its ends; and of
// `self.follow(over, attach)` (ERNDL-1191), attached again to each runtime a registry gives, with the races p3's
// plugin-side follower met in review (Opus, Astra, Fable).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { type Context, BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { int, local, obj, str, unknown } from "../../src/contracts/index.ts";
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

	// Astra, round 2 of this change (M4), Opus nit 1: a failed call before the attachment resolved was dropped; Opus,
	// round 3 (M4): kept as a failed member, a derive over it broke the activation for good.
	it.each(["plain", "over"])(
		"a failed call before the first %s attachment resolves fails the activation transient, and its retry attaches",
		async (form) => {
			const lost = new Error("failed while attaching");
			let attaches = 0;
			const { host, errors } = await loaded((h) =>
				h.serve(View, (_, self) => {
					const attach: FollowAttach<Count> = async (observer, ctx) => {
						if (attaches++ === 0) observer.advance({ kind: "failed", error: lost }, ctx);
						return { value: { n: 7 }, detach() {} };
					};
					const a =
						form === "plain"
							? self.follow(attach)
							: self.follow(self.writable(1), (_, observer, ctx) => attach(observer, ctx));
					return { a, sum: self.derive([a], ([x]) => x.n) };
				}),
			);
			try {
				const ref = host.hold(View, {}, context);
				await delivered();
				expect(ref.state.value).toMatchObject({ kind: "failed", cause: { kind: "transient" } });
				expect(errors).toMatchObject([{ kind: "activation_failed", failure: { kind: "transient" } }]);
				ref.retry();
				await waitLive(ref);
				expect([ref.a.value, ref.sum.value, attaches]).toEqual([{ n: 7 }, 7, 2]);
			} finally {
				await host.close(context);
			}
		},
	);
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

	// Astra, round 2 of this change (M1): A, B, A in one batch dropped the attachment and no frame came to attach it again.
	it("an intermediate move within a batch never orphans the follow when the batch gives A again", async () => {
		const a = new Runtime(1),
			b = new Runtime(2);
		const { host, errors, give, hold } = await overRuntimes(a);
		try {
			const ref = hold();
			await waitLive(ref);
			(host as unknown as ChordHost).batch.commit(() => {
				give(b);
				a.set(99);
				give(a);
			}, context);
			await delivered();
			a.set(7);
			await delivered();
			expect([a.observers.size, ref.a.value, errors]).toEqual([1, { n: 7 }, []]);
		} finally {
			await host.close(context);
		}
	});

	// Astra, round 2 of this change (M3): a held `null` was taken for no held value.
	it("a held null replaces a non-null attachment snapshot, on first attach and on replacement", async () => {
		const Nullable = local("app.nullable", { version: 1, params: { id: str() }, members: { a: unknown() } });
		let replace = () => {};
		const { host } = await loaded((h) =>
			h.serve(Nullable, (_, self) => {
				const given = self.writable(1);
				replace = () => given.set(2);
				return {
					a: self.follow(given, async (n, observer) => {
						observer.advance({ kind: "value", value: null, ops: [["r", null]], retired: false }, context);
						return { value: n, detach() {} };
					}),
				};
			}),
		);
		try {
			const ref = await host.get(Nullable, { id: "1" }, context);
			const initial = ref.a.value;
			const calls = changesOf(await ref.a.watch(context));
			replace();
			await delivered();
			expect([initial, ref.a.value, calls]).toEqual([
				null,
				null,
				[{ kind: "value", value: null, ops: [["r", null]], retired: false }],
			]);
		} finally {
			await host.close(context);
		}
	});

	// Astra, round 2 of this change (M4): a failed call while a replacement attached was dropped.
	it("a failed call while a replacement attaches is held, not discarded", async () => {
		const lost = new Error("lost B");
		let replace = () => {},
			recover = () => {};
		const { host } = await loaded((h) =>
			h.serve(Follower, (_, self) => {
				const s = self.writable(1);
				replace = () => s.set(2);
				return {
					a: self.follow(s, async (n, observer, ctx) => {
						if (n === 2) observer.advance({ kind: "failed", error: lost }, ctx);
						recover = () =>
							observer.advance({ kind: "value", value: { n: 8 }, ops: [["s", ["n"], 8]], retired: false }, ctx);
						return { value: { n }, detach() {} };
					}),
				};
			}),
		);
		try {
			const ref = await host.get(Follower, { id: "1" }, context);
			const calls = changesOf(await ref.a.watch(context));
			replace();
			await delivered();
			expect(() => ref.a.value).toThrow(lost);
			recover();
			await delivered();
			expect(calls).toEqual([{ kind: "failed", error: lost }, replaced(8)]);
		} finally {
			await host.close(context);
		}
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

	// Astra, round 2 of this change (S1): staging took a factory's derive for a writable.
	it("staging a follow over a factory's derive rejects the reload, preserving working code", async () => {
		const { host } = await loaded((h) =>
			h.serve(View, (_, self) => {
				const a = self.follow(new Runtime(7).attach);
				return { a, sum: self.derive([a], ([x]) => x.n) };
			}),
		);
		try {
			const ref = await host.get(View, {}, context);
			const result = await host.reload(
				[
					{
						name: "@test/app",
						facet: defineFacet((h) =>
							h.serve(View, (_, self) => {
								const a = self.follow(new Runtime().attach);
								const sum = self.derive([a], ([x]) => x.n);
								self.follow(sum, async (n) => ({ value: n, detach() {} }));
								return { a, sum };
							}),
						),
					},
				],
				context,
			);
			await delivered();
			expect([result.plugins.changed, ref.state.value.kind, ref.sum.value]).toEqual([[], "live", 7]);
		} finally {
			await host.close(context);
		}
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

/**
 * A registry that fails without a last good value once its one contributor leaves (its decision 5): the giver's own
 * follow fails it (`failGiver`); with `pause`, the follower's native waits for it before its follow attaches.
 */
async function failingRegistry(pause?: Promise<void>, options: { readyTimeout?: number } = {}) {
	const a = new Runtime(1);
	const started = Promise.withResolvers<void>();
	let failGiver = () => {};
	const { host, errors } = await loaded((h) => {
		h.serve(Runtimes, {
			compose: (table) => {
				if (!table.length) throw new Error("giver gone");
				return table[0]!.value;
			},
		});
		h.serve(Giver, (_, self) => {
			self.contribute(Runtimes, a);
			self.follow(async (observer) => {
				failGiver = () => observer.end({ kind: "failed", error: new Error("giver failed") });
				return { value: 1, detach() {} };
			});
			return {};
		});
		h.serve(Follower, (_, self) => {
			const registry = self.registry(Runtimes);
			if (pause)
				self.open(
					async () => {
						started.resolve();
						await pause;
						return 0;
					},
					async () => {},
				);
			const view = self.follow(registry, (runtime, observer, ctx) => runtime.attach(observer, ctx));
			return { a: view };
		});
	}, options);
	return { host, errors, a, failGiver: () => failGiver(), started: started.promise };
}

// Astra, round 2 of this change (M2): `over` failing with no last good value threw from Chord's observer and leaked.
describe("over a changing source: a registry with no usable value", () => {
	it("a failed registry with no last good value detaches the unavailable runtime; its calls cannot throw", async () => {
		const { host, a, failGiver } = await failingRegistry();
		try {
			const ref = await host.get(Follower, { id: "1" }, context);
			const registry = await host.registry(Runtimes, context);
			failGiver();
			await delivered();
			expect(() => registry.value).toThrow("giver gone");
			expect(() => a.set(9)).not.toThrow();
			expect([a.observers.size, ref.a.value]).toEqual([0, { n: 1 }]);
		} finally {
			await host.close(context);
		}
	});

	it("a registry that loses its value between the dependency check and first attach keeps no ended follow", async () => {
		const gate = Promise.withResolvers<void>();
		const { host, failGiver, started } = await failingRegistry(gate.promise);
		const source = (host as unknown as ChordHost).registryRecord(Runtimes.name).value(Runtimes.version);
		try {
			const ref = host.hold(Follower, { id: "1" }, context);
			await started;
			failGiver();
			await delivered();
			gate.resolve();
			await delivered();
			// No usable value is waited for under the activation's deadline, as `undefined` is.
			expect(ref.state.value.kind).toBe("loading");
			await ref.release();
			await delivered();
			expect([source.dependents.size, source.watched]).toEqual([0, false]);
		} finally {
			gate.resolve();
			await host.close(context);
		}
	});

	it("attaches again once the registry has a usable value", async () => {
		const { host, a, failGiver } = await failingRegistry();
		try {
			const ref = await host.get(Follower, { id: "1" }, context);
			const calls = changesOf(await ref.a.watch(context));
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			failGiver();
			await vi.advanceTimersByTimeAsync(0);
			expect(a.observers.size).toBe(0);
			// The giver's object retries after its backoff and contributes the runtime again.
			await vi.advanceTimersByTimeAsync(1_000);
			vi.useRealTimers();
			await delivered();
			a.set(5);
			await delivered();
			expect([a.observers.size, ref.a.value, calls]).toEqual([
				1,
				{ n: 5 },
				[replaced(1), { kind: "value", value: { n: 5 }, ops: [["s", ["n"], 5]], retired: false }],
			]);
		} finally {
			vi.useRealTimers();
			await host.close(context);
		}
	});
});

// Astra, round 3 of this change (M1): an attachment settling in the turn its source changed, before the reconciliation.
describe("over a changing source: settling in the turn its source changed", () => {
	it.each(["resolve", "reject"])(
		"a superseded %s cannot finish the activation while the actual current source is still attaching",
		async (outcome) => {
			const first = Promise.withResolvers<{ value: Count; detach(): void }>(),
				second = Promise.withResolvers<{ value: Count; detach(): void }>();
			let give = (_n: number) => {},
				starts = 0;
			const { host, errors } = await loaded((h) =>
				h.serve(Follower, (_, self) => {
					const s = self.writable(1);
					give = (n) => s.set(n);
					return {
						a: self.follow(s, (n) => {
							starts++;
							return n === 1 ? first.promise : second.promise;
						}),
					};
				}),
			);
			try {
				const ref = host.hold(Follower, { id: "1" }, context);
				await delivered();
				expect(starts).toBe(1);
				// A's promise queues Chord's await reaction; the source has changed before that reaction runs.
				if (outcome === "resolve") first.resolve({ value: { n: 1 }, detach() {} });
				else first.reject(new Error("A closed"));
				give(2);
				await delivered();
				const whilePending = [ref.state.value.kind, errors.map((e) => e.kind)];
				second.resolve({ value: { n: 2 }, detach() {} });
				await delivered();
				expect(whilePending).toEqual(["loading", []]);
				expect([ref.state.value.kind, ref.a.value]).toEqual(["live", { n: 2 }]);
			} finally {
				await host.close(context);
			}
		},
	);

	it.each(["resolve", "reject"])(
		"a superseded live re-attach's %s cannot publish or report after its withdrawal",
		async (outcome) => {
			const b = Promise.withResolvers<{ value: Count; detach(): void }>();
			let give = (_n: number | undefined) => {},
				starts = 0;
			const { host, errors } = await loaded((h) =>
				h.serve(Follower, (_, self) => {
					const s = self.writable<number | undefined>(1);
					give = (n) => s.set(n);
					return {
						a: self.follow(s, (n) => {
							starts++;
							return n === 2 ? b.promise : Promise.resolve({ value: { n }, detach() {} });
						}),
					};
				}),
			);
			try {
				const ref = await host.get(Follower, { id: "1" }, context);
				const calls = changesOf(await ref.a.watch(context));
				give(2);
				await delivered();
				expect(starts).toBe(2);
				if (outcome === "resolve") b.resolve({ value: { n: 2 }, detach() {} });
				else b.reject(new Error("withdrawn B"));
				give(undefined);
				await delivered();
				expect([calls, errors.map((e) => e.kind)]).toEqual([[], []]);
				expect(ref.a.value).toEqual({ n: 1 });
			} finally {
				await host.close(context);
			}
		},
	);
});

// Astra, round 3 of this change (M3, S1): the old observation is detached before the next attaches, and one its
// runtime ended stays ended until another value.
describe("over a changing source: the old observation", () => {
	it("releases a settled observation before its replacement needs the observation slot", async () => {
		let occupied = false,
			give = (_n: number) => {};
		const log: string[] = [];
		const { host, errors } = await loaded((h) =>
			h.serve(Follower, (_, self) => {
				const s = self.writable(1);
				give = (n) => s.set(n);
				return {
					a: self.follow(s, async (n) => {
						log.push(`attach ${n}`);
						if (occupied) throw new Error("observation still in use");
						occupied = true;
						return {
							value: { n },
							detach() {
								occupied = false;
								log.push(`detach ${n}`);
							},
						};
					}),
				};
			}),
		);
		try {
			const ref = await host.get(Follower, { id: "1" }, context);
			const calls = changesOf(await ref.a.watch(context));
			give(2);
			await delivered();
			expect([log, errors.map((e) => e.kind), calls]).toEqual([
				["attach 1", "detach 1", "attach 2"],
				[],
				[replaced(2)],
			]);
		} finally {
			await host.close(context);
		}
	});

	it("a registry recomposing to the same value does not restart an ended observation", async () => {
		const a = new Runtime(1);
		let poke = () => {};
		const { host } = await loaded((h) => {
			h.serve(Runtimes, { compose: () => a });
			h.serve(Giver, (_, self) => {
				const other = self.writable(a);
				self.contribute(Runtimes, other);
				poke = () => other.set(new Runtime(2));
				return {};
			});
			h.serve(Follower, (_, self) => ({
				a: self.follow(self.registry(Runtimes), (r, observer, ctx) => r.attach(observer, ctx)),
			}));
		});
		try {
			const ref = await host.get(Follower, { id: "1" }, context);
			const calls = changesOf(await ref.a.watch(context));
			a.end({ kind: "ended" });
			await delivered();
			poke();
			await delivered();
			expect([a.attachments, a.observers.size, calls]).toEqual([1, 0, []]);
		} finally {
			await host.close(context);
		}
	});
});

// Astra, round 3 of this change: the first wait for a registry with no usable value is bounded by the deadline (the
// decided expectation), its error naming the registry (Opus, round 3).
describe("over a changing source: the first wait under the deadline", () => {
	it("an unusable registry does not extend the attempt's deadline or leave a dependent afterwards", async () => {
		const gate = Promise.withResolvers<void>();
		const { host, errors, failGiver, started } = await failingRegistry(gate.promise, { readyTimeout: 200 });
		const source = (host as unknown as ChordHost).registryRecord(Runtimes.name).value(Runtimes.version);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		try {
			const ref = host.hold(Follower, { id: "1" }, context);
			await started;
			failGiver();
			await vi.advanceTimersByTimeAsync(0);
			gate.resolve();
			await vi.advanceTimersByTimeAsync(199);
			expect([ref.state.value.kind, source.dependents.size]).toEqual(["loading", 1]);
			await vi.advanceTimersByTimeAsync(1);
			expect([ref.state.value.kind, source.dependents.size]).toEqual(["failed", 0]);
			expect(errors.find((error) => error.kind === "activation_failed")).toMatchObject({
				failure: {
					error: {
						message:
							"app.follower(1): did not become live within 200 ms (waiting for a value of registry app.runtimes)",
					},
				},
			});
		} finally {
			gate.resolve();
			vi.useRealTimers();
			await host.close(context);
		}
	});

	it("waits for a newly usable value under the same attempt, without an activation failure", async () => {
		const gate = Promise.withResolvers<void>();
		const { host, failGiver, started, a } = await failingRegistry(gate.promise);
		try {
			const ref = host.hold(Follower, { id: "1" }, context);
			await started;
			failGiver();
			await delivered();
			gate.resolve();
			await delivered();
			expect([ref.state.value.kind, a.attachments]).toEqual(["loading", 0]);
			const giver = host.hold(Giver, {}, context);
			giver.retry();
			await waitLive(ref);
			expect([ref.a.value, a.attachments]).toEqual([{ n: 1 }, 1]);
		} finally {
			gate.resolve();
			await host.close(context);
		}
	});
});

// Astra, round 3 of this change (M2): a registry whose provider was removed and served again woke no follower.
describe("over a changing source: its registry provider removed and served again", () => {
	it("a live follower resumes when a removed registry provider is installed again", async () => {
		const a = new Runtime(1),
			b = new Runtime(2);
		const consumer = { name: "@test/consumer", facet: follower() };
		const provider = (runtime: Runtime) => ({
			name: "@test/provider",
			facet: defineFacet((h) => h.serve(Runtimes, { compose: () => runtime })),
		});
		const host = createHost({ onError() {} });
		try {
			await host.load([provider(a), consumer], context);
			const ref = await host.get(Follower, { id: "1" }, context);
			const registry = await host.registry(Runtimes, context);
			const calls = changesOf(await ref.a.watch(context));
			await host.reload([consumer], context);
			await delivered();
			expect(() => registry.value).toThrow("no plugin serves");
			expect(ref.a.value).toEqual({ n: 1 });
			await host.reload([provider(b), consumer], context);
			await delivered();
			expect(registry.value).toBe(b);
			expect([ref.state.value.kind, ref.a.value, a.observers.size, b.observers.size, calls]).toEqual([
				"live",
				{ n: 2 },
				0,
				1,
				[replaced(2)],
			]);
		} finally {
			await host.close(context);
		}
	});
});

// Astra, round 4 of this change (M1-M3): the first attachment folds its calls until it settles (the last decides, a
// cancelled attach crashes nothing), and a detach that ends the attempt starts no successor.
describe("over a changing source: the first attachment's calls and the attempt's seal", () => {
	it("a synchronous failed call from an attach that honors cancellation cannot terminate the host", () => {
		const entry = fileURLToPath(new URL("./fixtures/follow-cancelled-attach.ts", import.meta.url));
		const child = spawnSync(process.execPath, ["--conditions=source", "--unhandled-rejections=strict", entry], {
			encoding: "utf8",
		});
		expect(child.status, child.stderr).toBe(0);
		expect(child.stdout).toContain("observed state and error reports: failed");
	});
	it.each(["plain", "over"])(
		"a %s attach whose early failure recovers before resolution activates from the final good value",
		async (form) => {
			const { host, errors } = await loaded((h) =>
				h.serve(View, (_, self) => {
					const attach: FollowAttach<Count> = async (observer, ctx) => {
						observer.advance({ kind: "failed", error: new Error("brief failure") }, ctx);
						observer.advance({ kind: "value", value: { n: 8 }, ops: [["r", { n: 8 }]], retired: false }, ctx);
						return { value: { n: 7 }, detach() {} };
					};
					const a =
						form === "plain"
							? self.follow(attach)
							: self.follow(self.writable(0), (_, obs, ctx) => attach(obs, ctx));
					return { a, sum: self.derive([a], ([x]) => x.n) };
				}),
			);
			try {
				const ref = host.hold(View, {}, context);
				await delivered();
				expect([ref.state.value.kind, errors.map((e) => e.kind)]).toEqual(["live", []]);
				expect([ref.a.value, ref.sum.value]).toEqual([{ n: 8 }, 8]);
			} finally {
				await host.close(context);
			}
		},
	);

	it.each(["plain", "over"])(
		"a %s attach ending with a failed call fails activation transient without a derive",
		async (form) => {
			const { host, errors } = await loaded((h) =>
				h.serve(Follower, (_, self) => {
					const attach: FollowAttach<Count> = async (observer, ctx) => {
						observer.advance({ kind: "failed", error: new Error("failed before return") }, ctx);
						return { value: { n: 7 }, detach() {} };
					};
					return {
						a:
							form === "plain"
								? self.follow(attach)
								: self.follow(self.writable(1), (_, obs, ctx) => attach(obs, ctx)),
					};
				}),
			);
			try {
				const ref = host.hold(Follower, { id: "1" }, context);
				await delivered();
				expect(ref.state.value).toMatchObject({ kind: "failed", cause: { kind: "transient" } });
				expect(errors).toMatchObject([{ kind: "activation_failed", failure: { kind: "transient" } }]);
			} finally {
				await host.close(context);
			}
		},
	);

	it("a settled observation's detach can release the last holder without starting the successor on an aborted attempt", async () => {
		let release = () => {},
			replace = () => {};
		const calls: [number, boolean][] = [];
		const { host, errors } = await loaded((h) =>
			h.serve(Follower, (_, self) => {
				const s = self.writable(1);
				replace = () => s.set(2);
				return {
					a: self.follow(s, async (n, _, ctx) => {
						calls.push([n, ctx.abortSignal!.aborted]);
						return {
							value: { n },
							detach() {
								if (n === 1) release();
							},
						};
					}),
				};
			}),
		);
		try {
			const ref = await host.get(Follower, { id: "1" }, context);
			release = () => ref.release();
			replace();
			await delivered();
			expect([calls, errors]).toEqual([[[1, false]], []]);
		} finally {
			await host.close(context);
		}
	});
});

// Astra, round 4 of this change (S2): an ended or failed value withdrawn and given again in the next batch.
describe("over a changing source: an idle value withdrawn and given again", () => {
	it.each(["ended", "failed"])(
		"a %s address withdrawn in one batch and given again in the next is observed without waiting for another input",
		async (end) => {
			const a = new Runtime(1);
			const { host, hold, give } = await overRuntimes(a);
			try {
				const ref = hold();
				await waitLive(ref);
				const registry = await host.registry(Runtimes, context);
				const frames: string[] = [];
				const observed = registry.observe(
					{
						advance(call) {
							if (call.kind === "value") frames.push(call.value === undefined ? "absent" : "present");
						},
						end() {},
					},
					context,
				);
				a.end(end === "ended" ? { kind: "ended" } : { kind: "failed", error: new Error("was unavailable") });
				await delivered();
				// Separate commits, not A/undefined/A *inside one commit*; native readers see both.
				give(undefined);
				give(a);
				await delivered();
				a.set(3);
				await delivered();
				observed.detach();
				expect([frames, a.attachments, a.observers.size]).toEqual([["absent", "present"], 2, 1]);
				expect(ref.a.value).toEqual({ n: 3 });
			} finally {
				await host.close(context);
			}
		},
	);
});

// Astra, round 4 of this change: contributions changed while no provider served the registry, read meanwhile.
describe("over a changing source: reads while its registry has no provider", () => {
	it("a contribution changed between unserved reads is the one the restored provider composes, then later contributions still wake it", async () => {
		const a = new Runtime(1),
			b = new Runtime(2),
			c = new Runtime(3),
			d = new Runtime(4);
		let give = (_v: Runtime) => {};
		const consumer = { name: "@test/consumer", facet: follower() };
		const giver = {
			name: "@test/giver",
			facet: defineFacet((h) =>
				h.serve(Giver, (_, self) => {
					const v = self.writable(a);
					self.contribute(Runtimes, v);
					give = (r) => v.set(r);
					return {};
				}),
			),
		};
		const provider = {
			name: "@test/provider",
			facet: defineFacet((h) => h.serve(Runtimes, { compose: (t) => t[0]?.value })),
		};
		const host = createHost({ onError() {} });
		try {
			await host.load([provider, giver, consumer], context);
			const ref = await host.get(Follower, { id: "1" }, context);
			const registry = await host.registry(Runtimes, context);
			const calls = changesOf(await ref.a.watch(context));
			await host.reload([giver, consumer], context);
			await delivered();
			expect(() => registry.value).toThrow("no plugin serves");
			give(b);
			expect(() => registry.value).toThrow("no plugin serves");
			give(c);
			expect(() => registry.value).toThrow("no plugin serves");
			await host.reload([giver, consumer, provider], context);
			await delivered();
			expect(registry.value).toBe(c);
			give(d);
			await delivered();
			expect([registry.value === d, ref.a.value, calls, b.attachments]).toEqual([
				true,
				{ n: 4 },
				[replaced(3), replaced(4)],
				0,
			]);
		} finally {
			await host.close(context);
		}
	});
});

// Astra, round 4 of this change (S1): the reader's registry version not served, then served again.
describe("over a changing source: its registry version served again", () => {
	it("a table change while this reader's version is not served cannot hide its compatible provider returning", async () => {
		const a = new Runtime(1),
			b = new Runtime(2);
		const V2 = defineRegistry<Runtime | undefined, Runtime | undefined>(Runtimes.name, { version: 2 });
		let give = (_r: Runtime) => {};
		const consumer = { name: "@test/consumer", facet: follower() };
		const giver = {
			name: "@test/giver",
			facet: defineFacet((h) =>
				h.serve(Giver, (_, self) => {
					const v = self.writable(a);
					give = (r) => v.set(r);
					self.contribute(Runtimes, v);
					return {};
				}),
			),
		};
		const v1 = {
			name: "@test/provider",
			facet: defineFacet((h) => h.serve(Runtimes, { compose: (t) => t[0]?.value })),
		};
		const v2 = { name: "@test/provider", facet: defineFacet((h) => h.serve(V2, { compose: () => undefined })) };
		const host = createHost({ onError() {} });
		try {
			await host.load([giver, consumer, v1], context);
			const ref = await host.get(Follower, { id: "1" }, context);
			const registry = await host.registry(Runtimes, context);
			const calls = changesOf(await ref.a.watch(context));
			await host.reload([giver, consumer, v2], context);
			await delivered();
			expect(() => registry.value).toThrow("version 1 is not served");
			expect(a.observers.size).toBe(0);
			give(b);
			await delivered();
			expect(() => registry.value).toThrow("version 1 is not served");
			await host.reload([giver, consumer, v1], context);
			await delivered();
			expect(registry.value).toBe(b);
			expect([ref.a.value, b.observers.size, calls]).toEqual([{ n: 2 }, 1, [replaced(2)]]);
		} finally {
			await host.close(context);
		}
	});
});

// Astra, round 5 of this change (M1, S3): the first attachment's failure is decided where the runtime's attachment
// settles, in both forms; before it only the last call is kept.
describe("over a changing source: the first runtime's settlement", () => {
	it.each(["plain", "over"])(
		"%s: a failure last at settlement is not healed by a value on the following microtask",
		async (form) => {
			const ready = Promise.withResolvers<void>();
			const attached = Promise.withResolvers<{ value: Count; detach(): void }>();
			let send: FollowObserver<unknown> | undefined;
			const { host, errors } = await loaded((h) =>
				h.serve(Follower, (_, self) => {
					const attach: FollowAttach<Count> = (observer) => {
						send = observer;
						ready.resolve();
						return attached.promise;
					};
					return {
						a: form === "plain" ? self.follow(attach) : self.follow(self.writable(1), (_, o, c) => attach(o, c)),
					};
				}),
			);
			try {
				const ref = host.hold(Follower, { id: "1" }, context);
				await ready.promise;
				send!.advance({ kind: "failed", error: new Error("failed before settlement") }, context);
				attached.resolve({ value: { n: 7 }, detach() {} });
				// In either form Chord's reaction to the plugin's promise was enqueued first.
				queueMicrotask(() =>
					send!.advance({ kind: "value", value: { n: 8 }, ops: [["r", { n: 8 }]], retired: false }, context),
				);
				await delivered();
				expect([ref.state.value, errors]).toMatchObject([
					{ kind: "failed", cause: { kind: "transient" } },
					[{ kind: "activation_failed" }],
				]);
			} finally {
				await host.close(context);
			}
		},
	);
	it.each(["plain", "over"])(
		"%s: a failed call after its successful settlement cannot be healed while the object is still activating",
		async (form) => {
			const ready = Promise.withResolvers<void>();
			const attached = Promise.withResolvers<{ value: Count; detach(): void }>();
			let send: FollowObserver<unknown> | undefined;
			const { host, errors } = await loaded((h) =>
				h.serve(Follower, (_, self) => {
					const attach: FollowAttach<Count> = (observer) => {
						send = observer;
						ready.resolve();
						return attached.promise;
					};
					return {
						a: form === "plain" ? self.follow(attach) : self.follow(self.writable(1), (_, o, c) => attach(o, c)),
					};
				}),
			);
			try {
				const ref = host.hold(Follower, { id: "1" }, context);
				await ready.promise;
				attached.resolve({ value: { n: 7 }, detach() {} });
				queueMicrotask(() => {
					send!.advance({ kind: "failed", error: new Error("failure after settlement") }, context);
					send!.advance({ kind: "value", value: { n: 8 }, ops: [["r", { n: 8 }]], retired: false }, context);
				});
				await delivered();
				expect([ref.state.value, errors]).toMatchObject([
					{ kind: "failed", cause: { kind: "transient" } },
					[{ kind: "activation_failed" }],
				]);
			} finally {
				await host.close(context);
			}
		},
	);
	it.each(["plain", "over"])(
		"%s: a pending initial attach folds superseded failure and value payloads instead of retaining its whole history",
		async (form) => {
			const ready = Promise.withResolvers<void>(),
				gate = Promise.withResolvers<void>();
			let send: FollowObserver<unknown> | undefined;
			const { host } = await loaded((h) =>
				h.serve(Follower, (_, self) => {
					const attach: FollowAttach<Count> = async (observer) => {
						send = observer;
						ready.resolve();
						await gate.promise;
						return { value: { n: 0 }, detach() {} };
					};
					return {
						a: form === "plain" ? self.follow(attach) : self.follow(self.writable(1), (_, o, c) => attach(o, c)),
					};
				}),
			);
			try {
				const ref = host.hold(Follower, { id: "1" }, context);
				await ready.promise;
				const stale: Array<WeakRef<object>> = [];
				const emit = (n: number) => {
					const error = new Error("superseded"),
						value = { n };
					stale.push(new WeakRef(error), new WeakRef(value));
					send!.advance({ kind: "failed", error }, context);
					send!.advance({ kind: "value", value, ops: [["r", value]], retired: false }, context);
				};
				for (let i = 0; i < 16; i++) emit(i);
				send!.advance({ kind: "value", value: { n: 17 }, ops: [["r", { n: 17 }]], retired: false }, context);
				await expectCollected(...stale);
				gate.resolve();
				await waitLive(ref);
				expect(ref.a.value).toEqual({ n: 17 });
			} finally {
				gate.resolve();
				await host.close(context);
			}
		},
	);
});

// Astra, round 5 of this change (S4): a committed withdrawal with no last good value wakes an idle member.
describe("over a changing source: an idle value and a registry with no last good value", () => {
	it.each(["ended", "failed"])(
		"a %s idle runtime is woken when a separate contributor restores the same value after an unusable commit",
		async (end) => {
			const runtime = new Runtime(1);
			let remove = () => {},
				restore = () => {};
			const { host } = await loaded((h) => {
				h.serve(Runtimes, {
					compose: (table) => {
						const runtime = table.find((each) => each.value !== undefined)?.value;
						if (runtime === undefined) throw new Error("no usable contribution");
						return runtime;
					},
				});
				h.serve(Giver, (_, self) => {
					self.contribute(Runtimes, runtime);
					self.follow(async (observer) => {
						remove = () => observer.end({ kind: "failed", error: new Error("giver left") });
						return { value: 1, detach() {} };
					});
					return {};
				});
				h.serve(Giver2, (_, self) => {
					const next = self.writable<Runtime | undefined>(undefined);
					self.contribute(Runtimes, next);
					restore = () => next.set(runtime);
					return {};
				});
				h.serve(Follower, (_, self) => ({ a: self.follow(self.registry(Runtimes), (r, o, c) => r.attach(o, c)) }));
			});
			try {
				const ref = await host.get(Follower, { id: "1" }, context),
					registry = await host.registry(Runtimes, context);
				runtime.end(end === "ended" ? { kind: "ended" } : { kind: "failed", error: new Error("retry later") });
				await delivered();
				remove();
				expect(() => registry.value).toThrow("no usable contribution");
				restore();
				expect(registry.value).toBe(runtime);
				await delivered();
				runtime.set(2);
				await delivered();
				expect([runtime.attachments, runtime.observers.size]).toEqual([2, 1]);
				expect(ref.a.value).toEqual({ n: 2 });
			} finally {
				await host.close(context);
			}
		},
	);
});

// Astra, round 5 of this change (S4, controls): a failure that keeps the last good value is no withdrawal.
describe("over a changing source: an idle value and a registry failing with its last good value", () => {
	it.each(["ended", "failed"])(
		"does not wake the idle %s observation on a failure that kept its input",
		async (end) => {
			const runtime = new Runtime(1);
			let give = (_r: Runtime | undefined) => {};
			const { host } = await loaded((h) => {
				h.serve(Runtimes, {
					compose: (table) => {
						const r = table[0]?.value;
						if (r === undefined) throw new Error("last good stays");
						return r;
					},
				});
				h.serve(Giver, (_, self) => {
					const value = self.writable<Runtime | undefined>(runtime);
					give = (r) => value.set(r);
					self.contribute(Runtimes, value);
					return {};
				});
				h.serve(Follower, (_, self) => ({ a: self.follow(self.registry(Runtimes), (r, o, c) => r.attach(o, c)) }));
			});
			try {
				await host.get(Follower, { id: "1" }, context);
				const registry = await host.registry(Runtimes, context);
				runtime.end(end === "ended" ? { kind: "ended" } : { kind: "failed", error: new Error("not available") });
				await delivered();
				give(undefined);
				expect(registry.value).toBe(runtime);
				give(runtime);
				await delivered();
				expect([runtime.attachments, runtime.observers.size]).toEqual([1, 0]);
			} finally {
				await host.close(context);
			}
		},
	);
});

// Astra, round 5 of this change (S2): a discarded first attachment's cleanup changes no error.
describe("over a changing source: a failed first attachment's cleanup", () => {
	it.each(["plain", "over"])(
		"%s: a cleanup end cannot replace the activation error selected at settlement",
		async (form) => {
			const original = new Error("failed while attaching"),
				cleanup = new Error("ended while cleaning up");
			let detached = 0;
			const { host, errors } = await loaded((h) =>
				h.serve(Follower, (_, self) => {
					const attach: FollowAttach<Count> = async (o, c) => {
						o.advance({ kind: "failed", error: original }, c);
						return {
							value: { n: 0 },
							detach() {
								detached++;
								o.end({ kind: "failed", error: cleanup });
							},
						};
					};
					return {
						a: form === "plain" ? self.follow(attach) : self.follow(self.writable(1), (_, o, c) => attach(o, c)),
					};
				}),
			);
			try {
				const ref = host.hold(Follower, { id: "1" }, context);
				await delivered();
				expect(ref.state.value).toMatchObject({
					kind: "failed",
					cause: { kind: "transient", error: { cause: original } },
				});
				expect(errors).toHaveLength(1);
				expect(detached).toBe(1);
			} finally {
				await host.close(context);
			}
		},
	);
});

// Astra, round 6 of this change: the cleanup of a failed first attachment runs inside the activation, after the
// follow is over for good.
describe("over a changing source: the cleanup of a failed first attachment", () => {
	it("rejecting the first attachment cannot start a successor from its own cleanup", async () => {
		const starts: number[] = [];
		const ends: number[] = [];
		const { host, errors } = await loaded((h) =>
			h.serve(Follower, (_, self) => {
				const s = self.writable(1);
				return {
					a: self.follow(s, async (n, o, c) => {
						starts.push(n);
						if (n === 1) o.advance({ kind: "failed", error: new Error("A failed") }, c);
						return {
							value: { n },
							detach() {
								ends.push(n);
								if (n === 1) s.set(2);
							},
						};
					}),
				};
			}),
		);
		try {
			const ref = host.hold(Follower, { id: "1" }, context);
			await delivered();
			expect([ref.state.value, errors]).toMatchObject([
				{ kind: "failed", cause: { kind: "transient" } },
				[{ kind: "activation_failed" }],
			]);
			expect([starts, ends]).toEqual([[1], [1]]);
		} finally {
			await host.close(context);
		}
	});
	it.each(["plain", "over"])(
		"%s: a rejected first attachment cannot turn an exception from its cleanup into an uncaught host error",
		(form) => {
			const entry = fileURLToPath(new URL("./fixtures/follow-throwing-cleanup.ts", import.meta.url));
			const proc = spawnSync(process.execPath, ["--conditions=source", entry, form], { encoding: "utf8" });
			expect(proc.status, proc.stderr).toBe(0);
			expect(proc.stdout).toContain("state=failed");
		},
	);
});

// Astra, round 6 of this change: an idle value reads the committed value on the batch of its source's host.
describe("over a changing source: an idle value and its source's batch", () => {
	it.each(["ended", "failed"])(
		"a registry from another in-process host wakes an idle %s observation on a committed withdrawal and reoffer",
		async (end) => {
			const runtime = new Runtime(1);
			const source = await overRuntimes(runtime);
			const registry = await source.host.registry(Runtimes, context);
			const { host } = await loaded((h) =>
				h.serve(Follower, (_, self) => ({ a: self.follow(registry, (r, o, c) => r.attach(o, c)) })),
			);
			try {
				const ref = await host.get(Follower, { id: "1" }, context);
				runtime.end(
					end === "ended" ? { kind: "ended" } : { kind: "failed", error: new Error("ended before withdrawal") },
				);
				await delivered();
				source.give(undefined);
				source.give(runtime);
				await delivered();
				runtime.set(2);
				await delivered();
				expect([runtime.attachments, runtime.observers.size]).toEqual([2, 1]);
				expect(ref.a.value).toEqual({ n: 2 });
			} finally {
				await host.close(context);
				await source.host.close(context);
			}
		},
	);
	it.each(["ended", "failed"])(
		"re-offering %s in a second deferred commit wakes it, but one commit ending at A does not",
		async (end) => {
			const runtime = new Runtime(1);
			const { host, hold, give } = await overRuntimes(runtime);
			try {
				const ref = hold();
				await waitLive(ref);
				const batch = (host as unknown as ChordHost).batch;
				runtime.end(
					end === "ended" ? { kind: "ended" } : { kind: "failed", error: new Error("ended before withdrawal") },
				);
				await delivered();
				batch.commit(() => {
					give(undefined);
					give(runtime);
				}, context);
				await delivered();
				expect([runtime.attachments, runtime.observers.size]).toEqual([1, 0]);
				batch.commit(() => {
					give(undefined);
					batch.flushing(() => give(runtime));
				}, context);
				await delivered();
				runtime.set(2);
				await delivered();
				expect([runtime.attachments, runtime.observers.size, ref.a.value]).toEqual([2, 1, { n: 2 }]);
			} finally {
				await host.close(context);
			}
		},
	);
});

// Astra, round 7 of this change: every detach of the over form goes through its cleanup, which reports a throw.
describe("over a changing source: a throwing detach on every path", () => {
	it.each(["stale", "release", "replace"])(
		"%s: cleanup is observed exactly once without ending the host process",
		(mode) => {
			const entry = fileURLToPath(new URL("./fixtures/follow-cleanup-paths.ts", import.meta.url));
			const proc = spawnSync(process.execPath, ["--conditions=source", entry, mode], { encoding: "utf8" });
			expect(proc.status, proc.stderr).toBe(0);
			expect(JSON.parse(proc.stdout)).toMatchObject({
				detached: 1,
				reports: ["follow_failed:Error: cleanup failure"],
			});
		},
	);
});
