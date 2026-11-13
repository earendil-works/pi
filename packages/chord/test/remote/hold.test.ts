import { describe, expect, it, vi } from "vitest";
import { type Context, BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { bool, evolve, hostKind, int, keyed, local, method, obj, remote, str } from "../../src/contracts/index.ts";
import { broken, ChordError } from "../../src/data/index.ts";
import type * as Delta from "../../src/delta/index.ts";
import { decoder } from "../../src/delta/index.ts";
import { defineState } from "../../src/documents/index.ts";
import {
	type Ctx,
	createHost,
	defineFacet,
	type FacetHost,
	type Host,
	type RefIn,
	type Self,
} from "../../src/host/index.ts";
import type { ChordHost } from "../../src/host/internal.ts";
import { ChordObject } from "../../src/host/object.ts";
import { defineJob } from "../../src/jobs/index.ts";
import { type Link, memoryLinkPair } from "../../src/link/index.ts";
import { binaryCodec, jsonPart, type Message } from "../../src/link/internal.ts";
import { Hold } from "../../src/remote/hold.ts";
import { constant, type Writable } from "../../src/state/index.ts";
import {
	changesOf,
	delivered,
	expectCollected,
	failLive,
	fakeTimers,
	flushed,
	forEachCodec,
	instancesOf,
	linked,
	PlacedNotes,
	partValue,
	RawPeer,
	rawLinked,
	rejection,
	relayed,
	SERVER_ADDRESS,
	Server,
	Session,
	serveNotes,
	statesOf,
	type TestPrincipal,
	testCodec,
	transported,
	valuesOf,
	wireNames,
} from "../support.ts";

/** Every Delta encoder made while this file runs, weakly: the holds' member encoders among them. */
const encoders = vi.hoisted(() => [] as WeakRef<object>[]);

vi.mock("../../src/delta/index.ts", async (importOriginal) => {
	const original = await importOriginal<typeof Delta>();
	return {
		...original,
		encoder: () => {
			const made = original.encoder();
			encoders.push(new WeakRef(made));
			return made;
		},
	};
});

/** Every hold started while this file runs, weakly. */
const holds = instancesOf(Hold, "start");

const N = defineState("n", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });

/** `half` throws once `n` is 2: a member failing after the object is live (W1). */
const Halves = remote("app.halves", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { v: { state: { n: obj({ n: int() }), half: int() }, methods: { set: method(int()), wait: method() } } },
});

/** The wire's indexes of `Halves`. */
const HALVES = wireNames(Halves, "v");

/** A server serving `Halves` and a raw peer; `set` writes `n` through hold 0, the object of the link's principal. */
async function halves() {
	const linked = await rawLinked((h) =>
		h.serve(Halves, (_, _principal, self) => {
			const n = self.state(N);
			return {
				variant: "v",
				members: {
					n,
					half: self.derive([n], ([{ n }]) => {
						if (n === 2) throw new Error("half threw");
						return n / 2;
					}),
					set: async (value, ctx) => {
						await n.change((draft) => {
							draft.n = value;
						}, ctx);
						return null;
					},
					wait: (ctx) => new Promise((resolve) => ctx.abortSignal?.addEventListener("abort", () => resolve(null))),
				},
			};
		}),
	);
	let calls = 0;
	const set = async (value: number) => {
		const call = calls++;
		linked.peer.send({ kind: "call", call, hold: 0, method: HALVES.methods.set!, args: jsonPart(value) });
		expect((await linked.peer.next("result")).call).toBe(call);
	};
	return { ...linked, set };
}

function hold(peer: RawPeer, id: number, Type: { name: string; version: number; fingerprint: string }) {
	const { name: type, version, fingerprint } = Type;
	peer.send({ kind: "hold", hold: id, type, version, fingerprint, params: "{}", address: SERVER_ADDRESS });
}

/** The provider object behind a hold, reached through the host's own lookup (to end it by hand). */
function providerObject(server: unknown) {
	const host = server as ChordHost<TestPrincipal>;
	const { name: type, version, fingerprint } = Halves;
	const request = { type, version, fingerprint, params: "{}", address: SERVER_ADDRESS };
	const served = host.serving(request, {}, { kind: "owner" }, context);
	if (served.kind !== "object") throw new Error("Halves is served here");
	return served.object;
}

/** A remote type whose activation never completes: its open waits for its abort. */
const Pending = remote("app.pending", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { v: { state: { n: int() } } },
});

function servePending(h: Parameters<Parameters<typeof rawLinked>[0]>[0]) {
	h.serve(Pending, (_, _principal, self) => {
		self.open(
			(ctx) => new Promise((resolve) => ctx.abortSignal?.addEventListener("abort", resolve)),
			() => {},
		);
		return { variant: "v", members: { n: constant(1) } };
	});
}

forEachCodec(() => {
	describe("the parts of a hold", () => {
		it("are its members, each with its own encoder: the snapshot by member, then the changed members' ops", async () => {
			const { peer, set } = await halves();
			hold(peer, 0, Halves);
			expect(HALVES.named((await peer.next("bound")).holds[0]!.members)).toEqual({ n: { n: 0 }, half: 0 });
			await set(1);
			const first = HALVES.named((await peer.next("state")).holds[0]!.members);
			expect(first).toEqual({ n: [["s", ["n"], 1]], half: [["r", 0.5]] });
			await set(4);
			// The member's encoder interns a path on its second use.
			const n = decoder();
			n.decode(first.n as unknown[]);
			const second = HALVES.named((await peer.next("state")).holds[0]!.members);
			expect(n.decode(second.n as unknown[])).toEqual([["s", ["n"], 4]]);
		});
	});

	describe("failed members", () => {
		it("are listed in the header of the state that carries the failure, never in its part; they recover in the same hold", async () => {
			const { peer, set } = await halves();
			hold(peer, 0, Halves);
			hold(peer, 1, Halves);
			await peer.next("bound");
			await peer.next("bound");
			await set(2);
			const state = await peer.next("state");
			const failed = [
				{ member: HALVES.state.half!, error: { kind: "plugin", code: "internal", message: "half threw" } },
			];
			// Race 12: each hold's entry carries its healthy members' ops and the failure.
			expect(state.holds.map(({ hold, failed }) => ({ hold, failed }))).toEqual([
				{ hold: 0, failed },
				{ hold: 1, failed },
			]);
			for (const entry of state.holds) expect(HALVES.named(entry.members)).toEqual({ n: [["s", ["n"], 2]] });
			await set(3);
			const next = await peer.next("state");
			expect(next.holds.map(({ hold, failed }) => ({ hold, failed }))).toEqual([
				{ hold: 0, failed: [] },
				{ hold: 1, failed: [] },
			]);
			// The derive healed: its next value replaces the root.
			expect(HALVES.named(next.holds[0]!.members).half).toEqual([["r", 1.5]]);
		});

		it("reach a client's watch over the link as one failure call, then the healed value: the watch stays open", async () => {
			const { server, client } = await linked((h) =>
				h.serve(Halves, (_, _principal, self) => {
					const n = self.state(N);
					return {
						variant: "v",
						members: {
							n,
							half: self.derive([n], ([{ n }]) => {
								if (n === 2) throw new Error("half threw");
								return n / 2;
							}),
							set: async (value, ctx) => {
								await n.change((draft) => {
									draft.n = value;
								}, ctx);
								return null;
							},
							wait: async () => null,
						},
					};
				}),
			);
			const halves = await client.get(Halves, {}, context);
			if (halves.variant !== "v") throw new Error("expected variant v");
			const calls = changesOf(await halves.half.watch(context));
			await halves.set(2, context);
			await transported();
			expect(calls).toEqual([{ kind: "failed", error: expect.objectContaining({ message: "half threw" }) }]);
			await halves.set(6, context);
			await transported();
			expect(halves.half.value).toBe(3);
			expect(calls.at(-1)).toEqual({ kind: "value", value: 3, ops: [["r", 3]], retired: false });
			await client.close(context);
			await server.close(context);
		});

		it("are listed in bound for a hold made after the failure", async () => {
			const { peer, set } = await halves();
			hold(peer, 0, Halves);
			await peer.next("bound");
			await set(2);
			await peer.next("state");
			hold(peer, 1, Halves);
			const [bound] = (await peer.next("bound")).holds;
			expect(bound!.failed).toEqual([
				{ member: HALVES.state.half!, error: { kind: "plugin", code: "internal", message: "half threw" } },
			]);
			expect(HALVES.named(bound!.members)).toEqual({ n: { n: 2 } });
			// Followed though it failed at the snapshot: it recovers in this hold.
			await set(4);
			const next = await peer.next("state");
			expect(HALVES.named(next.holds.find(({ hold }) => hold === 1)!.members).half).toEqual([["r", 2]]);
		});
	});

	describe("transient failures", () => {
		// Timers stand still: the failed object's backoff window does not end while the test runs.
		fakeTimers();

		it("a new hold of an object failed transiently is sent the failure at once", async () => {
			const Flaky = remote("app.flaky", {
				version: 1,
				params: {},
				hostAddress: () => Server(),
				variants: { v: { state: { n: int() } } },
			});
			const { peer } = await rawLinked((h) =>
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
			hold(peer, 0, Flaky);
			const cause = {
				kind: "transient",
				error: { kind: "chord", error: { code: "unavailable", message: "app.flaky: offline" } },
			};
			expect(await peer.next("failed")).toMatchObject({ hold: 0, cause });
			hold(peer, 1, Flaky);
			// The object stays failed for its backoff window (1 s); the new hold does not wait for the next attempt.
			expect(await peer.next("failed")).toMatchObject({ hold: 1, cause });
		});
	});

	// A hold whose object ends sends `gone` and nothing for its pending calls (race 4): through revocation, the path
	// that ends a held object (`host/revocation.test.ts`, "aborts running calls").

	describe("GC", () => {
		it("a closed link retained by the test keeps no hold, encoder or object", async () => {
			const { server, refs, link } = await (async () => {
				const { server } = await halves();
				const [a, b] = memoryLinkPair();
				server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
				const peer = new RawPeer(b);
				const [held, made] = [holds.length, encoders.length];
				hold(peer, 0, Halves);
				await peer.next("bound");
				const refs: WeakRef<object>[] = [new WeakRef(providerObject(server)), ...holds.slice(held)];
				refs.push(...encoders.slice(made));
				expect(refs).toHaveLength(4);
				peer.close();
				await transported();
				return { server, refs, link: a };
			})();
			await expectCollected(...refs);
			expect([server, link]).toBeDefined();
		});

		it("a released pending hold is kept neither by its object, still activating for another hold, nor by its waits", async () => {
			const { server, peer, refs } = await (async () => {
				const { server, peer } = await rawLinked((h) => servePending(h));
				hold(peer, 0, Pending);
				await transported();
				const held = holds.length;
				hold(peer, 1, Pending);
				await transported();
				const refs = holds.slice(held);
				expect(refs).toHaveLength(1);
				peer.send({ kind: "release", hold: 1 });
				await transported();
				return { server, peer, refs };
			})();
			await expectCollected(...refs);
			expect([server, peer]).toBeDefined();
		});

		it("a pending activation on a closed link keeps no hold", async () => {
			const { server, link, refs } = await (async () => {
				const { server } = await rawLinked((h) => servePending(h));
				const [a, b] = memoryLinkPair();
				server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
				const peer = new RawPeer(b);
				const held = holds.length;
				hold(peer, 0, Pending);
				await transported();
				const refs = holds.slice(held);
				peer.close();
				await transported();
				return { server, link: a, refs };
			})();
			await expectCollected(...refs);
			expect([server, link]).toBeDefined();
		});

		it("a hold released while waiting for load is not kept by the wait", async () => {
			const Slow = local("app.slow", { version: 1, params: {}, members: { n: int() } });
			const { server, refs } = await (async () => {
				const server = createHost<TestPrincipal>({
					address: Server(),
					principal: { kind: "server" },
					readyTimeout: 2_000,
					onError: () => {},
				});
				const facet = defineFacet<TestPrincipal>((h) => {
					servePending(h);
					// A host-lifetime object whose open never resolves: `load` waits for it (until its readyTimeout).
					h.serve(Slow, (_, self) => {
						self.open(
							() => new Promise(() => {}),
							() => {},
						);
						return { n: constant(1) };
					});
				});
				void server.load([{ name: "@test/app", facet }], context);
				const [a, b] = memoryLinkPair();
				server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
				const peer = new RawPeer(b);
				const held = holds.length;
				hold(peer, 0, Pending);
				await transported();
				peer.send({ kind: "release", hold: 0 });
				await transported();
				return { server, refs: holds.slice(held) };
			})();
			expect(refs).toHaveLength(1);
			await expectCollected(...refs);
			expect(server).toBeDefined();
		});
	});
});

/** A remote type whose open throws `offline` (broken when `failing.broken`) while `failing.left` is above 0. */
const Flaky = remote("app.flaky", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { v: { state: { n: int() } } },
});

