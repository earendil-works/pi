import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import {
	type Contract,
	type EventSource,
	event,
	int,
	local,
	map,
	method,
	obj,
	remote,
} from "../../src/contracts/index.ts";
import { ChordError } from "../../src/data/index.ts";
import { PendingOps } from "../../src/delta/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { type Ctx, createHost, defineFacet, type FacetHost, type Self } from "../../src/host/index.ts";
import { ChordObject } from "../../src/host/object.ts";
import { type Compression, memoryLinkPair, type PartLimits } from "../../src/link/index.ts";
import { DeflatedPart, jsonPart, type Message } from "../../src/link/internal.ts";
import { nodeCompression } from "../../src/node/compression.ts";
import { ProviderSide } from "../../src/remote/provider.ts";
import { constant } from "../../src/state/index.ts";
import {
	addNote,
	countInflated,
	EDITOR,
	expectCollected,
	failLive,
	forEachCodec,
	instancesOf,
	Match,
	type MatchProbe,
	MatchV2,
	metered,
	Notes,
	type NotesProbe,
	partValue,
	RAW_PEER,
	RawPeer,
	rawLinked,
	Sample,
	SERVER_ADDRESS,
	Server,
	serveMatch,
	serveNotes,
	type TestPrincipal,
	testCodec,
	transported,
	wireNames,
} from "../support.ts";

/** Sends a hold of `Type` (its own version and fingerprint unless overridden), of `origin` when given. */
function hold(
	peer: RawPeer,
	id: number,
	Type: Contract,
	params: unknown,
	override: Partial<Contract> = {},
	origin?: number,
) {
	const { name: type, version, fingerprint } = { ...Type, ...override };
	const from = origin === undefined ? {} : { origin };
	peer.send({
		kind: "hold",
		...from,
		hold: id,
		type,
		version,
		fingerprint,
		params: jsonPart(params),
		address: SERVER_ADDRESS,
	});
}

/** Sends a call of the method at index `method` of the bound variant, with `args` (none when left out). */
function call(peer: RawPeer, id: number, holdId: number, method: number, args?: unknown, origin?: number) {
	const from = origin === undefined ? {} : { origin };
	const payload = args === undefined ? {} : { args: jsonPart(args) };
	peer.send({ kind: "call", ...from, call: id, hold: holdId, method, ...payload });
}

/** A remote type kept per id. */
const Kept = remote("app.kept", {
	version: 1,
	params: { id: int() },
	hostAddress: () => Server(),
	variants: { v: { state: { n: int() } } },
});

/** The wire's indexes of `Notes`'s reader variant. */
const READER = wireNames(Notes, "reader");

const { add, fail, wait } = EDITOR.methods as { add: number; fail: number; wait: number };

/**
 * A server serving `Notes` and a raw consumer peer stamped `child`, with the server's `callWindow` and the link trusted
 * when given.
 */
async function notesServer(
	child: TestPrincipal = { kind: "owner" },
	role: "child" | "parent" = "child",
	options: { readonly callWindow?: number; readonly trusted?: boolean } = {},
) {
	let probe: NotesProbe | undefined;
	const linked = await rawLinked(
		(h) => {
			probe = serveNotes(h);
		},
		{ child, role, ...options },
	);
	return { ...linked, probe: probe! };
}

