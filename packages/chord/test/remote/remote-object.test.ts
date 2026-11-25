import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel, withTelemetry } from "../../src/context/index.ts";
import { hostKind, int, local, method, obj, remote, str } from "../../src/contracts/index.ts";
import { ChordError, PluginError } from "../../src/data/index.ts";
import { defineState } from "../../src/documents/index.ts";
import {
	createHost,
	defineFacet,
	type FacetHost,
	type Host,
	type HostError,
	type Reference,
	type RefIn,
} from "../../src/host/index.ts";
import { resolveWatchable } from "../../src/host/reference.ts";
import { type Link, memoryLinkPair } from "../../src/link/index.ts";
import { jsonPart, wireError } from "../../src/link/internal.ts";
import { Path } from "../../src/remote/path.ts";
import { RemoteObject } from "../../src/remote/remote-object.ts";
import { constant } from "../../src/state/index.ts";
import type { Watchable } from "../../src/watch.ts";
import {
	bindHold,
	bindNext,
	changesOf,
	delivered,
	EDITOR,
	expectCollected,
	failures,
	fakeTimers,
	forEachCodec,
	framesOf,
	instancesOf,
	linked,
	Match,
	Notes,
	PlacedNotes,
	partValue,
	RawPeer,
	rawParent,
	rawProvider,
	rejection,
	relayed,
	Server,
	Session,
	serveNotes,
	statesOf,
	type TestPrincipal,
	testCodec,
	transported,
	valuesOf,
	waitLive,
	wireNames,
} from "../support.ts";

/** A counter document of the remote types defined in tests. */
const Counter = defineState("counter", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });

forEachCodec(() => {
	describe("a hold over the parent link", () => {
		it("reject a broken failure at once", async () => {
			const Broken = remote("app.broken", {
				version: 1,
				params: {},
				hostAddress: () => Server(),
				variants: { v: { state: { n: int() } } },
			});
			const { client } = await linked((h) =>
				h.serve(Broken, () => {
					throw new Error("factory threw");
				}),
			);
			expect(await rejection(client.get(Broken, {}, context, { readyTimeout: 5_000 }))).toEqual({
				code: "unavailable",
				message: "app.broken: factory threw",
			});
		});

		it("gone: the reference ends, its pending calls reject with the error", async () => {
			const { client, peer } = await rawProvider();
			const got = client.get(Notes, { session: "S1" }, context);
			const hold = await bindNext(peer);
			const notes = await got;
			const watch = await notes.notes.watch(context);
			const call = notes.wait(context);
			await peer.next("call");
			peer.send({
				kind: "gone",
				hold,
				error: { kind: "chord", error: { code: "released", reason: "ended", message: "app.notes(S1): ended" } },
			});
			expect(await rejection(call)).toEqual({ code: "released", reason: "ended", message: "app.notes(S1): ended" });
			expect(await watch.closed).toEqual({ kind: "ended" });
			expect(() => notes.count.value).toThrow("app.notes(S1): ended");
		});

		it("two references from one host with one key share one hold; another key is another hold", async () => {
			const { client, peer } = await rawProvider();
			const first = client.get(Notes, { session: "S1" }, context);
			const second = client.get(Notes, { session: "S1" }, context);
			const other = client.get(Notes, { session: "S2" }, context);
			expect(await bindNext(peer)).toBe(0);
			expect(await bindNext(peer)).toBe(1);
			await Promise.all([first, second, other]);
			expect(peer.kinds().filter((kind) => kind === "hold")).toEqual([]);
		});

		it("a member failure fails only that replica: reads throw it, its watch gets a failure call and stays open; the others update", async () => {
			const { client, peer } = await rawProvider();
			const got = client.get(Notes, { session: "S1" }, context);
			const hold = await bindNext(peer);
			const notes = await got;
			const count = changesOf(await notes.count.watch(context));
			const list = framesOf(await notes.notes.watch(context));
			const failed = [{ member: EDITOR.state.count!, error: wireError(new PluginError("derive", "count threw")) }];
			const members = [{ member: EDITOR.state.notes!, ops: jsonPart([["p", [], 0, 0, [{ text: "a" }]]]) }];
			peer.send({ kind: "state", holds: [{ hold, members, failed, retired: [] }] });
			await delivered();
			expect(count).toEqual([{ kind: "failed", error: expect.objectContaining({ code: "derive" }) }]);
			expect(list).toEqual([[[{ text: "a" }], [["p", [], 0, 0, [{ text: "a" }]]]]]);
			expect(() => notes.count.value).toThrow("count threw");
			// The provider's derive healed: its next value is a root replacement, in the same hold.
			const healed = [{ member: EDITOR.state.count!, ops: jsonPart([["r", 1]]) }];
			peer.send({ kind: "state", holds: [{ hold, members: healed, failed: [], retired: [] }] });
			await delivered();
			expect(notes.count.value).toBe(1);
			expect(count.at(-1)).toEqual({ kind: "value", value: 1, ops: [["r", 1]], retired: false });
		});
	});

	describe("retired members", () => {
		it("reach the replicas' watches with the flag: with the member's ops, or alone", async () => {
			const { client, peer } = await rawProvider();
			const got = client.get(Notes, { session: "S1" }, context);
			const hold = await bindNext(peer, [{ text: "a" }]);
			const notes = await got;
			const list = changesOf(await notes.notes.watch(context));
			const count = changesOf(await notes.count.watch(context));
			const members = [{ member: EDITOR.state.notes!, ops: jsonPart([["r", []]]) }];
			const retired = [EDITOR.state.notes!, EDITOR.state.count!];
			peer.send({ kind: "state", holds: [{ hold, members, failed: [], retired }] });
			await delivered();
			expect(list).toEqual([{ kind: "value", value: [], ops: [["r", []]], retired: true }]);
			expect(count).toEqual([{ kind: "value", value: 1, ops: [], retired: true }]);
		});

		it("of a failed member wait for its next value: never read from the failed replica; the link stays open", async () => {
			const { client, peer, errors } = await rawProvider();
			const got = client.get(Notes, { session: "S1" }, context);
			const hold = await bindNext(peer, [{ text: "a" }]);
			const notes = await got;
			const count = changesOf(await notes.count.watch(context));
			const member = EDITOR.state.count!;
			const failed = [{ member, error: wireError(new PluginError("derive", "count threw")) }];
			peer.send({ kind: "state", holds: [{ hold, members: [], failed, retired: [] }] });
			// A retirement alone (no ops) of the failed member, then its healed value.
			peer.send({ kind: "state", holds: [{ hold, members: [], failed: [], retired: [member] }] });
			await delivered();
			const value = [{ member, ops: jsonPart([["r", 5]]) }];
			peer.send({ kind: "state", holds: [{ hold, members: value, failed: [], retired: [] }] });
			await transported();
			expect([peer.closed, notes.state.value, errors]).toEqual([false, { kind: "live" }, []]);
			expect(count).toEqual([
				{ kind: "failed", error: expect.objectContaining({ message: "count threw" }) },
				{ kind: "value", value: 5, ops: [["r", 5]], retired: true },
			]);
		});

		it.each([
			["names a member outside the variant", [7]],
			["names a member twice", [EDITOR.state.count!, EDITOR.state.count!]],
		])("that %s closes the link", async (_, retired) => {
			const { client, peer, errors } = await rawProvider();
			const got = client.get(Notes, { session: "S1" }, context);
			const hold = await bindNext(peer);
			await got;
			peer.send({ kind: "state", holds: [{ hold, members: [], failed: [], retired }] });
			await transported();
			expect(peer.closed).toBe(true);
			expect(errors.map(({ kind }) => kind)).toEqual(["protocol_error"]);
		});
	});

	describe("a snapshot", () => {
		it.each([
			["misses a member", [{ member: EDITOR.state.notes!, value: "[]" }], EDITOR.variant],
			[
				"names a member twice",
				[
					{ member: EDITOR.state.notes!, value: "[]" },
					{ member: EDITOR.state.notes!, value: "[]" },
					{ member: EDITOR.state.count!, value: "0" },
				],
				EDITOR.variant,
			],
			["names a member outside the variant", [{ member: 7, value: "0" }], EDITOR.variant],
			["names a variant outside the version", [], 5],
		])("that %s closes the link; the reference stays loading", async (_, members, variant) => {
			const { client, peer, errors } = await rawProvider();
			const notes = client.hold(Notes, { session: "S1" }, context);
			const { hold } = await peer.next("hold");
			peer.send({ kind: "bound", holds: [{ hold, variant, members, failed: [] }] });
			await transported();
			expect(peer.closed).toBe(true);
			expect(errors.map(({ kind }) => kind)).toEqual(["protocol_error"]);
			expect(notes.state.value).toEqual({ kind: "loading" });
			expect(notes.variant).toBeUndefined();
		});
	});

	describe("transient failures over a link", () => {
		fakeTimers();

		it("are waited through; the deadline rejects with the last cause and releases the hold", async () => {
			const Flaky = remote("app.flaky", {
				version: 1,
				params: { id: int() },
				hostAddress: () => Server(),
				variants: { v: { state: { n: int() } } },
			});
			const opens: string[] = [];
			const { client } = await linked((h) =>
				h.serve(Flaky, ({ id }, _principal, self) => {
					self.open(
						async (ctx) => {
							opens.push(`open ${opens.length + 1}`);
							if (opens.length === 1) throw new Error("offline");
							await new Promise((resolve) => ctx.abortSignal?.addEventListener("abort", resolve));
							opens.push("aborted");
						},
						() => {},
					);
					return { variant: "v", members: { n: constant(id) } };
				}),
			);
			const got = rejection(client.get(Flaky, { id: 1 }, context, { readyTimeout: 1_500 }));
			await transported();
			await vi.advanceTimersByTimeAsync(1_000);
			await transported();
			expect(opens).toEqual(["open 1", "open 2"]);
			await vi.advanceTimersByTimeAsync(500);
			expect(await got).toEqual({ code: "unavailable", message: "app.flaky(1): offline" });
			await transported();
			// The release ended the object: its pending attempt was abandoned.
			expect(opens).toEqual(["open 1", "open 2", "aborted"]);
		});
	});

	/** Every remote object bound while this file runs, weakly. */
	const remoteObjects = instancesOf(RemoteObject, "hold");

	describe("GC of a released remote reference", () => {
		it("a released reference retained by the test keeps no hold, replica or object", async () => {
			const { server, client } = await linked((h) => void serveNotes(h));
			const { notes, refs } = await (async () => {
				const made = remoteObjects.length;
				const notes = await client.get(Notes, { session: "S1" }, context);
				const refs: WeakRef<object>[] = [new WeakRef(resolveWatchable(notes.notes)!), ...remoteObjects.slice(made)];
				expect(refs).toHaveLength(2);
				notes.release();
				await transported();
				return { notes, refs };
			})();
			await expectCollected(...refs);
			expect([notes, server, client]).toBeDefined();
		});

		it("a failure call's error kept by the app keeps neither the replica nor the remote object", async () => {
			const Halves = remote("app.halves", {
				version: 1,
				params: {},
				hostAddress: () => Server(),
				variants: { v: { state: { half: int() }, methods: { set: method(int()) } } },
			});
			const { server, client } = await linked((h) =>
				h.serve(Halves, (_, _principal, self) => {
					const doc = self.state(Counter);
					return {
						variant: "v",
						members: {
							half: self.derive([doc], ([{ n }]) => {
								// A fresh error: its stack's frames would keep what threw it.
								if (n === 2) throw new Error("half threw");
								return n / 2;
							}),
							set: async (value, ctx) => {
								await doc.change((draft) => {
									draft.n = value;
								}, ctx);
								return null;
							},
						},
					};
				}),
			);
			const kept: unknown[] = [];
			const refs = await (async () => {
				const made = remoteObjects.length;
				const halves = await client.get(Halves, {}, context);
				if (halves.variant !== "v") throw new Error("expected variant v");
				const refs: WeakRef<object>[] = [new WeakRef(resolveWatchable(halves.half)!), ...remoteObjects.slice(made)];
				(await halves.half.watch(context)).start(async (call) => {
					if (call.kind === "failed") kept.push(call.error);
				});
				await halves.set(2, context);
				await transported();
				halves.release();
				await transported();
				return refs;
			})();
			expect(kept).toHaveLength(1);
			await expectCollected(...refs);
			expect([server, client]).toBeDefined();
		});
	});

	describe("self.get of a type over the link (dependency model §3)", () => {
		it("a failed hold parks the dependent failed { waiting }: no new attempt or hold; bound wakes it", async () => {
			const View = local("app.view", { version: 1, params: {}, members: { count: int() } });
			const errors: HostError[] = [];
			const client = createHost({ onError: (error) => errors.push(error) });
			const [a, b] = memoryLinkPair();
			client.connect(a, { principal: { kind: "server" }, codec: testCodec() }, context);
			const peer = new RawPeer(b);
			let factories = 0;
			const facet = defineFacet((h) =>
				h.serve(View, (_, self) => {
					factories++;
					return { count: self.get(Notes, { session: "S1" }).count };
				}),
			);
			const loading = client.load([{ name: "@test/view", facet }], context);
			const { hold } = await peer.next("hold");
			peer.send({
				kind: "failed",
				hold,
				cause: { kind: "transient", error: { kind: "chord", error: { code: "unavailable", message: "warming" } } },
			});
			// Parked on a remote blocker: its first outcome, so the start barrier is over.
			await loading;
			await transported();
			expect(errors).toEqual([]);
			const view = client.hold(View, {}, context);
			expect(view.state.value).toMatchObject({
				kind: "failed",
				cause: { kind: "waiting", error: { message: "waiting for app.notes(S1): warming" } },
			});
			bindHold(peer, hold, [{ text: "a" }]);
			await transported();
			expect(view.state.value).toEqual({ kind: "live" });
			expect(view.count.value).toBe(1);
			expect([factories, peer.kinds().filter((kind) => kind === "hold" || kind === "release")]).toEqual([1, []]);
		});
	});

	describe("self.get through a relay whose upstream dropped (R18)", () => {
		it("a loading notice while loading changes nothing: the dependent goes on waiting and goes live when bound", async () => {
			const View = local("app.view", { version: 1, params: {}, members: { count: int() } });
			const errors: HostError[] = [];
			const client = createHost({ onError: (error) => errors.push(error) });
			const [a, b] = memoryLinkPair();
			client.connect(a, { principal: { kind: "server" }, codec: testCodec() }, context);
			const peer = new RawPeer(b);
			const facet = defineFacet((h) =>
				h.serve(View, (_, self) => ({ count: self.get(Notes, { session: "S1" }).count })),
			);
			const loading = client.load([{ name: "@test/view", facet }], context);
			const { hold } = await peer.next("hold");
			// The relay's upstream link dropped before the hold was bound: a drop is not a dependency failure (audit).
			peer.send({ kind: "loading", hold });
			await transported();
			bindHold(peer, hold, [{ text: "a" }]);
			await loading;
			expect(errors).toEqual([]);
			const view = await client.get(View, {}, context);
			expect(view.count.value).toBe(1);
		});
	});

	describe("a dependent of an object failed transiently over the link", () => {
		// Timers stand still: neither the backoff window nor a readyTimeout ends while the test runs.
		fakeTimers();

		it("parks at once on the real cause when its load holds it (no wait for a timeout)", async () => {
			const Flaky = remote("app.flaky", {
				version: 1,
				params: {},
				hostAddress: () => Server(),
				variants: { v: { state: { n: int() } } },
			});
			const View = local("app.view", { version: 1, params: {}, members: { n: int() } });
			const { server, client: first } = await linked((h) =>
				h.serve(Flaky, (_, _principal, self) => {
					self.open(
						async () => {
							throw new Error("offline");
						},
						() => {},
					);
					return { variant: "v", members: { n: constant(1) } };
				}),
			);
			// The first client's get makes the object fail; it stays failed for its backoff window.
			const failing = first.get(Flaky, {}, context).catch(() => {});
			await transported();
			const errors: HostError[] = [];
			const second = createHost({ onError: (error) => errors.push(error) });
			const [a, b] = memoryLinkPair();
			server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
			second.connect(b, { principal: { kind: "server" }, codec: testCodec() }, context);
			const facet = defineFacet((h) => h.serve(View, (_, self) => ({ n: self.get(Flaky, {}).n })));
			await second.load([{ name: "@test/view", facet }], context);
			await transported();
			expect(errors).toEqual([]);
			expect(second.hold(View, {}, context).state.value).toMatchObject({
				kind: "failed",
				cause: { kind: "waiting", error: { message: "waiting for app.flaky: app.flaky: offline" } },
			});
			await first.close(context);
			await failing;
		});
	});
});