function serveFlaky(h: Parameters<Parameters<typeof rawLinked>[0]>[0], failing: { left: number; broken: boolean }) {
	h.serve(Flaky, (_, _principal, self) => {
		self.open(
			async () => {
				if (failing.left-- <= 0) return;
				throw failing.broken ? broken(new Error("offline")) : new Error("offline");
			},
			() => {},
		);
		return { variant: "v", members: { n: constant(1) } };
	});
}

/** A second raw peer on `server`, stamped with the same principal as `rawLinked`'s: it holds the same objects. */
function secondPeer(server: Host<TestPrincipal>): RawPeer {
	const [a, b] = memoryLinkPair();
	server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
	return new RawPeer(b);
}

const offline = { code: "unavailable", message: "app.flaky: offline" };

forEachCodec(() => {
	describe("notices of a failed object", () => {
		fakeTimers();

		it("its holds get failed with the rest of its window, loading for each attempt, then bound (race 6)", async () => {
			const { peer } = await rawLinked((h) => serveFlaky(h, { left: 2, broken: false }));
			hold(peer, 0, Flaky);
			expect(await peer.next("failed")).toEqual({
				kind: "failed",
				hold: 0,
				cause: { kind: "transient", error: { kind: "chord", error: offline } },
				retryIn: 1_000,
			});
			await vi.advanceTimersByTimeAsync(600);
			hold(peer, 1, Flaky);
			expect(await peer.next("failed")).toMatchObject({ hold: 1, retryIn: 400 });
			await vi.advanceTimersByTimeAsync(400);
			await transported();
			expect(peer.kinds()).toEqual(["hello", "loading", "loading", "failed", "failed"]);
			expect((await peer.next("failed")).retryIn).toBe(2_000);
			await vi.advanceTimersByTimeAsync(2_000);
			await peer.next("bound");
			await peer.next("bound");
			expect(peer.kinds()).toEqual(["hello", "loading", "loading", "failed", "loading", "loading"]);
		});

		it("a retry from one consumer renews a broken object for every holder: loading, then bound (races 12, 13)", async () => {
			const failing = { left: 1, broken: true };
			const { server, peer } = await rawLinked((h) => serveFlaky(h, failing));
			const other = secondPeer(server);
			hold(peer, 0, Flaky);
			hold(other, 0, Flaky);
			const broken = {
				kind: "failed",
				hold: 0,
				cause: { kind: "broken", error: { kind: "chord", error: offline } },
			};
			expect([await peer.next("failed"), await other.next("failed")]).toEqual([broken, broken]);
			peer.send({ kind: "retry", hold: 0, hops: 16 });
			for (const consumer of [peer, other]) {
				expect(await consumer.next("loading")).toEqual({ kind: "loading", hold: 0 });
				expect((await consumer.next("bound")).holds[0]).toMatchObject({ hold: 0 });
			}
		});

		it("a retry skips a transient failure's window for every holder (race 12)", async () => {
			const { server, peer } = await rawLinked((h) => serveFlaky(h, { left: 1, broken: false }));
			const other = secondPeer(server);
			hold(peer, 0, Flaky);
			await peer.next("failed");
			hold(other, 0, Flaky);
			await other.next("failed");
			other.send({ kind: "retry", hold: 0, hops: 16 });
			for (const consumer of [peer, other]) {
				await consumer.next("loading");
				await consumer.next("bound");
			}
		});

		it("a retry of a live or an unknown hold does nothing", async () => {
			const { peer } = await rawLinked((h) => serveFlaky(h, { left: 0, broken: false }));
			hold(peer, 0, Flaky);
			await peer.next("bound");
			peer.send({ kind: "retry", hold: 0, hops: 16 });
			peer.send({ kind: "retry", hold: 9, hops: 16 });
			await transported();
			expect([peer.kinds(), peer.closed]).toEqual([["hello"], false]);
		});
	});

	describe("holds that bind to nothing yet (dependency model §1, §3)", () => {
		const Absent = { name: "app.absent", version: 1, fingerprint: "0123456789abcdef" };

		it("a refused hold waits failed { waiting }, counted; a retry re-runs its start (loading, failed); its link's close drops it", async () => {
			const { server, peer } = await rawLinked(() => {});
			hold(peer, 0, Absent);
			const failed = await peer.next("failed");
			expect(failed).toMatchObject({ hold: 0, cause: { kind: "waiting" } });
			expect(failed.retryIn).toBeUndefined();
			expect(server.activity.value.references).toBe(1);
			expect(server.references(Halves).value).toEqual([]);
			peer.send({ kind: "retry", hold: 0, hops: 16 });
			expect(await peer.next("loading")).toEqual({ kind: "loading", hold: 0 });
			expect(await peer.next("failed")).toMatchObject({ hold: 0, cause: { kind: "waiting" } });
			peer.close();
			await transported();
			expect(server.activity.value.references).toBe(0);
		});

		it("a hold on an object parked on a failed dependency is told each new cause, then loading, then bound", async () => {
			const Core = local("app.core", { version: 1, params: {}, members: { n: int() } });
			let cores = 0;
			const { peer } = await rawLinked((h) => {
				h.serve(Core, () => {
					if (++cores < 3) throw new Error(`bug ${cores}`);
					return { n: constant(cores) };
				});
				h.serve(Halves, (_, _principal, self) => {
					const core = self.get(Core, {});
					const n = self.state(N);
					return {
						variant: "v",
						members: {
							n,
							half: self.derive([core.n], ([c]) => c),
							set: async () => null,
							wait: async () => null,
						},
					};
				});
			});
			hold(peer, 0, Halves);
			const waiting = (message: string) => ({
				kind: "failed",
				hold: 0,
				cause: { kind: "waiting", error: { kind: "chord", error: { code: "unavailable", message } } },
			});
			// The core failed at load (its first outcome): the parked object names it at once.
			expect(await peer.next("failed")).toEqual(waiting("waiting for app.core: app.core: bug 1"));
			// A retry passes on through the parked object to its broken dependency (one host's retry operation).
			// (Its new attempt failed within the batch of changes the parked object checks once: no loading between.)
			peer.send({ kind: "retry", hold: 0, hops: 16 });
			expect(await peer.next("failed")).toEqual(waiting("waiting for app.core: app.core: bug 2"));
			peer.send({ kind: "retry", hold: 0, hops: 16 });
			await peer.next("loading");
			expect((await peer.next("bound")).holds[0]).toMatchObject({ hold: 0 });
		});
	});

	describe("a reconnecting consumer", () => {
		const Tally = remote("app.tally", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: { v: { state: { n: obj({ n: int() }) }, methods: { bump: method() } } },
		});
		const Fresh = remote("app.fresh", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: { v: { state: { n: obj({ n: int() }) }, methods: { bump: method() } } },
		});

		/** A server serving `Tally` (lingering a minute) and `Fresh` (not lingering, its native's close waits for `closing`). */
		async function served(closing: Promise<void>) {
			const serve = (self: Self) => {
				const doc = self.state(N);
				return {
					variant: "v" as const,
					members: {
						n: doc,
						bump: async (ctx: Context) => {
							await doc.change((draft) => {
								draft.n++;
							}, ctx);
							return null;
						},
					},
				};
			};
			return linked((h) => {
				h.serve(Tally, (_, _principal, self) => serve(self), { linger: 60_000 });
				h.serve(Fresh, (_, _principal, self) => {
					self.open(
						async () => null,
						() => closing,
					);
					return serve(self);
				});
			});
		}

		/** Drops the client's link and connects it again. */
		async function reconnect(server: Host<TestPrincipal>, client: Host<TestPrincipal>, link: Link) {
			link.close();
			await transported();
			const [a, b] = memoryLinkPair();
			server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
			client.connect(b, { principal: { kind: "server" }, codec: testCodec() }, context);
			await transported();
		}

		it("finds a lingering object as it left it: its in-memory documents kept; one without linger is new (race 7)", async () => {
			const closing = Promise.resolve();
			const { server, client, links } = await served(closing);
			const tally = await client.get(Tally, {}, context);
			const fresh = await client.get(Fresh, {}, context);
			await tally.bump(context);
			await fresh.bump(context);
			await reconnect(server, client, links[0]);
			expect([tally.state.value, fresh.state.value]).toEqual([{ kind: "live" }, { kind: "live" }]);
			expect([tally.n.value, fresh.n.value]).toEqual([{ n: 1 }, { n: 0 }]);
		});

		it("re-holds an object whose previous instance still tears down: bound once that ended (race 17)", async () => {
			const closing = Promise.withResolvers<void>();
			const { server, client, links } = await served(closing.promise);
			const fresh = await client.get(Fresh, {}, context);
			await fresh.bump(context);
			await reconnect(server, client, links[0]);
			expect([fresh.state.value, fresh.n.value]).toEqual([{ kind: "loading" }, { n: 1 }]);
			closing.resolve();
			await transported();
			expect([fresh.state.value, fresh.n.value]).toEqual([{ kind: "live" }, { n: 0 }]);
		});
	});
});

