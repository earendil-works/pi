import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, local, method, remote, str } from "../../../src/next/contracts/index.ts";
import { createHost, defineFacet, type FacetHost, type HostError } from "../../../src/next/host/index.ts";
import { type Compression, memoryLinkPair, type PartLimits } from "../../../src/next/link/index.ts";
import { jsonPart } from "../../../src/next/link/internal.ts";
import { constant } from "../../../src/next/state/index.ts";
import { nodeCompression } from "../../../src/next-node/compression.ts";
import {
	addNote,
	countInflated,
	delivered,
	EDITOR,
	forEachCodec,
	framesOf,
	incarnationOf,
	Notes,
	PlacedNotes,
	partValue,
	RAW_PEER,
	RawPeer,
	rawWorkers,
	rejection,
	relayed,
	Session,
	serveNotes,
	type TestPrincipal,
	testCodec,
	transported,
} from "../support.ts";

/** A server type that tells who holds it, and echoes as whom it is called. */
const ServerWho = remote("app.server-who", {
	version: 1,
	params: {},
	variants: { v: { state: { who: str() }, methods: { echo: method(str(), str()) } } },
});

/** A worker type that asks the server, from a handler (`ask`) and from its factory (`who`). */
const Asker = remote("app.asker", {
	version: 1,
	params: { session: str() },
	placement: ({ session }) => Session({ id: session }),
	variants: { v: { state: { who: str() }, methods: { ask: method(str(), str()) } } },
});

/** A worker type that reads another session's notes through the server. */
const Neighbour = remote("app.neighbour", {
	version: 1,
	params: { session: str(), other: str() },
	placement: ({ session }) => Session({ id: session }),
	variants: { v: { state: { count: int() } } },
});

function serveWho(h: FacetHost<TestPrincipal>): void {
	h.serve(ServerWho, (_, principal) => ({
		variant: "v",
		members: { who: constant(principal.kind), echo: async (text, ctx) => `${ctx.principal?.kind}:${text}` },
	}));
}

function serveAsker(h: FacetHost<TestPrincipal>): void {
	h.serve(Asker, (_, _principal, self) => {
		const server = self.get(ServerWho, {});
		return {
			variant: "v",
			members: {
				who: server.who,
				ask: async (text, ctx) => (await ctx.get(ServerWho, {})).echo(text, ctx),
			},
		};
	});
	h.serve(Neighbour, ({ other }, _principal, self) => {
		const notes = self.get(PlacedNotes, { session: other });
		return { variant: "v", members: { count: notes.count } };
	});
}