/** A remote type whose variants share `y`: `a` has `x` and a method, `b` has `z`. */
const Shifting = remote("app.shifting", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		a: { state: { x: int(), y: int() }, methods: { m: method() } },
		b: { state: { y: int(), z: int() } },
	},
});

/** A client whose `View` derives `x`+`y` of a `Shifting` reference, connected to a raw provider; `View` is bound. */
async function shifting() {
	const View = local("app.view", { version: 1, params: {}, members: { sum: int(), label: str() } });
	const errors: HostError[] = [];
	const client = createHost<TestPrincipal>({ onError: (error) => errors.push(error) });
	const peer = await rawParent(client);
	let held: Reference<typeof Shifting> | undefined;
	const facet = defineFacet<TestPrincipal>((h) =>
		h.serve(View, (_, self) => {
			const ref = self.get(Shifting, {});
			held = ref;
			const { x, y } = ref as RefIn<typeof Shifting, "a">;
			return {
				sum: self.derive([x, y], ([x, y]) => x + y),
				// Reads the reference's variant when `y` changes.
				label: self.derive([y], ([y]) => `${ref.variant}:${y}`),
			};
		}),
	);
	const loading = client.load([{ name: "@test/view", facet }], context);
	const A = wireNames(Shifting, "a");
	const { hold } = await peer.next("hold");
	const members = [
		{ member: A.state.x!, value: "1" },
		{ member: A.state.y!, value: "2" },
	];
	peer.send({ kind: "bound", holds: [{ hold, variant: A.variant, members, failed: [] }] });
	await loading;
	const view = await client.get(View, {}, context);
	return { client, peer, view, ref: held!, errors };
}