/**
 * A remote type whose document can be retired; `big` derives a flag that a retirement of a small value leaves as is,
 * `t` is `n` and throws while it is negative.
 */
const Retiring = remote("app.retiring", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		v: {
			state: { doc: obj({ n: int() }), big: bool(), t: int() },
			methods: { set: method(int()), retire: method() },
		},
	},
});

const RETIRING = wireNames(Retiring, "v");

/** Every member of `Retiring` retired with its document, sorted. */
const retiredAll = [RETIRING.state.doc!, RETIRING.state.big!, RETIRING.state.t!].sort();

/**
 * A server serving `Retiring` to a raw peer that acks only when told; `call` calls a method of the object hold 0 holds,
 * from the server itself as the hold's principal (an answer over the link would send the waiting state before it).
 */
async function retiring() {
	const server = createHost<TestPrincipal>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
	await server.load(
		[
			{
				name: "@test/app",
				facet: defineFacet<TestPrincipal>((h) =>
					h.serve(Retiring, (_, _principal, self) => {
						const doc = self.state(N);
						return {
							variant: "v",
							members: {
								doc,
								big: self.derive([doc], ([{ n }]) => n > 10),
								t: self.derive([doc], ([{ n }]) => {
									if (n < 0) throw new Error(`failed ${n}`);
									return n;
								}),
								set: async (n, ctx) => {
									await doc.change((draft) => {
										draft.n = n;
									}, ctx);
									return null;
								},
								retire: async (ctx) => {
									await doc.retire(ctx);
									return null;
								},
							},
						};
					}),
				),
			},
		],
		context,
	);
	const [a, b] = memoryLinkPair();
	server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
	const peer = new RawPeer(b, { ack: false });
	await transported();
	const call = (method: "set" | "retire", args?: number) =>
		server.root(
			async (ctx) => {
				const object = await ctx.get(Retiring, {});
				await (method === "set" ? object.set(args!, ctx) : object.retire(ctx));
			},
			context,
			{ principal: { kind: "owner" } },
		);
	const { name: type, version, fingerprint } = Retiring;
	peer.send({ kind: "hold", hold: 0, type, version, fingerprint, params: "{}", address: SERVER_ADDRESS });
	await peer.next("bound");
	peer.ack();
	return { peer, call };
}

forEachCodec(() => {
	describe('retired members (decision "One retirement mechanism")', () => {
		it("are listed in the state that carries the retirement, a derive whose value stayed without ops", async () => {
			const { peer, call } = await retiring();
			await call("set", 1);
			const set = await peer.next("state");
			expect(set.holds[0]!.retired).toEqual([]);
			peer.ack();
			await call("retire");
			const retired = (await peer.next("state")).holds[0]!;
			expect(RETIRING.named(retired.members)).toEqual({ doc: [["r", { n: 0 }]], t: [["r", 0]] });
			expect(retired.retired.toSorted()).toEqual(retiredAll);
		});

		it("are kept while the window is full and sent once with the folded ops", async () => {
			const { peer, call } = await retiring();
			await call("set", 1);
			await call("set", 2);
			await peer.next("state");
			await peer.next("state");
			// The window is full: the retirement and the next change wait, folded into one entry.
			await call("retire");
			await call("set", 4);
			await transported();
			expect(peer.kinds().filter((kind) => kind === "state")).toEqual([]);
			peer.ack();
			const pending = (await peer.next("state")).holds[0]!;
			expect(RETIRING.named(pending.members)).toEqual({
				doc: [
					["r", { n: 0 }],
					["s", ["n"], 4],
				],
				t: [["r", 4]],
			});
			expect(pending.retired.toSorted()).toEqual(retiredAll);
			peer.ack();
			peer.ack();
			await call("set", 5);
			expect((await peer.next("state")).holds[0]!.retired).toEqual([]);
		});

		it("of a member failed again before its entry leaves wait for its next value, never with its failure", async () => {
			const { peer, call } = await retiring();
			await call("set", 1);
			await call("set", 2);
			await peer.next("state");
			await peer.next("state");
			// The window is full: `t` fails, heals with the retirement (n is 0 again), and fails again.
			await call("set", -1);
			await call("retire");
			await call("set", -3);
			peer.ack();
			const failed = (await peer.next("state")).holds[0]!;
			expect(failed.failed).toEqual([
				{ member: RETIRING.state.t!, error: { kind: "plugin", code: "internal", message: "failed -3" } },
			]);
			expect(Object.keys(RETIRING.named(failed.members))).toEqual(["doc"]);
			expect(failed.retired.toSorted()).toEqual([RETIRING.state.doc!, RETIRING.state.big!].sort());
			peer.ack();
			peer.ack();
			await call("set", 5);
			const healed = (await peer.next("state")).holds[0]!;
			expect(RETIRING.named(healed.members).t).toEqual([["r", 5]]);
			expect(healed.retired).toEqual([RETIRING.state.t!]);
		});
	});

	describe("failures while the window is full", () => {
		it("fold per member: 1000 failing commits leave one failure entry, the member's ops dropped; bounded", async () => {
			const { peer, call } = await retiring();
			await call("set", 1);
			await call("set", 2);
			await peer.next("state");
			await peer.next("state");
			// An earlier episode, healed: its failure leaves with the heal.
			await call("set", -1);
			await call("set", 3);
			for (let n = 1; n <= 1000; n++) await call("set", -1000 - n);
			peer.ack();
			const pending = (await peer.next("state")).holds[0]!;
			// One failure call per episode: the error of the commit that started it.
			expect(pending.failed).toEqual([
				{ member: RETIRING.state.t!, error: { kind: "plugin", code: "internal", message: "failed -1001" } },
			]);
			expect(Object.keys(RETIRING.named(pending.members))).not.toContain("t");
			expect(peer.codec.encode({ kind: "state", holds: [pending] }).byteLength).toBeLessThan(200);
		});

		it("are replaced by a value that follows them: the value as a root replacement, no failure", async () => {
			const { peer, call } = await retiring();
			await call("set", 1);
			await call("set", 2);
			await peer.next("state");
			await peer.next("state");
			await call("set", -1);
			await call("set", 3);
			peer.ack();
			const pending = (await peer.next("state")).holds[0]!;
			expect(pending.failed).toEqual([]);
			expect(RETIRING.named(pending.members).t).toEqual([["r", 3]]);
		});
	});
});

/** Lets every pending reaction run (a memory link delivers by microtask). */
async function flush(): Promise<void> {
	for (let i = 0; i < 100; i++) await Promise.resolve();
}

/** A local type nobody serves. */
const Missing = local("app.missing", { version: 1, params: {}, members: { n: int() } });