forEachCodec(() => {
	describe("holds arriving on a link", () => {
		it("bind as the link's principal: bound with the variant and the snapshot", async () => {
			const { peer, server } = await notesServer({ kind: "guest", session: "S1" });
			await addNote(server, "S1", "a");
			hold(peer, 0, Notes, { session: "S1" });
			const [bound] = (await peer.next("bound")).holds;
			expect(bound).toMatchObject({ hold: 0, variant: READER.variant, failed: [] });
			expect(READER.named(bound!.members)).toEqual({ notes: [{ text: "a" }], count: 1 });
		});

		it.each([
			[
				"a type not served here",
				{ type: "app.nope" },
				{ code: "unavailable", message: "app.nope is not served here" },
			],
			[
				"a local type",
				{ type: "app.note-store" },
				{ code: "unavailable", message: "app.note-store is not served here" },
			],
			[
				"another version",
				{ version: 2 },
				{ code: "contract_mismatch", message: "app.notes v2 does not match the served v1" },
			],
			[
				"another fingerprint",
				{ fingerprint: "0000000000000000" },
				{ code: "contract_mismatch", message: "app.notes v1 does not match the served v1" },
			],
		])("keep %s refused, failed { waiting }", async (_, override, error) => {
			const { peer } = await notesServer();
			const { type, ...rest } = override as { type?: string };
			hold(peer, 0, { ...Notes, name: type ?? Notes.name } as Contract, { session: "S1" }, rest);
			const failed = await peer.next("failed");
			expect(failed).toMatchObject({ hold: 0, cause: { kind: "waiting", error: { kind: "chord", error } } });
			// No backoff window: an event (a publication) wakes it.
			expect(failed.retryIn).toBeUndefined();
		});

		it("refuse invalid params with a broken failed", async () => {
			const { peer } = await notesServer();
			hold(peer, 0, Notes, { session: 1 });
			expect(await peer.next("failed")).toMatchObject({
				cause: { kind: "broken", error: { kind: "chord", error: { code: "invalid", reason: "params" } } },
			});
		});

		it("arriving before the publication wait for it, and bind before the start barrier is over", async () => {
			const server = createHost<TestPrincipal>({
				address: Server(),
				principal: { kind: "server" },
				onError: () => {},
			});
			const [a, b] = memoryLinkPair();
			server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
			const peer = new RawPeer(b);
			hold(peer, 0, Notes, { session: "S1" });
			await transported();
			expect(peer.kinds()).toEqual(["hello"]);
			await server.load(
				[{ name: "@test/app", facet: defineFacet<TestPrincipal>((h) => void serveNotes(h)) }],
				context,
			);
			expect((await peer.next("bound")).holds[0]).toMatchObject({ hold: 0, variant: EDITOR.variant });
		});
	});

	describe("calls arriving on a link", () => {
		it("run as the link's principal with the child's incarnation; results and errors go back", async () => {
			const { peer, probe } = await notesServer();
			hold(peer, 0, Notes, { session: "S1" });
			await peer.next("bound");
			call(peer, 0, 0, add, { text: "x" });
			expect(partValue((await peer.next("result")).value!)).toBe(1);
			call(peer, 1, 0, fail, { how: "plugin" });
			expect((await peer.next("error")).error).toEqual({
				kind: "plugin",
				code: "quota",
				message: "too many",
				details: { limit: 1 },
			});
			call(peer, 2, 0, wait);
			await transported();
			expect(probe.waits[0]).toMatchObject({ principal: { kind: "owner" }, incarnation: RAW_PEER });
		});

		it("outside the binding's variant cannot be named: an index past its methods, forged at the wire, closes the link", async () => {
			const { peer, errors } = await notesServer({ kind: "guest", session: "S1" });
			hold(peer, 0, Notes, { session: "S1" });
			await peer.next("bound");
			// The reader variant has one method, `wait`; the editor's `add` has no index in it.
			call(peer, 0, 0, Object.keys(READER.methods).length, { text: "x" });
			await transported();
			expect(peer.closed).toBe(true);
			expect(errors).toMatchObject([{ kind: "protocol_error", error: { message: "hold 0: no method 1" } }]);
		});

		it("check their arguments", async () => {
			const { peer } = await notesServer();
			hold(peer, 0, Notes, { session: "S1" });
			await peer.next("bound");
			call(peer, 0, 0, add, { text: "x", extra: 1 });
			expect((await peer.next("error")).error).toMatchObject({
				kind: "chord",
				error: { code: "invalid", reason: "args" },
			});
		});

		it("before bound are refused not_ready (race 3)", async () => {
			const Slow = remote("app.slow", {
				version: 1,
				params: {},
				hostAddress: () => Server(),
				variants: { v: { state: { n: int() } } },
			});
			const { peer } = await rawLinked((h) =>
				h.serve(Slow, (_, _principal, self) => {
					self.open(
						() => new Promise(() => {}),
						() => {},
					);
					return { variant: "v", members: { n: constant(1) } };
				}),
			);
			hold(peer, 0, Slow, {});
			call(peer, 0, 0, 0);
			expect((await peer.next("error")).error).toMatchObject({ kind: "chord", error: { code: "not_ready" } });
		});

		it("cancelled are aborted and get no reply; a result crossing the cancel is never sent (race 1)", async () => {
			const { peer, probe } = await notesServer();
			hold(peer, 0, Notes, { session: "S1" });
			await peer.next("bound");
			call(peer, 0, 0, wait);
			await transported();
			peer.send({ kind: "abort", call: 0 });
			await transported();
			expect(probe.waits[0]!.abortSignal?.aborted).toBe(true);
			expect(peer.kinds()).toEqual(["hello"]);
		});
	});

	describe("ids", () => {
		it("a link ignores ids it does not know and messages for the other direction", async () => {
			const { peer, errors } = await notesServer();
			peer.send({ kind: "release", hold: 9 });
			peer.send({ kind: "abort", call: 9 });
			call(peer, 0, 9, add, { text: "x" });
			peer.send({ kind: "gone", hold: 9, error: { kind: "chord", error: { code: "released", message: "m" } } });
			await transported();
			expect(peer.closed).toBe(false);
			expect(peer.kinds()).toEqual(["hello"]);
			expect(errors).toEqual([]);
		});

		it("a hold reusing a live id closes the link", async () => {
			const { peer, errors } = await notesServer();
			hold(peer, 0, Notes, { session: "S1" });
			hold(peer, 0, Notes, { session: "S1" });
			await transported();
			expect(peer.closed).toBe(true);
			expect(errors).toMatchObject([{ kind: "protocol_error", error: { message: "hold 0: the id is in use" } }]);
		});

		it("a call reusing a live id closes the link", async () => {
			const { peer } = await notesServer();
			hold(peer, 0, Notes, { session: "S1" });
			await peer.next("bound");
			call(peer, 0, 0, wait);
			call(peer, 0, 0, wait);
			await transported();
			expect(peer.closed).toBe(true);
		});

		it("a message the codec cannot decode closes the link", async () => {
			const { peer } = await notesServer();
			hold(peer, 0, Notes, { session: "S1" });
			await peer.next("bound");
			peer.sendBytes(new Uint8Array([0xff, 0xff]));
			await transported();
			expect(peer.closed).toBe(true);
		});
	});

	describe("one message per link per commit (W1)", () => {
		it("three holds on one link: one state message, one part per hold, one encode each", async () => {
			const { peer, server } = await notesServer();
			for (const id of [0, 1, 2]) hold(peer, id, Notes, { session: "S1" });
			for (const _ of [0, 1, 2]) await peer.next("bound");
			const { context: counting, counts } = await metered();
			const store = await server.get(Notes, { session: "S1" }, context);
			if (store.variant === "editor") await store.add({ text: "a" }, counting);
			await transported();
			const states = peer.received.filter((message) => message.kind === "state");
			expect(states).toHaveLength(1);
			expect(states[0]).toMatchObject({ holds: [{ hold: 0 }, { hold: 1 }, { hold: 2 }] });
			expect(counts()["chord.link.encodes"]).toBe(3);
			// No validation or walk of state on the provider: only the argument checks of `add` and the store's `add`.
			expect(counts()["chord.data.validations"]).toBe(2);
			expect(counts()["chord.data.walks"]).toBeUndefined();
		});

		it("a derive travels with its source in the same part", async () => {
			const { peer, server } = await notesServer();
			hold(peer, 0, Notes, { session: "S1" });
			await peer.next("bound");
			await addNote(server, "S1", "a");
			const state = await peer.next("state");
			expect(Object.keys(EDITOR.named(state.holds[0]!.members)).sort()).toEqual(["count", "notes"]);
		});

		it("two links: one message each; when one closes, the other keeps updating (race 8)", async () => {
			const { peer, server } = await notesServer();
			const [a, b] = memoryLinkPair();
			server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
			const other = new RawPeer(b);
			hold(peer, 0, Notes, { session: "S1" });
			hold(other, 0, Notes, { session: "S1" });
			await peer.next("bound");
			await other.next("bound");
			await addNote(server, "S1", "a");
			await peer.next("state");
			await other.next("state");
			peer.close();
			await transported();
			await addNote(server, "S1", "b");
			const next = await other.next("state");
			expect(Object.keys(EDITOR.named(next.holds[0]!.members)).sort()).toEqual(["count", "notes"]);
		});
	});

	describe("races at the provider", () => {
		/** Serves `Kept`, recording each factory run and each native close. */
		function serveKept(h: Parameters<Parameters<typeof rawLinked>[0]>[0], events: string[]) {
			h.serve(Kept, ({ id }, _principal, self) => {
				events.push(`factory ${id}`);
				self.open(
					async () => null,
					(_value, reason) => void events.push(`close ${reason.kind}`),
				);
				return { variant: "v", members: { n: constant(id) } };
			});
		}

		it("a new hold and the old one's release in one turn hand the object over without ending it (R18)", async () => {
			const events: string[] = [];
			const { peer } = await rawLinked((h) => serveKept(h, events));
			hold(peer, 0, Kept, { id: 1 });
			await peer.next("bound");
			hold(peer, 1, Kept, { id: 1 });
			peer.send({ kind: "release", hold: 0 });
			expect((await peer.next("bound")).holds[0]).toMatchObject({ hold: 1 });
			expect(events).toEqual(["factory 1"]);
		});

		it("a hold released right after it was sent keeps no object", async () => {
			const events: string[] = [];
			const { peer } = await rawLinked((h) => serveKept(h, events));
			hold(peer, 0, Kept, { id: 1 });
			await Promise.resolve();
			peer.send({ kind: "release", hold: 0 });
			await transported();
			// The object ended: a new hold makes a new one.
			hold(peer, 1, Kept, { id: 1 });
			await peer.next("bound");
			expect(events.filter((event) => event.startsWith("factory"))).toEqual(["factory 1", "factory 1"]);
		});

		it("a hold released while it waits for load takes nothing once load resolves", async () => {
			const events: string[] = [];
			const server = createHost<TestPrincipal>({
				address: Server(),
				principal: { kind: "server" },
				onError: () => {},
			});
			const [a, b] = memoryLinkPair();
			server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
			const peer = new RawPeer(b);
			await transported();
			hold(peer, 0, Kept, { id: 1 });
			await Promise.resolve();
			peer.send({ kind: "release", hold: 0 });
			await transported();
			await server.load(
				[{ name: "@test/app", facet: defineFacet<TestPrincipal>((h) => serveKept(h, events)) }],
				context,
			);
			await transported();
			expect(events).toEqual([]);
		});

		it("a release while activating unholds; bound is never sent (race 6)", async () => {
			const Slow = remote("app.slow", {
				version: 1,
				params: { id: int() },
				hostAddress: () => Server(),
				variants: { v: { state: { n: int() } } },
			});
			const aborted: string[] = [];
			const { peer } = await rawLinked((h) =>
				h.serve(Slow, ({ id }, _principal, self) => {
					self.open(
						(ctx) =>
							new Promise((resolve) =>
								ctx.abortSignal?.addEventListener("abort", () => resolve(aborted.push(`${id}`))),
							),
						() => {},
					);
					return { variant: "v", members: { n: constant(id) } };
				}),
			);
			hold(peer, 0, Slow, { id: 1 });
			await transported();
			peer.send({ kind: "release", hold: 0 });
			await transported();
			expect(aborted).toEqual(["1"]);
			expect(peer.kinds()).toEqual(["hello"]);
		});

		it("a hold while the previous instance of its identity tears down waits for it (race 7)", async () => {
			const Closing = remote("app.closing", {
				version: 1,
				params: { id: int() },
				hostAddress: () => Server(),
				variants: { v: { state: { n: int() } } },
			});
			const events: string[] = [];
			let finish: () => void = () => {};
			const { peer } = await rawLinked((h) =>
				h.serve(Closing, ({ id }, _principal, self) => {
					self.open(
						async () => void events.push("open"),
						() =>
							new Promise<void>((resolve) => {
								events.push("closing");
								finish = () => {
									events.push("closed");
									resolve();
								};
							}),
					);
					return { variant: "v", members: { n: constant(id) } };
				}),
			);
			hold(peer, 0, Closing, { id: 1 });
			await peer.next("bound");
			peer.send({ kind: "release", hold: 0 });
			hold(peer, 1, Closing, { id: 1 });
			await transported();
			expect(events).toEqual(["open", "closing"]);
			finish();
			await peer.next("bound");
			expect(events).toEqual(["open", "closing", "closed", "open"]);
		});

		it("a commit right after the binding continues exactly from the snapshot (race 2)", async () => {
			const { peer, server } = await notesServer();
			hold(peer, 0, Notes, { session: "S1" });
			const adding = addNote(server, "S1", "a");
			const [bound] = (await peer.next("bound")).holds;
			await adding;
			await transported();
			const snapshot = EDITOR.named(bound!.members) as { notes: unknown[] };
			const states = peer.received.filter((message) => message.kind === "state");
			const added = states.flatMap((message) => (EDITOR.named(message.holds[0]!.members).notes ?? []) as unknown[]);
			expect(snapshot.notes.length + added.length).toBe(1);
		});

		it("closing a link during a batch drops its state message and releases its holds (race 9)", async () => {
			const Counter = remote("app.counter", {
				version: 1,
				params: { id: int() },
				hostAddress: () => Server(),
				variants: { v: { state: { n: int(), seen: int() }, methods: { bump: method() } } },
			});
			const N = defineState("n", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });
			// Called inside the batch, from a derive the hold follows.
			let during: () => void = () => {};
			const ends: string[] = [];
			const { server, errors } = await rawLinked((h) =>
				h.serve(Counter, ({ id }, _principal, self) => {
					const n = self.state(N);
					self.open(
						async () => null,
						() => void ends.push(`counter ${id} ended`),
					);
					return {
						variant: "v",
						members: {
							n: self.derive([n], ([{ n }]) => n),
							seen: self.derive([n], ([{ n }]) => {
								if (n > 0) during();
								return n;
							}),
							bump: async (ctx) => {
								await n.change((draft) => void draft.n++, ctx);
								return null;
							},
						},
					};
				}),
			);
			const [a, b] = memoryLinkPair();
			server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
			const peer = new RawPeer(b);
			hold(peer, 0, Counter, { id: 1 });
			await peer.next("bound");
			during = () => a.close();
			call(peer, 0, 0, 0);
			await transported();
			expect(peer.kinds()).toEqual(["hello"]);
			expect(ends).toEqual(["counter 1 ended"]);
			expect(errors).toEqual([]);
		});
	});

	describe("local types over a link", () => {
		it("never cross one: a hold naming one is not served (failed { waiting })", async () => {
			const Store = local("app.store", { version: 1, params: {}, members: { n: int() } });
			const { peer } = await rawLinked((h) => h.serve(Store, () => ({ n: constant(1) })));
			hold(peer, 0, Store, {});
			expect(await peer.next("failed")).toMatchObject({
				cause: { kind: "waiting", error: { kind: "chord", error: { code: "unavailable" } } },
			});
		});
	});
});