forEachCodec(() => {
	describe("re-holds after a drop", () => {
		it("hold every reference not released again on the next link, with that link's fresh ids, in order", async () => {
			const { client, peer } = await rawProvider();
			const refs = ["S1", "S2", "S3"].map((session) => client.hold(Notes, { session }, context));
			for (let i = 0; i < 3; i++) await bindNext(peer);
			refs[1]!.release();
			peer.close();
			await transported();
			const next = await rawParent(client);
			const holds = [await next.next("hold"), await next.next("hold")];
			expect(holds.map(({ hold, params }) => [hold, partValue(params)])).toEqual([
				[0, { session: "S1" }],
				[1, { session: "S3" }],
			]);
		});

		it("apply bound in one batch: each member gets one frame (a diff from its last value) and a fresh decoder", async () => {
			const { client, peer } = await rawProvider();
			const notes = client.hold(Notes, { session: "S1" }, context);
			await bindNext(peer, [{ text: "a" }]);
			await transported();
			const frames = framesOf(await notes.notes.watch(context));
			const counts = framesOf(await notes.count.watch(context));
			peer.close();
			await transported();
			const next = await rawParent(client);
			const hold = await bindNext(next, [{ text: "a" }, { text: "b" }]);
			await delivered();
			const list = [{ text: "a" }, { text: "b" }];
			// One frame each, a diff from the last value the reference kept while its hold re-bound.
			expect(frames).toEqual([[list, [["p", [], 1, 0, [{ text: "b" }]]]]]);
			expect(counts).toEqual([[2, [["r", 2]]]]);
			// The fresh decoder: the provider's new encoder starts over, interning paths anew.
			next.send({
				kind: "state",
				holds: [{ hold, members: [{ member: EDITOR.state.count!, ops: '[["r",3]]' }], failed: [], retired: [] }],
			});
			await delivered();
			expect(counts.at(-1)).toEqual([3, [["r", 3]]]);
		});

		it("a derive over two members of a re-held reference sees the snapshot whole: one batch", async () => {
			const { client, peer, view } = await shifting();
			const sums = framesOf(await view.sum.watch(context));
			peer.close();
			await transported();
			const next = await rawParent(client);
			const { hold } = await next.next("hold");
			const A = wireNames(Shifting, "a");
			const members = [
				{ member: A.state.x!, value: "10" },
				{ member: A.state.y!, value: "20" },
			];
			next.send({ kind: "bound", holds: [{ hold, variant: A.variant, members, failed: [] }] });
			await transported();
			expect(sums.map(([sum]) => sum)).toEqual([30]);
		});

		it("another variant: vanished members fail (watches stay open), derives over them fail, new members get values, parked calls are checked (race 14)", async () => {
			const { client, peer, view, ref } = await shifting();
			expect(view.sum.value).toBe(3);
			const a = ref as RefIn<typeof Shifting, "a">;
			const x = changesOf(await a.x.watch(context));
			const y = framesOf(await a.y.watch(context));
			const sum = changesOf(await view.sum.watch(context));
			const labels = framesOf(await view.label.watch(context));
			peer.close();
			await transported();
			const parked = rejection(a.m(context));
			const next = await rawParent(client);
			const { hold } = await next.next("hold");
			const B = wireNames(Shifting, "b");
			const members = [
				{ member: B.state.y!, value: "20" },
				{ member: B.state.z!, value: "30" },
			];
			next.send({ kind: "bound", holds: [{ hold, variant: B.variant, members, failed: [] }] });
			await transported();
			expect(ref.variant).toBe("b");
			const vanished = { kind: "failed", error: expect.objectContaining({ code: "invalid", reason: "member" }) };
			expect(x).toEqual([vanished]);
			expect(sum).toEqual([vanished]);
			expect(y).toEqual([[20, [["r", 20]]]]);
			// The variant changed in the same batch: the derive recomputed with the new one.
			expect(labels.map(([label]) => label)).toEqual(["b:20"]);
			expect((ref as RefIn<typeof Shifting, "b">).z.value).toBe(30);
			expect(() => a.x.value).toThrow('app.shifting (variant b) has no state member "x"');
			expect(await parked).toEqual({
				code: "invalid",
				reason: "member",
				message: 'app.shifting (variant b) has no method "m"',
			});
			// A later binding of the variant that has `x` brings it back in the same watches; the derive heals.
			next.close();
			await transported();
			const third = await rawParent(client);
			const again = (await third.next("hold")).hold;
			const A = wireNames(Shifting, "a");
			const back = [
				{ member: A.state.x!, value: "5" },
				{ member: A.state.y!, value: "6" },
			];
			third.send({ kind: "bound", holds: [{ hold: again, variant: A.variant, members: back, failed: [] }] });
			await transported();
			expect(x.at(-1)).toEqual({ kind: "value", value: 5, ops: [["r", 5]], retired: false });
			expect(view.sum.value).toBe(11);
			expect(sum.at(-1)).toEqual({ kind: "value", value: 11, ops: [["r", 11]], retired: false });
		});

		it("calls sent before a drop fail unavailable, never resent; an old link's leftovers never reach the next (race 1)", async () => {
			const { client, peer } = await rawProvider();
			const notes = client.hold(Notes, { session: "S1" }, context);
			await bindNext(peer);
			const { context: cancellable, cancel } = withCancel(context);
			const sent = notes.wait(cancellable);
			await peer.next("call");
			peer.close();
			expect(await rejection(sent)).toEqual({ code: "unavailable", message: "the link closed" });
			const next = await rawParent(client);
			const hold = await bindNext(next);
			await transported();
			cancel(new Error("late"));
			notes.release();
			await transported();
			expect(next.received).toEqual([{ kind: "ack" }, { kind: "release", hold }]);
		});

		it("a drop before bound, or during the next link's handshake, leaves it loading; the next connect holds again (race 5)", async () => {
			const { client, peer } = await rawProvider();
			const notes = client.hold(Notes, { session: "S1" }, context);
			await peer.next("hold");
			peer.close();
			await transported();
			const [a, b] = memoryLinkPair();
			client.connect(a, { principal: { kind: "server" }, codec: testCodec() }, context);
			// The peer never answers the handshake; the hold waits in the channel, then the link drops.
			b.close();
			await transported();
			expect(notes.state.value).toEqual({ kind: "loading" });
			await bindNext(await rawParent(client));
			await transported();
			expect(notes.state.value).toEqual({ kind: "live" });
		});

		it("a re-hold refused after a provider upgrade stays failed; the next connect holds it again", async () => {
			const NotesV2 = remote("app.notes", {
				version: 2,
				params: { session: str() },
				hostAddress: () => Server(),
				variants: { editor: { state: { count: int() } } },
			});
			const { server, client, links } = await linked((h) => void serveNotes(h));
			const upgraded = createHost<TestPrincipal>({
				address: Server(),
				principal: { kind: "server" },
				onError: () => {},
			});
			const facet = defineFacet<TestPrincipal>((h) =>
				h.serve(NotesV2, () => ({ variant: "editor", members: { count: constant(0) } })),
			);
			await upgraded.load([{ name: "@test/app", facet }], context);
			const notes = await client.get(Notes, { session: "S1" }, context);
			/** Drops the client's link and connects it to `to`. */
			const relink = async (to: Host<TestPrincipal>, from: Link) => {
				from.close();
				await transported();
				const [a, b] = memoryLinkPair();
				to.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
				client.connect(b, { principal: { kind: "server" }, codec: testCodec() }, context);
				await transported();
				return a;
			};
			const toUpgraded = await relink(upgraded, links[0]);
			expect(notes.state.value).toMatchObject({
				kind: "failed",
				cause: { kind: "waiting", error: { code: "contract_mismatch" } },
				retryAt: undefined,
			});
			notes.retry();
			await transported();
			expect(notes.state.value.kind).toBe("failed");
			await relink(server, toUpgraded);
			expect(notes.state.value).toEqual({ kind: "live" });
		});

		it("ref.retry() of a broken failure sends retry on the same hold: no release, no new hold (audit)", async () => {
			const { client, peer } = await rawProvider();
			const notes = client.hold(Notes, { session: "S1" }, context);
			const { hold } = await peer.next("hold");
			const error = { code: "forbidden", message: "not authorized" } as const;
			peer.send({ kind: "failed", hold, cause: { kind: "broken", error: { kind: "chord", error } } });
			await transported();
			expect(notes.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken" } });
			notes.retry();
			expect(await peer.next("retry")).toEqual({ kind: "retry", hold, hops: 16 });
			bindHold(peer, hold);
			await transported();
			expect(notes.state.value).toEqual({ kind: "live" });
			expect(peer.received.filter(({ kind }) => kind === "hold" || kind === "release")).toEqual([]);
		});

		it("ref.retry() of an object whose factory threw, held twice: failed, loading, live; a call made then succeeds (audit)", async () => {
			const Flaky = remote("app.flaky", {
				version: 1,
				params: {},
				hostAddress: () => Server(),
				variants: { only: { state: {}, methods: { ping: method() } } },
			});
			let factories = 0;
			const { client } = await linked((h) =>
				h.serve(Flaky, () => {
					if (++factories === 1) throw new Error("bad factory");
					return { variant: "only", members: { ping: async () => null } };
				}),
			);
			const one = client.hold(Flaky, {}, context);
			const two = client.hold(Flaky, {}, context);
			await transported();
			const states: string[] = [];
			const watch = await one.state.watch(context);
			states.push(watch.value.kind);
			watch.start(async (call) => {
				if (call.kind === "value") states.push(call.value.kind);
			});
			one.retry();
			// A call made while it loads again waits for the binding; none sees the old failure.
			let called: Promise<string> | undefined;
			const unwatch = await one.state.watch(context);
			unwatch.start(async (call) => {
				if (call.kind === "value" && call.value.kind === "loading" && called === undefined) {
					called = one.ping(context).then(
						() => "ok",
						(error: Error) => `rejected: ${error.message}`,
					);
				}
			});
			await transported();
			await transported();
			expect(states).toEqual(["failed", "loading", "live"]);
			expect(await called).toBe("ok");
			expect(two.state.value).toEqual({ kind: "live" });
			expect(factories).toBe(2);
		});

		it("a drop while failed: loading, held again on the next link (race 19)", async () => {
			const { client, peer } = await rawProvider();
			const notes = client.hold(Notes, { session: "S1" }, context);
			const { hold } = await peer.next("hold");
			const error = { code: "unavailable", message: "no configuration" } as const;
			peer.send({ kind: "failed", hold, cause: { kind: "broken", error: { kind: "chord", error } } });
			await transported();
			expect(notes.state.value.kind).toBe("failed");
			peer.close();
			await transported();
			expect(notes.state.value).toEqual({ kind: "loading" });
			await bindNext(await rawParent(client));
			await transported();
			expect(notes.state.value).toEqual({ kind: "live" });
		});

		it("a member watch before the first binding waits for it through a failure, and rejects when released (race 16)", async () => {
			const { client, peer } = await rawProvider();
			const bound = client.hold(Notes, { session: "S1" }, context);
			const failing = client.hold(Notes, { session: "S2" }, context);
			const released = client.hold(Notes, { session: "S3" }, context);
			const watches = [bound.count.watch(context), failing.count.watch(context), released.count.watch(context)];
			await bindNext(peer, [{ text: "a" }]);
			const { hold } = await peer.next("hold");
			const error = { code: "unavailable", message: "offline" } as const;
			peer.send({
				kind: "failed",
				hold,
				cause: { kind: "transient", error: { kind: "chord", error } },
				retryIn: 1_000,
			});
			released.release();
			expect((await watches[0]!).value).toBe(1);
			expect(await rejection(watches[2]!)).toEqual({ code: "released", message: "app.notes: released" });
			// A failure is waited through (Opus G3): the watch rejects only when its reference ends.
			let settled = false;
			const settle = (): void => {
				settled = true;
			};
			void watches[1]!.then(settle, settle);
			await transported();
			expect([failing.state.value.kind, settled]).toEqual(["failed", false]);
			failing.release();
			expect(await rejection(watches[1]!)).toMatchObject({ code: "released" });
		});
	});

	describe("a get across a drop", () => {
		fakeTimers();

		it("keeps waiting within its one deadline, from the moment it was called", async () => {
			const { client, peer } = await rawProvider();
			const got = client.get(Notes, { session: "S1" }, context, { readyTimeout: 1_000 });
			const late = rejection(client.get(Notes, { session: "S2" }, context, { readyTimeout: 1_000 }));
			await peer.next("hold");
			await peer.next("hold");
			await vi.advanceTimersByTimeAsync(400);
			peer.close();
			await transported();
			const next = await rawParent(client);
			await bindNext(next, [{ text: "a" }]);
			expect((await got).count.value).toBe(1);
			await vi.advanceTimersByTimeAsync(600);
			expect(await late).toEqual({
				code: "unavailable",
				message: "app.notes(S2): did not become live within 1000 ms",
			});
		});
	});

	describe("an activating dependent whose remote dependency's link drops (audit; supersedes race 18)", () => {
		fakeTimers();

		const View = local("app.view", { version: 1, params: {}, members: { count: int() } });
		const facet = defineFacet<TestPrincipal>((h) =>
			h.serve(View, (_, self) => ({ count: self.get(Notes, { session: "S1" }).count })),
		);

		it("stays loading through the drop, no failure reported, and goes live when the next link binds it", async () => {
			const errors: HostError[] = [];
			const client = createHost<TestPrincipal>({ onError: (error) => errors.push(error) });
			const peer = await rawParent(client);
			const loading = client.load([{ name: "@test/view", facet }], context);
			await peer.next("hold");
			peer.close();
			await transported();
			const view = client.hold(View, {}, context);
			expect(view.state.value).toEqual({ kind: "loading" });
			const next = await rawParent(client);
			expect(await bindNext(next, [{ text: "a" }])).toBe(0);
			await loading;
			await transported();
			expect(view.state.value).toEqual({ kind: "live" });
			expect(errors).toEqual([]);
		});

		it("dropped and never bound again, stays parked loading: nothing fails, one parked_long (audit A11)", async () => {
			const errors: HostError[] = [];
			const client = createHost<TestPrincipal>({ readyTimeout: 1_000, onError: (error) => errors.push(error) });
			const peer = await rawParent(client);
			const loading = client.load([{ name: "@test/view", facet }], context);
			await peer.next("hold");
			// A remote blocker ends the start barrier's first pass.
			await loading;
			peer.close();
			await transported();
			await vi.advanceTimersByTimeAsync(10_000);
			// A diagnostic whatever the blocker (audit A11): its path without a link too; nothing failed.
			expect(errors).toEqual([
				{ kind: "parked_long", object: "app.view", waitingFor: "app.notes(S1)", state: "loading", since: 0 },
			]);
			expect(client.hold(View, {}, context).state.value).toEqual({ kind: "loading" });
		});

		it("without any link stays loading past its readyTimeout and goes live when the first link binds its one hold", async () => {
			const errors: HostError[] = [];
			const client = createHost<TestPrincipal>({ readyTimeout: 1_000, onError: (error) => errors.push(error) });
			await client.load([{ name: "@test/view", facet }], context);
			await vi.advanceTimersByTimeAsync(500);
			expect(failures(errors)).toEqual([]);
			const next = await rawParent(client);
			expect(await bindNext(next, [{ text: "a" }])).toBe(0);
			expect((await client.get(View, {}, context, { readyTimeout: 1 })).count.value).toBe(1);
			expect(next.kinds().filter((kind) => kind === "hold" || kind === "release")).toEqual([]);
		});
	});

	describe("GC across a drop", () => {
		it("a reference that lived through a drop keeps nothing of the closed link", async () => {
			const { client, peer } = await rawProvider();
			const notes = client.hold(Notes, { session: "S1" }, context);
			await bindNext(peer);
			const closed = await (async () => {
				const [a, b] = memoryLinkPair();
				peer.close();
				await transported();
				client.connect(a, { principal: { kind: "server" }, codec: testCodec() }, context);
				const second = new RawPeer(b);
				await second.next("hello");
				await bindNext(second);
				second.close();
				await transported();
				return [new WeakRef(a), new WeakRef(second)];
			})();
			await bindNext(await rawParent(client));
			await expectCollected(...closed);
			expect(notes.state.value).toEqual({ kind: "live" });
		});
	});
});

describe("consumer spans (slice 9)", () => {
	it("holds in a `chord.hold` span until bound, its carrier on the hold; a call in a `chord.call` span, its carrier on the call", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const { client, peer } = await rawProvider({ telemetry });
		await telemetry.startSpan({ name: "view" }, async (span) => {
			const traced = withTelemetry(span, context);
			const getting = client.get(Notes, { session: "S1" }, traced);
			const held = await peer.next("hold");
			bindHold(peer, held.hold);
			const notes = await getting;
			const calling = (notes as RefIn<typeof Notes, "editor">).add({ text: "a" }, traced);
			const call = await peer.next("call");
			peer.send({ kind: "error", call: call.call, error: wireError(new PluginError("quota", "full")) });
			await rejection(calling);
			const spans = telemetry.getSpans();
			const hold = spans.find(({ name }) => name === "chord.hold")!;
			const chordCall = spans.find(({ name }) => name === "chord.call")!;
			expect(held.trace).toEqual(hold.context);
			expect(call.trace).toEqual(chordCall.context);
			expect(hold.attributes).toEqual({
				"chord.host": "client",
				type: "app.notes",
				object: "app.notes(S1)",
				"address.kind": "server",
				outcome: "bound",
			});
			expect(chordCall.attributes).toMatchObject({ member: "add", outcome: "error" });
			expect(chordCall.status).toEqual({ status: "error", error: { name: "call_failed", message: "full" } });
		});
	});

	it("keeps a call its caller cancelled ok, outcome `aborted` (a thrown cancel is no error)", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const { client, peer } = await rawProvider({ telemetry });
		const getting = client.get(Notes, { session: "S1" }, context);
		bindHold(peer, (await peer.next("hold")).hold);
		const notes = (await getting) as RefIn<typeof Notes, "editor">;
		const { context: cancellable, cancel } = withCancel(context);
		await telemetry.startSpan({ name: "view" }, async (span) => {
			const calling = notes.add({ text: "a" }, withTelemetry(span, cancellable));
			await peer.next("call");
			cancel();
			await rejection(calling);
		});
		const call = telemetry.getSpans().find(({ name }) => name === "chord.call")!;
		expect([call.attributes.outcome, call.status]).toEqual(["aborted", { status: "ok" }]);
	});

	it("ends a hold's span failed when its first answer is a failure", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const { client, peer } = await rawProvider({ telemetry });
		await telemetry.startSpan({ name: "view" }, async (span) => {
			client.hold(Notes, { session: "S1" }, withTelemetry(span, context));
			const { hold } = await peer.next("hold");
			const error = { kind: "chord", error: { code: "unavailable", message: "not served" } } as const;
			peer.send({ kind: "failed", hold, cause: { kind: "waiting", error } });
			await delivered();
		});
		const hold = telemetry.getSpans().find(({ name }) => name === "chord.hold")!;
		expect(hold.attributes.outcome).toBe("failed");
		expect(hold.status).toEqual({ status: "error", error: { name: "hold_failed", message: "not served" } });
	});
});