describe("retries across links: the hop budget (audit A5)", () => {
	it.each([1, 9, 50])(
		"quiesce after %i concurrent Retries round a waiting ring across hosts: each stops at its budget, no attempt started",
		async (operations) => {
			type P = { kind: "server" } | { kind: "worker" };
			const Server = hostKind("app.retry-server");
			const Worker = hostKind("app.retry-worker");
			const LocalA = local("app.a", { version: 1, params: {}, members: { n: int() } });
			const LocalB = local("app.b", { version: 1, params: {}, members: { n: int() } });
			const RemoteA = remote("app.remote-a", {
				version: 1,
				params: {},
				hostAddress: () => Server(),
				variants: { reader: { state: { n: int() } } },
			});
			const RemoteB = remote("app.remote-b", {
				version: 1,
				params: {},
				hostAddress: () => Worker(),
				variants: { reader: { state: { n: int() } } },
			});
			const hops: number[] = [];
			let factories = 0;
			const count = (link: Link): Link => ({
				send: (bytes) => {
					const message = binaryCodec.decode(bytes);
					if (message.kind === "retry") hops.push(message.hops);
					link.send(bytes);
				},
				onMessage: (listener) => link.onMessage(listener),
				onClose: (listener) => link.onClose(listener),
				close: () => link.close(),
			});
			const [down, up] = memoryLinkPair();
			const server = createHost<P>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
			const worker = createHost<P>({ address: Worker(), principal: { kind: "worker" }, onError: () => {} });
			server.route(
				Worker,
				{
					authorize: () => true,
					resolve: async () => ({ link: count(down), principal: { kind: "worker" }, trusted: true }),
				},
				context,
			);
			worker.connect(count(up), { principal: { kind: "server" }, trusted: true }, context);
			try {
				const left = server.load(
					[
						{
							name: "@test/a",
							facet: defineFacet<P>((h) => {
								h.serve(LocalA, (_, self) => {
									factories++;
									return { n: self.get(RemoteB, {}).n };
								});
								h.serve(RemoteA, (_, _principal, self) => {
									factories++;
									return { variant: "reader", members: { n: self.get(LocalA, {}).n } };
								});
							}),
						},
					],
					context,
				);
				const right = worker.load(
					[
						{
							name: "@test/b",
							facet: defineFacet<P>((h) => {
								h.serve(LocalB, (_, self) => {
									factories++;
									self.get(Missing, {});
									return { n: self.get(RemoteA, {}).n };
								});
								h.serve(RemoteB, (_, _principal, self) => {
									factories++;
									return { variant: "reader", members: { n: self.get(LocalB, {}).n } };
								});
							}),
						},
					],
					context,
				);
				await Promise.all([left, right]);
				await flush();
				const a = server.hold(LocalA, {}, context);
				expect(a.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
				const made = factories;
				for (let i = 0; i < operations; i++) a.retry();
				await flush();
				// Each passed round the ring with one hop less per host (16 from the first), never sent at 0.
				const lap = Array.from({ length: 16 }, (_, i) => 16 - i);
				expect(hops.toSorted((x, y) => y - x)).toEqual(lap.flatMap((hop) => Array(operations).fill(hop)));
				await flush();
				expect(hops).toHaveLength(16 * operations);
				// Parked objects only passed it on: no attempt started.
				expect(factories).toBe(made);
			} finally {
				await server.close(context);
				await worker.close(context);
			}
		},
	);
});

/** A remote object on the server: a label, a counter and `bump`. */
const Shown = remote("app.shown", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { v: { state: { label: str(), n: int() }, methods: { bump: method(undefined, int()) } } },
});

/** `Shown` v2: its label became an object; v1 consumers map back through `accepts`. */
const ShownV2 = evolve(Shown, (e) => e.state("v", "label", obj({ text: str() })));

/** Serves `Shown` labelled `label` (with a native when `native`); `bump` adds 1 to its in-memory counter. */
function serveShown(h: FacetHost<TestPrincipal>, label: string, native = false): void {
	h.serve(Shown, (_, _principal, self) => {
		const doc = self.state(N);
		if (native)
			self.open(
				async () => label,
				() => {},
			);
		return {
			variant: "v",
			members: {
				label: constant(label),
				n: self.derive([doc], ([d]) => d.n),
				bump: async (ctx) => {
					await doc.change((draft) => {
						draft.n += 1;
					}, ctx);
					return doc.value.n;
				},
			},
		};
	});
}

/** Serves `ShownV2` labelled `text`; with `accepts`, v1 consumers see `label` as its text. */
function serveShownV2(h: FacetHost<TestPrincipal>, text: string, accept: boolean): void {
	h.serve(
		ShownV2,
		(_, _principal, self) => {
			const doc = self.state(N);
			return {
				variant: "v",
				members: {
					label: constant({ text }),
					n: self.derive([doc], ([d]) => d.n),
					bump: async (ctx) => {
						await doc.change((draft) => {
							draft.n += 1;
						}, ctx);
						return doc.value.n;
					},
				},
			};
		},
		accept ? { accepts: { 1: { state: { v: { label: (current) => current.text } } } } } : {},
	);
}

/** Reloads the server's plugin `@test/app` (as `linked` names it) with `setup`. */
function reloadServer(server: Host<TestPrincipal>, setup: (host: FacetHost<TestPrincipal>) => void) {
	return server.reload([{ name: "@test/app", facet: defineFacet<TestPrincipal>(setup) }], context);
}