/** A store whose `fill` sets `cells[0..n)` to a value in one commit: `n` leaf ops on distinct paths. */
const Grid = remote("app.grid", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		v: {
			state: { grid: obj({ cells: map(int()) }), one: int() },
			methods: { fill: method(obj({ n: int(), value: int() })) },
		},
	},
});

const GridDoc = defineState("grid", { schema: obj({ cells: map(int()) }), version: 1, initial: () => ({ cells: {} }) });

function serveGrid(h: FacetHost<TestPrincipal>): void {
	h.serve(Grid, (_, _principal, self) => {
		const grid = self.state(GridDoc);
		return {
			variant: "v",
			members: {
				grid,
				one: constant(1),
				fill: async ({ n, value }, ctx) => {
					await grid.change((draft) => {
						for (let cell = 0; cell < n; cell++) draft.cells[`c${cell}`] = value;
					}, ctx);
					return null;
				},
			},
		};
	});
}

/** A server serving `Notes` and `Grid` to a raw peer that acks only when told, the link's context counting. */
async function slowConsumer(role: "child" | "parent" = "child") {
	const counting = await metered();
	const server = createHost<TestPrincipal>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
	await server.load(
		[
			{
				name: "@test/app",
				facet: defineFacet<TestPrincipal>((h) => {
					serveNotes(h);
					serveGrid(h);
				}),
			},
		],
		context,
	);
	const [a, b] = memoryLinkPair();
	const options = { principal: { kind: "owner" }, codec: testCodec() } as const;
	if (role === "parent") server.connect(a, options, counting.context);
	else server.accept(a, options, counting.context);
	const peer = new RawPeer(b, { ack: false });
	await transported();
	return { server, peer, counts: counting.counts };
}

/** The `state` messages received and not taken. */
function statesOf(peer: RawPeer): Extract<Message, { kind: "state" }>[] {
	return peer.received.filter((message) => message.kind === "state");
}

/** The `bound` and `state` messages received and not taken, by kind. */
function windowed(peer: RawPeer): string[] {
	return peer.kinds().filter((kind) => kind === "bound" || kind === "state");
}

const GRID = wireNames(Grid, "v");

