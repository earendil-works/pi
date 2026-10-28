// Tests of presence (§19): \`host.references(Type)\`, its entries and incarnations, its batches (a link drop as a departure,
// one discovered while a commit sends lands in the next batch), derives over it, its cost and GC.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, local, remote, str } from "../../../src/next/contracts/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";
import { type Link, memoryLinkPair } from "../../../src/next/link/index.ts";
import { jsonPart } from "../../../src/next/link/internal.ts";
import { Hold } from "../../../src/next/remote/hold.ts";
import { constant } from "../../../src/next/state/index.ts";
import {
	addNote,
	delivered,
	expectCollected,
	framesOf,
	incarnationOf,
	instancesOf,
	linked,
	NoteStore,
	Notes,
	PlacedNotes,
	RawPeer,
	relayed,
	serveNotes,
	type TestPrincipal,
	testCodec,
	transported,
	wireNames,
} from "../support.ts";

/** Every hold started in this file, weakly. */
const holds = instancesOf(Hold, "start");

describe("host.references", () => {
	it("lists every reference with the object's params, its principal and its incarnation", async () => {
		const { server, client } = await linked((h) => void serveNotes(h), { child: { kind: "guest", session: "S1" } });
		const notes = server.references(Notes);
		expect(notes.value).toEqual([]);
		await client.get(Notes, { session: "S1" }, context);
		const own = await server.get(Notes, { session: "S2" }, context);
		expect(notes.value).toEqual([
			{ params: { session: "S1" }, principal: { kind: "guest", session: "S1" }, incarnation: incarnationOf(client) },
			{ params: { session: "S2" }, principal: { kind: "server" }, incarnation: incarnationOf(server) },
		]);
		// A local type's entries have no principal: the store is referenced by both views.
		expect(server.references(NoteStore).value).toEqual([
			{ params: { session: "S1" }, incarnation: incarnationOf(server) },
			{ params: { session: "S2" }, incarnation: incarnationOf(server) },
		]);
		own.release();
		expect(notes.value).toHaveLength(1);
	});

	it("is made for the first ask with the references that exist then, and kept", async () => {
		const { server, client } = await linked((h) => void serveNotes(h));
		await client.get(Notes, { session: "S1" }, context);
		const notes = server.references(Notes);
		expect(notes.value).toHaveLength(1);
		expect(server.references(Notes)).toBe(notes);
	});

	it("changes in the batch where a reference binds or ends: a watch gets one splice per change", async () => {
		const { server, client } = await linked((h) => void serveNotes(h));
		const watch = await server.references(Notes).watch(context);
		const frames = framesOf(watch);
		const one = await client.get(Notes, { session: "S1" }, context);
		await client.get(Notes, { session: "S2" }, context);
		one.release();
		await transported();
		await delivered();
		const incarnation = incarnationOf(client);
		const entry = (session: string) => ({ params: { session }, principal: { kind: "owner" }, incarnation });
		expect(frames.map(([, ops]) => ops)).toEqual([
			[["p", [], 0, 0, [entry("S1")]]],
			[["p", [], 1, 0, [entry("S2")]]],
			[["p", [], 0, 1, []]],
		]);
		expect(frames.at(-1)![0]).toEqual([entry("S2")]);
	});

	it("feeds derives in factories: viewers per session, a link drop a departure in its batch (race 9)", async () => {
		const Viewers = local("app.viewers", { version: 1, params: { session: str() }, members: { count: int() } });
		const Shown = remote("app.shown", {
			version: 1,
			params: { session: str() },
			variants: { v: { state: { here: int() } } },
		});
		const server = createHost<TestPrincipal>({ principal: { kind: "server" }, onError: () => {} });
		await server.load(
			[
				{
					name: "@test/app",
					facet: defineFacet<TestPrincipal>((host) => {
						host.serve(Shown, () => ({ variant: "v", members: { here: constant(1) } }));
						host.serve(Viewers, ({ session }, self) => ({
							count: self.derive(
								[host.references(Shown)],
								([refs]) => refs.filter((ref) => ref.params.session === session).length,
							),
						}));
					}),
				},
			],
			context,
		);
		const viewers = await server.get(Viewers, { session: "S1" }, context);
		const counts = framesOf(await viewers.count.watch(context));
		const tabs = await Promise.all(
			[0, 1].map(async () => {
				const tab = createHost<TestPrincipal>({ onError: () => {} });
				await tab.load([], context);
				const [a, b] = memoryLinkPair();
				server.accept(a, { principal: { kind: "owner" } }, context);
				tab.connect(b, { principal: { kind: "server" } }, context);
				return { tab, link: a };
			}),
		);
		await Promise.all(tabs.map(({ tab }) => tab.get(Shown, { session: "S1" }, context)));
		await tabs[0]!.tab.get(Shown, { session: "S2" }, context);
		expect(viewers.count.value).toBe(2);
		tabs[1]!.link.close();
		// The departure is in the batch of the link's close: the derive has it at once.
		expect(viewers.count.value).toBe(1);
		await delivered();
		expect(counts.at(-1)![0]).toBe(1);
	});

	it("puts a departure discovered while a commit sends into the next batch: one state message per commit (race 9)", async () => {
		const Viewed = remote("app.viewed", {
			version: 1,
			params: { session: str() },
			variants: { v: { state: { count: int(), viewers: int() } } },
		});
		const server = createHost<TestPrincipal>({ principal: { kind: "server" }, onError: () => {} });
		const facet = defineFacet<TestPrincipal>((host) => {
			serveNotes(host);
			host.serve(Viewed, ({ session }, _principal, self) => {
				const store = self.get(NoteStore, { session });
				const count = self.derive([store.list], ([list]) => list.length);
				const viewers = self.derive([host.references(Viewed)], ([refs]) => refs.length);
				return { variant: "v", members: { count, viewers } };
			});
		});
		await server.load([{ name: "@test/app", facet }], context);
		const names = wireNames(Viewed, "v").state as { count: number; viewers: number };
		/** A raw tab; its server end closes while it sends, once `drop.armed` (a transport failing on send). */
		const tab = (drop?: { armed: boolean }) => {
			const [a, b] = memoryLinkPair();
			const end = drop === undefined ? a : closingOnSend(a, drop);
			server.accept(end, { principal: { kind: "owner" }, codec: testCodec() }, context);
			const peer = new RawPeer(b);
			const { name: type, version, fingerprint } = Viewed;
			peer.send({ kind: "hold", hold: 0, type, version, fingerprint, params: jsonPart({ session: "S1" }) });
			return peer;
		};
		const drop = { armed: false };
		// The dropped tab binds first, so its link sends (and fails) before the kept one's in the commit's flushes.
		const dropped = tab(drop);
		await dropped.next("bound");
		const kept = tab();
		await kept.next("bound");
		await transported();
		kept.received.length = 0;
		drop.armed = true;
		await addNote(server, "S1", "x");
		await transported();
		const states = kept.received.filter((message) => message.kind === "state");
		const changed = states.map(({ holds }) => holds.flatMap(({ members }) => members.map(({ member }) => member)));
		// The commit's message carries the commit (the count); the departure is the next batch's (the viewers).
		expect(changed).toEqual([[names.count], [names.viewers]]);
		expect(dropped.closed).toBe(true);
	});

	it("completes a hold's bookkeeping before its presence entry publishes: a link closing then leaks nothing", async () => {
		const Viewed = remote("app.viewed", {
			version: 1,
			params: {},
			variants: { v: { state: { viewers: int() } } },
		});
		const server = createHost<TestPrincipal>({ principal: { kind: "server" }, onError: () => {} });
		const facet = defineFacet<TestPrincipal>((host) => {
			host.serve(
				Viewed,
				(_params, _principal, self) => ({
					variant: "v",
					members: { viewers: self.derive([host.references(Viewed)], ([refs]) => refs.length) },
				}),
				{ linger: 60_000 },
			);
		});
		await server.load([{ name: "@test/app", facet }], context);
		const [a, b] = memoryLinkPair();
		const drop = { armed: false };
		server.accept(closingOnSend(a, drop), { principal: { kind: "owner" }, codec: testCodec() }, context);
		const peer = new RawPeer(b);
		const { name: type, version, fingerprint } = Viewed;
		peer.send({ kind: "hold", hold: 0, type, version, fingerprint, params: "{}" });
		await peer.next("bound");
		peer.send({ kind: "ack" });
		await transported();
		// The second hold's presence entry changes the first's state: sending it closes the link.
		drop.armed = true;
		peer.send({ kind: "hold", hold: 1, type, version, fingerprint, params: "{}" });
		await transported();
		expect(peer.closed).toBe(true);
		expect(server.references(Viewed).value).toEqual([]);
		expect(server.activity.value).toMatchObject({ references: 0, lingering: 1 });
		await server.close(context);
	});

	it("completes a release's bookkeeping before its departure publishes: a link closing then leaves no lingering", async () => {
		const Viewed = remote("app.viewed", { version: 1, params: {}, variants: { v: { state: { viewers: int() } } } });
		const server = createHost<TestPrincipal>({ principal: { kind: "server" }, onError: () => {} });
		const facet = defineFacet<TestPrincipal>((host) => {
			host.serve(
				Viewed,
				(_params, _principal, self) => ({
					variant: "v",
					members: { viewers: self.derive([host.references(Viewed)], ([refs]) => refs.length) },
				}),
				{ linger: 50 },
			);
		});
		await server.load([{ name: "@test/app", facet }], context);
		const [a, b] = memoryLinkPair();
		const drop = { armed: false };
		server.accept(closingOnSend(a, drop), { principal: { kind: "owner" }, codec: testCodec() }, context);
		const peer = new RawPeer(b);
		const { name: type, version, fingerprint } = Viewed;
		for (const hold of [0, 1]) {
			peer.send({ kind: "hold", hold, type, version, fingerprint, params: "{}" });
			await peer.next("bound");
			peer.send({ kind: "ack" });
		}
		await transported();
		// The first release changes the second hold's state: sending it closes the link, which releases the second.
		drop.armed = true;
		peer.send({ kind: "release", hold: 0 });
		await transported();
		expect(peer.closed).toBe(true);
		expect(server.activity.value).toMatchObject({ references: 0, lingering: 1 });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(server.references(Viewed).value).toEqual([]);
		expect(server.activity.value).toMatchObject({ references: 0, lingering: 0 });
		await server.close(context);
	});

	it("removes a bulk departure with one list and one splice op per entry, in one frame (a revoke of many holds)", async () => {
		const server = createHost<TestPrincipal, { session: string }>({
			principal: { kind: "server" },
			revokedBy: (principal) => (principal.kind === "guest" ? [{ session: principal.session }] : []),
			onError: () => {},
		});
		await server.load([{ name: "@test/app", facet: defineFacet<TestPrincipal>((h) => void serveNotes(h)) }], context);
		const [a, b] = memoryLinkPair();
		server.accept(a, { principal: { kind: "guest", session: "S1" }, codec: testCodec() }, context);
		const peer = new RawPeer(b);
		const { name: type, version, fingerprint } = Notes;
		for (let hold = 0; hold < 4; hold++) {
			peer.send({ kind: "hold", hold, type, version, fingerprint, params: jsonPart({ session: "S1" }) });
		}
		await transported();
		const references = server.references(Notes);
		const frames = framesOf(await references.watch(context));
		expect(references.value).toHaveLength(4);
		server.revoke({ session: "S1" }, context);
		await delivered();
		expect(frames.map(([, ops]) => ops)).toEqual([Array(4).fill(["p", [], 0, 1, []])]);
		expect(frames[0]![0]).toEqual([]);
	});

	it("counts two tabs through a relay as two incarnations on the worker", async () => {
		const relay = await relayed();
		const second = createHost<TestPrincipal>({ onError: () => {} });
		await second.load([], context);
		const [a, b] = memoryLinkPair();
		relay.server.accept(a, { principal: { kind: "owner" } }, context);
		second.connect(b, { principal: { kind: "server" } }, context);
		await relay.tab.get(PlacedNotes, { session: "S1" }, context);
		await second.get(PlacedNotes, { session: "S1" }, context);
		const worker = relay.workers.get("session|S1")!;
		const incarnations = worker.references(PlacedNotes).value.map(({ incarnation }) => incarnation);
		expect(incarnations).toEqual([incarnationOf(relay.tab), incarnationOf(second)]);
	});

	it("has no entries for lingering objects", async () => {
		const Kept = remote("app.kept", { version: 1, params: {}, variants: { v: { state: { n: int() } } } });
		const { server, client } = await linked((h) =>
			h.serve(Kept, () => ({ variant: "v", members: { n: constant(1) } }), { linger: 60_000 }),
		);
		const kept = await client.get(Kept, {}, context);
		const references = server.references(Kept);
		expect(references.value).toHaveLength(1);
		kept.release();
		await transported();
		expect(references.value).toEqual([]);
		expect(server.activity.value.lingering).toBe(1);
		await server.close(context);
	});

	it("keeps no released reference (GC)", async () => {
		const { server, refs } = await (async () => {
			const { server, client } = await linked((h) => void serveNotes(h));
			const references = server.references(Notes);
			const held = holds.length;
			const notes = await client.get(Notes, { session: "S1" }, context);
			expect(references.value).toHaveLength(1);
			const refs = holds.slice(held);
			notes.release();
			await transported();
			expect(references.value).toEqual([]);
			return { server, refs };
		})();
		await expectCollected(...refs);
		expect(server.references(Notes).value).toEqual([]);
	});
});

/** `link`, closing itself on a send once `drop.armed`, as a transport whose send fails. */
function closingOnSend(link: Link, drop: { readonly armed: boolean }): Link {
	return {
		send: (message) => (drop.armed ? link.close() : link.send(message)),
		onMessage: (listener) => link.onMessage(listener),
		close: () => link.close(),
		onClose: (listener) => link.onClose(listener),
	};
}