describe("holds across a reload (slice 7b §6)", () => {
	it("a restarted object's holds see loading, then a fresh bound", async () => {
		const { server, client } = await linked((h) => serveShown(h, "v1", true));
		const shown = await client.get(Shown, {}, context);
		const states = statesOf(await shown.state.watch(context));
		const label = changesOf(await shown.label.watch(context));
		await reloadServer(server, (h) => serveShown(h, "v2", true));
		await transported();
		expect(states).toEqual(["loading", "live"]);
		expect(valuesOf(label)).toEqual(["v2"]);
		await server.close(context);
	});

	it("a version the new code no longer accepts unbinds its holds (version); a later reload accepting it binds them", async () => {
		const { server, client } = await linked((h) => serveShown(h, "v1"));
		const shown = await client.get(Shown, {}, context);
		await reloadServer(server, (h) => serveShownV2(h, "v2", false));
		await transported();
		expect(shown.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: { code: "contract_mismatch" } },
		});
		expect(await rejection(shown.bump(context))).toMatchObject({ code: "contract_mismatch" });
		await reloadServer(server, (h) => serveShownV2(h, "v3", true));
		await transported();
		expect(shown.state.value).toEqual({ kind: "live" });
		expect(shown.label.value).toBe("v3");
		await server.close(context);
	});

	it("a removed type unbinds its holds (not_served); served again, they bind and a derive over them heals", async () => {
		const Panel = local("app.panel", { version: 1, params: {}, members: { text: str() } });
		const { server, client } = await linked((h) => serveShown(h, "v1"));
		await client.reload(
			[
				{
					name: "@test/panel",
					facet: defineFacet<TestPrincipal>((h) =>
						h.serve(Panel, (_, self) => {
							const shown = self.get(Shown, {});
							return { text: self.derive([shown.label], ([label]) => `panel ${label}`) };
						}),
					),
				},
			],
			context,
		);
		const panel = await client.get(Panel, {}, context);
		const shown = client.hold(Shown, {}, context);
		await server.reload([], context);
		await transported();
		expect(shown.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: { code: "unavailable" } },
		});
		// The dependent stays live (R18) with its last value.
		expect(panel.state.value).toEqual({ kind: "live" });
		expect(panel.text.value).toBe("panel v1");
		await server.reload(
			[{ name: "@test/app", facet: defineFacet<TestPrincipal>((h) => serveShown(h, "v2")) }],
			context,
		);
		await transported();
		expect(shown.state.value).toEqual({ kind: "live" });
		expect(panel.text.value).toBe("panel v2");
		await server.close(context);
	});

	it("a hold unbound while the window is full drops its pending ops; acks of messages sent stay counted", async () => {
		const server = createHost<TestPrincipal>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		await server.load(
			[{ name: "@test/app", facet: defineFacet<TestPrincipal>((h) => serveShown(h, "v1")) }],
			context,
		);
		const [a, b] = memoryLinkPair();
		server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
		const peer = new RawPeer(b, { ack: false });
		await peer.next("hello");
		hold(peer, 0, Shown);
		await peer.next("bound");
		// Commits from the server itself as the hold's principal: an answer over the link would send the waiting state.
		const bump = async (ctx: Ctx<TestPrincipal>) => (await ctx.get(Shown, {})).bump(ctx);
		for (let commit = 0; commit < 3; commit++) await server.root(bump, context, { principal: { kind: "owner" } });
		// One state in flight with the bound: the third commit's ops wait in their pending queue.
		await peer.next("state");
		await server.reload([], context);
		await transported();
		expect((await peer.next("failed")).cause).toMatchObject({ kind: "waiting" });
		peer.ack();
		peer.ack();
		await transported();
		expect(peer.kinds()).toEqual([]);
		await server.close(context);
	});

	it("a restart sends each bound hold loading, then one fresh bound with the new instance's values", async () => {
		const server = createHost<TestPrincipal>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		await server.load(
			[{ name: "@test/app", facet: defineFacet<TestPrincipal>((h) => serveShown(h, "v1")) }],
			context,
		);
		const [a, b] = memoryLinkPair();
		server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
		const peer = new RawPeer(b);
		const SHOWN = wireNames(Shown, "v");
		await peer.next("hello");
		hold(peer, 0, Shown);
		hold(peer, 1, Shown);
		await peer.next("bound");
		await transported();
		peer.received.length = 0;
		await reloadServer(server, (h) => serveShown(h, "v2"));
		await transported();
		expect(new Set(peer.kinds())).toEqual(new Set(["loading", "bound"]));
		const entries = peer.received.flatMap((message) => (message.kind === "bound" ? message.holds : []));
		expect(entries.map(({ hold }) => hold).sort()).toEqual([0, 1]);
		for (const entry of entries) expect(SHOWN.named(entry.members)).toEqual({ label: "v2", n: 0 });
		await server.close(context);
	});

	it("reloads during a full window: calls are answered by the old names until the fresh bound goes (audit A9)", async () => {
		const Two = remote("app.two-variants", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: {
				a: { state: { label: str() }, methods: { bump: method(undefined, int()), ping: method(undefined, int()) } },
				b: { state: { label: str() }, methods: { ping: method(undefined, int()) } },
			},
		});
		const serveTwo = (variant: "a" | "b", label: string) =>
			defineFacet<TestPrincipal>((h) =>
				h.serve(Two, (_, _principal, self) => {
					const doc = self.state(N);
					const ping = async () => 7;
					const bump = async (ctx: Context) => {
						await doc.change((draft) => {
							draft.n += 1;
						}, ctx);
						return doc.value.n;
					};
					return variant === "a"
						? { variant, members: { label: constant(label), bump, ping } }
						: { variant, members: { label: constant(label), ping } };
				}),
			);
		const server = createHost<TestPrincipal>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		await server.load([{ name: "@test/app", facet: serveTwo("a", "v1") }], context);
		const [a, b] = memoryLinkPair();
		server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
		const peer = new RawPeer(b, { ack: false });
		const A = wireNames(Two, "a");
		await peer.next("hello");
		hold(peer, 0, Two);
		await peer.next("bound");
		// A second message in flight: the window (two) is full.
		const changed = defineFacet<TestPrincipal>((h) =>
			h.serve(Two, (_, _principal, self) => ({
				variant: "a",
				members: {
					label: self.derive([self.state(N)], ([d]) => `n ${d.n}`),
					bump: async () => 0,
					ping: async () => 7,
				},
			})),
		);
		await server.reload([{ name: "@test/app", facet: changed }], context);
		await peer.next("bound");
		// Restarts while the window is full: the fresh bound waits for a slot, the hold answers by its old names.
		await server.reload([{ name: "@test/app", facet: serveTwo("a", "v2") }], context);
		await transported();
		peer.send({ kind: "call", call: 0, hold: 0, method: A.methods.bump! });
		expect(partValue((await peer.next("result")).value!)).toBe(1);
		// The new variant lacks a method of the old names: the attempt refuses it.
		await server.reload([{ name: "@test/app", facet: serveTwo("b", "v3") }], context);
		await transported();
		peer.send({ kind: "call", call: 1, hold: 0, method: A.methods.bump! });
		expect(await peer.next("error")).toMatchObject({ error: { error: { code: "invalid", reason: "member" } } });
		peer.send({ kind: "call", call: 2, hold: 0, method: A.methods.ping! });
		expect(partValue((await peer.next("result")).value!)).toBe(7);
		expect(peer.kinds().filter((kind) => kind === "bound")).toEqual([]);
		peer.ack();
		const fresh = await peer.next("bound");
		expect(fresh.holds[0]).toMatchObject({ hold: 0, variant: wireNames(Two, "b").variant });
		expect(wireNames(Two, "b").named(fresh.holds[0]!.members)).toEqual({ label: "v3" });
		await server.close(context);
	});

	it("collects the old instance while the hold's fresh bound waits for a slot (Astra, audit A9 GC)", async () => {
		const Type = remote("astra.audit-gc", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: { main: { state: { n: int() } } },
		});
		let declared: Self<TestPrincipal> | undefined;
		const facet = (n: number) =>
			defineFacet<TestPrincipal>((h) =>
				h.serve(Type, (_, _principal, self) => {
					declared = self;
					return { variant: "main", members: { n: constant(n) } };
				}),
			);
		const server = createHost<TestPrincipal>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		await server.load([{ name: "@astra/audit-gc", facet: facet(1) }], context);
		const [a, b] = memoryLinkPair();
		server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
		const peer = new RawPeer(b, { ack: false });
		await peer.next("hello");
		hold(peer, 0, Type);
		await peer.next("bound");
		// A second bound in flight: the window is full.
		await server.reload([{ name: "@astra/audit-gc", facet: facet(2) }], context);
		await peer.next("bound");
		const retired = new WeakRef(declared!);
		declared = undefined;
		await server.reload([{ name: "@astra/audit-gc", facet: facet(3) }], context);
		await transported();
		await flushed();
		// Its fresh bound waits for an ack; the hold keeps the old names for calls, not the old instance.
		expect(peer.kinds().filter((kind) => kind === "bound")).toEqual([]);
		await expectCollected(retired);
		peer.ack();
		await peer.next("bound");
		await server.close(context);
	});

	it("a hold waiting for a window slot whose slot frees between the old attempt's seal and its end binds safely", async () => {
		const Window = remote("app.window", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: {
				main: {
					state: { n: int() },
					methods: { bump: method(undefined, int()), slow: method(undefined, str()), start: method() },
				},
			},
		});
		const Wait = defineJob("app.window-wait", { version: 1, args: obj({}), result: str() });
		const gate = Promise.withResolvers<void>();
		/** Called once the old attempt's seal cut the job's run: the test frees the window's slots then. */
		let atSeal = (): void => {};
		const serveWindow = (code: string) =>
			defineFacet<TestPrincipal>((h) =>
				h.serve(Window, (_, _principal, self) => {
					self.open(
						async () => code,
						() => {},
					);
					const doc = self.state(N);
					const job = self.job(Wait, {
						run: (_args, ctx) =>
							new Promise<string>((resolve) =>
								ctx.abortSignal?.addEventListener("abort", () => {
									atSeal();
									resolve("cut");
								}),
							),
					});
					return {
						variant: "main",
						members: {
							n: self.derive([doc], ([d]) => d.n),
							bump: async (ctx: Context) => {
								await doc.change((draft) => {
									draft.n += 1;
								}, ctx);
								return doc.value.n;
							},
							start: async (ctx: Context) => {
								await job.start({}, ctx);
								return null;
							},
							slow: async () => {
								await gate.promise;
								return `${code} slow`;
							},
						},
					};
				}),
			);
		const errors: string[] = [];
		const server = createHost<TestPrincipal>({
			address: Server(),
			principal: { kind: "server" },
			onError: (error) => errors.push(error.kind),
		});
		await server.load([{ name: "@test/app", facet: serveWindow("v1") }], context);
		const [a, b] = memoryLinkPair();
		server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
		const peer = new RawPeer(b, { ack: false });
		const names = wireNames(Window, "main");
		await peer.next("hello");
		hold(peer, 0, Window);
		await peer.next("bound");
		peer.ack();
		peer.send({ kind: "call", call: 0, hold: 0, method: names.methods.start! });
		await peer.next("result");
		// Two messages unacknowledged: the window (two) is full.
		peer.send({ kind: "call", call: 1, hold: 0, method: names.methods.bump! });
		await peer.next("state");
		peer.send({ kind: "call", call: 2, hold: 0, method: names.methods.bump! });
		await peer.next("result");
		await peer.next("result");
		await transported();
		// A running call keeps the old attempt open; the acks come right at its seal (the job's run is cut there).
		peer.send({ kind: "call", call: 3, hold: 0, method: names.methods.slow! });
		await transported();
		atSeal = () => {
			peer.ack();
			peer.ack();
		};
		await server.reload([{ name: "@test/app", facet: serveWindow("v2") }], context);
		// A second hold during the drain: it binds the old attempt shown live, but waits for a slot.
		hold(peer, 1, Window);
		await transported();
		gate.resolve();
		expect(partValue((await peer.next("result")).value!)).toBe("v1 slow");
		await transported();
		await transported();
		expect(errors).not.toContain("protocol_error");
		expect(peer.closed).toBe(false);
		// Both holds end on the new code.
		for (let rounds = 0; rounds < 10 && !peer.received.some((m) => m.kind === "bound"); rounds++) await transported();
		peer.ack();
		peer.ack();
		await transported();
		const bound = peer.received.filter((message) => message.kind === "bound").flatMap(({ holds }) => holds);
		expect(new Set(bound.map(({ hold }) => hold))).toEqual(new Set([0, 1]));
		await server.close(context);
	});

	it("through a relay: a worker's reload reaches the tab as it reaches a direct consumer", async () => {
		const { tab, workers, server } = await relayed();
		const notes = await tab.get(PlacedNotes, { session: "S1" }, context);
		const worker = workers.get("session|S1")!;
		const states = statesOf(await notes.state.watch(context));
		await worker.reload([], context);
		await transported();
		expect(notes.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		await worker.reload(
			[{ name: "@test/worker", facet: defineFacet<TestPrincipal>((h) => void serveNotes(h, PlacedNotes)) }],
			context,
		);
		await transported();
		expect(notes.state.value).toEqual({ kind: "live" });
		expect(states.at(-1)).toBe("live");
		await server.close(context);
	});

	it('a reference made during a version-dropping reload\'s drain joins the old live binding: no fresh admission (decision "References share one wire hold", accepted difference 2)', async () => {
		const gate = Promise.withResolvers<void>();
		const { server, client } = await linked((h) =>
			h.serve(Shown, () => ({
				variant: "v",
				members: {
					label: constant("v1"),
					n: constant(0),
					bump: async () => {
						await gate.promise;
						return 1;
					},
				},
			})),
		);
		const a = (await client.get(Shown, {}, context)) as RefIn<typeof Shown, "v">;
		// A running call keeps the old attempt open: it drains after the reload commits.
		const running = a.bump(context);
		await transported();
		await reloadServer(server, (h) => serveShownV2(h, "v2", false));
		await transported();
		expect(a.state.value).toEqual({ kind: "live" });
		const b = client.hold(Shown, {}, context);
		expect([b.state.value, b.label.value, server.activity.value.references]).toEqual([{ kind: "live" }, "v1", 1]);
		// A separate consumer's new hold is admitted against the new code: v1 is no longer accepted.
		const other = createHost<TestPrincipal>({ onError: () => {} });
		await other.load([], context);
		const [near, far] = memoryLinkPair();
		server.accept(near, { principal: { kind: "owner" }, codec: testCodec() }, context);
		other.connect(far, { principal: { kind: "server" }, codec: testCodec() }, context);
		const fresh = other.hold(Shown, {}, context);
		await transported();
		expect(fresh.state.value).toMatchObject({ kind: "failed", cause: { error: { code: "contract_mismatch" } } });
		gate.resolve();
		expect(await running).toBe(1);
		await transported();
		// After the drain both references leave the old binding together.
		expect([a.state.value, b.state.value]).toMatchObject([
			{ kind: "failed", cause: { error: { code: "contract_mismatch" } } },
			{ kind: "failed", cause: { error: { code: "contract_mismatch" } } },
		]);
		await other.close(context);
		await server.close(context);
	});

	it('two references sharing one hold (decision "References share one wire hold") follow a restart, a dropped version and a removal together', async () => {
		const { server, client } = await linked((h) => serveShown(h, "v1", true));
		const a = await client.get(Shown, {}, context);
		const b = await client.get(Shown, {}, context);
		await transported();
		expect(server.activity.value.references).toBe(1);
		const states = [statesOf(await a.state.watch(context)), statesOf(await b.state.watch(context))];
		await reloadServer(server, (h) => serveShown(h, "v2", true));
		await transported();
		expect([a.label.value, b.label.value]).toEqual(["v2", "v2"]);
		await reloadServer(server, (h) => serveShownV2(h, "v3", false));
		await transported();
		await server.reload([], context);
		await transported();
		await reloadServer(server, (h) => serveShown(h, "v4"));
		await transported();
		expect([a.label.value, b.label.value]).toEqual(["v4", "v4"]);
		// Each reference sees what one hold of its own would have: the restart, the dropped version, the removal while
		// failed (no change), the type served again.
		const followed = ["loading", "live", "loading", "failed", "loading", "live"];
		expect(states.map((each) => each.map((state) => state.replace(/:.*/, "")))).toEqual([followed, followed]);
		expect(server.activity.value.references).toBe(1);
		await server.close(context);
	});
});