forEachCodec(() => {
	describe("the window at the provider", () => {
		it("holds at most two unacknowledged bound and state messages; what waits goes out folded, encoded once", async () => {
			const { server, peer, counts } = await slowConsumer();
			hold(peer, 0, Notes, { session: "S1" });
			await peer.next("bound");
			for (const text of ["a", "b", "c", "d"]) await addNote(server, "S1", text);
			await transported();
			expect(windowed(peer)).toEqual(["state"]);
			const before = counts()["chord.link.encodes"] ?? 0;
			peer.ack();
			await transported();
			const [, pending] = peer.received.filter(({ kind }) => kind === "state") as Extract<
				Message,
				{ kind: "state" }
			>[];
			// Three commits waited: one message, one entry, `count`'s three replacements folded into the last.
			expect(EDITOR.named(pending!.holds[0]!.members).count).toEqual([["r", 4]]);
			expect(counts()["chord.link.encodes"]! - before).toBe(1);
			expect(windowed(peer)).toEqual(["state", "state"]);
			await addNote(server, "S1", "e");
			await transported();
			expect(windowed(peer)).toEqual(["state", "state"]);
		});

		it("ignores acks that cross nothing: they never open the window past two (race 18)", async () => {
			const { server, peer } = await slowConsumer();
			for (const _ of [0, 1, 2]) peer.ack();
			hold(peer, 0, Notes, { session: "S1" });
			await peer.next("bound");
			for (const text of ["a", "b", "c"]) await addNote(server, "S1", text);
			await transported();
			expect(windowed(peer)).toEqual(["state"]);
		});

		it("lets a hold that binds while the window is full wait: the waiting state first, its bound at the next slot", async () => {
			const { server, peer } = await slowConsumer();
			hold(peer, 0, Notes, { session: "S1" });
			await peer.next("bound");
			await addNote(server, "S1", "a");
			await addNote(server, "S1", "b");
			hold(peer, 1, Notes, { session: "S1" });
			await transported();
			expect(windowed(peer)).toEqual(["state"]);
			peer.ack();
			await transported();
			expect(windowed(peer)).toEqual(["state", "state"]);
			await addNote(server, "S1", "c");
			peer.ack();
			await transported();
			// Hold 1's snapshot is taken now, with every commit so far.
			const bound = peer.received.findLast(({ kind }) => kind === "bound") as Extract<Message, { kind: "bound" }>;
			expect(bound.holds.map(({ hold }) => hold)).toEqual([1]);
			expect(EDITOR.named(bound.holds[0]!.members).count).toBe(3);
		});

		it("overflows past 10,000 pending ops to a replacement with the current value (race 23)", async () => {
			const { server, peer } = await slowConsumer();
			hold(peer, 0, Grid, {});
			await peer.next("bound");
			// Calls on the owner's object from the server itself: an answer over the link would send the waiting state first.
			const fills = async (ctx: Ctx<TestPrincipal>) => {
				const grid = await ctx.get(Grid, {});
				for (const value of [1, 2, 3]) await grid.fill({ n: 6_000, value }, ctx);
			};
			await server.root(fills, context, { principal: { kind: "owner" } });
			// The first fill took the second slot; the next two overflowed the queue.
			peer.ack();
			await transported();
			const states = peer.received.filter(({ kind }) => kind === "state") as Extract<Message, { kind: "state" }>[];
			const last = GRID.named(states.at(-1)!.holds[0]!.members).grid as [string, { cells: object }][];
			expect(last[0]![0]).toBe("r");
			expect(Object.keys(last[0]![1].cells)).toHaveLength(6_000);
		});
	});

	describe('an answer after its state (decision "A call\'s answer follows its state")', () => {
		it("sends the waiting state before a result when the window is full: one message, every hold, past the window", async () => {
			const { server, peer } = await slowConsumer();
			hold(peer, 0, Notes, { session: "S1" });
			hold(peer, 1, Notes, { session: "S2" });
			await peer.next("bound");
			await peer.next("bound");
			await addNote(server, "S2", "a");
			await addNote(server, "S2", "b");
			call(peer, 0, 0, add, { text: "c" });
			await transported();
			// The two bindings fill the window: both commits and the call's own wait, then go before its result.
			expect(peer.kinds()).toEqual(["hello", "state", "result"]);
			const { holds } = statesOf(peer)[0]!;
			expect(holds.map(({ hold, members }) => [hold, EDITOR.named(members).count])).toEqual([
				[1, [["r", 2]]],
				[0, [["r", 1]]],
			]);
			expect(partValue((await peer.next("result")).value!)).toBe(1);
		});

		it("acknowledges every message once, in order, those past the window too: the window opens after their acks", async () => {
			const { server, peer } = await slowConsumer();
			hold(peer, 0, Notes, { session: "S1" });
			await peer.next("bound");
			await addNote(server, "S1", "a");
			await addNote(server, "S1", "b");
			call(peer, 0, 0, add, { text: "c" });
			await peer.next("result");
			await addNote(server, "S1", "d");
			await transported();
			// Three in flight (the bound, a state, the state past the window): the first ack leaves the window full.
			expect(windowed(peer)).toEqual(["state", "state"]);
			peer.ack();
			await transported();
			expect(windowed(peer)).toEqual(["state", "state"]);
			peer.ack();
			await transported();
			expect(windowed(peer)).toEqual(["state", "state", "state"]);
			for (const _ of [0, 1]) peer.ack();
			// Acks crossing nothing are ignored: two slots, not more.
			for (const _ of [0, 1]) peer.ack();
			for (const text of ["e", "f", "g"]) await addNote(server, "S1", text);
			await transported();
			expect(windowed(peer)).toEqual(["state", "state", "state", "state", "state"]);
		});

		it("sends nothing more when nothing waits: a full window, an answer of a call that changed nothing", async () => {
			const { server, peer } = await slowConsumer();
			hold(peer, 0, Notes, { session: "S1" });
			await peer.next("bound");
			await addNote(server, "S1", "a");
			call(peer, 0, 0, fail, { how: "chord" });
			await transported();
			expect(peer.kinds()).toEqual(["hello", "state", "error"]);
		});

		it("costs nothing on the common path: a call's commit goes out once, at its commit, never again with its answer", async () => {
			const telemetry = new InMemoryTelemetryContext();
			const { peer } = await rawLinked((h) => void serveNotes(h), { telemetry });
			hold(peer, 0, Notes, { session: "S1" });
			await peer.next("bound");
			for (const [id, text] of ["a", "b", "c"].entries()) {
				call(peer, id, 0, add, { text });
				await peer.next("result");
			}
			await transported();
			const states = telemetry.getMetrics().filter(({ name }) => name === "chord.link.state_messages");
			expect(states.reduce((sum, { value }) => sum + value, 0)).toBe(3);
			expect(peer.kinds()).toEqual(["hello", "state", "state", "state"]);
		});
	});

	describe("origins at the provider (a relay's: on its parent link)", () => {
		it("key holds and calls by (origin, id): the same ids on two origins are two holds; answers carry the origin", async () => {
			const { peer } = await slowConsumer("parent");
			hold(peer, 0, Notes, { session: "S1" });
			hold(peer, 0, Notes, { session: "S2" }, {}, 3);
			const [own, relayed] = [await peer.next("bound"), await peer.next("bound")];
			expect(own.origin).toBeUndefined();
			expect(relayed.origin).toBe(3);
			call(peer, 0, 0, add, { text: "a" });
			call(peer, 0, 0, add, { text: "b" }, 3);
			const results = [await peer.next("result"), await peer.next("result")];
			expect(results.map(({ origin, call }) => ({ origin, call }))).toEqual([
				{ origin: undefined, call: 0 },
				{ origin: 3, call: 0 },
			]);
		});

		it("keep a window per origin: a stalled origin folds its commits, another keeps receiving each", async () => {
			const { server, peer } = await slowConsumer("parent");
			hold(peer, 0, Notes, { session: "S1" });
			hold(peer, 0, Notes, { session: "S1" }, {}, 1);
			await peer.next("bound");
			await peer.next("bound");
			for (const text of ["a", "b", "c", "d"]) {
				await addNote(server, "S1", text);
				// Only origin 0 acknowledges.
				peer.ack();
			}
			await transported();
			const states = statesOf(peer);
			expect(states.filter(({ origin }) => origin === undefined)).toHaveLength(4);
			// Origin 1: its bound and one state fill its window; three commits wait, folded into its next state.
			expect(states.filter(({ origin }) => origin === 1)).toHaveLength(1);
			peer.ack(1);
			peer.ack(1);
			await transported();
			const folded = statesOf(peer)
				.filter(({ origin }) => origin === 1)
				.at(-1)!;
			expect(EDITOR.named(folded.holds[0]!.members).count).toEqual([["r", 4]]);
		});

		it("count calls per origin against N: 8 on each of two origins run, one more on one closes the link", async () => {
			const { peer, errors } = await notesServer({ kind: "owner" }, "parent", { callWindow: 8 });
			hold(peer, 0, Notes, { session: "S1" });
			hold(peer, 0, Notes, { session: "S1" }, {}, 1);
			await peer.next("bound");
			await peer.next("bound");
			for (let id = 0; id < 8; id++) {
				call(peer, id, 0, wait);
				call(peer, id, 0, wait, undefined, 1);
			}
			await transported();
			expect(peer.closed).toBe(false);
			call(peer, 8, 0, wait, undefined, 1);
			await transported();
			expect(peer.closed).toBe(true);
			expect(errors).toMatchObject([{ kind: "protocol_error", error: { message: "call 8: more than 8 calls" } }]);
		});

		it("ignore a call on a hold they do not know before counting it (Q1)", async () => {
			const { peer, errors } = await notesServer({ kind: "owner" }, "parent");
			hold(peer, 0, Notes, { session: "S1" });
			await peer.next("bound");
			for (let id = 0; id < 256; id++) call(peer, id, 0, wait);
			call(peer, 256, 9, wait);
			call(peer, 257, 0, wait, undefined, 4);
			await transported();
			expect(peer.closed).toBe(false);
			expect(errors).toEqual([]);
		});

		it("closed releases the origin's holds and aborts its calls; another origin keeps its own", async () => {
			const { peer, probe, server } = await notesServer({ kind: "owner" }, "parent");
			hold(peer, 0, Notes, { session: "S1" });
			hold(peer, 0, Notes, { session: "S2" }, {}, 2);
			await peer.next("bound");
			await peer.next("bound");
			call(peer, 0, 0, wait, undefined, 2);
			await transported();
			const [waiting] = probe.waits;
			peer.send({ kind: "closed", origin: 2 });
			await transported();
			expect(waiting!.abortSignal?.aborted).toBe(true);
			// Its ids are free: nothing answers them, a new hold of origin 2 starts over.
			call(peer, 1, 0, add, { text: "x" }, 2);
			await addNote(server, "S1", "a");
			await transported();
			expect(peer.kinds().filter((kind) => kind === "result" || kind === "error")).toEqual([]);
			expect(statesOf(peer).map(({ origin }) => origin)).toEqual([undefined]);
		});

		it("carry constants and failed members, and an empty variant's binding, in a first bound (race 24)", async () => {
			const Empty = remote("app.empty", {
				version: 1,
				params: {},
				hostAddress: () => Server(),
				variants: { v: {} },
			});
			const N = defineState("n", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });
			const { peer } = await rawLinked((h) => {
				h.serve(Empty, () => ({ variant: "v", members: {} }));
				h.serve(Halves, (_, _principal, self) => {
					const n = self.state(N);
					return {
						variant: "v",
						members: {
							one: constant(1),
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
						},
					};
				});
			});
			hold(peer, 0, Halves, {});
			await peer.next("bound");
			call(peer, 0, 0, HALVES.methods.set!, 2);
			await peer.next("result");
			hold(peer, 1, Empty, {});
			hold(peer, 2, Halves, {});
			const bounds = [await peer.next("bound"), await peer.next("bound")];
			const [empty, halves] = [1, 2].map((id) => bounds.find(({ holds }) => holds[0]!.hold === id)!);
			expect(empty.holds).toEqual([{ hold: 1, variant: 0, members: [], failed: [] }]);
			expect(halves.holds).toEqual([
				{
					hold: 2,
					variant: 0,
					members: [{ member: HALVES.state.one!, value: expect.anything() }],
					failed: [
						{ member: HALVES.state.half!, error: { kind: "plugin", code: "internal", message: "half threw" } },
					],
				},
			]);
			expect(HALVES.named(halves.holds[0]!.members)).toEqual({ one: 1 });
		});
	});

	describe("GC of the window", () => {
		it("a closed origin drops its pending queue's ops: nothing keeps them", async () => {
			const push = PendingOps.prototype.push;
			const pushed: WeakRef<object>[] = [];
			// Patched by hand: a spy would keep every argument in its call log.
			PendingOps.prototype.push = function (this: PendingOps, ops) {
				pushed.push(new WeakRef(ops));
				push.call(this, ops);
			};
			try {
				const { server, peer } = await slowConsumer("parent");
				hold(peer, 0, Notes, { session: "S1" }, {}, 1);
				await peer.next("bound");
				for (const text of ["a", "b", "c"]) await addNote(server, "S1", text);
				expect(pushed.length).toBeGreaterThan(0);
				peer.send({ kind: "closed", origin: 1 });
				await transported();
				await expectCollected(...pushed);
				expect(peer.closed).toBe(false);
			} finally {
				PendingOps.prototype.push = push;
			}
		});
	});

	describe('the call limit (decision "Call windows only for untrusted links")', () => {
		/** The `calls` of the `hello` the server sent the raw peer. */
		const announced = (peer: RawPeer) => peer.received.find((message) => message.kind === "hello")!;

		it("announces the host's callWindow on a link it was not given as trusted, 10,000 by default", async () => {
			expect(announced((await notesServer()).peer)).toMatchObject({ calls: 10_000 });
			expect(announced((await notesServer({ kind: "owner" }, "child", { callWindow: 8 })).peer)).toMatchObject({
				calls: 8,
			});
		});

		it("announces no window on a trusted link (accept and connect)", async () => {
			for (const role of ["child", "parent"] as const) {
				const { peer } = await notesServer({ kind: "owner" }, role, { callWindow: 8, trusted: true });
				expect(announced(peer)).not.toHaveProperty("calls");
			}
		});

		it("closes a link whose peer sends more calls than this side announced", async () => {
			const { peer, errors } = await notesServer({ kind: "owner" }, "child", { callWindow: 8 });
			hold(peer, 0, Notes, { session: "S1" });
			await peer.next("bound");
			for (let id = 0; id <= 8; id++) call(peer, id, 0, wait);
			await transported();
			expect(peer.closed).toBe(true);
			expect(errors).toMatchObject([{ kind: "protocol_error", error: { message: "call 8: more than 8 calls" } }]);
		});

		it("never closes a trusted link for running calls: 300 run where the window would be 8", async () => {
			const { peer, errors, probe } = await notesServer({ kind: "owner" }, "child", {
				callWindow: 8,
				trusted: true,
			});
			hold(peer, 0, Notes, { session: "S1" });
			await peer.next("bound");
			for (let id = 0; id < 300; id++) call(peer, id, 0, wait);
			await transported();
			expect(peer.closed).toBe(false);
			expect(probe.waits).toHaveLength(300);
			expect(errors).toEqual([]);
		});

		it("frees a slot per reply, cancel and release", async () => {
			const { peer, errors } = await notesServer({ kind: "owner" }, "child", { callWindow: 8 });
			hold(peer, 0, Notes, { session: "S1" });
			await peer.next("bound");
			for (let id = 0; id < 8; id++) call(peer, id, 0, wait);
			peer.send({ kind: "abort", call: 0 });
			call(peer, 8, 0, wait);
			peer.send({ kind: "release", hold: 0 });
			hold(peer, 1, Notes, { session: "S1" });
			await peer.next("bound");
			for (let id = 300; id < 308; id++) call(peer, id, 1, wait);
			await transported();
			expect(peer.closed).toBe(false);
			expect(errors).toEqual([]);
		});
	});
});