/** The kinds of the messages a raw provider received of `kind`, taken: how many holds or releases it saw. */
function taken(peer: RawPeer, kind: "hold" | "release" | "call" | "abort" | "retry"): number {
	const count = peer.received.filter((message) => message.kind === kind).length;
	peer.received.splice(0, peer.received.length, ...peer.received.filter((message) => message.kind !== kind));
	return count;
}

/** A remote panel whose variants differ in their state members: `wide` has `x`, `y` and `poke`, `narrow` only `x`. */
const Panel = remote("app.panel", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		wide: { state: { x: int(), y: int() }, methods: { poke: method(str(), int()) } },
		narrow: { state: { x: int() }, methods: {} },
	},
});

const WIDE = wireNames(Panel, "wide");

const NARROW = wireNames(Panel, "narrow");

/** Binds `hold` of `Panel` in `variant` with `values` (absent members failed with `failure`). */
function bindPanel(
	peer: RawPeer,
	hold: number,
	variant: "wide" | "narrow",
	values: { readonly x?: number; readonly y?: number },
	failure = "member threw",
): void {
	const names = variant === "wide" ? WIDE : NARROW;
	const members: { member: number; value: ReturnType<typeof jsonPart> }[] = [];
	const failed: { member: number; error: ReturnType<typeof wireError> }[] = [];
	for (const [member, index] of Object.entries(names.state)) {
		const value = values[member as "x" | "y"];
		if (value === undefined) failed.push({ member: index, error: wireError(new PluginError("derive", failure)) });
		else members.push({ member: index, value: jsonPart(value) });
	}
	peer.send({ kind: "bound", holds: [{ hold, variant: names.variant, members, failed }] });
}

/** Sends a `state` message setting `x` of `Panel`'s hold (bound `wide` or `narrow`), or failing it. */
function setX(peer: RawPeer, hold: number, x: number | undefined, variant: "wide" | "narrow" = "wide"): void {
	const member = (variant === "wide" ? WIDE : NARROW).state.x!;
	if (x === undefined) {
		const failed = [{ member, error: wireError(new PluginError("derive", "x threw")) }];
		peer.send({ kind: "state", holds: [{ hold, members: [], failed, retired: [] }] });
		return;
	}
	peer.send({
		kind: "state",
		holds: [{ hold, members: [{ member, ops: jsonPart([["r", x]]) }], failed: [], retired: [] }],
	});
}

/** What a watch opened now on `member` gives: its value (the last good one when failed), or the rejection. */
async function opened(member: Watchable<unknown>): Promise<{ opened?: unknown; rejected?: string }> {
	try {
		const watch = await member.watch(context);
		const value = watch.value;
		await watch.stop();
		return { opened: value };
	} catch (error) {
		return { rejected: (error as Error).message };
	}
}