describe("holds across more than one reload (fix round 1)", () => {
	it("keeps a real subscriber when a changed constant later becomes dynamic", async () => {
		type P = { kind: "server" } | { kind: "tab" };
		const Server = hostKind("sol-server");
		const Type = remote("sol.wire", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: { main: { state: { x: int() }, methods: { set: method(int()) } } },
		});
		const Doc = defineState("wire", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });
		const facet = (choice: { kind: "constant"; n: number } | { kind: "dynamic" }) =>
			defineFacet<P>((h) =>
				h.serve(Type, (_, _principal, self) => {
					const doc = self.state(Doc);
					return {
						variant: "main",
						members: {
							x: choice.kind === "constant" ? constant(choice.n) : self.derive([doc], ([value]) => value.n),
							set: async (n: number, ctx: Context) => {
								await doc.change((draft) => {
									draft.n = n;
								}, ctx);
								return null;
							},
						},
					};
				}),
			);
		const server = createHost<P>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		const tab = createHost<P>({ onError: () => {} });
		try {
			await server.load([{ name: "@sol/wire", facet: facet({ kind: "constant", n: 1 }) }], context);
			await tab.load([], context);
			const [up, down] = memoryLinkPair();
			server.accept(up, { principal: { kind: "tab" } }, context);
			tab.connect(down, { principal: { kind: "server" } }, context);
			const held = await tab.get(Type, {}, context);
			await server.reload([{ name: "@sol/wire", facet: facet({ kind: "constant", n: 2 }) }], context);
			await delivered();
			expect(held.x.value).toBe(2);
			await server.reload([{ name: "@sol/wire", facet: facet({ kind: "dynamic" }) }], context);
			await delivered();
			expect(held.x.value).toBe(0);
			await held.set(7, context);
			await delivered();
			expect(held.x.value).toBe(7);
		} finally {
			await tab.close(context);
			await server.close(context);
		}
	});
});

describe("a hold after its object's live failure (final review)", () => {
	const attempted = instancesOf(ChordObject, "attempt");

	it("follows a member re-exposing another object's source until the admitted commits published (audit A10)", async () => {
		const Point = obj({ n: int() });
		const A = local("app.foreign", { version: 1, params: {}, members: { x: Point } });
		const B = remote("app.reexposing", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: { main: { state: { x: Point } } },
		});
		let foreign: Writable<{ n: number }> | undefined;
		let self: Self<TestPrincipal> | undefined;
		const { server, client } = await linked((h) => {
			h.serve(A, (_, s) => {
				foreign = s.writable({ n: 0 });
				return { x: s.derive([foreign], ([value]) => value) };
			});
			h.serve(B, (_, _principal, s) => {
				self = s;
				return { variant: "main", members: { x: s.get(A, {}).x } };
			});
		});
		const ref = await client.get(B, {}, context);
		const calls = changesOf(await ref.x.watch(context));
		failLive(attempted, self!, new ChordError({ code: "unavailable", message: "boom" }));
		// A's change lands after B failed, in the window before B's admitted commits published: it shows (one more
		// change), then the member holds with the failure.
		foreign!.set({ n: 1 });
		await delivered();
		expect([ref.x.value, valuesOf(calls)]).toEqual([{ n: 1 }, [{ n: 1 }, { failed: "boom" }]]);
		await client.close(context);
		await server.close(context);
	});
});

describe("a hold across a reload whose mapping fails (final review)", () => {
	it("gets the member's failure in its fresh bound and heals with the new source (Sol, audit A9)", async () => {
		const W1 = remote("app.swap-failed", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: { main: { state: { x: int() } } },
		});
		const W2 = evolve(W1, (e) => e.state("main", "x", obj({ n: int() })));
		let throws = true;
		let point: Writable<{ n: number }> | undefined;
		const serve = (h: FacetHost<TestPrincipal>, map: (value: { n: number }) => number) =>
			h.serve(
				W2,
				(_, _principal, s) => {
					point = s.writable({ n: 1 });
					return { variant: "main", members: { x: s.derive([point], ([value]) => value) } };
				},
				{ accepts: { 1: { state: { main: { x: map } } } } },
			);
		const { server, client } = await linked((h) => serve(h, (value) => value.n));
		const ref = await client.get(W1, {}, context);
		const calls = changesOf(await ref.x.watch(context));
		// The new instance's mapping throws for its first value.
		const failing = (value: { n: number }) => {
			if (throws) throw new Error("member boom");
			return value.n;
		};
		await server.reload(
			[{ name: "@test/app", facet: defineFacet<TestPrincipal>((h) => serve(h, failing)) }],
			context,
		);
		await delivered();
		// Live, the member failed: its watch got the failure, a read throws it (as a failed member does on the host).
		expect([ref.state.value.kind, valuesOf(calls)]).toEqual(["live", [{ failed: "member boom" }]]);
		expect(() => ref.x.value).toThrow("member boom");
		// It follows the new source: the next value heals it.
		throws = false;
		point!.set({ n: 3 });
		await delivered();
		expect([ref.x.value, valuesOf(calls)]).toEqual([3, [{ failed: "member boom" }, 3]]);
		await client.close(context);
		await server.close(context);
	});
});

describe('calls over a link while a restart waits (decision "Reload restarts every affected object")', () => {
	/** A provider on the server: its name, its keys (`entries`) and `set`, which writes key `x`. */
	const Provider = local("app.gate-provider", {
		version: 1,
		params: {},
		members: { name: str(), entries: keyed(obj({ n: int() })), set: method(int()) },
	});
	const ENTRIES = { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }), keyed: true } as const;
	const Entries = defineState("entries", ENTRIES);
	const PersistedEntries = defineState("entries", { ...ENTRIES, persist: true, checkpointWhen: () => false });
	/** A local type whose native opens once `opened` resolves. */
	const Slow = local("app.gate-slow", { version: 1, params: {}, members: { name: str() } });
	/** A remote object over the provider: `bump` answers its code's number. */
	const Gated = remote("app.gated", {
		version: 1,
		params: {},
		hostAddress: () => Server(),
		variants: { v: { state: { label: str() }, methods: { bump: method(undefined, int()) } } },
	});

	/** Serves `Slow`, whose native opens once `opened` resolves. */
	function serveSlow(h: FacetHost<TestPrincipal>, opened: Promise<void>): void {
		h.serve(Slow, (_, self) => {
			self.open(
				async () => {
					await opened;
					return null;
				},
				() => {},
			);
			return { name: constant("slow") };
		});
	}

	/** Serves the provider labelled `name`, needing `Slow` when `slow`, its keys persisted when `persisted`. */
	function serveProvider(h: FacetHost<TestPrincipal>, name: string, options: { slow?: boolean; persisted?: boolean }) {
		h.serve(Provider, (_, self) => {
			if (options.slow === true) self.get(Slow, {});
			const entries = self.state(options.persisted === true ? PersistedEntries : Entries);
			return {
				name: constant(name),
				entries,
				set: async (n: number, ctx: Context) => {
					await entries.change(
						"x",
						(draft) => {
							draft.n = n;
						},
						ctx,
					);
					return null;
				},
			};
		});
	}

	/**
	 * Serves `Gated` as code `code`: its label over the provider's name (or its key `k`), `bump` first awaiting `gate`;
	 * needing `Slow` too when `slow`.
	 */
	function serveGated(
		h: FacetHost<TestPrincipal>,
		code: number,
		options: { gate?: Promise<void>; pin?: boolean; slow?: boolean },
	) {
		h.serve(Gated, (_, _principal, self) => {
			const provider = self.get(Provider, {});
			if (options.slow === true) self.get(Slow, {});
			const label =
				options.pin === true
					? self.derive([provider.entries.at("k")], ([entry]) => `v${code} ${entry.n}`)
					: self.derive([provider.name], ([name]) => `v${code} ${name}`);
			return {
				variant: "v",
				members: {
					label,
					bump: async () => {
						await options.gate;
						return code;
					},
				},
			};
		});
	}

	it("a call arriving while the old attempt drains and the successor's request opens waits for the new code (never not_ready)", async () => {
		const gate = Promise.withResolvers<void>();
		const opened = Promise.withResolvers<void>();
		const { server, client } = await linked((h) => {
			serveProvider(h, "p1", {});
			serveGated(h, 1, { gate: gate.promise });
		});
		const gated = await client.get(Gated, {}, context);
		const old = gated.bump(context);
		await transported();
		const report = await server.reload(
			[
				{
					name: "@test/app",
					facet: defineFacet<TestPrincipal>((h) => {
						serveSlow(h, opened.promise);
						serveProvider(h, "p2", {});
						serveGated(h, 2, { slow: true });
					}),
				},
			],
			context,
		);
		// The new code of `Gated` needs `Slow`, a new type still opening: its old attempt stays open meanwhile.
		expect(report.objects).toEqual([
			{ object: "app.gate-provider", kind: "restarted" },
			{ object: "app.gated", kind: "restarted" },
		]);
		// The old attempt still runs its call, so the hold stays bound: the client sees live and sends new work.
		const outcome = gated.bump(context).then(
			(value) => ({ value }),
			(error: ChordError) => ({ code: error.code }),
		);
		await transported();
		expect(gated.state.value).toEqual({ kind: "live" });
		opened.resolve();
		gate.resolve();
		expect(await old).toBe(1);
		expect(await outcome).toEqual({ value: 2 });
		await transported();
		expect(gated.label.value).toBe("v2 p2");
		await client.close(context);
		await server.close(context);
	});
});