/** `Halves`: a constant, and a member that fails once `set(2)`. */
const Halves = remote("app.halves", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { v: { state: { one: int(), half: int() }, methods: { set: method(int()) } } },
});

const HALVES = wireNames(Halves, "v");

forEachCodec(() => {
	describe("limits per part at the provider", () => {
		/**
		 * A server serving `Notes` behind a raw consumer whose link has `limits`, compressing with `compression`; the raw
		 * peer is its child, or its parent (only a parent may send compressed arguments).
		 */
		async function limited(limits: PartLimits, compression?: Compression, role?: "child" | "parent") {
			return rawLinked((h) => void serveNotes(h), { limits, compression, role });
		}

		/** Deflated JSON of `{ text }` with `length` characters. */
		const deflatedText = (length: number) =>
			new DeflatedPart(nodeCompression.deflate(UTF8.encode(JSON.stringify({ text: "x".repeat(length) }))));

		it("fails a call whose argument part is past the wire limit with too_large/part; the link stays", async () => {
			const { peer } = await limited({ part: 100 });
			hold(peer, 0, Notes, { session: "S1" });
			await peer.next("bound");
			call(peer, 0, 0, add, { text: "x".repeat(200) });
			expect(await peer.next("error")).toMatchObject({
				call: 0,
				error: { kind: "chord", error: { code: "too_large", reason: "part" } },
			});
			call(peer, 1, 0, add, { text: "fits" });
			expect(partValue((await peer.next("result")).value!)).toBe(1);
			expect(peer.closed).toBe(false);
		});

		it("fails a hold whose params are past the limit broken too_large/part", async () => {
			const { peer } = await limited({ part: 30 });
			hold(peer, 0, Notes, { session: "s".repeat(40) });
			expect(await peer.next("failed")).toMatchObject({
				hold: 0,
				cause: { kind: "broken", error: { kind: "chord", error: { code: "too_large", reason: "part" } } },
			});
		});

		it("fails a call whose deflated argument inflates past the decoded limit, on both inflate paths", async () => {
			for (const compression of [nodeCompression, undefined]) {
				const { peer } = await limited({ decoded: 10_000 }, compression, "parent");
				hold(peer, 0, Notes, { session: "S1" });
				await peer.next("bound");
				peer.send({ kind: "call", call: 0, hold: 0, method: add, args: deflatedText(50_000) });
				expect(await peer.next("error")).toMatchObject({ error: { error: { code: "too_large" } } });
				call(peer, 1, 0, add, { text: "fits" });
				expect((await peer.next("result")).call).toBe(1);
			}
		});

		it("inflates a deflated argument within the hold's stamped decoded limit, a bomb included (both paths)", async () => {
			const output = countInflated();
			try {
				for (const compression of [nodeCompression, undefined]) {
					// The stamped limit is smaller than the link's own: it bounds the inflate.
					const { peer } = await limited({}, compression, "parent");
					peer.send({ ...notesHold(0), limit: 1000 });
					await peer.next("bound");
					const bomb = new DeflatedPart(
						nodeCompression.deflate(UTF8.encode(JSON.stringify("x".repeat(64 << 20)))),
					);
					peer.send({ kind: "call", call: 0, hold: 0, method: add, args: bomb });
					expect(await peer.next("error")).toMatchObject({ error: { error: { code: "too_large" } } });
					peer.send({ kind: "call", call: 1, hold: 0, method: add, args: deflatedText(500) });
					expect((await peer.next("result")).call).toBe(1);
				}
				// The asynchronous inflate stopped within a chunk of the stamped limit, never near the bomb's 64 MiB.
				expect(output.bytes).toBeLessThan(1024 * 1024);
			} finally {
				output.restore();
			}
		});

		it("checks a deflated argument's wire size before inflating it (both paths)", async () => {
			for (const compression of [nodeCompression, undefined]) {
				const { peer, errors } = await limited({ part: 18 }, compression, "parent");
				hold(peer, 0, Notes, { session: "S1" });
				await peer.next("bound");
				// Corrupt data past the wire limit: refused by its size, never inflated (no protocol error).
				peer.send({ kind: "call", call: 0, hold: 0, method: add, args: new DeflatedPart(new Uint8Array(20)) });
				expect(await peer.next("error")).toMatchObject({ error: { error: { code: "too_large" } } });
				expect(peer.closed).toBe(false);
				expect(errors).toEqual([]);
			}
		});

		it("inflates nothing for a call it ignores: an unknown hold (Q1), a refused one (both paths)", async () => {
			for (const compression of [nodeCompression, undefined]) {
				const { peer, errors } = await limited({}, compression, "parent");
				const corrupt = () => new DeflatedPart(new Uint8Array([255, 255, 255]));
				peer.send({ kind: "call", call: 0, hold: 9, method: add, args: corrupt() });
				peer.send({ ...notesHold(0), type: "app.kept" });
				await peer.next("failed");
				peer.send({ kind: "call", call: 1, hold: 0, method: 0, args: corrupt() });
				await transported();
				expect(peer.closed).toBe(false);
				expect(errors).toEqual([]);
			}
		});

		it("refuses compressed arguments from a child, and compressed params on any link: protocol errors", async () => {
			const child = await limited({});
			hold(child.peer, 0, Notes, { session: "S1" });
			await child.peer.next("bound");
			child.peer.send({ kind: "call", call: 0, hold: 0, method: add, args: deflatedText(10) });
			await transported();
			expect(child.peer.closed).toBe(true);
			expect(child.errors).toMatchObject([{ kind: "protocol_error" }]);
			const parent = await limited({}, undefined, "parent");
			parent.peer.send({ ...notesHold(0), params: new DeflatedPart(nodeCompression.deflate(UTF8.encode("{}"))) });
			await transported();
			expect(parent.peer.closed).toBe(true);
			expect(parent.errors).toMatchObject([{ kind: "protocol_error" }]);
		});

		it("honours a stamped decoded limit only on a parent link: a child's is ignored (race 12)", async () => {
			const { peer } = await limited({});
			peer.send({ ...notesHold(0), limit: 10 });
			await peer.next("bound");
			call(peer, 0, 0, add, { text: "longer than ten bytes" });
			expect((await peer.next("result")).call).toBe(0);
		});
	});
});

