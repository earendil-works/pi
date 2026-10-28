import { describe, expect, it, vi } from "vitest";
import { type Context, BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import type * as Delta from "../../../src/delta/index.ts";
import { decoder } from "../../../src/delta/index.ts";
import { bool, int, local, method, obj, remote } from "../../../src/next/contracts/index.ts";
import { broken } from "../../../src/next/data/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type Host, type Self } from "../../../src/next/host/index.ts";
import type { ChordHost } from "../../../src/next/host/internal.ts";
import { type Link, memoryLinkPair } from "../../../src/next/link/index.ts";
import { jsonPart } from "../../../src/next/link/internal.ts";
import { Hold } from "../../../src/next/remote/hold.ts";
import { constant } from "../../../src/next/state/index.ts";
import {
	changesOf,
	expectCollected,
	fakeTimers,
	forEachCodec,
	instancesOf,
	linked,
	RawPeer,
	rawLinked,
	type TestPrincipal,
	testCodec,
	transported,
	wireNames,
} from "../support.ts";

/** Every Delta encoder made while this file runs, weakly: the holds' member encoders among them. */
const encoders = vi.hoisted(() => [] as WeakRef<object>[]);

vi.mock("../../../src/delta/index.ts", async (importOriginal) => {
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
	peer.send({ kind: "hold", hold: id, type, version, fingerprint, params: "{}" });
}

/** The provider object behind a hold, reached through the host's own lookup (to end it by hand). */
function providerObject(server: unknown) {
	const host = server as ChordHost<TestPrincipal>;
	const { name: type, version, fingerprint } = Halves;
	return host.serving({ type, version, fingerprint, params: "{}" }, {}, { kind: "owner" }, context);
}

/** A remote type whose activation never completes: its open waits for its abort. */
const Pending = remote("app.pending", { version: 1, params: {}, variants: { v: { state: { n: int() } } } });

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
			const Flaky = remote("app.flaky", { version: 1, params: {}, variants: { v: { state: { n: int() } } } });
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
const Flaky = remote("app.flaky", { version: 1, params: {}, variants: { v: { state: { n: int() } } } });

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
			peer.send({ kind: "retry", hold: 0 });
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
			other.send({ kind: "retry", hold: 0 });
			for (const consumer of [peer, other]) {
				await consumer.next("loading");
				await consumer.next("bound");
			}
		});

		it("a retry of a live or an unknown hold does nothing", async () => {
			const { peer } = await rawLinked((h) => serveFlaky(h, { left: 0, broken: false }));
			hold(peer, 0, Flaky);
			await peer.next("bound");
			peer.send({ kind: "retry", hold: 0 });
			peer.send({ kind: "retry", hold: 9 });
			await transported();
			expect([peer.kinds(), peer.closed]).toEqual([["hello"], false]);
		});
	});

	describe("a reconnecting consumer", () => {
		const Tally = remote("app.tally", {
			version: 1,
			params: {},
			variants: { v: { state: { n: obj({ n: int() }) }, methods: { bump: method() } } },
		});
		const Fresh = remote("app.fresh", {
			version: 1,
			params: {},
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

/** A server serving `Retiring` to a raw peer that acks only when told; `call` calls a method of hold 0. */
async function retiring() {
	const server = createHost<TestPrincipal>({ principal: { kind: "server" }, onError: () => {} });
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
	let calls = 0;
	const call = async (method: "set" | "retire", args?: number) => {
		const id = calls++;
		const payload = args === undefined ? {} : { args: jsonPart(args) };
		peer.send({ kind: "call", call: id, hold: 0, method: RETIRING.methods[method]!, ...payload });
		expect((await peer.next("result")).call).toBe(id);
	};
	const { name: type, version, fingerprint } = Retiring;
	peer.send({ kind: "hold", hold: 0, type, version, fingerprint, params: "{}" });
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