// A call sent after the hold's `loading` by the names it was bound with (as a consumer sends it before it learns of the
// `loading`) is kept as a call in flight at the unbind is: several tests below send their calls that way.
describe('calls in flight across a `loading` unbind (decision "Calls in flight survive a `loading` unbind")', () => {
	/** A remote object on the server: `bump` (variant `a` only) and `ping` answer its code's number. */
	const Kept = remote("app.kept", {
		version: 1,
		params: {},
		hostAddress: () => Server(),
		variants: {
			a: { state: { label: str() }, methods: { bump: method(undefined, int()), ping: method(undefined, int()) } },
			b: { state: { label: str() }, methods: { ping: method(undefined, int()) } },
		},
	});
	const KEPT = wireNames(Kept, "a");
	/** `Kept` v2: its label became an object, which v1 consumers are not mapped to (their version is dropped). */
	const KeptV2 = evolve(Kept, (e) => e.state("a", "label", obj({ text: str() })));
	/** A local type whose factory throws (with params: no host-lifetime object): one needing it parks on its failure. */
	const Broken = local("app.kept-broken", { version: 1, params: { id: int() }, members: { n: int() } });

	/** One code of `Kept`. */
	type KeptCode = {
		/** What `bump` and `ping` answer. */
		readonly n: number;
		readonly variant?: "a" | "b";
		/** Whether it opens a native (a reload then restarts it), which opens once `opened` resolves. */
		readonly native?: boolean;
		readonly opened?: Promise<void>;
		/** What `bump` waits for first. */
		readonly gate?: Promise<void>;
		/** Whether it needs `Broken` (it parks on a failed dependency). */
		readonly broken?: boolean;
		/** Each call that ran on this code, by method. */
		readonly ran?: string[];
	};

	/** `Kept` as `code` (with `Broken` served beside it). */
	function keptFacet(code: KeptCode) {
		return defineFacet<TestPrincipal>((h) => {
			h.serve(Broken, () => {
				throw new Error("broken factory");
			});
			h.serve(Kept, (_, _principal, self) => {
				if (code.native === true)
					self.open(
						async () => {
							await code.opened;
							return null;
						},
						() => {},
					);
				if (code.broken === true) self.get(Broken, { id: 1 });
				const ping = async () => {
					code.ran?.push("ping");
					return code.n;
				};
				const bump = async () => {
					await code.gate;
					code.ran?.push("bump");
					return code.n;
				};
				const label = constant(`v${code.n}`);
				return code.variant === "b"
					? { variant: "b", members: { label, ping } }
					: { variant: "a", members: { label, bump, ping } };
			});
		});
	}

	/** A server serving `code` and a raw peer holding its `Kept` as hold 0, bound. */
	async function keptServer(
		code: KeptCode,
		options: { readonly closeTimeout?: number; readonly readyTimeout?: number; readonly ack?: boolean } = {},
	) {
		const server = createHost<TestPrincipal>({
			address: Server(),
			principal: { kind: "server" },
			closeTimeout: options.closeTimeout,
			readyTimeout: options.readyTimeout,
			revokedBy: (principal) => (principal.kind === "owner" ? ["owner"] : []),
			onError: () => {},
		});
		await server.load([{ name: "@test/app", facet: keptFacet(code) }], context);
		const [a, b] = memoryLinkPair();
		server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
		const peer = new RawPeer(b, { ack: options.ack });
		await peer.next("hello");
		hold(peer, 0, Kept);
		await peer.next("bound");
		const reload = (next: KeptCode | ReturnType<typeof keptFacet>) =>
			server.reload([{ name: "@test/app", facet: "n" in next ? keptFacet(next) : next }], context);
		return { server, peer, reload };
	}

	/** Sends call `call` of `method` (an index of `Kept`'s variant `a`) on hold 0. */
	function call(peer: RawPeer, call: number, method: "bump" | "ping"): void {
		peer.send({ kind: "call", call, hold: 0, method: KEPT.methods[method]! });
	}

	/** The answers (`result`, `error`) the peer received for `call`, taken. */
	function answersTo(peer: RawPeer, id: number): Message[] {
		const answers = peer.received.filter(
			(message) => (message.kind === "result" || message.kind === "error") && message.call === id,
		);
		peer.received.splice(0, peer.received.length, ...peer.received.filter((message) => !answers.includes(message)));
		return answers;
	}

	it("a restart: the running call drains on the old code, one arriving during the drain runs on the new code", async () => {
		const gate = Promise.withResolvers<void>();
		const opened = Promise.withResolvers<void>();
		const ran: string[] = [];
		const { server, peer, reload } = await keptServer({ n: 1, native: true, gate: gate.promise, ran });
		call(peer, 0, "bump");
		await transported();
		const report = await reload({ n: 2, native: true, opened: opened.promise, ran });
		expect(report.objects).toEqual([{ object: "app.kept", kind: "restarted" }]);
		// The hold stays bound while the old instance drains: a call sent now waits at the gate.
		call(peer, 1, "bump");
		await transported();
		gate.resolve();
		expect(partValue((await peer.next("result")).value!)).toBe(1);
		await peer.next("loading");
		await transported();
		// Kept across the `loading`: no answer until the new attempt is live.
		expect(answersTo(peer, 1)).toEqual([]);
		opened.resolve();
		await peer.next("bound");
		const result = await peer.next("result");
		expect([result.call, partValue(result.value!)]).toEqual([1, 2]);
		expect(ran).toEqual(["bump", "bump"]);
		expect(peer.kinds().filter((kind) => kind === "error")).toEqual([]);
		await server.close(context);
	});

	it("a call stuck on the old code past closeTimeout is answered released at the seal, once", async () => {
		const opened = Promise.withResolvers<void>();
		const { server, peer, reload } = await keptServer(
			{ n: 1, native: true, gate: new Promise(() => {}) },
			{ closeTimeout: 30 },
		);
		call(peer, 0, "bump");
		await transported();
		await reload({ n: 2, native: true, opened: opened.promise });
		await peer.next("loading");
		const error = await peer.next("error");
		expect(error).toMatchObject({ call: 0, error: { error: { code: "released" } } });
		opened.resolve();
		await peer.next("bound");
		await transported();
		expect(answersTo(peer, 0)).toEqual([]);
		await server.close(context);
	});

	it("a kept call takes the gate's rejection: the parked cause, or unavailable after readyTimeout", async () => {
		const parked = await keptServer({ n: 1, native: true });
		const opened = Promise.withResolvers<void>();
		await parked.reload({ n: 2, native: true, opened: opened.promise, broken: true });
		call(parked.peer, 0, "ping");
		opened.resolve();
		const failed = await parked.peer.next("failed");
		expect(failed.cause).toMatchObject({ kind: "waiting" });
		const rejected = await parked.peer.next("error");
		expect(rejected).toMatchObject({
			call: 0,
			error: { error: { message: expect.stringContaining("broken factory") } },
		});
		await parked.server.close(context);

		const timed = await keptServer({ n: 1, native: true }, { readyTimeout: 60 });
		await timed.reload({ n: 2, native: true, opened: new Promise(() => {}) });
		call(timed.peer, 0, "ping");
		await timed.peer.next("loading");
		const timeout = await timed.peer.next("error");
		// Bounded by readyTimeout (here the new attempt's own deadline fails it first).
		expect(timeout).toMatchObject({
			call: 0,
			error: { error: { code: "unavailable", message: expect.stringContaining("60 ms") } },
		});
		await timed.server.close(context);
	});

	it("a kept call aborted or released by its consumer gets no answer and never runs", async () => {
		const ran: string[] = [];
		const opened = Promise.withResolvers<void>();
		const { server, peer, reload } = await keptServer({ n: 1, native: true, ran });
		await reload({ n: 2, native: true, opened: opened.promise, ran });
		call(peer, 0, "ping");
		call(peer, 1, "ping");
		await peer.next("loading");
		peer.send({ kind: "abort", call: 0 });
		await transported();
		opened.resolve();
		await peer.next("bound");
		expect((await peer.next("result")).call).toBe(1);
		await transported();
		expect(answersTo(peer, 0)).toEqual([]);
		expect(ran).toEqual(["ping"]);
		// A release while kept: the call goes with the hold.
		const second = Promise.withResolvers<void>();
		await reload({ n: 3, native: true, opened: second.promise, ran });
		call(peer, 2, "ping");
		await peer.next("loading");
		peer.send({ kind: "release", hold: 0 });
		await transported();
		second.resolve();
		await transported();
		expect(answersTo(peer, 2)).toEqual([]);
		expect(ran).toEqual(["ping"]);
		await server.close(context);
	});

	it("across a variant change a kept call runs by name: one the new variant lacks fails invalid/member", async () => {
		const opened = Promise.withResolvers<void>();
		const { server, peer, reload } = await keptServer({ n: 1, native: true });
		await reload({ n: 2, variant: "b", native: true, opened: opened.promise });
		call(peer, 0, "bump");
		call(peer, 1, "ping");
		await peer.next("loading");
		opened.resolve();
		const fresh = await peer.next("bound");
		expect(fresh.holds[0]!.variant).toBe(wireNames(Kept, "b").variant);
		const missing = await peer.next("error");
		expect(missing).toMatchObject({ call: 0, error: { error: { code: "invalid", reason: "member" } } });
		const result = await peer.next("result");
		expect([result.call, partValue(result.value!)]).toEqual([1, 2]);
		await server.close(context);
	});

	it("a kept call of a version the new code drops is rejected contract_mismatch with the hold's failed", async () => {
		const opened = Promise.withResolvers<void>();
		const ran: string[] = [];
		const { server, peer, reload } = await keptServer({ n: 1, native: true });
		const v2 = defineFacet<TestPrincipal>((h) =>
			h.serve(KeptV2, (_, _principal, self) => {
				self.open(
					async () => {
						await opened.promise;
						return null;
					},
					() => {},
				);
				const ping = async () => {
					ran.push("ping");
					return 2;
				};
				return { variant: "a", members: { label: constant({ text: "v2" }), bump: ping, ping } };
			}),
		);
		await reload(v2);
		call(peer, 0, "ping");
		await peer.next("loading");
		opened.resolve();
		const failed = await peer.next("failed");
		expect(failed.cause).toMatchObject({ kind: "waiting", error: { error: { code: "contract_mismatch" } } });
		expect(await peer.next("error")).toMatchObject({ call: 0, error: { error: { code: "contract_mismatch" } } });
		expect(ran).toEqual([]);
		await server.close(context);
	});

	it("a call by the old names crossing the loading on the wire waits at the gate, never not_ready", async () => {
		const opened = Promise.withResolvers<void>();
		const { server, peer, reload } = await keptServer({ n: 1, native: true });
		await reload({ n: 2, native: true, opened: opened.promise });
		// Sent as a consumer sends it before it learns of the `loading`: by the names it was bound with.
		await peer.next("loading");
		call(peer, 0, "bump");
		await transported();
		expect(answersTo(peer, 0)).toEqual([]);
		opened.resolve();
		await peer.next("bound");
		const result = await peer.next("result");
		expect([result.call, partValue(result.value!)]).toEqual([0, 2]);
		await server.close(context);
	});

	it("a revocation racing the rebind ends the kept call with the link: no result", async () => {
		const ran: string[] = [];
		const { server, peer, reload } = await keptServer({ n: 1, native: true, ran });
		await reload({ n: 2, native: true, opened: new Promise(() => {}), ran });
		call(peer, 0, "ping");
		await peer.next("loading");
		server.revoke("owner", context);
		await transported();
		expect(peer.closed).toBe(true);
		expect(answersTo(peer, 0).filter(({ kind }) => kind === "result")).toEqual([]);
		expect(ran).toEqual([]);
		await server.close(context);
	});

	it("a failed unbind still rejects: a live failure answers its calls with the failure, and calls crossing it too", async () => {
		const gate = Promise.withResolvers<void>();
		let self: Self<TestPrincipal> | undefined;
		const server = createHost<TestPrincipal>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
		const facet = defineFacet<TestPrincipal>((h) =>
			h.serve(Kept, (_, _principal, declared) => {
				self = declared;
				const ping = async () => {
					await gate.promise;
					return 1;
				};
				return { variant: "a", members: { label: constant("v1"), bump: ping, ping } };
			}),
		);
		await server.load([{ name: "@test/app", facet }], context);
		const objects = instancesOf(ChordObject, "attempt");
		const [a, b] = memoryLinkPair();
		server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
		const peer = new RawPeer(b);
		await peer.next("hello");
		hold(peer, 0, Kept);
		await peer.next("bound");
		call(peer, 0, "ping");
		await transported();
		failLive(objects, self!, new ChordError({ code: "unavailable", message: "it broke" }));
		const rejected = await peer.next("error");
		expect(rejected).toMatchObject({ call: 0, error: { error: { message: "it broke" } } });
		await peer.next("failed");
		// Told a failure, the hold takes no calls by the old names: one that crossed the `failed` gets that cause.
		call(peer, 1, "ping");
		expect(await peer.next("error")).toMatchObject({ call: 1, error: { error: { message: "it broke" } } });
		gate.resolve();
		await server.close(context);
	});

	it("a call by the old variant's index crossing a fresh bound of another variant is decoded by the old names (audit F4)", async () => {
		const ran: string[] = [];
		const { server, peer, reload } = await keptServer({ n: 1, ran }, { ack: false });
		peer.ack();
		await reload({ n: 2, variant: "b", ran });
		const bound = await peer.next("bound");
		expect(bound.holds[0]!.variant).toBe(1);
		// Sent before the consumer applied that `bound`: by variant a's indexes (`bump` is 0, which is `ping` in b).
		call(peer, 0, "bump");
		call(peer, 1, "ping");
		await transported();
		expect(answersTo(peer, 0)).toMatchObject([
			{ kind: "error", error: { error: { code: "invalid", reason: "member" } } },
		]);
		expect(answersTo(peer, 1).map((answer) => answer.kind === "result" && partValue(answer.value!))).toEqual([2]);
		expect(ran).toEqual(["ping"]);
		// Applied and acknowledged: now by variant b's indexes.
		peer.ack();
		peer.send({ kind: "call", call: 2, hold: 0, method: wireNames(Kept, "b").methods.ping! });
		expect(partValue((await peer.next("result")).value!)).toBe(2);
		expect(ran).toEqual(["ping", "ping"]);
		expect(peer.closed).toBe(false);
		await server.close(context);
	});

	it("a call crossing a removal's failed gets the removal's cause, never not_ready (audit F3)", async () => {
		const { server, peer } = await keptServer({ n: 1 });
		await server.reload([], context);
		const failed = await peer.next("failed");
		expect(failed.cause).toMatchObject({ kind: "waiting", error: { error: { code: "unavailable" } } });
		// Sent as a consumer sends it before the `failed` reaches it.
		call(peer, 0, "ping");
		const answer = await peer.next("error");
		expect(answer.error).toEqual(failed.cause.error);
		await server.close(context);
	});

	it("a call crossing a version refusal's failed gets contract_mismatch, never not_ready (audit F3)", async () => {
		const { server, peer, reload } = await keptServer({ n: 1 });
		// The new code serves version 2 only: the version 1 hold is refused.
		const answer = async () => 2;
		const v2 = defineFacet<TestPrincipal>((h) =>
			h.serve(KeptV2, () => ({
				variant: "a",
				members: { label: constant({ text: "v2" }), bump: answer, ping: answer },
			})),
		);
		await reload(v2);
		const failed = await peer.next("failed");
		expect(failed.cause).toMatchObject({ kind: "waiting", error: { error: { code: "contract_mismatch" } } });
		call(peer, 0, "ping");
		expect(await peer.next("error")).toMatchObject({ call: 0, error: { error: { code: "contract_mismatch" } } });
		await server.close(context);
	});

	describe("through a relay", () => {
		/** `Kept` placed on a session's worker. */
		const PlacedKept = remote("app.placed-kept", {
			version: 1,
			params: { session: str() },
			hostAddress: ({ session }) => Session({ id: session }),
			variants: { a: { state: { label: str() }, methods: { ping: method(undefined, int()) } } },
		});

		/** Serves `PlacedKept` answering `n` (recorded in `ran`), with a native that opens once `opened` resolves. */
		function servePlacedKept(h: FacetHost<TestPrincipal>, n: number, ran: number[], opened?: Promise<void>): void {
			h.serve(PlacedKept, (_, _principal, self) => {
				self.open(
					async () => {
						await opened;
						return null;
					},
					() => {},
				);
				const ping = async () => {
					ran.push(n);
					return n;
				};
				return { variant: "a", members: { label: constant(`v${n}`), ping } };
			});
		}

		it("a worker's restart: the tab's kept call crosses the forwarded loading and is answered by the new code", async () => {
			const ran: number[] = [];
			const { tab, workers, server } = await relayed({ worker: (h) => servePlacedKept(h, 1, ran) });
			const kept = await tab.get(PlacedKept, { session: "S1" }, context);
			const states = statesOf(await kept.state.watch(context));
			const opened = Promise.withResolvers<void>();
			const worker = workers.get("session|S1")!;
			await worker.reload(
				[
					{
						name: "@test/worker",
						facet: defineFacet<TestPrincipal>((h) => servePlacedKept(h, 2, ran, opened.promise)),
					},
				],
				context,
			);
			// Still live during the drain: the call goes out and waits at the worker's gate.
			const answer = kept.ping(context);
			await transported();
			expect(states).toEqual(["loading"]);
			opened.resolve();
			expect(await answer).toBe(2);
			await transported();
			expect(states).toEqual(["loading", "live"]);
			expect(ran).toEqual([2]);
			await server.close(context);
		});

		it("a downstream drop while the call is kept aborts it on the worker: it never runs", async () => {
			const ran: number[] = [];
			const { tab, workers, server, tabLink } = await relayed({ worker: (h) => servePlacedKept(h, 1, ran) });
			const kept = await tab.get(PlacedKept, { session: "S1" }, context);
			const opened = Promise.withResolvers<void>();
			const worker = workers.get("session|S1")!;
			await worker.reload(
				[
					{
						name: "@test/worker",
						facet: defineFacet<TestPrincipal>((h) => servePlacedKept(h, 2, ran, opened.promise)),
					},
				],
				context,
			);
			const answer = rejection(kept.ping(context));
			await transported();
			tabLink.close();
			expect(await answer).toMatchObject({ code: "unavailable" });
			await transported();
			opened.resolve();
			await transported();
			expect(ran).toEqual([]);
			await server.close(context);
		});
	});
});