/** A hold of `Notes` for S1 as a message. */
function notesHold(id: number): Extract<Message, { kind: "hold" }> {
	const { name: type, version, fingerprint } = Notes;
	return {
		kind: "hold",
		hold: id,
		type,
		version,
		fingerprint,
		params: jsonPart({ session: "S1" }),
		address: SERVER_ADDRESS,
	};
}

const UTF8 = new TextEncoder();

describe("telemetry at the provider (slice 9)", () => {
	/** A server recording to `telemetry`, serving `Notes`, and a raw consumer holding S1 (bound). */
	async function traced() {
		const telemetry = new InMemoryTelemetryContext();
		const { peer, server } = await rawLinked((h) => void serveNotes(h), { telemetry });
		hold(peer, 0, Notes, { session: "S1" });
		await peer.next("bound");
		return { telemetry, peer, server };
	}

	it("runs a call's method under its carrier, extracted with the host's adapter; an absent or unknown one is a root", async () => {
		const { telemetry, peer } = await traced();
		const carrier = await telemetry.startSpan({ name: "caller" }, (span) => telemetry.inject(span));
		const { add: addIndex } = EDITOR.methods as { add: number };
		peer.send({ kind: "call", call: 0, hold: 0, method: addIndex, args: jsonPart({ text: "a" }), trace: carrier });
		await peer.next("result");
		call(peer, 1, 0, addIndex, { text: "b" });
		await peer.next("result");
		peer.send({ kind: "call", call: 2, hold: 0, method: addIndex, args: jsonPart({ text: "c" }), trace: { x: "y" } });
		await peer.next("result");
		const spans = telemetry.getSpans();
		const caller = spans.find(({ name }) => name === "caller")!;
		const methods = spans.filter(
			({ name, attributes }) => name === "chord.method" && attributes.type === "app.notes",
		);
		expect(methods.map(({ parentId }) => parentId)).toEqual([caller.id, null, null]);
		expect(methods[0]!.attributes).toEqual({
			"chord.host": "server",
			type: "app.notes",
			member: "add",
			object: "app.notes(S1)",
			"principal.kind": "owner",
			"chord.principal": '{"kind":"owner"}',
			outcome: "ok",
		});
	});

	it("counts holds placed here up and down, its own state messages, and the bytes of its link", async () => {
		const { telemetry, peer, server } = await traced();
		await addNote(server, "S1", "a");
		await peer.next("state");
		peer.send({ kind: "release", hold: 0 });
		await transported();
		const sums: Record<string, number> = {};
		for (const { name, value } of telemetry.getMetrics()) sums[name] = (sums[name] ?? 0) + value;
		expect(sums["chord.holds.active"]).toBe(0);
		expect(
			telemetry
				.getMetrics()
				.filter(({ name }) => name === "chord.holds.active")
				.map(({ value }) => value),
		).toEqual([1, -1]);
		expect(sums["chord.link.state_messages"]).toBe(1);
		expect(sums["chord.links.open"]).toBe(1);
		const bytes = telemetry.getMetrics().filter(({ name }) => name === "chord.link.bytes");
		expect(new Set(bytes.map(({ attributes }) => attributes.direction))).toEqual(new Set(["sent", "received"]));
	});

	it("records how long state waited for a slot of the window", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const { server } = await rawLinked((h) => void serveNotes(h), { telemetry });
		const [a, b] = memoryLinkPair();
		server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
		const slow = new RawPeer(b, { ack: false });
		hold(slow, 0, Notes, { session: "S1" });
		await slow.next("bound");
		await addNote(server, "S1", "a");
		await slow.next("state");
		// The window (two messages) is full: the next change waits for an ack.
		await addNote(server, "S1", "b");
		expect(telemetry.getMetrics().filter(({ name }) => name === "chord.backpressure.wait")).toHaveLength(0);
		slow.ack();
		await slow.next("state");
		expect(telemetry.getMetrics().filter(({ name }) => name === "chord.backpressure.wait")).toHaveLength(1);
	});
});

