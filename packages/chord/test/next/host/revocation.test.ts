// Tests of revocation (§4, R10, R11): revocation keys, \`host.revoke\` on one host (objects, running calls, activations,
// holds still waiting for \`load\`), child links and \`revoke\` messages, GC, and revocation across a relay.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, local, remote } from "../../../src/next/contracts/index.ts";
import { createHost, defineFacet, type FacetHost, type Host } from "../../../src/next/host/index.ts";
import { ChordObject } from "../../../src/next/host/object.ts";
import { memoryLinkPair } from "../../../src/next/link/index.ts";
import { jsonPart } from "../../../src/next/link/internal.ts";
import { constant } from "../../../src/next/state/index.ts";
import {
	expectCollected,
	forEachCodec,
	instancesOf,
	Notes,
	PlacedNotes,
	RawPeer,
	rawParent,
	rawWorkers,
	relayed,
	Session,
	serveNotes,
	type TestPrincipal,
	testCodec,
	transported,
	wireNames,
} from "../support.ts";

/** Every object attempted in this file, weakly. */
const objects = instancesOf(ChordObject, "attempt");

/** The test app's revocations: a guest's session, or every owner. */
type Revocation = { session: string } | { owners: true };

const revokedBy = (principal: TestPrincipal): Revocation[] =>
	principal.kind === "guest"
		? [{ session: principal.session }]
		: principal.kind === "owner"
			? [{ owners: true }]
			: principal.kind === "worker"
				? [{ session: principal.session }]
				: [];

const S1: TestPrincipal = { kind: "guest", session: "S1" };

/** A host-lifetime type whose activation waits for an open: `load` waits for it (the start barrier). */
const Barrier = local("app.barrier", { version: 1, params: {}, members: { n: int() } });

/** A guest's variant: its `wait` method's index. */
const { wait } = wireNames(Notes, "reader").methods as { wait: number };

/** A worker of session S1 serving `Notes` (as `serveNotes`), its parent a raw peer whose holds name their principal. */
async function worker(setup: (host: FacetHost<TestPrincipal>) => void = (h) => void serveNotes(h)) {
	const host = createHost<TestPrincipal, Revocation>({
		principal: { kind: "worker", session: "S1" },
		revokedBy,
		onError: () => {},
	});
	await host.load([{ name: "@test/worker", facet: defineFacet<TestPrincipal>(setup) }], context);
	const parent = await rawParent(host);
	return { host, parent };
}

/** Sends a hold of `Notes` for S1 with id `hold`, acting as `principal` (honoured: the peer is the parent). */
function holdAs(peer: RawPeer, hold: number, principal: TestPrincipal, Type: typeof Notes = Notes): void {
	peer.send({
		kind: "hold",
		hold,
		type: Type.name,
		version: Type.version,
		fingerprint: Type.fingerprint,
		params: jsonPart({ session: "S1" }),
		principal,
	});
}

describe("revocation keys", () => {
	it("are computed once per principal object, compared as canonical JSON", async () => {
		let calls = 0;
		const host = createHost<TestPrincipal, { a: number; b: number }>({
			principal: { kind: "server" },
			revokedBy: () => {
				calls++;
				return [{ b: 2, a: 1 }];
			},
			onError: () => {},
		});
		await host.load([{ name: "@test/app", facet: defineFacet<TestPrincipal>((h) => serveNotes(h)) }], context);
		const peer = await rawParent(host);
		holdAs(peer, 0, S1);
		holdAs(peer, 1, { kind: "guest", session: "S2" });
		await peer.next("bound");
		await peer.next("bound");
		host.revoke({ a: 1, b: 2 }, context);
		host.revoke({ a: 1, b: 3 }, context);
		await transported();
		expect(calls).toBe(2);
		expect((await peer.next("gone")).hold).toBe(0);
		expect((await peer.next("gone")).hold).toBe(1);
	});

	it("keep no principal alive (a WeakMap keyed by the principal the host cached them for)", async () => {
		const cached: WeakRef<TestPrincipal>[] = [];
		const host = createHost<TestPrincipal, Revocation>({
			principal: { kind: "worker", session: "S1" },
			revokedBy: (principal) => {
				// The principal decoded on this host, the cache's key: not the sender's object.
				cached.push(new WeakRef(principal));
				return revokedBy(principal);
			},
			onError: () => {},
		});
		await host.load([{ name: "@test/worker", facet: defineFacet<TestPrincipal>((h) => serveNotes(h)) }], context);
		const parent = await rawParent(host);
		holdAs(parent, 0, { kind: "guest", session: "S9" });
		await parent.next("bound");
		host.revoke({ session: "S1" }, context);
		parent.send({ kind: "release", hold: 0 });
		await transported();
		expect(cached.length).toBeGreaterThan(0);
		await expectCollected(...cached);
		// The cache's owner is still alive and working.
		holdAs(parent, 1, S1);
		await parent.next("bound");
		host.revoke({ session: "S1" }, context);
		expect((await parent.next("gone")).hold).toBe(1);
		await host.close(context);
	});
});

