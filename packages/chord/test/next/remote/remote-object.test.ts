import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../../src/context/index.ts";
import { int, local, method, obj, remote, str } from "../../../src/next/contracts/index.ts";
import { PluginError } from "../../../src/next/data/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import {
	createHost,
	defineFacet,
	type Host,
	type HostError,
	type Reference,
	type RefIn,
} from "../../../src/next/host/index.ts";
import { resolveWatchable } from "../../../src/next/host/reference.ts";
import { type Link, memoryLinkPair } from "../../../src/next/link/index.ts";
import { jsonPart, wireError } from "../../../src/next/link/internal.ts";
import { RemoteObject } from "../../../src/next/remote/remote-object.ts";
import { constant } from "../../../src/next/state/index.ts";
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
	Notes,
	partValue,
	RawPeer,
	rawParent,
	rawProvider,
	rejection,
	Server,
	serveNotes,
	type TestPrincipal,
	testCodec,
	transported,
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

		it("two references from one host are two holds", async () => {
			const { client, peer } = await rawProvider();
			const first = client.get(Notes, { session: "S1" }, context);
			const second = client.get(Notes, { session: "S1" }, context);
			expect(await bindNext(peer)).toBe(0);
			expect(await bindNext(peer)).toBe(1);
			await Promise.all([first, second]);
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

		it("apply bound in one batch: each member gets one frame [['r', value]] and a fresh decoder", async () => {
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
			expect(frames).toEqual([[list, [["r", list]]]]);
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
			expect(await peer.next("retry")).toEqual({ kind: "retry", hold, operation: expect.any(String) });
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

		it("a member watch before the first binding waits for it, and rejects when it fails or is released (race 16)", async () => {
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
			expect(await rejection(watches[1]!)).toEqual(error);
			expect(await rejection(watches[2]!)).toEqual({ code: "released", message: "app.notes: released" });
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

		it("dropped and never bound again, stays parked loading: nothing fails, no parked_long without a link", async () => {
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
			// No remote attempt answers for it while its path has no link (fix round 1, Opus F2).
			expect(errors).toEqual([]);
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