forEachCodec(() => {
	describe("two-sided links", () => {
		it("carry the server's holds of a worker type and the worker's holds of a server type over one route link", async () => {
			const { tab, routeLinks } = await relayed({ server: serveWho, worker: serveAsker });
			const asker = await tab.get(Asker, { session: "S1" }, context);
			// The worker's factory held `ServerWho` over its parent link, the route link the server made.
			expect(asker.who.value).toBe("worker");
			expect(routeLinks).toHaveLength(1);
		});

		it("carry calls both ways with equal ids: each side's ids are its own", async () => {
			const { tab } = await relayed({ server: serveWho, worker: serveAsker });
			const asker = await tab.get(Asker, { session: "S1" }, context);
			// Server to worker: call 0 on the route link; inside it, worker to server: call 0 the other way.
			expect(await asker.ask("x", context)).toBe("worker:x");
			expect(await Promise.all([asker.ask("a", context), asker.ask("b", context)])).toEqual([
				"worker:a",
				"worker:b",
			]);
		});

		it("let a worker reach another worker through the server", async () => {
			const { tab, workers, resolves } = await relayed({ worker: serveAsker });
			const neighbour = await tab.get(Neighbour, { session: "S1", other: "S2" }, context);
			expect(resolves).toEqual(["session|S1", "session|S2"]);
			await addNote(workers.get("session|S2")!, "S2", "a");
			await transported();
			expect(neighbour.count.value).toBe(1);
		});

		it("apply this host's own messages and forward the tab origin's, each acknowledged by its consumer", async () => {
			const peers: RawPeer[] = [];
			const { tab, server } = await relayed({ resolve: rawWorkers(peers) });
			const own = server.get(PlacedNotes, { session: "S1" }, context);
			await transported();
			const [worker] = peers;
			const first = await worker!.next("hold");
			bindPlaced(worker!, first);
			const relayedHold = tab.get(PlacedNotes, { session: "S1" }, context);
			const second = await worker!.next("hold");
			expect([first.origin, second.origin]).toEqual([undefined, 1]);
			bindPlaced(worker!, second);
			const [serverNotes, tabs] = [await own, await relayedHold];
			await transported();
			worker!.received.length = 0;
			const ops = jsonPart([["r", 5]]);
			for (const { hold, origin } of [first, second]) {
				const from = origin === undefined ? {} : { origin };
				const members = [{ member: EDITOR.state.count!, ops }];
				worker!.send({ kind: "state", ...from, holds: [{ hold, members, failed: [], retired: [] }] });
			}
			await transported();
			expect(serverNotes.count.value).toBe(5);
			expect(tabs.count.value).toBe(5);
			expect(worker!.received).toEqual([{ kind: "ack" }, { kind: "ack", origin: 1 }]);
		});
	});

	describe("principals on holds (section 4's table)", () => {
		/** A server serving a guest-facing gateway and a local view, both reaching `PlacedNotes` on a raw worker. */
		async function principals(tab: TestPrincipal = { kind: "guest", session: "S1" }) {
			const peers: RawPeer[] = [];
			const Gateway = remote("app.gateway", {
				version: 1,
				params: {},
				variants: { v: { state: { n: int() }, methods: { open: method(str(), int()) } } },
			});
			// With params: not activated by `load`, which would wait for the raw worker.
			const View = local("app.view", { version: 1, params: { id: int() }, members: { n: int() } });
			const relay = await relayed({
				tab,
				resolve: rawWorkers(peers),
				server: (h) => {
					h.serve(Gateway, (_, _principal, self) => {
						// `self.get` in a remote object: the object's principal, this host's incarnation.
						const own = self.get(PlacedNotes, { session: "own" });
						return {
							variant: "v",
							members: {
								n: own.count,
								// `ctx.get` in a handler: the caller's principal and incarnation.
								open: async (session, ctx) => (await ctx.get(PlacedNotes, { session })).count.value,
							},
						};
					});
					h.serve(View, (_, self) => ({ n: self.get(PlacedNotes, { session: "view" }).count }));
				},
			});
			return { ...relay, peers, Gateway, View };
		}

		/** The next hold the raw worker of `peers[index]` receives, bound at once, with whom it acts for. */
		async function nextHold(peers: RawPeer[], index = 0) {
			for (let tries = 0; peers[index] === undefined && tries < 10; tries++) await transported();
			const hold = await peers[index]!.next("hold");
			bindPlaced(peers[index]!, hold);
			const { session } = partValue(hold.params) as { session: string };
			return { session, principal: hold.principal, incarnation: hold.incarnation };
		}

		it("a relayed hold acts as the link's principal: a forged principal from a tab is ignored (race 9)", async () => {
			const { server, peers } = await principals();
			const [a, b] = memoryLinkPair();
			server.accept(a, { principal: { kind: "guest", session: "S1" }, codec: testCodec() }, context);
			const tab = new RawPeer(b);
			tab.send({
				kind: "hold",
				hold: 0,
				type: PlacedNotes.name,
				version: PlacedNotes.version,
				fingerprint: PlacedNotes.fingerprint,
				params: jsonPart({ session: "S1" }),
				address: { kind: "session", params: { id: "S1" } },
				principal: { kind: "owner" },
			});
			expect(await nextHold(peers)).toEqual({
				session: "S1",
				principal: { kind: "guest", session: "S1" },
				incarnation: RAW_PEER,
			});
		});

		it("a hold relayed over a parent path names nobody: a child's principal and incarnation stay behind", async () => {
			const worker = createHost<TestPrincipal>({ principal: { kind: "worker", session: "S1" }, onError: () => {} });
			await worker.load([], context);
			const [up, parentEnd] = memoryLinkPair();
			worker.connect(up, { principal: { kind: "server" }, codec: testCodec() }, context);
			const parent = new RawPeer(parentEnd);
			const [a, b] = memoryLinkPair();
			worker.accept(a, { principal: { kind: "guest", session: "S1" }, codec: testCodec() }, context);
			const child = new RawPeer(b);
			child.send({
				kind: "hold",
				hold: 0,
				type: PlacedNotes.name,
				version: PlacedNotes.version,
				fingerprint: PlacedNotes.fingerprint,
				params: jsonPart({ session: "S1" }),
				address: { kind: "session", params: { id: "S1" } },
				principal: { kind: "owner" },
				incarnation: RAW_PEER,
			});
			const relayedHold = await parent.next("hold");
			expect(relayedHold).toMatchObject({ hold: 0, origin: 1, type: PlacedNotes.name });
			expect("principal" in relayedHold).toBe(false);
			expect("incarnation" in relayedHold).toBe(false);
			await worker.close(context);
		});

		it("host.get through a route acts as the host: its principal and incarnation", async () => {
			const { server, peers } = await principals();
			void server.get(PlacedNotes, { session: "S1" }, context);
			expect(await nextHold(peers)).toEqual({
				session: "S1",
				principal: { kind: "server" },
				incarnation: incarnationOf(server),
			});
		});

		it("ctx.get in a guest's call acts as the guest, with the tab's incarnation (race 10)", async () => {
			const { tab, peers, Gateway } = await principals();
			const got = tab.get(Gateway, {}, context);
			expect(await nextHold(peers)).toMatchObject({ session: "own" });
			const opened = (await got).open("S1", context);
			// Another address: another worker.
			expect(await nextHold(peers, 1)).toEqual({
				session: "S1",
				principal: { kind: "guest", session: "S1" },
				incarnation: incarnationOf(tab),
			});
			expect(await opened).toBe(0);
		});

		it("self.get in a remote object acts as that object's principal, with this host's incarnation", async () => {
			const { tab, server, peers, Gateway } = await principals();
			tab.hold(Gateway, {}, context);
			expect(await nextHold(peers)).toEqual({
				session: "own",
				principal: { kind: "guest", session: "S1" },
				incarnation: incarnationOf(server),
			});
		});

		it("self.get in a local object acts as the host", async () => {
			const { server, peers, View } = await principals();
			void server.get(View, { id: 1 }, context);
			expect(await nextHold(peers)).toEqual({
				session: "view",
				principal: { kind: "server" },
				incarnation: incarnationOf(server),
			});
		});

		it("two origins with equal principal keys but other incarnations are two upstream holds", async () => {
			const { tab, server, peers } = await principals({ kind: "owner" });
			const other = createHost<TestPrincipal>({ onError: () => {} });
			await other.load([], context);
			const [a, b] = memoryLinkPair();
			server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
			other.connect(b, { principal: { kind: "server" }, codec: testCodec() }, context);
			void tab.get(PlacedNotes, { session: "S1" }, context);
			const first = await nextHold(peers);
			void other.get(PlacedNotes, { session: "S1" }, context);
			const second = await nextHold(peers);
			expect([first, second]).toEqual([
				{ session: "S1", principal: { kind: "owner" }, incarnation: incarnationOf(tab) },
				{ session: "S1", principal: { kind: "owner" }, incarnation: incarnationOf(other) },
			]);
		});

		it("upward is a boundary: a worker's hold of a server type acts as the worker, whoever it serves (race 11)", async () => {
			const { tab } = await relayed({ tab: { kind: "guest", session: "S1" }, server: serveWho, worker: serveAsker });
			const asker = await tab.get(Asker, { session: "S1" }, context);
			expect(await asker.ask("x", context)).toBe("worker:x");
		});
	});

	describe("trusted links", () => {
		it("work as untrusted ones do", async () => {
			const { tab } = await relayed({ trusted: true });
			expect((await tab.get(PlacedNotes, { session: "S1" }, context)).variant).toBe("editor");
		});
	});
});