describe('old work from another host (decision "Reload restarts every affected object", `call.old`)', () => {
	/** A remote type whose `slow` waits for `gate` (the call a restart drains) and whose `ping` answers its code. */
	const Coded = remote("app.coded", {
		version: 1,
		params: {},
		hostAddress: () => Server(),
		variants: { v: { state: {}, methods: { slow: method(undefined, int()), ping: method(undefined, int()) } } },
	});
	const CODED = wireNames(Coded, "v");

	/** Serves `Coded` as code `code`, `slow` first awaiting `gate`. */
	const serveCoded = (h: FacetHost<TestPrincipal>, code: number, gate?: Promise<void>) =>
		h.serve(Coded, () => ({
			variant: "v",
			members: {
				slow: async () => {
					await gate;
					return code;
				},
				ping: async () => code,
			},
		}));

	/**
	 * Holds `Coded` on a server restarting it while its call `slow` drains, then sends `ping` (marked old when `old`) on
	 * a link trusted when `trusted`: resolves with the code that answered it and whether that came before the drain.
	 */
	async function pingDuringDrain(old: boolean, trusted: boolean) {
		const gate = Promise.withResolvers<void>();
		const { server, peer } = await rawLinked((h) => serveCoded(h, 1, gate.promise), { trusted });
		await peer.next("hello");
		hold(peer, 0, Coded, {});
		await peer.next("bound");
		call(peer, 0, 0, CODED.methods.slow!);
		await transported();
		await server.reload([{ name: "@test/app", facet: defineFacet<TestPrincipal>((h) => serveCoded(h, 2)) }], context);
		peer.send({
			kind: "call",
			call: 1,
			hold: 0,
			method: CODED.methods.ping!,
			...(old ? { old: true as const } : {}),
		});
		await transported();
		const early = peer.received.some((message) => message.kind === "result" && message.call === 1);
		gate.resolve();
		const first = await peer.next("result");
		const result = first.call === 1 ? first : await peer.next("result");
		await server.close(context);
		return { code: partValue(result.value!), early };
	}

	it("runs a marked call from a trusted link on the open old attempt: answered by the old code, before the drain", async () => {
		expect(await pingDuringDrain(true, true)).toEqual({ code: 1, early: true });
	});

	it("ignores the mark from a link that is not trusted: the call is new work and waits for the new code", async () => {
		expect(await pingDuringDrain(true, false)).toEqual({ code: 2, early: false });
	});

	it("runs an unmarked call from a trusted link as new work", async () => {
		expect(await pingDuringDrain(false, true)).toEqual({ code: 2, early: false });
	});
});

/** Every object of this file, weakly: a live failure is handed to its attempt's object. */
const objects = instancesOf(ChordObject, "attempt");

/** A host-lifetime event source, and a remote view re-exposing it. */
const TickSource = local("app.tick-source", { version: 1, params: {}, members: { ticks: event(Sample) } });

const TickView = remote("app.tick-view", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { v: { events: { ticks: Sample } } },
});

/** Every provider side sending events in this file, weakly. */
const sides = instancesOf(ProviderSide, "sendEvents");

/** The event members' wire indexes of `Match`'s player variant (sorted). */
const EVENTS = { ball: 0, paddle: 1 } as const;

/** A server serving `Match` and a raw consumer, with the server's options. */
async function matchServer(options: Parameters<typeof rawLinked>[1] = {}) {
	const probe: MatchProbe = { paddles: [], scores: [], selves: [] };
	const linked = await rawLinked((h) => serveMatch(h, probe), options);
	return { ...linked, probe };
}

/** The `event` messages a raw peer received (taken), each entry with its value parsed. */
function takeEvents(
	peer: RawPeer,
): { origin?: number; events: { hold: number; member: number; at: number; y: unknown }[] }[] {
	const taken: Extract<Message, { kind: "event" }>[] = [];
	for (let index = 0; index < peer.received.length; ) {
		const message = peer.received[index]!;
		if (message.kind === "event")
			taken.push(peer.received.splice(index, 1)[0] as Extract<Message, { kind: "event" }>);
		else index++;
	}
	return taken.map(({ origin, events }) => ({
		...(origin === undefined ? {} : { origin }),
		events: events.map(({ hold, member, at, value }) => ({ hold, member, at, y: (partValue(value) as Sample).y })),
	}));
}

/** The kinds of the messages a raw peer received after its hello, without acks of its own. */
function kindsAfterHello(peer: RawPeer): string[] {
	return peer.kinds().filter((kind) => kind !== "hello");
}