forEachCodec(() => {
	describe("revoke on one host", () => {
		it("ends the principal's objects at once, whatever references remain: each hold gets gone forbidden", async () => {
			const { host, parent } = await worker();
			holdAs(parent, 0, S1);
			holdAs(parent, 1, S1);
			holdAs(parent, 2, { kind: "owner" });
			for (let i = 0; i < 3; i++) await parent.next("bound");
			host.revoke({ session: "S1" }, context);
			await transported();
			const gone = [await parent.next("gone"), await parent.next("gone")];
			expect(gone.map(({ hold }) => hold).sort()).toEqual([0, 1]);
			expect(gone[0]!.error).toEqual({
				kind: "chord",
				error: { code: "forbidden", reason: "revoked", message: "app.notes(S1): revoked" },
			});
			// The owner's hold, the parent link and the local store stay.
			expect(parent.closed).toBe(false);
			expect(parent.kinds()).toEqual([]);
			holdAs(parent, 3, S1);
			expect((await parent.next("bound")).holds[0]!.hold).toBe(3);
		});

		it("aborts running calls (race 2): the handler's context, no result; a call crossing the gone is ignored", async () => {
			let probe: ReturnType<typeof serveNotes> | undefined;
			const { host, parent } = await worker((h) => {
				probe = serveNotes(h);
			});
			holdAs(parent, 0, S1);
			await parent.next("bound");
			parent.send({ kind: "call", call: 0, hold: 0, method: wait });
			await transported();
			host.revoke({ session: "S1" }, context);
			expect(probe!.waits[0]!.abortSignal?.reason).toMatchObject({ code: "forbidden" });
			expect((await parent.next("gone")).hold).toBe(0);
			await transported();
			expect(parent.kinds()).toEqual([]);
			parent.send({ kind: "call", call: 1, hold: 0, method: wait });
			await transported();
			expect(parent.kinds()).toEqual([]);
		});

		it("abandons an activation in progress (race 1): its open's context is aborted, its holders get gone", async () => {
			const Slow = remote("app.slow", { version: 1, params: {}, variants: { v: { state: { n: int() } } } });
			const aborted: unknown[] = [];
			const { host, parent } = await worker((h) =>
				h.serve(Slow, (_, _principal, self) => {
					self.open(
						(opening) =>
							new Promise((_, reject) =>
								opening.abortSignal?.addEventListener("abort", () => {
									aborted.push(opening.abortSignal?.reason);
									reject(opening.abortSignal?.reason);
								}),
							),
						() => {},
					);
					return { variant: "v", members: { n: constant(1) } };
				}),
			);
			parent.send({
				kind: "hold",
				hold: 0,
				type: Slow.name,
				version: Slow.version,
				fingerprint: Slow.fingerprint,
				params: "{}",
				principal: S1,
			});
			await transported();
			host.revoke({ session: "S1" }, context);
			expect((await parent.next("gone")).error).toMatchObject({ kind: "chord", error: { code: "forbidden" } });
			expect(aborted).toMatchObject([{ code: "forbidden" }]);
		});

		it("never revokes the host's own principal", async () => {
			const { host } = await worker();
			const own = await host.get(Notes, { session: "S1" }, context);
			host.revoke({ session: "S1" }, context);
			expect(own.state.value.kind).toBe("live");
			await host.close(context);
		});

		it("ends a hold the parent sent before its revoke while it still waits for load (race 3): gone, never bound", async () => {
			for (const delayed of [false, true]) {
				// A worker connects before it loads (W6); a load can wait for an activation (the start barrier).
				const opened = Promise.withResolvers<void>();
				const host = createHost<TestPrincipal, Revocation>({
					principal: { kind: "worker", session: "S1" },
					revokedBy,
					onError: () => {},
				});
				const parent = await rawParent(host);
				const facet = defineFacet<TestPrincipal>((h) => {
					serveNotes(h);
					if (delayed) {
						h.serve(Barrier, (_params, self) => {
							self.open(
								() => opened.promise,
								() => {},
							);
							return { n: constant(0) };
						});
					}
				});
				const loading = host.load([{ name: "@test/worker", facet }], context);
				holdAs(parent, 0, S1);
				parent.send({ kind: "revoke", revocation: { session: "S1" } });
				await transported();
				opened.resolve();
				await loading;
				await transported();
				expect(await parent.next("gone")).toMatchObject({
					hold: 0,
					error: { kind: "chord", error: { code: "forbidden", reason: "revoked" } },
				});
				expect(parent.kinds()).toEqual([]);
				expect(host.references(Notes).value).toEqual([]);
				await host.close(context);
			}
		});

		it("ends a relayed hold of the principal still waiting for its route's link: never held there", async () => {
			const host = createHost<TestPrincipal, Revocation>({
				principal: { kind: "worker", session: "S0" },
				revokedBy,
				onError: () => {},
			});
			const resolving = Promise.withResolvers<void>();
			const routed: RawPeer[] = [];
			host.route(
				Session,
				{
					authorize: () => true,
					resolve: async () => {
						await resolving.promise;
						const [a, b] = memoryLinkPair();
						routed.push(new RawPeer(b));
						return { link: a, principal: { kind: "worker", session: "S1" }, codec: testCodec() };
					},
				},
				context,
			);
			await host.load([], context);
			const parent = await rawParent(host);
			const { name: type, version, fingerprint } = PlacedNotes;
			const address = { kind: "session", params: { id: "S1" } };
			parent.send({
				kind: "hold",
				hold: 0,
				type,
				version,
				fingerprint,
				params: jsonPart({ session: "S1" }),
				address,
				principal: S1,
			});
			await transported();
			parent.send({ kind: "revoke", revocation: { session: "S1" } });
			expect(await parent.next("gone")).toMatchObject({
				hold: 0,
				error: { kind: "chord", error: { code: "forbidden", reason: "revoked" } },
			});
			resolving.resolve();
			await transported();
			await transported();
			expect(routed.flatMap((peer) => peer.received.filter(({ kind }) => kind === "hold"))).toEqual([]);
			await host.close(context);
		});

		it("binds a hold made for a revoked principal, then the parent's revoke after it ends it (race 3, R10's window)", async () => {
			const { host, parent } = await worker();
			holdAs(parent, 0, S1);
			await parent.next("bound");
			// The parent's revoke follows the hold on the same link, so it reaches the worker after it.
			parent.send({ kind: "revoke", revocation: { session: "S1" } });
			expect((await parent.next("gone")).error).toMatchObject({ kind: "chord", error: { code: "forbidden" } });
			await host.close(context);
		});
	});

	describe("links and revoke messages", () => {
		it("closes the child links whose principal it revokes, never the parent link", async () => {
			const host = createHost<TestPrincipal, Revocation>({
				principal: { kind: "server" },
				revokedBy,
				onError: () => {},
			});
			await host.load([], context);
			const peers = [S1, { kind: "guest", session: "S2" } as const, S1].map((principal) => {
				const [a, b] = memoryLinkPair();
				host.accept(a, { principal, codec: testCodec() }, context);
				return new RawPeer(b);
			});
			const parent = await rawParent(host);
			host.revoke({ session: "S1" }, context);
			await transported();
			// Two tabs of one grant: both links close (race 4).
			expect(peers.map(({ closed }) => closed)).toEqual([true, false, true]);
			expect(parent.closed).toBe(false);
			// A revocation is no message for a child, nor for the parent.
			expect(peers[1]!.kinds()).toEqual(["hello"]);
			expect(parent.kinds()).toEqual([]);
		});

		it("ignores a revoke from a child link (race 6)", async () => {
			const host = createHost<TestPrincipal, Revocation>({
				principal: { kind: "server" },
				revokedBy,
				onError: () => {},
			});
			await host.load([{ name: "@test/app", facet: defineFacet<TestPrincipal>((h) => serveNotes(h)) }], context);
			const [a, b] = memoryLinkPair();
			host.accept(a, { principal: S1, codec: testCodec() }, context);
			const child = new RawPeer(b);
			await child.next("hello");
			holdAs(child, 0, S1);
			await child.next("bound");
			child.send({ kind: "revoke", revocation: { session: "S1" } });
			await transported();
			expect(child.closed).toBe(false);
			expect(child.kinds()).toEqual([]);
		});

		it("sends revoke on every route link, and on none made later (race 5: nothing is replayed)", async () => {
			const workers: RawPeer[] = [];
			const relay = await relayed({ resolve: rawWorkers(workers) });
			const server = relay.server as unknown as Host<TestPrincipal, Revocation>;
			relay.tab.hold(PlacedNotes, { session: "S1" }, context);
			await transported();
			server.revoke({ session: "S7" }, context);
			await transported();
			expect(workers[0]!.received.filter(({ kind }) => kind === "revoke")).toEqual([
				{ kind: "revoke", revocation: { session: "S7" } },
			]);
			relay.tab.hold(PlacedNotes, { session: "S2" }, context);
			await transported();
			expect(workers[1]!.received.some(({ kind }) => kind === "revoke")).toBe(false);
		});
	});
});