describe('references sharing one wire hold (decision "References share one wire hold")', () => {
	describe("sharing", () => {
		it("two holds of one remote object: one hold, one snapshot; the second is live at once; a commit reaches both", async () => {
			const { client, peer } = await rawProvider();
			const first = client.hold(Notes, { session: "S1" }, context);
			const hold = await bindNext(peer, [{ text: "a" }]);
			await waitLive(first);
			const second = client.hold(Notes, { session: "S1" }, context);
			expect(second.state.value).toEqual({ kind: "live" });
			expect(second.count.value).toBe(1);
			expect(taken(peer, "hold")).toBe(0);
			const frames = [framesOf(await first.count.watch(context)), framesOf(await second.count.watch(context))];
			peer.send({
				kind: "state",
				holds: [
					{ hold, members: [{ member: EDITOR.state.count!, ops: jsonPart([["r", 2]]) }], failed: [], retired: [] },
				],
			});
			await delivered();
			expect(frames).toEqual([[[2, [["r", 2]]]], [[2, [["r", 2]]]]]);
			// Accepted difference 6: shared values are identical.
			expect(first.notes.value).toBe(second.notes.value);
		});

		it("joins show the object's state: loading, failed transient (retryAt), live; failed waiting over the link and broken hold anew", async () => {
			const { client, peer } = await rawProvider();
			const first = client.hold(Notes, { session: "S1" }, context);
			const { hold } = await peer.next("hold");
			expect(client.hold(Notes, { session: "S1" }, context).state.value).toEqual({ kind: "loading" });
			const error = wireError(new PluginError("down", "down"));
			peer.send({ kind: "failed", hold, cause: { kind: "transient", error }, retryIn: 60_000 });
			await delivered();
			const transient = client.hold(Notes, { session: "S1" }, context);
			expect(transient.state.value).toMatchObject({ kind: "failed", cause: { kind: "transient" } });
			expect((transient.state.value as { retryAt?: number }).retryAt).toBeGreaterThan(Date.now());
			peer.send({ kind: "loading", hold });
			bindHold(peer, hold);
			await delivered();
			expect(client.hold(Notes, { session: "S1" }, context).state.value).toEqual({ kind: "live" });
			expect(taken(peer, "hold")).toBe(0);
			// A refusal over the link: a new reference is a new request (a relay's failed route resolves again for it).
			peer.send({ kind: "failed", hold, cause: { kind: "waiting", error } });
			await delivered();
			client.hold(Notes, { session: "S1" }, context);
			expect((await peer.next("hold")).hold).toBe(1);
			// A broken object leaves the table for good.
			peer.send({ kind: "failed", hold: 1, cause: { kind: "broken", error } });
			peer.send({ kind: "failed", hold, cause: { kind: "broken", error } });
			await delivered();
			client.hold(Notes, { session: "S1" }, context);
			expect((await peer.next("hold")).hold).toBe(2);
			expect(first.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken" } });
		});

		it("releasing one sends nothing and the other keeps receiving; the last sends one release; a reference after it holds anew, also in the same turn", async () => {
			const { client, peer } = await rawProvider();
			const first = client.hold(Notes, { session: "S1" }, context);
			const second = client.hold(Notes, { session: "S1" }, context);
			const hold = await bindNext(peer);
			await waitLive(second);
			first.release();
			await delivered();
			expect(taken(peer, "release")).toBe(0);
			peer.send({
				kind: "state",
				holds: [
					{ hold, members: [{ member: EDITOR.state.count!, ops: jsonPart([["r", 5]]) }], failed: [], retired: [] },
				],
			});
			await delivered();
			expect(second.count.value).toBe(5);
			second.release();
			const third = client.hold(Notes, { session: "S1" }, context);
			await delivered();
			expect(peer.kinds().filter((kind) => kind === "release" || kind === "hold")).toEqual(["release", "hold"]);
			expect(third.state.value).toEqual({ kind: "loading" });
		});

		it("a getter timing out or aborted, before and after the object's first binding, releases only its own binding", async () => {
			const { client, peer } = await rawProvider();
			const kept = client.hold(Notes, { session: "S1" }, context);
			const { hold } = await peer.next("hold");
			const late = client.get(Notes, { session: "S1" }, context, { readyTimeout: 20 });
			const cancel = withCancel(context);
			const aborted = client.get(Notes, { session: "S1" }, cancel.context);
			cancel.cancel(new Error("gone"));
			expect(await rejection(aborted)).toMatchObject({ message: "gone" });
			expect(await rejection(late)).toMatchObject({ code: "unavailable" });
			bindHold(peer, hold);
			await waitLive(kept);
			// After the first binding: a getter of a failed object times out.
			const error = wireError(new PluginError("down", "down"));
			peer.send({ kind: "failed", hold, cause: { kind: "transient", error }, retryIn: 60_000 });
			await delivered();
			const again = client.get(Notes, { session: "S1" }, context, { readyTimeout: 20 });
			await rejection(again);
			await delivered();
			expect(taken(peer, "release")).toBe(0);
			expect(kept.state.value).toMatchObject({ kind: "failed" });
		});

		it("calls through two references are both answered; calls parked per reference go in order once live", async () => {
			const { client, peer } = await rawProvider();
			const first = client.hold(Notes, { session: "S1" }, context) as unknown as RefIn<typeof Notes, "editor">;
			const second = client.hold(Notes, { session: "S1" }, context) as unknown as RefIn<typeof Notes, "editor">;
			const parked = [first.add({ text: "a" }, context), second.add({ text: "b" }, context)];
			const hold = await bindNext(peer);
			const calls = [await peer.next("call"), await peer.next("call")];
			expect(calls.map(({ hold: held, args }) => [held, partValue(args!)])).toEqual([
				[hold, { text: "a" }],
				[hold, { text: "b" }],
			]);
			for (const [index, { call }] of calls.entries())
				peer.send({ kind: "result", call, value: jsonPart(index + 1) });
			expect(await Promise.all(parked)).toEqual([1, 2]);
		});
	});

	describe("state changes", () => {
		it("a rebind to another variant moves every binding in one batch; a member the new variant lacks fails for all", async () => {
			const { client, peer } = await rawProvider();
			const first = client.hold(Panel, {}, context) as unknown as RefIn<typeof Panel, "wide">;
			const second = client.hold(Panel, {}, context) as unknown as RefIn<typeof Panel, "wide">;
			const { hold } = await peer.next("hold");
			bindPanel(peer, hold, "wide", { x: 1, y: 2 });
			await waitLive(second);
			const calls = [changesOf(await first.y.watch(context)), changesOf(await second.y.watch(context))];
			peer.send({ kind: "loading", hold });
			bindPanel(peer, hold, "narrow", { x: 3 });
			await delivered();
			expect([first.variant, second.variant]).toEqual(["narrow", "narrow"]);
			expect(calls.map((each) => each.map(({ kind }) => kind))).toEqual([["failed"], ["failed"]]);
			expect(() => second.y.value).toThrow('has no state member "y"');
		});

		it("gone and the host's close end every binding exactly once (watches, subscriptions and calls too); a later reference holds anew", async () => {
			const { client, peer } = await rawProvider();
			const first = client.hold(Notes, { session: "S1" }, context) as unknown as RefIn<typeof Notes, "editor">;
			const second = client.hold(Notes, { session: "S1" }, context) as unknown as RefIn<typeof Notes, "editor">;
			const hold = await bindNext(peer);
			await waitLive(second);
			const watches = [await first.count.watch(context), await second.count.watch(context)];
			const call = rejection(second.add({ text: "a" }, context));
			await peer.next("call");
			const error = {
				kind: "chord",
				error: { code: "released", reason: "ended", message: "app.notes(S1): ended" },
			} as const;
			peer.send({ kind: "gone", hold, error });
			await delivered();
			expect([first.state.value.kind, second.state.value.kind]).toEqual(["ended", "ended"]);
			expect(await Promise.all(watches.map((watch) => watch.closed))).toEqual([
				{ kind: "ended" },
				{ kind: "ended" },
			]);
			expect(await call).toMatchObject({ code: "released", reason: "ended" });
			client.hold(Notes, { session: "S1" }, context);
			expect((await peer.next("hold")).hold).toBe(1);
			const third = client.hold(Notes, { session: "S2" }, context);
			const fourth = client.hold(Notes, { session: "S2" }, context);
			const waits = [third.count.watch(context), rejection(fourth.count.watch(context))];
			await client.close(context);
			expect([third.state.value.kind, fourth.state.value.kind]).toEqual(["ended", "ended"]);
			expect(await rejection(waits[0]!)).toMatchObject({ code: "released" });
			expect(await waits[1]).toMatchObject({ code: "released" });
		});

		it("a link drop: one re-hold, every binding live again", async () => {
			const { client, peer } = await rawProvider();
			const first = client.hold(Notes, { session: "S1" }, context);
			const second = client.hold(Notes, { session: "S1" }, context);
			await bindNext(peer);
			await waitLive(second);
			peer.close();
			await transported();
			expect([first.state.value.kind, second.state.value.kind]).toEqual(["loading", "loading"]);
			const next = await rawParent(client);
			await bindNext(next, [{ text: "b" }]);
			await waitLive(first);
			await waitLive(second);
			expect(taken(next, "hold")).toBe(0);
			expect(second.count.value).toBe(1);
		});

		it("failure and loading fan out to every binding: watch callbacks in batch order; a last release while the first binding is pending", async () => {
			const { client, peer } = await rawProvider();
			const first = client.hold(Notes, { session: "S1" }, context);
			const second = client.hold(Notes, { session: "S1" }, context);
			const { hold } = await peer.next("hold");
			first.release();
			second.release();
			await delivered();
			expect(taken(peer, "release")).toBe(1);
			const third = client.hold(Notes, { session: "S1" }, context);
			const fourth = client.hold(Notes, { session: "S1" }, context);
			const next = await bindNext(peer);
			expect(next).toBe(hold + 1);
			await waitLive(fourth);
			const order: string[] = [];
			for (const [name, ref] of [
				["third", third],
				["fourth", fourth],
			] as const) {
				(await ref.state.watch(context)).start(async (call) => {
					if (call.kind === "value") order.push(`${name} ${call.value.kind}`);
				});
			}
			const error = wireError(new PluginError("down", "down"));
			peer.send({ kind: "failed", hold: next, cause: { kind: "transient", error }, retryIn: 60_000 });
			await delivered();
			peer.send({ kind: "loading", hold: next });
			await delivered();
			expect(order).toEqual(["third failed", "fourth failed", "third loading", "fourth loading"]);
		});

		it("a broken object that recovers stays out of the table; ending it leaves the newer entry alone", async () => {
			const { client, peer } = await rawProvider();
			const a = client.hold(Notes, { session: "S1" }, context);
			const { hold } = await peer.next("hold");
			const error = wireError(new PluginError("down", "down"));
			peer.send({ kind: "failed", hold, cause: { kind: "broken", error } });
			await delivered();
			const c = client.hold(Notes, { session: "S1" }, context);
			const { hold: newer } = await peer.next("hold");
			a.retry();
			await peer.next("retry");
			peer.send({ kind: "loading", hold });
			bindHold(peer, hold);
			bindHold(peer, newer);
			await delivered();
			expect([a.state.value.kind, c.state.value.kind]).toEqual(["live", "live"]);
			a.release();
			await delivered();
			expect((await peer.next("release")).hold).toBe(hold);
			// D joins C's object: the recovered one never came back, and its end took nothing of C's.
			const d = client.hold(Notes, { session: "S1" }, context);
			expect([d.state.value.kind, taken(peer, "hold")]).toEqual(["live", 0]);
		});

		it("a refused hold's retry restarts it for every reference sharing it (accepted difference 8)", async () => {
			const { client, peer } = await rawProvider();
			const first = client.hold(Notes, { session: "S1" }, context);
			const second = client.hold(Notes, { session: "S1" }, context);
			const { hold } = await peer.next("hold");
			const error = wireError(new ChordError({ code: "unavailable", message: "not served" }));
			peer.send({ kind: "failed", hold, cause: { kind: "waiting", error } });
			await delivered();
			const states = [statesOf(await first.state.watch(context)), statesOf(await second.state.watch(context))];
			first.retry();
			expect(await peer.next("retry")).toMatchObject({ hold });
			peer.send({ kind: "loading", hold });
			peer.send({ kind: "failed", hold, cause: { kind: "waiting", error } });
			await delivered();
			expect(states).toEqual([
				["loading", "failed: not served"],
				["loading", "failed: not served"],
			]);
		});
	});

	describe("too_large/part and the retry alone", () => {
		/** A remote type whose `hostAddress` throws while `throws.now` is set. */
		const throws = { now: false };
		const Placed = remote("app.placed", {
			version: 1,
			params: {},
			hostAddress: () => {
				if (throws.now) throw new Error("no address");
				return Server();
			},
			variants: { v: { state: { text: str() }, methods: {} } },
		});
		const PLACED = wireNames(Placed, "v");

		/** Binds `hold` of `Placed` with `text`. */
		const bindText = (peer: RawPeer, hold: number, text: string): void => {
			const members = [{ member: PLACED.state.text!, value: jsonPart(text) }];
			peer.send({ kind: "bound", holds: [{ hold, variant: PLACED.variant, members, failed: [] }] });
		};

		it("fails every binding broken; a new reference holds anew; a retry moves only its binding, keeping its last value", async () => {
			throws.now = false;
			const { client, peer } = await rawProvider({ limits: { part: 64 } });
			const a1 = client.hold(Placed, {}, context) as unknown as RefIn<typeof Placed, "v">;
			const a2 = client.hold(Placed, {}, context) as unknown as RefIn<typeof Placed, "v">;
			const { hold } = await peer.next("hold");
			bindText(peer, hold, "short");
			await waitLive(a2);
			const watch = changesOf(await a1.text.watch(context));
			// A state part past the link's limit: the shared object fails, every binding with it.
			peer.send({
				kind: "state",
				holds: [
					{
						hold,
						members: [{ member: PLACED.state.text!, ops: jsonPart([["r", "x".repeat(100)]]) }],
						failed: [],
						retired: [],
					},
				],
			});
			await delivered();
			expect(await peer.next("release")).toMatchObject({ hold });
			expect([a1.state.value, a2.state.value]).toMatchObject([
				{ kind: "failed", cause: { kind: "broken", error: { code: "too_large" } } },
				{ kind: "failed", cause: { kind: "broken", error: { code: "too_large" } } },
			]);
			// C makes a new hold, owning the new entry.
			const c = client.hold(Placed, {}, context);
			const held = await peer.next("hold");
			// A1 alone moves to a private hold, its watch and last value its own.
			a1.retry();
			const retried = await peer.next("hold");
			expect(retried.hold).not.toBe(held.hold);
			expect([a1.state.value.kind, a2.state.value.kind, a1.text.value]).toEqual(["loading", "failed", "short"]);
			bindText(peer, retried.hold, "again");
			await waitLive(a1);
			await delivered();
			expect(valuesOf(watch)).toEqual([{ failed: expect.stringContaining("over the wire limit") }, "again"]);
			// D joins C's entry, not A1's private object.
			bindText(peer, held.hold, "c");
			await waitLive(c);
			const d = client.hold(Placed, {}, context) as unknown as RefIn<typeof Placed, "v">;
			expect([d.state.value.kind, d.text.value, taken(peer, "hold")]).toEqual(["live", "c", 0]);
			// The old object's last binding leaves: nothing more is sent for it.
			a2.release();
			c.release();
			await delivered();
			expect(taken(peer, "release")).toBe(0);
			d.release();
			a1.release();
			await delivered();
			expect(
				peer.received
					.filter((m) => m.kind === "release")
					.map((m) => (m as { hold: number }).hold)
					.sort(),
			).toEqual([held.hold, retried.hold].sort());
		});

		it("a retry whose placement throws fails only that binding; the old object's last binding retrying ends it", async () => {
			const { client, peer } = await rawProvider({ limits: { part: 64 } });
			throws.now = false;
			const a1 = client.hold(Placed, {}, context);
			const a2 = client.hold(Placed, {}, context);
			const { hold } = await peer.next("hold");
			bindText(peer, hold, "x".repeat(100));
			await delivered();
			await peer.next("release");
			throws.now = true;
			a1.retry();
			expect(a1.state.value).toMatchObject({
				kind: "failed",
				cause: { kind: "broken", error: { message: expect.stringContaining("no address") } },
			});
			expect(a2.state.value).toMatchObject({ kind: "failed", cause: { error: { code: "too_large" } } });
			throws.now = false;
			// A2, the old object's last binding, retries: the old object ends, A2 holds on its own.
			a2.retry();
			const { hold: again } = await peer.next("hold");
			bindText(peer, again, "ok");
			await waitLive(a2);
			a1.retry();
			expect((await peer.next("hold")).hold).toBe(again + 1);
			throws.now = false;
		});
	});

	describe("seen members", () => {
		it("a join to a live object with a failed member: its watch rejects with the error, no last value, until a value arrives", async () => {
			const { client, peer } = await rawProvider();
			const a = client.hold(Panel, {}, context) as unknown as RefIn<typeof Panel, "wide">;
			const { hold } = await peer.next("hold");
			bindPanel(peer, hold, "wide", { x: 7, y: 1 });
			await waitLive(a);
			setX(peer, hold, undefined);
			await delivered();
			const b = client.hold(Panel, {}, context) as unknown as RefIn<typeof Panel, "wide">;
			expect([await opened(a.x), await opened(b.x)]).toEqual([{ opened: 7 }, { rejected: "x threw" }]);
			setX(peer, hold, 8);
			await delivered();
			expect(await opened(b.x)).toEqual({ opened: 8 });
		});

		it("a member missing from the bound variant at the join: likewise, also across variants (missing, present, missing)", async () => {
			const { client, peer } = await rawProvider();
			const a = client.hold(Panel, {}, context) as unknown as RefIn<typeof Panel, "wide">;
			const { hold } = await peer.next("hold");
			bindPanel(peer, hold, "wide", { x: 1, y: 2 });
			await waitLive(a);
			peer.send({ kind: "loading", hold });
			bindPanel(peer, hold, "narrow", { x: 3 });
			await delivered();
			const b = client.hold(Panel, {}, context) as unknown as RefIn<typeof Panel, "wide">;
			expect((await opened(a.y)).opened).toBe(2);
			expect((await opened(b.y)).rejected).toMatch('has no state member "y"');
			peer.send({ kind: "loading", hold });
			bindPanel(peer, hold, "wide", { x: 4, y: 5 });
			await delivered();
			peer.send({ kind: "loading", hold });
			bindPanel(peer, hold, "narrow", { x: 6 });
			await delivered();
			// Seen while present: its own last value now.
			expect((await opened(b.y)).opened).toBe(5);
		});

		it("a join while loading sees nothing of before: the reconnect's snapshot with x failed rejects its watch; the old one starts at 7", async () => {
			const { client, peer } = await rawProvider();
			const a = client.hold(Panel, {}, context) as unknown as RefIn<typeof Panel, "wide">;
			bindPanel(peer, (await peer.next("hold")).hold, "wide", { x: 7, y: 1 });
			await waitLive(a);
			expect(a.x.value).toBe(7);
			peer.close();
			await transported();
			const b = client.hold(Panel, {}, context) as unknown as RefIn<typeof Panel, "wide">;
			const next = await rawParent(client);
			bindPanel(next, (await next.next("hold")).hold, "wide", { y: 2 });
			await waitLive(b);
			expect([await opened(a.x), await opened(b.x)]).toEqual([{ opened: 7 }, { rejected: "member threw" }]);
		});

		it("failed, then good, then failed again before the joiner's first read: the joiner keeps that value as its own", async () => {
			const { client, peer } = await rawProvider();
			const a = client.hold(Panel, {}, context) as unknown as RefIn<typeof Panel, "wide">;
			const { hold } = await peer.next("hold");
			bindPanel(peer, hold, "wide", { x: 7, y: 1 });
			await waitLive(a);
			setX(peer, hold, undefined);
			await delivered();
			const b = client.hold(Panel, {}, context) as unknown as RefIn<typeof Panel, "wide">;
			setX(peer, hold, 9);
			setX(peer, hold, undefined);
			await delivered();
			expect(await opened(b.x)).toEqual({ opened: 9 });
		});

		it("unseen members and own last values survive the retry alone after too_large/part", async () => {
			const { client, peer } = await rawProvider({ limits: { part: 64 } });
			const a = client.hold(Panel, {}, context) as unknown as RefIn<typeof Panel, "wide">;
			const { hold } = await peer.next("hold");
			bindPanel(peer, hold, "wide", { x: 7, y: 1 });
			await waitLive(a);
			setX(peer, hold, undefined);
			await delivered();
			const b = client.hold(Panel, {}, context) as unknown as RefIn<typeof Panel, "wide">;
			expect((await opened(b.y)).opened).toBe(1);
			const y = WIDE.state.y!;
			peer.send({
				kind: "state",
				holds: [
					{ hold, members: [{ member: y, ops: jsonPart([["r", "y".repeat(100)]]) }], failed: [], retired: [] },
				],
			});
			await delivered();
			await peer.next("release");
			b.retry();
			const { hold: own } = await peer.next("hold");
			bindPanel(peer, own, "wide", { y: 2 });
			await waitLive(b);
			// x: still unseen (failed at the join, no value since); y: its own.
			expect(await opened(b.x)).toEqual({ rejected: "member threw" });
			setX(peer, own, 3);
			setX(peer, own, undefined);
			await delivered();
			expect(await opened(b.x)).toEqual({ opened: 3 });
		});
	});

	describe("the accepted differences", () => {
		it("presence and activity at the provider: one entry and count per hold; a non-final release changes neither", async () => {
			const { server, client } = await linked((h) => void serveNotes(h));
			const listed = (): number => (server.references(Notes).value as unknown[]).length;
			const a = await client.get(Notes, { session: "S1" }, context);
			const b = await client.get(Notes, { session: "S1" }, context);
			const other = await client.get(Notes, { session: "S2" }, context);
			await transported();
			expect([listed(), server.activity.value.references]).toEqual([2, 2]);
			a.release();
			await transported();
			expect([listed(), server.activity.value.references]).toEqual([2, 2]);
			b.release();
			other.release();
			await transported();
			expect([listed(), server.activity.value.references]).toEqual([0, 0]);
		});

		it("a commit in transit: a joiner first reads the replica, then gets the commit", async () => {
			const { client, peer } = await rawProvider();
			const a = client.hold(Notes, { session: "S1" }, context);
			const hold = await bindNext(peer, [{ text: "a" }]);
			await waitLive(a);
			peer.send({
				kind: "state",
				holds: [
					{ hold, members: [{ member: EDITOR.state.count!, ops: jsonPart([["r", 2]]) }], failed: [], retired: [] },
				],
			});
			const b = client.hold(Notes, { session: "S1" }, context);
			expect(b.count.value).toBe(1);
			await delivered();
			expect(b.count.value).toBe(2);
		});

		it("part limits apply to received parts: a value grown past the limit by deltas does not fail a joiner; an oversized call result fails only its call", async () => {
			const { client, peer } = await rawProvider({ limits: { part: 64 } });
			const a = client.hold(Notes, { session: "S1" }, context) as unknown as RefIn<typeof Notes, "editor">;
			const hold = await bindNext(peer);
			await waitLive(a);
			for (let n = 0; n < 6; n++) {
				const ops = jsonPart([["p", [], n, 0, [{ text: "0123456789" }]]]);
				peer.send({
					kind: "state",
					holds: [{ hold, members: [{ member: EDITOR.state.notes!, ops }], failed: [], retired: [] }],
				});
			}
			await delivered();
			expect(JSON.stringify(a.notes.value).length).toBeGreaterThan(64);
			const b = client.hold(Notes, { session: "S1" }, context) as unknown as RefIn<typeof Notes, "editor">;
			expect(b.state.value).toEqual({ kind: "live" });
			const calling = rejection(b.add({ text: "x" }, context));
			const { call } = await peer.next("call");
			peer.send({ kind: "result", call, value: jsonPart("y".repeat(100)) });
			expect(await calling).toMatchObject({ code: "too_large" });
			expect([a.state.value.kind, b.state.value.kind]).toEqual(["live", "live"]);
		});

		it("watch callbacks of one shared commit run in subscription order, not hold order (accepted difference 9)", async () => {
			const { client, peer } = await rawProvider();
			const a = client.hold(Notes, { session: "S1" }, context);
			const b = client.hold(Notes, { session: "S1" }, context);
			const hold = await bindNext(peer);
			await waitLive(b);
			const order: string[] = [];
			// B subscribes first, though A holds first.
			(await b.count.watch(context)).start(async () => void order.push("b"));
			(await a.count.watch(context)).start(async () => void order.push("a"));
			peer.send({
				kind: "state",
				holds: [
					{ hold, members: [{ member: EDITOR.state.count!, ops: jsonPart([["r", 4]]) }], failed: [], retired: [] },
				],
			});
			await delivered();
			expect(order).toEqual(["b", "a"]);
		});

		it("a joining getter makes no hold and no window turn: it resolves with the replica at once", async () => {
			const { client, peer } = await rawProvider();
			const a = await (async () => {
				const getting = client.get(Notes, { session: "S1" }, context);
				await bindNext(peer, [{ text: "a" }]);
				return getting;
			})();
			const b = await client.get(Notes, { session: "S1" }, context);
			expect([b.count.value, taken(peer, "hold")]).toEqual([1, 0]);
			expect(a.notes.value).toBe(b.notes.value);
		});
	});

	describe("events", () => {
		const PLAYER = wireNames(Match, "player");

		/** An `event` message of `Match`'s paddle for `hold` with `y`. */
		const paddle = (peer: RawPeer, hold: number, ...ys: number[]): void =>
			peer.send({
				kind: "event",
				events: ys.map((y) => ({ hold, member: PLAYER.events.paddle!, at: 1, value: jsonPart({ y }) })),
			});

		/** `Match` bound as a player over a raw provider: two references to it. */
		const match = async () => {
			const { client, peer } = await rawProvider();
			const a = client.hold(Match, { id: 1 }, context) as unknown as RefIn<typeof Match, "player">;
			const { hold } = await peer.next("hold");
			const members = [{ member: PLAYER.state.score!, value: jsonPart(0) }];
			peer.send({ kind: "bound", holds: [{ hold, variant: PLAYER.variant, members, failed: [] }] });
			await waitLive(a);
			return { client, peer, hold, a };
		};

		it("a subscription survives its reference's retry alone after too_large/part: the private hold's events reach it", async () => {
			const { client, peer } = await rawProvider({ limits: { part: 64 } });
			const a1 = client.hold(Match, { id: 1 }, context) as unknown as RefIn<typeof Match, "player">;
			const a2 = client.hold(Match, { id: 1 }, context) as unknown as RefIn<typeof Match, "player">;
			const { hold } = await peer.next("hold");
			const bound = (id: number): void =>
				peer.send({
					kind: "bound",
					holds: [
						{
							hold: id,
							variant: PLAYER.variant,
							members: [{ member: PLAYER.state.score!, value: jsonPart(0) }],
							failed: [],
						},
					],
				});
			bound(hold);
			await waitLive(a1);
			const heard: string[] = [];
			await a1.paddle.on(({ value }) => void heard.push(`a1:${value.y}`), context);
			await a2.paddle.on(({ value }) => void heard.push(`a2:${value.y}`), context);
			const ops = jsonPart([["r", "x".repeat(100)]]);
			peer.send({
				kind: "state",
				holds: [{ hold, members: [{ member: PLAYER.state.score!, ops }], failed: [], retired: [] }],
			});
			await delivered();
			await peer.next("release");
			a1.retry();
			const { hold: own } = await peer.next("hold");
			bound(own);
			await waitLive(a1);
			paddle(peer, own, 1);
			paddle(peer, hold, 2);
			await delivered();
			expect([heard, a2.state.value.kind]).toEqual([["a1:1"], "failed"]);
		});

		for (const terminal of ["gone", "the host's close", "revocation"] as const) {
			it(`${terminal} ends every reference sharing the hold once: its watches, event subscriptions and running calls`, async () => {
				const client = createHost<TestPrincipal>({
					revokedBy: (principal) => (principal.kind === "guest" ? [principal.session] : []),
					onError: () => {},
				});
				await client.load([], context);
				const peer = await rawParent(client);
				// Two references of a guest's scope (revocation ends a revoked principal's, never the host's own).
				const refs: RefIn<typeof Match, "player">[] = [];
				const ready = Promise.withResolvers<void>();
				const scope = client
					.root(
						async (ctx) => {
							for (let n = 0; n < 2; n++)
								refs.push((await ctx.get(Match, { id: 1 })) as RefIn<typeof Match, "player">);
							ready.resolve();
							await new Promise(() => {});
						},
						context,
						{ principal: { kind: "guest", session: "S1" } },
					)
					.catch(() => {});
				const { hold } = await peer.next("hold");
				const members = [{ member: PLAYER.state.score!, value: jsonPart(0) }];
				peer.send({ kind: "bound", holds: [{ hold, variant: PLAYER.variant, members, failed: [] }] });
				await ready.promise;
				const states = await Promise.all(refs.map(async (ref) => statesOf(await ref.state.watch(context))));
				const watches = await Promise.all(refs.map((ref) => ref.score.watch(context)));
				const heard: string[] = [];
				for (const [index, ref] of refs.entries()) {
					await ref.paddle.on(({ value }) => void heard.push(`${index}:${value.y}`), context);
				}
				const calls = refs.map((ref) => rejection(ref.bump(context)));
				await peer.next("call");
				await peer.next("call");
				paddle(peer, hold, 1);
				await delivered();
				expect(heard).toEqual(["0:1", "1:1"]);
				if (terminal === "gone") {
					const error = { kind: "chord", error: { code: "released", reason: "ended", message: "ended" } } as const;
					peer.send({ kind: "gone", hold, error });
					await delivered();
				} else if (terminal === "revocation") {
					client.revoke("S1", context);
				} else {
					await client.close(context);
				}
				const code = terminal === "revocation" ? "forbidden" : "released";
				// Ended once each: no other state on the way, their state watches ended with it.
				expect([refs.map((ref) => ref.state.value.kind), states]).toEqual([
					["ended", "ended"],
					[[], []],
				]);
				expect(await Promise.all(watches.map((watch) => watch.closed))).toEqual([
					{ kind: "ended" },
					{ kind: "ended" },
				]);
				// The host's close closes its links first: running calls see the link drop.
				const called = terminal === "the host's close" ? "unavailable" : code;
				expect((await Promise.all(calls)).map((error) => (error as ChordError).code)).toEqual([called, called]);
				// Their subscriptions ended: a new one is refused, and nothing more reaches the old listeners.
				expect(await rejection(refs[0]!.paddle.on(() => {}, context))).toMatchObject({ code });
				if (!peer.closed) paddle(peer, hold, 2);
				await delivered();
				expect(heard).toEqual(["0:1", "1:1"]);
				await client.close(context);
				await scope;
			});
		}

		it("two references subscribed to one member each get every event once; stopping one leaves the other's", async () => {
			const { client, peer, hold, a } = await match();
			const b = client.hold(Match, { id: 1 }, context) as unknown as RefIn<typeof Match, "player">;
			const seen: string[] = [];
			const stopA = await a.paddle.on(({ value }) => void seen.push(`a${value.y}`), context);
			await b.paddle.on(({ value }) => void seen.push(`b${value.y}`), context);
			paddle(peer, hold, 1);
			await delivered();
			stopA.stop();
			paddle(peer, hold, 2);
			await delivered();
			expect(seen).toEqual(["a1", "b1", "b2"]);
		});

		it("an event in transit when a reference joins reaches it; one queued for the host's flush before it bound does not", async () => {
			const { client, peer, hold, a } = await match();
			const seen: string[] = [];
			// In transit: sent before B joins, delivered after.
			paddle(peer, hold, 1);
			const b = client.hold(Match, { id: 1 }, context) as unknown as RefIn<typeof Match, "player">;
			await b.paddle.on(({ value }) => void seen.push(`b${value.y}`), context);
			await delivered();
			expect(seen).toEqual(["b1"]);
			// Queued for the flush: C joins in A's listener of the first of two entries; it gets neither.
			let c: RefIn<typeof Match, "player"> | undefined;
			await a.paddle.on(({ value }) => {
				if (value.y !== 2 || c !== undefined) return;
				c = client.hold(Match, { id: 1 }, context) as unknown as RefIn<typeof Match, "player">;
				void c.paddle.on(({ value: later }) => void seen.push(`c${later.y}`), context);
			}, context);
			paddle(peer, hold, 2, 3);
			await delivered();
			paddle(peer, hold, 4);
			await delivered();
			expect(seen).toEqual(["b1", "b2", "b3", "b4", "c4"]);
		});

		it("a binding's event cutoff stays when another binding joins", async () => {
			const { client, peer, hold, a } = await match();
			const seen: number[] = [];
			await a.paddle.on(({ value }) => void seen.push(value.y), context);
			paddle(peer, hold, 1);
			client.hold(Match, { id: 1 }, context);
			await delivered();
			expect(seen).toEqual([1]);
		});
	});

	describe("cancellation (accepted difference 4)", () => {
		it("a non-final release: the caller gets released, the provider's handler aborted, a sibling's call survives; the last release: released", async () => {
			let probe: ReturnType<typeof serveNotes> | undefined;
			const { client } = await linked((h) => {
				probe = serveNotes(h);
			});
			const a = (await client.get(Notes, { session: "S1" }, context)) as RefIn<typeof Notes, "editor">;
			const b = (await client.get(Notes, { session: "S1" }, context)) as RefIn<typeof Notes, "editor">;
			const aCall = rejection(a.wait(context));
			const bCall = rejection(b.wait(context));
			await transported();
			expect(probe!.waits).toHaveLength(2);
			a.release();
			expect(await aCall).toMatchObject({ code: "released" });
			await transported();
			expect(probe!.waits.map((ctx) => (ctx.abortSignal?.reason as ChordError | undefined)?.code)).toEqual([
				"aborted",
				undefined,
			]);
			b.release();
			expect(await bCall).toMatchObject({ code: "released" });
			await transported();
			expect((probe!.waits[1]!.abortSignal?.reason as ChordError).code).toBe("released");
		});

		/** A waiter placed on a session's worker: `wait(tag)` records its tag, resolves when its context aborts. */
		const Waiter = remote("app.waiter", {
			version: 1,
			params: { session: str() },
			hostAddress: ({ session }) => Session({ id: session }),
			variants: { v: { state: { n: int() }, methods: { wait: method(str()) } } },
		});

		/** Serves `Waiter`, recording each call's tag in `seen`. */
		const serveWaiter = (h: FacetHost<TestPrincipal>, seen: string[]): void =>
			h.serve(Waiter, () => ({
				variant: "v",
				members: {
					n: constant(0),
					wait: async (tag, ctx) => {
						seen.push(tag);
						await new Promise((resolve) => ctx.abortSignal?.addEventListener("abort", resolve));
						return null;
					},
				},
			}));

		it("through a relay with an upstream window of 1 (A1 running, A2 and B1 queued there): the worker sees A1 and B1, never A2", async () => {
			const seen: string[] = [];
			const { tab } = await relayed({ workerCallWindow: 1, worker: (h) => serveWaiter(h, seen) });
			const a = (await tab.get(Waiter, { session: "S1" }, context)) as RefIn<typeof Waiter, "v">;
			const b = (await tab.get(Waiter, { session: "S1" }, context)) as RefIn<typeof Waiter, "v">;
			const calls = [rejection(a.wait("A1", context)), rejection(a.wait("A2", context))];
			const sibling = rejection(b.wait("B1", context));
			await transported();
			expect(seen).toEqual(["A1"]);
			a.release();
			await Promise.all(calls);
			await transported();
			expect(seen).toEqual(["A1", "B1"]);
			b.release();
			expect(await sibling).toMatchObject({ code: "released" });
		});

		it("through two relays with upstream windows 2 and 1, owners interleaved: the provider never sees the released owner's queued call", async () => {
			const Deep = hostKind("deep");
			const DeepWaiter = remote("app.deep-waiter", {
				version: 1,
				params: {},
				hostAddress: () => Deep(),
				variants: { v: { state: { n: int() }, methods: { wait: method(str()) } } },
			});
			const seen: string[] = [];
			const provider = createHost<TestPrincipal>({
				address: Deep(),
				principal: { kind: "server" },
				callWindow: 1,
				onError: () => {},
			});
			await provider.load(
				[
					{
						name: "@test/deep",
						facet: defineFacet<TestPrincipal>((h) =>
							h.serve(DeepWaiter, () => ({
								variant: "v",
								members: {
									n: constant(0),
									wait: async (tag, ctx) => {
										seen.push(tag);
										await new Promise((resolve) => ctx.abortSignal?.addEventListener("abort", resolve));
										return null;
									},
								},
							})),
						),
					},
				],
				context,
			);
			/** A relay host routing `Deep` to `upstream`, with `callWindow` on the links it accepts. */
			const relay = async (upstream: Host<TestPrincipal>, callWindow: number) => {
				const host = createHost<TestPrincipal>({
					address: Server(),
					principal: { kind: "server" },
					callWindow,
					onError: () => {},
				});
				host.route(
					Deep,
					{
						authorize: () => true,
						resolve: async () => {
							const [near, far] = memoryLinkPair();
							// The upstream takes the relay as its parent: a child link carries no origins.
							upstream.connect(far, { principal: { kind: "server" }, codec: testCodec() }, context);
							return { link: near, principal: { kind: "server" } as const, codec: testCodec() };
						},
					},
					context,
				);
				await host.load([], context);
				return host;
			};
			const inner = await relay(provider, 2);
			const outer = await relay(inner, 2);
			const tab = createHost<TestPrincipal>({ onError: () => {} });
			await tab.load([], context);
			const [near, far] = memoryLinkPair();
			outer.accept(far, { principal: { kind: "owner" }, codec: testCodec() }, context);
			tab.connect(near, { principal: { kind: "server" }, codec: testCodec() }, context);
			const a = (await tab.get(DeepWaiter, {}, context)) as RefIn<typeof DeepWaiter, "v">;
			const b = (await tab.get(DeepWaiter, {}, context)) as RefIn<typeof DeepWaiter, "v">;
			// The tab's window (2) sends A1 and A2, the outer relay forwards both (2), the inner one runs A1 (1) and queues
			// A2; B1 and B2 wait in the tab.
			const calls = [
				rejection(a.wait("A1", context)),
				rejection(a.wait("A2", context)),
				rejection(b.wait("B1", context)),
				rejection(b.wait("B2", context)),
			];
			for (let i = 0; i < 6; i++) await transported();
			expect(seen).toEqual(["A1"]);
			// abort(A2) first drops A2 at the inner relay; abort(A1) then frees the provider's slot for B1. Oldest first,
			// that slot would send A2.
			a.release();
			for (let i = 0; i < 6; i++) await transported();
			expect(seen).toEqual(["A1", "B1"]);
			b.release();
			expect((await Promise.all(calls)).map((error) => (error as ChordError).code)).toEqual([
				"released",
				"released",
				"released",
				"released",
			]);
			for (let i = 0; i < 6; i++) await transported();
			expect(seen).toEqual(["A1", "B1"]);
			// Downstream first: a relay closing before its consumer would resolve its route again for it.
			for (const host of [tab, outer, inner, provider]) await host.close(context);
		});
	});

	describe("admission (accepted difference 2)", () => {
		it("a relay's authorize turned false after A is held: B joins with no hold upstream and no authorization", async () => {
			let allowed = true;
			let asked = 0;
			const { tab, server } = await relayed({
				authorize: () => {
					asked++;
					return allowed;
				},
			});
			const a = await tab.get(PlacedNotes, { session: "S1" }, context);
			await transported();
			const holds = server.activity.value.references;
			allowed = false;
			const before = asked;
			const b = await tab.get(PlacedNotes, { session: "S1" }, context);
			await transported();
			expect([asked - before, b.state.value.kind, server.activity.value.references]).toEqual([0, "live", holds]);
			expect(a.state.value.kind).toBe("live");
		});
	});

	describe("cost", () => {
		it("two references, one hold: one encode per commit", async () => {
			const telemetry = new InMemoryTelemetryContext();
			const { client } = await linked((h) => void serveNotes(h), { telemetry });
			const a = (await client.get(Notes, { session: "S1" }, context)) as RefIn<typeof Notes, "editor">;
			const b = (await client.get(Notes, { session: "S1" }, context)) as RefIn<typeof Notes, "editor">;
			await transported();
			const encodes = () =>
				telemetry
					.getMetrics()
					.filter(({ name }) => name === "chord.link.encodes")
					.reduce((sum, { value }) => sum + (value as number), 0);
			const before = encodes();
			await a.add({ text: "x" }, context);
			await b.add({ text: "y" }, context);
			await transported();
			expect(encodes() - before).toBe(2);
			expect([a.count.value, b.count.value]).toEqual([2, 2]);
		});
	});

	describe("telemetry", () => {
		it("the shared hold is a root linked to its first getter; a joining getter links to it while open; an untraced first getter gives a root without a link", async () => {
			const telemetry = new InMemoryTelemetryContext();
			const { client, peer } = await rawProvider({ telemetry });
			await telemetry.startSpan({ name: "first" }, async (span) => {
				client.hold(Notes, { session: "S1" }, withTelemetry(span, context));
			});
			await telemetry.startSpan({ name: "second" }, async (span) => {
				client.hold(Notes, { session: "S1" }, withTelemetry(span, context));
			});
			client.hold(Notes, { session: "S2" }, context);
			await telemetry.startSpan({ name: "third" }, async (span) => {
				client.hold(Notes, { session: "S2" }, withTelemetry(span, context));
			});
			await bindNext(peer);
			await bindNext(peer);
			await delivered();
			const spans = telemetry.getSpans();
			const named = (name: string) => spans.filter((span) => span.name === name);
			const [s1, s2] = named("chord.hold");
			const [first, second, third] = ["first", "second", "third"].map((name) => named(name)[0]!);
			expect([s1!.parentId, s2!.parentId]).toEqual([null, null]);
			expect(s1!.links.map(({ context: carrier }) => carrier)).toEqual([first!.context]);
			expect(s2!.links).toEqual([]);
			expect(second!.links.map(({ context: carrier }) => carrier)).toEqual([s1!.context]);
			expect(third!.links.map(({ context: carrier }) => carrier)).toEqual([s2!.context]);
		});

		it("a re-hold is a fresh root linked to the first hold's, also when the first getter was untraced; the NOOP adapter records none", async () => {
			const telemetry = new InMemoryTelemetryContext();
			const { client, peer } = await rawProvider({ telemetry });
			const held = client.hold(Notes, { session: "S1" }, context);
			await bindNext(peer);
			await waitLive(held);
			peer.close();
			await transported();
			await bindNext(await rawParent(client));
			await delivered();
			const [first, again] = telemetry.getSpans().filter((span) => span.name === "chord.hold");
			expect([first!.parentId, again!.parentId, again!.links.map(({ context: carrier }) => carrier)]).toEqual([
				null,
				null,
				[first!.context],
			]);
			// Without an adapter (NOOP) no hold span is made, whatever the getter's context: its hold carries no carrier.
			const untraced = await rawProvider();
			await telemetry.startSpan({ name: "getter" }, async (span) => {
				untraced.client.hold(Notes, { session: "S1" }, withTelemetry(span, context));
			});
			expect((await untraced.peer.next("hold")).trace).toBeUndefined();
		});
	});

	describe("GC", () => {
		const objects = instancesOf(RemoteObject, "attach");
		const paths = instancesOf(Path, "attach");

		it("no remote object stays after its last release while the path lives; a released reference kept by the app keeps none", async () => {
			const { server, client } = await linked((h) => void serveNotes(h));
			const { kept, refs } = await (async () => {
				const made = objects.length;
				const a = await client.get(Notes, { session: "S1" }, context);
				const b = await client.get(Notes, { session: "S1" }, context);
				const refs = objects.slice(made);
				expect(refs).toHaveLength(1);
				a.release();
				b.release();
				await transported();
				return { kept: [a, b], refs };
			})();
			await expectCollected(...refs);
			expect([kept, server, client]).toBeDefined();
		});

		it("a released reference (its calls cancelled, its watches) is not kept by a live sibling, its object or its link", async () => {
			let probe: ReturnType<typeof serveNotes> | undefined;
			const { server, client } = await linked((h) => {
				probe = serveNotes(h);
			});
			const b = (await client.get(Notes, { session: "S1" }, context)) as RefIn<typeof Notes, "editor">;
			const refs = await (async () => {
				const a = (await client.get(Notes, { session: "S1" }, context)) as RefIn<typeof Notes, "editor">;
				const call = rejection(a.wait(context));
				(await a.count.watch(context)).start(async () => {});
				await transported();
				const refs = [new WeakRef(a), new WeakRef(resolveWatchable(a.count)!)];
				a.release();
				await call;
				return refs;
			})();
			await transported();
			await expectCollected(...refs);
			expect([b.state.value.kind, probe, server]).toEqual(["live", probe, server]);
		});

		it("a released joiner with queued calls and unseen members is kept by no queue, call record or sibling", async () => {
			const client = createHost<TestPrincipal>({ onError: () => {} });
			await client.load([], context);
			const [near, far] = memoryLinkPair();
			client.connect(near, { principal: { kind: "server" }, codec: testCodec() }, context);
			const peer = new RawPeer(far, { calls: 1 });
			await peer.next("hello");
			const b = client.hold(Panel, {}, context) as unknown as RefIn<typeof Panel, "wide">;
			const { hold } = await peer.next("hold");
			bindPanel(peer, hold, "wide", { x: 7, y: 1 });
			await waitLive(b);
			setX(peer, hold, undefined);
			await delivered();
			// B's call takes the window's one slot: A's calls wait in its queue.
			const sibling = b.poke("B1", context);
			const refs = await (async () => {
				const a = client.hold(Panel, {}, context) as unknown as RefIn<typeof Panel, "wide">;
				expect(await opened(a.x)).toEqual({ rejected: "x threw" });
				const queued = [rejection(a.poke("A1", context)), rejection(a.poke("A2", context))];
				const refs = [new WeakRef(a), new WeakRef(resolveWatchable(a.x)!)];
				a.release();
				await Promise.all(queued);
				return refs;
			})();
			await transported();
			await expectCollected(...refs);
			const { call } = await peer.next("call");
			peer.send({ kind: "result", call, value: jsonPart(1) });
			expect([await sibling, b.state.value.kind, taken(peer, "call")]).toEqual([1, "live", 0]);
		});

		it("after a retry alone, the old object keeps neither the moved binding nor the private object's forked replicas", async () => {
			const { client, peer } = await rawProvider({ limits: { part: 64 } });
			const kept = client.hold(Notes, { session: "S1" }, context);
			const refs = await (async () => {
				const moved = client.hold(Notes, { session: "S1" }, context);
				const hold = await bindNext(peer);
				await waitLive(moved);
				const ops = jsonPart([["r", [{ text: "x".repeat(100) }]]]);
				peer.send({
					kind: "state",
					holds: [{ hold, members: [{ member: EDITOR.state.notes!, ops }], failed: [], retired: [] }],
				});
				await delivered();
				await peer.next("release");
				moved.retry();
				bindHold(peer, (await peer.next("hold")).hold);
				await waitLive(moved);
				const own = objects.at(-1)!.deref()!;
				const refs = [new WeakRef(moved), new WeakRef(own), new WeakRef(own.member("count"))];
				moved.release();
				return refs;
			})();
			await transported();
			await expectCollected(...refs);
			expect(kept.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken" } });
		});

		it("a route path dropped after its last holder takes its sharing table", async () => {
			const { server, routeLinks } = await relayed();
			const refs = await (async () => {
				const made = paths.length;
				const notes = await server.get(PlacedNotes, { session: "S1" }, context);
				const refs = paths.slice(made);
				notes.release();
				await transported();
				return refs;
			})();
			for (const link of routeLinks) link.close();
			await transported();
			await expectCollected(...refs);
			expect(server).toBeDefined();
		});
	});
});