/** Binds a hold a raw worker received (its id and origin): `PlacedNotes`'s editor variant, no notes. */
function bindPlaced(peer: RawPeer, { hold, origin }: { readonly hold: number; readonly origin?: number }): void {
	const members = [
		{ member: EDITOR.state.notes!, value: "[]" },
		{ member: EDITOR.state.count!, value: "0" },
	];
	const from = origin === undefined ? {} : { origin };
	peer.send({ kind: "bound", ...from, holds: [{ hold, variant: EDITOR.variant, members, failed: [] }] });
}

/** A compressor that counts what it does (`nodeCompression` underneath). */
function counting(): Compression & { deflates: number; inflates: number } {
	const counts = {
		deflates: 0,
		inflates: 0,
		deflate: (bytes: Uint8Array) => {
			counts.deflates++;
			return nodeCompression.deflate(bytes);
		},
		inflate: (bytes: Uint8Array, limit: number) => {
			counts.inflates++;
			return nodeCompression.inflate(bytes, limit);
		},
	};
	return counts;
}

/** A note text large enough that a notes list with it is deflated at its origin. */
const LARGE = "lorem ipsum ".repeat(2000);

/**
 * A server serving `Notes` with `compression`, and a client with its own `compression` (none: it inflates
 * asynchronously), its parent link's limits `limits`.
 */