describe("GC of revoked objects", () => {
	it("keeps no revoked object, however many references its holders still have", async () => {
		const { host, refs, parent } = await (async () => {
			const { host, parent } = await worker();
			const made = objects.length;
			holdAs(parent, 0, S1);
			await parent.next("bound");
			const refs = objects.slice(made);
			expect(refs.length).toBeGreaterThan(0);
			host.revoke({ session: "S1" }, context);
			await parent.next("gone");
			return { host, refs, parent };
		})();
		await expectCollected(...refs.filter((ref: WeakRef<ChordObject>) => ref.deref()?.served.kind === "remote"));
		expect(parent.closed).toBe(false);
		await host.close(context);
	});
});

describe("revocation across a relay", () => {
	it("closes a revoked tab's link at the server and ends its objects on the worker", async () => {
		const relay = await relayed({ tab: S1, revokedBy });
		const notes = relay.tab.hold(PlacedNotes, { session: "S1" }, context);
		await transported();
		await transported();
		expect(notes.state.value.kind).toBe("live");
		const worker = relay.workers.get("session|S1")!;
		const present = worker.references(PlacedNotes);
		expect(present.value).toHaveLength(1);
		const server = relay.server as unknown as Host<TestPrincipal, Revocation>;
		server.revoke({ session: "S1" }, context);
		await transported();
		await transported();
		// The tab's link closed: its reference waits for a new link, its holds on the worker are released.
		expect(notes.state.value.kind).toBe("loading");
		expect(present.value).toEqual([]);
	});

	it("ends the worker's objects of the principal through the revoke message alone; the relay forwards their gone", async () => {
		// The server's own revokedBy names no guest: its tab link stays, only the worker applies the revocation.
		const relay = await relayed({ tab: S1, revokedBy, serverRevokedBy: () => [] });
		const notes = relay.tab.hold(PlacedNotes, { session: "S1" }, context);
		await transported();
		await transported();
		expect(notes.state.value.kind).toBe("live");
		const server = relay.server as unknown as Host<TestPrincipal, Revocation>;
		server.revoke({ session: "S1" }, context);
		await transported();
		await transported();
		expect(notes.state.value.kind).toBe("ended");
		expect(relay.workers.get("session|S1")!.references(PlacedNotes).value).toEqual([]);
		expect(relay.errors.tab).toEqual([]);
		// The tab's link stayed open: a new hold binds.
		const again = await relay.tab.get(PlacedNotes, { session: "S1" }, context);
		expect(again.state.value.kind).toBe("live");
	});
});