forEachCodec(() => {
	describe('events at the provider (decision "Events: fire-and-forget members")', () => {
		it("send a turn's events as one event message per link and origin, after the state published before the flush", async () => {
			const { peer, probe } = await matchServer();
			hold(peer, 0, Match, { id: 1 });
			hold(peer, 1, Match, { id: 1 });
			await peer.next("bound");
			await peer.next("bound");
			peer.received.splice(0);
			const [paddle] = probe.paddles;
			const before = Date.now();
			paddle!.emit({ y: 1 });
			probe.scores[0]!.set(1);
			paddle!.emit({ y: 2 });
			await transported();
			expect(kindsAfterHello(peer)).toEqual(["state", "event"]);
			const [message] = takeEvents(peer);
			expect(message!.events.map(({ hold, member, y }) => [hold, member, y])).toEqual([
				[0, EVENTS.paddle, 1],
				[1, EVENTS.paddle, 1],
				[0, EVENTS.paddle, 2],
				[1, EVENTS.paddle, 2],
			]);
			for (const { at } of message!.events) expect(at).toBeGreaterThanOrEqual(before);
		});

		it("send one message per origin, each with its origin", async () => {
			const { peer, probe } = await matchServer({ role: "parent" });
			hold(peer, 0, Match, { id: 1 });
			hold(peer, 0, Match, { id: 1 }, {}, 3);
			await peer.next("bound");
			await peer.next("bound");
			probe.paddles[0]!.emit({ y: 1 });
			await transported();
			expect(takeEvents(peer).map(({ origin, events }) => [origin, events.length])).toEqual([
				[undefined, 1],
				[3, 1],
			]);
		});

		it("send nothing to a variant without the member, and none before a bound the state window holds back", async () => {
			const { peer, probe } = await matchServer({ ack: false, child: { kind: "owner" } });
			hold(peer, 0, Match, { id: 1 });
			await peer.next("bound");
			// The window's two slots: the bound and a state, unacknowledged; a new hold's bound waits.
			probe.scores[0]!.set(1);
			await peer.next("state");
			hold(peer, 1, Match, { id: 1 });
			await transported();
			probe.paddles[0]!.emit({ y: 1 });
			await transported();
			expect(takeEvents(peer).map(({ events }) => events.map(({ hold }) => hold))).toEqual([[0]]);
			peer.ack();
			await peer.next("bound");
			probe.paddles[0]!.emit({ y: 2 });
			await transported();
			expect(takeEvents(peer).map(({ events }) => events.map(({ hold }) => hold))).toEqual([[0, 1]]);
		});

		it("send nothing for an emit its object fails after in the same turn: no event to a binding not shown live", async () => {
			const { peer, probe } = await matchServer();
			hold(peer, 0, Match, { id: 1 });
			await peer.next("bound");
			probe.paddles[0]!.emit({ y: 1 });
			failLive(objects, probe.selves[0]!, new ChordError({ code: "unavailable", message: "boom" }));
			await peer.next("failed");
			await transported();
			expect(takeEvents(peer)).toEqual([]);
		});

		it("send nothing re-exposed: an emit its source fails after in the same turn reaches no hold of the view", async () => {
			const sources: { source: EventSource<Sample>; self: Self }[] = [];
			const { peer } = await rawLinked((h) => {
				h.serve(TickSource, (_, self) => {
					const ticks = self.events<Sample>();
					sources.push({ source: ticks, self });
					return { ticks };
				});
				h.serve(TickView, (_, _principal, self) => ({
					variant: "v",
					members: { ticks: self.get(TickSource, {}).ticks },
				}));
			});
			hold(peer, 0, TickView, {});
			await peer.next("bound");
			const [{ source, self }] = sources as [{ source: EventSource<Sample>; self: Self }];
			source.emit({ y: 1 });
			await transported();
			expect(takeEvents(peer).map(({ events }) => events.map(({ y }) => y))).toEqual([[1]]);
			source.emit({ y: 2 });
			failLive(objects, self, new ChordError({ code: "unavailable", message: "boom" }));
			await transported();
			expect(takeEvents(peer)).toEqual([]);
		});

		it("keep state and event credits apart: events flow while the state window is full, and the reverse", async () => {
			const { peer, probe } = await matchServer({ ack: false, eventWindow: 1 });
			hold(peer, 0, Match, { id: 1 });
			await peer.next("bound");
			probe.scores[0]!.set(1);
			await peer.next("state");
			probe.scores[0]!.set(2);
			// State waits for a slot; an event goes.
			probe.paddles[0]!.emit({ y: 1 });
			await transported();
			expect(takeEvents(peer)).toHaveLength(1);
			expect(kindsAfterHello(peer).filter((kind) => kind === "state")).toEqual([]);
			// The event window is full now; state acks open the state window only.
			peer.ack();
			peer.ack();
			await transported();
			expect(kindsAfterHello(peer).filter((kind) => kind === "state")).toEqual(["state"]);
			probe.paddles[0]!.emit({ y: 2 });
			await transported();
			expect(takeEvents(peer)).toEqual([]);
			// An event ack frees the event window, not a state slot.
			peer.send({ kind: "ack", events: 1 });
			await transported();
			probe.paddles[0]!.emit({ y: 3 });
			await transported();
			expect(takeEvents(peer).map(({ events }) => events.map(({ y }) => y))).toEqual([[3]]);
		});

		it("drop a flush's events while the event window is full, counted, and send again once acknowledged", async () => {
			const telemetry = new InMemoryTelemetryContext();
			const { peer, probe } = await matchServer({ eventWindow: 2, telemetry });
			hold(peer, 0, Match, { id: 1 });
			await peer.next("bound");
			const counts = (): Record<string, number> => {
				const result: Record<string, number> = {};
				for (const { name, value, attributes } of telemetry.getMetrics()) {
					const key = attributes?.reason === undefined ? name : `${name}.${String(attributes.reason)}`;
					result[key] = (result[key] ?? 0) + value;
				}
				return result;
			};
			for (const y of [1, 2, 3]) {
				probe.paddles[0]!.emit({ y });
				probe.paddles[0]!.emit({ y: y * 10 });
				await transported();
			}
			expect(takeEvents(peer).map(({ events }) => events.map(({ y }) => y))).toEqual([
				[1, 10],
				[2, 20],
			]);
			// The dropped round encoded nothing: the window is decided before a value is encoded.
			expect(counts()).toMatchObject({
				"chord.events.emitted": 6,
				"chord.events.sent": 4,
				"chord.events.dropped.window": 2,
				"chord.events.encodes": 4,
			});
			peer.send({ kind: "ack", events: 2 });
			await transported();
			probe.paddles[0]!.emit({ y: 4 });
			await transported();
			expect(takeEvents(peer).map(({ events }) => events.map(({ y }) => y))).toEqual([[4]]);
		});

		it("encode each value once per representation: 1 and 10 holders, one more for a mapped version; never walked or copied", async () => {
			const { telemetry, counts } = await metered();
			const paddles: EventSource<{ y: number; t: number }>[] = [];
			const { peer } = await rawLinked(
				(h) =>
					h.serve(
						MatchV2,
						(_, _principal, self) => {
							const paddle = self.events<{ y: number; t: number }>();
							paddles.push(paddle);
							const score = constant(0);
							return {
								variant: "player",
								members: { score, paddle, ball: self.events(), bump: async () => null },
							};
						},
						{ accepts: { 1: { events: { player: { paddle: ({ y }) => ({ y }) } } } } },
					),
				{ telemetry },
			);
			const encodes = async (y: number): Promise<number> => {
				const before = counts()["chord.events.encodes"] ?? 0;
				paddles[0]!.emit({ y, t: 0 });
				await transported();
				return (counts()["chord.events.encodes"] ?? 0) - before;
			};
			hold(peer, 0, MatchV2, { id: 1 });
			await peer.next("bound");
			expect(await encodes(1)).toBe(1);
			// Bindings waiting for a slot go out together: the holds' entries, not their messages, are counted.
			const bound = (): number =>
				peer.received.flatMap((message) => (message.kind === "bound" ? message.holds : [])).length;
			for (let id = 1; id < 10; id++) hold(peer, id, MatchV2, { id: 1 });
			await transported();
			expect(bound()).toBe(9);
			expect(await encodes(2)).toBe(1);
			// An older consumer: its mapped values are a representation of their own, encoded once for all its holds.
			hold(peer, 10, Match, { id: 1 });
			hold(peer, 11, Match, { id: 1 });
			await transported();
			expect(bound()).toBe(11);
			takeEvents(peer);
			expect(await encodes(3)).toBe(2);
			const [message] = takeEvents(peer);
			expect(message!.events.filter(({ hold }) => hold >= 10).map(({ y }) => y)).toEqual([3, 3]);
		});

		it("retire a provider side's record only once its event tickets drained (GC)", async () => {
			const { peer, probe } = await matchServer();
			const made = sides.length;
			hold(peer, 0, Match, { id: 1 });
			hold(peer, 1, Match, { id: 1 });
			await peer.next("bound");
			await peer.next("bound");
			probe.paddles[0]!.emit({ y: 1 });
			await transported();
			expect(takeEvents(peer)).toHaveLength(1);
			// The test keeps no attempt (its source): an ended attempt kept by a test keeps its object's past.
			probe.paddles.length = 0;
			probe.scores.length = 0;
			probe.selves.length = 0;
			peer.send({ kind: "release", hold: 0 });
			peer.send({ kind: "release", hold: 1 });
			await transported();
			// Nothing held, its event message unacknowledged: the side stays until its ack.
			expect(sides.slice(made).some((side) => side.deref() !== undefined)).toBe(true);
			const kept = sides.slice(made);
			peer.send({ kind: "ack", events: 1 });
			await transported();
			await expectCollected(...kept);
			expect(peer.closed).toBe(false);
		});
	});
});