async function compressing(options: {
	readonly server?: Compression;
	readonly client?: Compression;
	readonly limits?: PartLimits;
}) {
	const errors: HostError[] = [];
	const server = createHost<TestPrincipal>({
		principal: { kind: "server" },
		compression: options.server,
		onError: (error) => errors.push(error),
	});
	await server.load([{ name: "@test/app", facet: defineFacet<TestPrincipal>((h) => void serveNotes(h)) }], context);
	const client = createHost<TestPrincipal>({ compression: options.client, onError: (error) => errors.push(error) });
	await client.load([], context);
	const [a, b] = memoryLinkPair();
	server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
	client.connect(b, { principal: { kind: "server" }, codec: testCodec(), limits: options.limits }, context);
	return { server, client, errors };
}

forEachCodec(() => {
	describe("parts: compression at the origin and limits", () => {
		it("deflate JSON parts above 16 KiB at their origin and inflate them where owned, synchronously; never up a parent link's arguments", async () => {
			const [server, client] = [counting(), counting()];
			const hosts = await compressing({ server, client });
			await addNote(hosts.server, "S1", LARGE);
			const notes = await hosts.client.get(Notes, { session: "S1" }, context);
			if (notes.variant !== "editor") throw new Error("an owner's notes are the editor's");
			expect(notes.notes.value).toEqual([{ text: LARGE }]);
			expect([server.deflates, client.inflates]).toEqual([1, 1]);
			// A large argument goes up the client's parent link uncompressed: child links refuse compressed parts.
			await notes.add({ text: LARGE }, context);
			expect([client.deflates, server.inflates]).toEqual([0, 0]);
			await transported();
			expect(notes.notes.value).toEqual([{ text: LARGE }, { text: LARGE }]);
		});

		it("inflate asynchronously without a compressor: later messages of the link wait, in order", async () => {
			const hosts = await compressing({ server: nodeCompression });
			await addNote(hosts.server, "S1", LARGE);
			const notes = await hosts.client.get(Notes, { session: "S1" }, context);
			expect(notes.notes.value).toEqual([{ text: LARGE }]);
			const counts = framesOf(await notes.count.watch(context));
			// Each commit sends the whole changed list (a derive's diff appends one note): large ones deflated.
			for (let i = 0; i < 5; i++) await addNote(hosts.server, "S1", i % 2 === 0 ? LARGE : "small");
			for (let i = 0; i < 100 && notes.count.value < 6; i++) await new Promise((resolve) => setTimeout(resolve, 5));
			expect(notes.count.value).toBe(6);
			expect(notes.notes.value.map(({ text }) => text.length)).toEqual(
				[LARGE, LARGE, "small", LARGE, "small", LARGE].map((text) => text.length),
			);
			await delivered();
			const seen = counts.map(([count]) => count);
			expect(seen).toEqual([...seen].sort());
		});

		it("fail only the hold of a compressed bomb, on either inflate path (race 11): the link stays", async () => {
			for (const client of [nodeCompression, undefined]) {
				const hosts = await compressing({ server: nodeCompression, client, limits: { decoded: 100_000 } });
				await addNote(hosts.server, "S1", "x".repeat(200_000));
				await addNote(hosts.server, "S2", "small");
				const error = await rejection(hosts.client.get(Notes, { session: "S1" }, context));
				expect(error).toMatchObject({ code: "too_large", reason: "part" });
				const other = await hosts.client.get(Notes, { session: "S2" }, context);
				expect(other.notes.value).toEqual([{ text: "small" }]);
			}
		});

		it("cost nothing for uncompressed messages at a host without a compressor: no inflate, no stream", async () => {
			const inflated = countInflated();
			try {
				const hosts = await compressing({ server: nodeCompression });
				const notes = await hosts.client.get(Notes, { session: "S1" }, context);
				for (let i = 0; i < 5; i++) await addNote(hosts.server, "S1", "small");
				await transported();
				expect(notes.count.value).toBe(5);
				expect(inflated.bytes).toBe(0);
				expect(hosts.errors).toEqual([]);
			} finally {
				inflated.restore();
			}
		});

		it("send every part uncompressed from a host without a compressor", async () => {
			const server = counting();
			const hosts = await compressing({ server });
			const notes = await hosts.client.get(Notes, { session: "S1" }, context);
			if (notes.variant !== "editor") throw new Error("an owner's notes are the editor's");
			await notes.add({ text: LARGE }, context);
			expect(server.inflates).toBe(0);
		});
	});
});
