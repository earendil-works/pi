import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../src/context/index.ts";
import { type EventSource, int, local, method, remote, str } from "../../src/contracts/index.ts";
import { createHost, defineFacet, untilAborted } from "../../src/host/index.ts";
import { type Compression, type Link, memoryLinkPair } from "../../src/link/index.ts";
import { binaryCodec, jsonPart, type Message, textCodec } from "../../src/link/internal.ts";
import type * as Values from "../../src/link/values.ts";
import { nodeCompression } from "../../src/node/compression.ts";
import { RelayedHold } from "../../src/remote/relay.ts";
import {
	addNote,
	countInflated,
	EDITOR,
	expectCollected,
	fakeTimers,
	forEachCodec,
	instancesOf,
	Match,
	type MatchProbe,
	Notes,
	PlacedNotes,
	partValue,
	RawPeer,
	rawWorkers,
	rejection,
	relayed,
	Sample,
	SERVER_ADDRESS,
	Server,
	Session,
	serveMatch,
	serveNotes,
	type TestPrincipal,
	testCodec,
	transported,
	wireNames,
} from "../support.ts";

/** How often a part was parsed in this file, by anyone. */
const parses = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../src/link/values.ts", async (importOriginal) => {
	const original = await importOriginal<typeof Values>();
	return {
		...original,
		parsePart: (part: string | Uint8Array) => {
			parses.count++;
			return original.parsePart(part);
		},
		parsePayload: (part: string | Uint8Array, segments: readonly Uint8Array[] | undefined) => {
			parses.count++;
			return original.parsePayload(part, segments);
		},
	};
});

/** Every relayed hold started in this file, weakly. */
const relayedHolds = instancesOf(RelayedHold, "start");

const READER = wireNames(PlacedNotes, "reader");

const { wait, add } = EDITOR.methods as { wait: number; add: number };

/** A server routing to raw workers, and a raw tab on a link it accepted as `principal`. */
async function rawRelay(options: { readonly principal?: TestPrincipal; readonly calls?: number } = {}) {
	const workers: RawPeer[] = [];
	const relay = await relayed({ resolve: rawWorkers(workers, { calls: options.calls }) });
	const tab = rawTab(relay.server, options.principal);
	return { ...relay, workers, raw: tab };
}

/**
 * A raw tab on a new link the server accepts as `principal` (owner by default), trusted when `trusted`; it acknowledges
 * `bound` and `state` by itself unless `ack` is false.
 */
function rawTab(
	server: Awaited<ReturnType<typeof relayed>>["server"],
	principal?: TestPrincipal,
	trusted = false,
	ack = true,
): RawPeer {
	const [a, b] = memoryLinkPair();
	server.accept(a, { principal: principal ?? { kind: "owner" }, codec: testCodec(), trusted }, context);
	return new RawPeer(b, { ack });
}

/** The ids of the calls a raw peer received, in order. */
function callsOf(peer: RawPeer): number[] {
	return peer.received.flatMap((message) => (message.kind === "call" ? [message.call] : []));
}

/** The ids of the calls a raw tab got an answer for (`result` or `error`), with the error's message, in order. */
function answersOf(peer: RawPeer): (readonly [number, string])[] {
	return peer.received.flatMap((message) => {
		if (message.kind === "result") return [[message.call, "ok"] as const];
		if (message.kind !== "error") return [];
		const { error } = message.error as { readonly error: { readonly message: string } };
		return [[message.call, error.message] as const];
	});
}

/** A chord error on the wire. */
function wireChord(code: string, message: string) {
	return { kind: "chord" as const, error: { code, message } };
}

/** Sends a hold of `PlacedNotes` for `session` with id `hold`, naming its address. */
function holdPlaced(peer: RawPeer, hold: number, session = "S1"): void {
	peer.send({
		kind: "hold",
		hold,
		type: PlacedNotes.name,
		version: PlacedNotes.version,
		fingerprint: PlacedNotes.fingerprint,
		params: jsonPart({ session }),
		address: { kind: "session", params: { id: session } },
	});
}

/** The raw worker at `index` once it exists (a resolve runs a turn after the hold arrived). */
async function workerAt(workers: RawPeer[], index = 0): Promise<RawPeer> {
	for (let tries = 0; workers[index] === undefined && tries < 10; tries++) await transported();
	return workers[index]!;
}

/** A hold as a raw worker received it: its id and its origin, which every answer names. */
type Held = { readonly hold: number; readonly origin?: number };

/** The origin field of an answer to `held`. */
function originOf({ origin }: Held): { origin?: number } {
	return origin === undefined ? {} : { origin };
}

/** Binds `held` on a raw worker with `PlacedNotes`'s editor (or reader) variant and `count`. */
function bindPlaced(peer: RawPeer, held: Held, count = 0, variant = EDITOR): void {
	const members = [
		{ member: variant.state.notes!, value: "[]" },
		{ member: variant.state.count!, value: jsonPart(count) },
	];
	peer.send({
		kind: "bound",
		...originOf(held),
		holds: [{ hold: held.hold, variant: variant.variant, members, failed: [] }],
	});
}

/** A `state` of `count` for `holds` (of one origin) on a raw worker. */
function countState(holds: readonly Held[], count: number): Extract<Message, { kind: "state" }> {
	const ops = jsonPart([["r", count]]);
	return {
		kind: "state",
		...originOf(holds[0]!),
		holds: holds.map(({ hold }) => ({
			hold,
			members: [{ member: EDITOR.state.count!, ops }],
			failed: [],
			retired: [],
		})),
	};
}

forEachCodec(() => {
	describe("ids and origins", () => {
		it("keep the downstream ids upstream, under the downstream link's origin; answers come back by it", async () => {
			const { raw, workers } = await rawRelay();
			holdPlaced(raw, 7);
			const worker = await workerAt(workers);
			const held = await worker.next("hold");
			expect(held).toMatchObject({ hold: 7, origin: 1 });
			bindPlaced(worker, held, 3);
			const bound = await raw.next("bound");
			expect(bound.origin).toBeUndefined();
			expect(bound.holds[0]).toMatchObject({ hold: 7, variant: EDITOR.variant });
			raw.send({ kind: "call", call: 5, hold: 7, method: add, args: jsonPart({ text: "x" }) });
			// Calls are forwarded at once, with the same id.
			expect(await worker.next("call")).toMatchObject({ origin: 1, call: 5, hold: 7, method: add });
			worker.send({ kind: "result", origin: 1, call: 5, value: "1" });
			const result = await raw.next("result");
			expect(result).toMatchObject({ kind: "result", call: 5 });
			expect(result.origin).toBeUndefined();
			raw.send({ kind: "retry", hold: 7, hops: 5 });
			// Forwarded with its budget as it is: a relay visits no object.
			expect(await worker.next("retry")).toEqual({ kind: "retry", origin: 1, hold: 7, hops: 5 });
		});

		it("forward a call's old-work flag from a trusted downstream link only (a page cannot claim old work)", async () => {
			const { raw, server, workers } = await rawRelay();
			holdPlaced(raw, 0);
			const worker = await workerAt(workers);
			bindPlaced(worker, await worker.next("hold"));
			await raw.next("bound");
			raw.send({ kind: "call", call: 0, hold: 0, method: wait, old: true });
			expect((await worker.next("call")).old).toBeUndefined();
			const trusted = rawTab(server, undefined, true);
			holdPlaced(trusted, 0);
			bindPlaced(worker, await worker.next("hold"));
			await trusted.next("bound");
			trusted.send({ kind: "call", call: 0, hold: 0, method: wait, old: true });
			expect(await worker.next("call")).toMatchObject({ call: 0, origin: 2, old: true });
		});

		it("give each downstream link its own origin, never reused", async () => {
			const { raw, server, workers } = await rawRelay();
			holdPlaced(raw, 0);
			const worker = await workerAt(workers);
			const one = await worker.next("hold");
			const other = rawTab(server);
			holdPlaced(other, 0);
			const two = await worker.next("hold");
			expect([one.origin, two.origin]).toEqual([1, 2]);
			other.close();
			await transported();
			holdPlaced(rawTab(server), 0);
			expect((await worker.next("hold")).origin).toBe(3);
		});

		it("drop entries, notices and replies for holds of the origin relayed over another link", async () => {
			const { raw, workers } = await rawRelay();
			holdPlaced(raw, 0, "S1");
			holdPlaced(raw, 1, "S2");
			const one = await workerAt(workers, 0);
			const x = await one.next("hold");
			const two = await workerAt(workers, 1);
			const y = await two.next("hold");
			expect([x.origin, y.origin]).toEqual([1, 1]);
			bindPlaced(one, x);
			await raw.next("bound");
			raw.send({ kind: "call", call: 0, hold: 0, method: wait });
			await one.next("call");
			// Worker two speaks for worker one's hold of the same tab origin.
			two.send(countState([x], 9));
			two.send({ kind: "loading", origin: 1, hold: 0 });
			two.send({ kind: "result", origin: 1, call: 0 });
			two.send({
				kind: "gone",
				origin: 1,
				hold: 0,
				error: { kind: "chord", error: { code: "unavailable", message: "forged" } },
			});
			bindPlaced(two, x);
			await transported();
			expect(raw.kinds()).toEqual(["hello"]);
			// Its windowed messages, left empty, are acknowledged to it at once.
			expect(two.kinds().filter((kind) => kind === "ack")).toEqual(["ack", "ack"]);
			// A message with its own hold and the other's: only its own entry is forwarded.
			bindPlaced(two, y);
			await raw.next("bound");
			two.send({ kind: "state", origin: 1, holds: [...countState([x], 9).holds, ...countState([y], 3).holds] });
			const state = await raw.next("state");
			expect(state.holds.map(({ hold }) => hold)).toEqual([1]);
			one.send({ kind: "result", origin: 1, call: 0 });
			expect(await raw.next("result")).toMatchObject({ call: 0 });
		});

		it("ignore answers for an origin from a link it relayed nothing to", async () => {
			const { raw, server, workers } = await rawRelay();
			holdPlaced(raw, 0);
			const worker = await workerAt(workers);
			const held = await worker.next("hold");
			// Another tab speaks for the first tab's origin on its own link.
			const other = rawTab(server);
			await transported();
			bindPlaced(other, held);
			await transported();
			expect(raw.kinds()).toEqual(["hello"]);
			bindPlaced(worker, held);
			await raw.next("bound");
		});
	});

	describe("parts at a relay", () => {
		it("are never parsed: params, snapshots, ops, arguments and results travel as they came", async () => {
			const { raw, workers } = await rawRelay();
			await transported();
			const before = parses.count;
			holdPlaced(raw, 0);
			const worker = await workerAt(workers);
			const held = await worker.next("hold");
			bindPlaced(worker, held, 1);
			await raw.next("bound");
			worker.send(countState([held], 2));
			await raw.next("state");
			raw.send({ kind: "call", call: 0, hold: 0, method: add, args: jsonPart({ text: "x" }) });
			await worker.next("call");
			worker.send({ kind: "result", origin: held.origin, call: 0, value: "2" });
			await raw.next("result");
			expect(parses.count).toBe(before);
		});
	});

	describe("the window through a relay", () => {
		it("forwards every bound and state at once and relays each ack to its worker", async () => {
			const workers: RawPeer[] = [];
			const relay = await relayed({ resolve: rawWorkers(workers, { ack: false }) });
			const [a, b] = memoryLinkPair();
			relay.server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
			const tab = new RawPeer(b, { ack: false });
			holdPlaced(tab, 0);
			const worker = await workerAt(workers);
			const held = await worker.next("hold");
			bindPlaced(worker, held);
			for (const count of [1, 2, 3]) worker.send(countState([held], count));
			await transported();
			// The relay holds nothing back: the worker's window for this origin is the limit.
			expect(tab.kinds()).toEqual(["hello", "bound", "state", "state", "state"]);
			expect(worker.kinds().filter((kind) => kind === "ack")).toEqual([]);
			tab.ack();
			tab.ack();
			await transported();
			expect(worker.received.filter(({ kind }) => kind === "ack")).toEqual([
				{ kind: "ack", origin: held.origin },
				{ kind: "ack", origin: held.origin },
			]);
		});

		it("acknowledges to the right worker in order: two workers sharing one tab", async () => {
			const workers: RawPeer[] = [];
			const relay = await relayed({ resolve: rawWorkers(workers, { ack: false }) });
			const [a, b] = memoryLinkPair();
			relay.server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
			const tab = new RawPeer(b, { ack: false });
			holdPlaced(tab, 0, "S1");
			const one = await workerAt(workers, 0);
			const x = await one.next("hold");
			holdPlaced(tab, 1, "S2");
			const two = await workerAt(workers, 1);
			const y = await two.next("hold");
			bindPlaced(one, x);
			await transported();
			bindPlaced(two, y);
			await transported();
			tab.ack();
			await transported();
			expect(one.kinds().filter((kind) => kind === "ack")).toEqual(["ack"]);
			expect(two.kinds().filter((kind) => kind === "ack")).toEqual([]);
			tab.ack();
			await transported();
			expect(two.kinds().filter((kind) => kind === "ack")).toEqual(["ack"]);
		});

		it("never tears a commit: a slow tab's states fold at the worker, a derive over two holds sees both at one moment (race 21)", async () => {
			const Pair = local("app.pair", { version: 1, params: {}, members: { pair: str() } });
			const relay = await relayed();
			const seen: string[] = [];
			const tab = createHost<TestPrincipal>({ onError: () => {} });
			const [a, b] = memoryLinkPair();
			relay.server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
			const slow = pausable(b);
			tab.connect(slow.link, { principal: { kind: "server" }, codec: testCodec() }, context);
			await tab.load(
				[
					{
						name: "@test/pair",
						facet: defineFacet<TestPrincipal>((h) =>
							h.serve(Pair, (_, self) => {
								const one = self.get(PlacedNotes, { session: "S1" });
								const two = self.get(PlacedNotes, { session: "S1" });
								return {
									pair: self.derive([one.count, two.count], ([x, y]) => {
										seen.push(`${x}/${y}`);
										return `${x}/${y}`;
									}),
								};
							}),
						),
					},
				],
				context,
			);
			const view = await tab.get(Pair, {}, context);
			const watch = await view.pair.watch(context);
			watch.start(async () => {});
			const worker = relay.workers.get("session|S1")!;
			slow.pause();
			slow.kinds.length = 0;
			for (const text of ["a", "b", "c", "d", "e"]) await addNote(worker, "S1", text);
			await transported();
			// Two states in the tab origin's window at the worker, the other commits folded there.
			expect(slow.kinds).toEqual(["state", "state"]);
			slow.resume();
			await transported();
			await transported();
			expect(view.pair.value).toBe("5/5");
			expect(slow.kinds).toEqual(["state", "state", "state"]);
			expect(seen.every((pair) => pair.split("/")[0] === pair.split("/")[1])).toBe(true);
			expect(relay.errors.server).toEqual([]);
		});
	});

	describe("a relayed answer after the relay's own state (decision \"A call's answer follows its state\")", () => {
		it("forwards a worker's result after the state the relay's own objects keep waiting for the tab; every ack reaches its sender", async () => {
			const workers: RawPeer[] = [];
			const relay = await relayed({
				server: (h) => void serveNotes(h),
				resolve: rawWorkers(workers, { ack: false }),
			});
			const [a, b] = memoryLinkPair();
			relay.server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
			const tab = new RawPeer(b, { ack: false });
			const { name: type, version, fingerprint } = Notes;
			const params = jsonPart({ session: "S1" });
			tab.send({ kind: "hold", hold: 0, type, version, fingerprint, params, address: SERVER_ADDRESS });
			await tab.next("bound");
			holdPlaced(tab, 1);
			const worker = await workerAt(workers);
			const held = await worker.next("hold");
			bindPlaced(worker, held);
			await tab.next("bound");
			// The relay's own window for the tab: its bound and this state; the next commit waits.
			await addNote(relay.server, "S1", "a");
			await addNote(relay.server, "S1", "b");
			tab.send({ kind: "call", call: 0, hold: 1, method: add, args: jsonPart({ text: "x" }) });
			const forwarded = await worker.next("call");
			worker.send({ kind: "result", ...originOf(held), call: forwarded.call, value: jsonPart(1) });
			await transported();
			expect(tab.kinds()).toEqual(["hello", "state", "state", "result"]);
			const waited = tab.received.filter((message) => message.kind === "state").at(-1)!;
			expect(waited.holds.map(({ hold, members }) => [hold, EDITOR.named(members).count])).toEqual([
				[0, [["r", 2]]],
			]);
			// Four messages in flight to the tab, one of them the worker's: its ack goes to the worker, the others free the
			// relay's own window (the state past it included).
			for (const _ of [0, 1, 2, 3]) tab.ack();
			await transported();
			expect(worker.kinds().filter((kind) => kind === "ack")).toEqual(["ack"]);
			for (const text of ["c", "d", "e"]) await addNote(relay.server, "S1", text);
			await transported();
			expect(tab.kinds().filter((kind) => kind === "state")).toHaveLength(4);
		});
	});

	describe('relayed calls in the upstream window (decision "Call windows only for untrusted links")', () => {
		/** A raw tab holding `PlacedNotes` S1 bound through the relay at a raw worker announcing 2 calls; `ack` as `rawTab`. */
		async function bound(options: { readonly trusted?: boolean; readonly ack?: boolean } = {}) {
			const workers: RawPeer[] = [];
			const relay = await relayed({ resolve: rawWorkers(workers, { calls: 2 }) });
			const raw = rawTab(relay.server, undefined, options.trusted, options.ack);
			holdPlaced(raw, 0);
			const worker = await workerAt(workers);
			const held = await worker.next("hold");
			bindPlaced(worker, held);
			await raw.next("bound");
			if (options.ack === false) raw.ack();
			return { ...relay, raw, workers, worker, held };
		}

		/** Sends calls `ids` of hold `hold` from the raw tab. */
		function callFrom(raw: RawPeer, ids: readonly number[], hold = 0): void {
			for (const call of ids) raw.send({ kind: "call", call, hold, method: wait });
		}

		it("wait per upstream window: the worker's 2 of five calls, the rest in order as answers free slots", async () => {
			const { raw, worker, held } = await bound();
			callFrom(raw, [0, 1, 2, 3, 4]);
			await transported();
			expect(callsOf(worker)).toEqual([0, 1]);
			worker.send({ kind: "result", ...originOf(held), call: 0 });
			worker.send({ kind: "error", ...originOf(held), call: 1, error: wireChord("unavailable", "no") });
			await transported();
			expect(callsOf(worker)).toEqual([0, 1, 2, 3]);
			expect(answersOf(raw)).toEqual([
				[0, "ok"],
				[1, "no"],
			]);
			expect(raw.closed).toBe(false);
		});

		it("wait per upstream window from a trusted downstream link too: none announced to the tab, 2 upstream", async () => {
			const { raw, worker } = await bound({ trusted: true });
			expect(raw.received.find(({ kind }) => kind === "hello")).not.toHaveProperty("calls");
			callFrom(
				raw,
				Array.from({ length: 20 }, (_, call) => call),
			);
			await transported();
			expect(callsOf(worker)).toEqual([0, 1]);
			expect(raw.closed).toBe(false);
		});

		it("abort: a waiting call leaves the queue unsent; a forwarded one is aborted upstream and frees its slot", async () => {
			const { raw, worker, held } = await bound();
			callFrom(raw, [0, 1, 2, 3]);
			await transported();
			raw.send({ kind: "abort", call: 2 });
			raw.send({ kind: "abort", call: 0 });
			await transported();
			expect(callsOf(worker)).toEqual([0, 1, 3]);
			expect(worker.received.filter(({ kind }) => kind === "abort")).toEqual([
				{ kind: "abort", ...originOf(held), call: 0 },
			]);
		});

		it("release: the hold's waiting calls go unsent, its forwarded ones free their slots for the origin's others", async () => {
			const { raw, worker, held } = await bound();
			holdPlaced(raw, 1);
			const other = await worker.next("hold");
			bindPlaced(worker, other);
			await raw.next("bound");
			callFrom(raw, [0, 1]);
			callFrom(raw, [2], 1);
			callFrom(raw, [3]);
			await transported();
			expect(callsOf(worker)).toEqual([0, 1]);
			raw.send({ kind: "release", hold: 0 });
			await transported();
			expect(worker.received.filter(({ kind }) => kind === "release")).toEqual([
				{ kind: "release", ...originOf(held), hold: 0 },
			]);
			expect(callsOf(worker)).toEqual([0, 1, 2]);
			// The release first: the upstream counts the released hold's forwarded calls until it arrives.
			const order = worker.received.flatMap((message) =>
				message.kind === "release" ? ["release"] : message.kind === "call" ? [`call ${message.call}`] : [],
			);
			expect(order).toEqual(["call 0", "call 1", "release", "call 2"]);
		});

		it("a downstream close: waiting calls never go, the worker gets one closed", async () => {
			const { raw, worker, held } = await bound();
			callFrom(raw, [0, 1, 2]);
			await transported();
			raw.close();
			await transported();
			expect(callsOf(worker)).toEqual([0, 1]);
			const ends = worker.received.filter(({ kind }) => ["release", "abort", "closed"].includes(kind));
			expect(ends).toEqual([{ kind: "closed", origin: held.origin }]);
		});

		it("an upstream drop: forwarded and waiting calls fail unavailable, none sent on the next link", async () => {
			const { raw, workers, worker } = await bound();
			callFrom(raw, [0, 1, 2, 3]);
			await transported();
			worker.close();
			await transported();
			expect(answersOf(raw).map(([call]) => call)).toEqual([0, 1, 2, 3]);
			expect(raw.received.filter(({ kind }) => kind === "loading")).toHaveLength(1);
			const next = await workerAt(workers, 1);
			bindPlaced(next, await next.next("hold"));
			await raw.next("bound");
			await transported();
			expect(callsOf(next)).toEqual([]);
		});

		it("loading: the waiting calls are rejected unavailable, the forwarded ones kept; a bound of another variant gets none of them", async () => {
			const { raw, worker, held } = await bound();
			callFrom(raw, [0, 1, 2, 3]);
			await transported();
			worker.send({ kind: "loading", ...originOf(held), hold: held.hold });
			await transported();
			expect(answersOf(raw)).toEqual([
				[2, "hold 0: rebinding"],
				[3, "hold 0: rebinding"],
			]);
			expect(raw.received.filter(({ kind }) => kind === "loading")).toHaveLength(1);
			bindPlaced(worker, held, 0, READER);
			worker.send({ kind: "result", ...originOf(held), call: 0 });
			await transported();
			expect(callsOf(worker)).toEqual([0, 1]);
			expect(answersOf(raw).at(-1)).toEqual([0, "ok"]);
		});

		it("a call crossing the loading notice, still waiting when the new bound's ack passes: rejected before the ack goes up", async () => {
			const { raw, worker, held } = await bound({ ack: false });
			callFrom(raw, [0, 1]);
			await transported();
			worker.send({ kind: "loading", ...originOf(held), hold: held.hold });
			await transported();
			// The tab had not learnt of the loading when it called: the old indexes.
			callFrom(raw, [2]);
			await transported();
			bindPlaced(worker, held, 0, READER);
			await raw.next("bound");
			await transported();
			expect(answersOf(raw)).toEqual([]);
			const acks = worker.received.filter(({ kind }) => kind === "ack").length;
			raw.ack();
			await transported();
			expect(answersOf(raw)).toEqual([[2, "hold 0: rebound"]]);
			expect(worker.received.filter(({ kind }) => kind === "ack")).toHaveLength(acks + 1);
			// Made with the new binding: it waits and goes as a slot frees.
			callFrom(raw, [3]);
			worker.send({ kind: "result", ...originOf(held), call: 0 });
			await transported();
			expect(callsOf(worker)).toEqual([0, 1, 3]);
		});

		it("failed and gone: the waiting calls are rejected with their cause", async () => {
			const { raw, worker, held } = await bound();
			holdPlaced(raw, 1);
			const other = await worker.next("hold");
			bindPlaced(worker, other);
			await raw.next("bound");
			callFrom(raw, [0, 1]);
			callFrom(raw, [2]);
			callFrom(raw, [3], 1);
			await transported();
			const cause = { kind: "waiting" as const, error: wireChord("unavailable", "parked") };
			worker.send({ kind: "failed", ...originOf(held), hold: held.hold, cause });
			worker.send({ kind: "gone", ...originOf(other), hold: other.hold, error: wireChord("unavailable", "ended") });
			await transported();
			expect(answersOf(raw)).toEqual([
				[2, "parked"],
				[3, "ended"],
			]);
			expect(callsOf(worker)).toEqual([0, 1]);
		});
	});

	describe("an upstream drop", () => {
		fakeTimers();

		it("sends loading downstream, fails relayed calls unavailable, holds again with the same id and forwards the new bound, another variant allowed (race 12)", async () => {
			const { tab, workers, errors } = await rawRelay();
			const got = tab.get(PlacedNotes, { session: "S1" }, context);
			const first = await workerAt(workers);
			const held = await first.next("hold");
			bindPlaced(first, held, 1);
			const notes = await got;
			expect(notes.variant).toBe("editor");
			const call = notes.wait(context);
			await first.next("call");
			first.close();
			expect(await rejection(call)).toMatchObject({ code: "unavailable" });
			await transported();
			// The link had completed its handshake: its address resolves again at once (no timer, slice 10 R2).
			expect(notes.state.value).toEqual({ kind: "loading" });
			const second = await workerAt(workers, 1);
			const again = await second.next("hold");
			expect(again).toMatchObject({ hold: held.hold, origin: held.origin });
			bindPlaced(second, again, 4, READER);
			await transported();
			expect(notes.state.value).toEqual({ kind: "live" });
			expect(notes.variant).toBe("reader");
			expect(notes.count.value).toBe(4);
			expect(errors.tab).toEqual([]);
		});

		it("answers a call that crossed the loading notice unavailable (race 13)", async () => {
			// The address's next resolve never settles: the relayed hold has no upstream link when the call arrives.
			const workers: RawPeer[] = [];
			const resolve = rawWorkers(workers);
			const relay = await relayed({
				resolve: (address) => (workers.length === 0 ? resolve(address) : new Promise<never>(() => {})),
			});
			const raw = rawTab(relay.server);
			holdPlaced(raw, 0);
			const worker = await workerAt(workers);
			bindPlaced(worker, await worker.next("hold"));
			await raw.next("bound");
			worker.close();
			await transported();
			raw.send({ kind: "call", call: 0, hold: 0, method: wait });
			expect(await raw.next("loading")).toEqual({ kind: "loading", hold: 0 });
			expect((await raw.next("error")).error).toMatchObject({ error: { code: "unavailable" } });
		});
	});

	describe("a parent link that is down (audit)", () => {
		it("holds a hold arriving meanwhile on the parent path: it waits loading and binds on the next parent link", async () => {
			// The middle host relays its tab's holds to its parent, which reaches it over a route: origins arrive only on
			// parent and route links (decision "Origins only from relays").
			const middle = createHost<TestPrincipal>({
				address: Session({ id: "M" }),
				principal: { kind: "worker", session: "M" },
				onError: () => {},
			});
			await middle.load([], context);
			const server = createHost<TestPrincipal>({
				address: Server(),
				principal: { kind: "server" },
				onError: () => {},
			});
			const links: Link[] = [];
			let gate = Promise.resolve();
			server.route(
				Session,
				{
					authorize: () => true,
					resolve: async () => {
						await gate;
						const [a, b] = memoryLinkPair();
						middle.connect(b, { principal: { kind: "server" }, codec: testCodec() }, context);
						links.push(a);
						return { link: a, principal: { kind: "worker", session: "M" }, codec: testCodec() };
					},
				},
				context,
			);
			await server.load(
				[{ name: "@test/app", facet: defineFacet<TestPrincipal>((h) => void serveNotes(h)) }],
				context,
			);
			// The server holds something at the middle's address: its route link exists while it does.
			const anchor = server.hold(PlacedNotes, { session: "M" }, context);
			await transported();
			// The next resolve waits: the middle's parent path is down meanwhile.
			let admit: () => void = () => {};
			gate = new Promise<void>((resolve) => {
				admit = resolve;
			});
			links[0]!.close();
			await transported();
			const tab = createHost<TestPrincipal>({ onError: () => {} });
			await tab.load([], context);
			const [a, b] = memoryLinkPair();
			middle.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
			tab.connect(b, { principal: { kind: "server" }, codec: testCodec() }, context);
			const notes = tab.hold(Notes, { session: "S1" }, context);
			await transported();
			expect(notes.state.value).toEqual({ kind: "loading" });
			admit();
			await transported();
			await transported();
			expect(notes.state.value).toEqual({ kind: "live" });
			anchor.release();
		});
	});

	describe("a downstream release", () => {
		it("before the upstream hold was sent drops it; after, releases it upstream; messages crossing it are dropped (race 14)", async () => {
			let finish: () => void = () => {};
			const workers: RawPeer[] = [];
			const make = rawWorkers(workers);
			const { server } = await relayed({
				resolve: async (address) => {
					await new Promise<void>((resolve) => {
						finish = resolve;
					});
					return make(address);
				},
			});
			const raw = rawTab(server);
			holdPlaced(raw, 0);
			await transported();
			raw.send({ kind: "release", hold: 0 });
			holdPlaced(raw, 1);
			await transported();
			finish();
			const worker = await workerAt(workers);
			const sent = await worker.next("hold");
			expect(sent.hold).toBe(1);
			await transported();
			expect(worker.kinds()).toEqual(["hello"]);
			raw.send({ kind: "release", hold: 1 });
			expect(await worker.next("release")).toEqual({ kind: "release", origin: sent.origin, hold: 1 });
			bindPlaced(worker, sent);
			worker.send(countState([sent], 1));
			await transported();
			// The origin held nothing more: its record went and the worker was told `closed` (decision "Origins only from
			// relays"); what crossed it is dropped (Q1).
			expect(raw.kinds()).toEqual(["hello"]);
			expect(worker.received.filter(({ kind }) => kind === "closed")).toEqual([
				{ kind: "closed", origin: sent.origin },
			]);
		});
	});

	describe("a downstream drop", () => {
		it("closes its origin upstream: one closed per worker, no release or cancel (race 15)", async () => {
			const { raw, workers } = await rawRelay();
			holdPlaced(raw, 0, "S1");
			holdPlaced(raw, 1, "S2");
			const one = await workerAt(workers, 0);
			const held = await one.next("hold");
			const two = await workerAt(workers, 1);
			await two.next("hold");
			bindPlaced(one, held);
			await raw.next("bound");
			raw.send({ kind: "call", call: 0, hold: 0, method: wait });
			await one.next("call");
			raw.close();
			await transported();
			for (const worker of [one, two]) {
				const ends = worker.received.filter(({ kind }) => ["release", "abort", "closed"].includes(kind));
				expect(ends).toEqual([{ kind: "closed", origin: held.origin }]);
			}
		});
	});

	describe("gone from upstream", () => {
		it("is forwarded and the relayed hold forgotten (race 16)", async () => {
			const { tab, workers } = await rawRelay();
			const got = tab.get(PlacedNotes, { session: "S1" }, context);
			const worker = await workerAt(workers);
			const held = await worker.next("hold");
			bindPlaced(worker, held);
			const notes = await got;
			const watch = await notes.count.watch(context);
			worker.send({
				kind: "gone",
				...originOf(held),
				hold: held.hold,
				error: { kind: "chord", error: { code: "unavailable", message: "revoked" } },
			});
			expect(await watch.closed).toEqual({ kind: "ended" });
			expect(() => notes.count.value).toThrow("revoked");
			// A state crossing the gone reaches the tab, which ignores it; nothing closes.
			worker.send(countState([held], 9));
			await transported();
			expect(worker.closed).toBe(false);
		});
	});

	describe("GC at a relay", () => {
		it("a released relayed hold and a closed downstream link keep no relay state", async () => {
			const { refs, server } = await (async () => {
				const { raw, workers, server } = await rawRelay();
				const made = relayedHolds.length;
				holdPlaced(raw, 0);
				holdPlaced(raw, 1);
				const worker = await workerAt(workers);
				const one = await worker.next("hold");
				bindPlaced(worker, one);
				await raw.next("bound");
				raw.send({ kind: "call", call: 0, hold: 0, method: wait });
				await worker.next("call");
				raw.send({ kind: "release", hold: 0 });
				raw.close();
				await transported();
				return { refs: relayedHolds.slice(made), server };
			})();
			expect(refs).toHaveLength(2);
			await expectCollected(...refs);
			expect(server).toBeDefined();
		});
	});
});

describe("received buffers at a relay", () => {
	it("are not kept by the parts of a relayed hold after its message was handled", async () => {
		const workers: RawPeer[] = [];
		const { server } = await relayed({ resolve: rawWorkers(workers) });
		const [a, b] = memoryLinkPair();
		const buffers: WeakRef<ArrayBufferLike>[] = [];
		const listening: Link = {
			send: (message) => a.send(message),
			close: () => a.close(),
			onClose: (listener) => a.onClose(listener),
			onMessage: (listener) =>
				a.onMessage((message) => {
					buffers.push(new WeakRef(message.buffer));
					listener(message);
				}),
		};
		server.accept(listening, { principal: { kind: "owner" }, codec: binaryCodec }, context);
		const tab = (() => {
			const peer = new RawPeer(b, { codec: binaryCodec });
			holdPlaced(peer, 0, "S1");
			return peer;
		})();
		const worker = await workerAt(workers);
		bindPlaced(worker, await worker.next("hold"));
		await tab.next("bound");
		expect(buffers.length).toBeGreaterThan(1);
		await expectCollected(...buffers);
		expect(relayedHolds.at(-1)?.deref()).toBeDefined();
	});
});

describe("mixed codecs", () => {
	it("relay between a binary tab link and a text route link", async () => {
		const { tab, workers } = await relayed({ codecs: { tab: binaryCodec, route: textCodec } });
		const notes = await tab.get(PlacedNotes, { session: "S1" }, context);
		await addNote(workers.get("session|S1")!, "S1", "é");
		await transported();
		expect(notes.notes.value).toEqual([{ text: "é" }]);
		if (notes.variant !== "editor") throw new Error("expected the editor");
		expect(await notes.add({ text: "b" }, context)).toBe(2);
		const { context: cancellable, cancel } = withCancel(context);
		const waiting = notes.wait(cancellable);
		cancel(new Error("stop"));
		await expect(waiting).rejects.toThrow("stop");
	});
});

/**
 * A link end whose incoming messages can be held back (a slow tab): paused, they wait; resumed, they arrive in order.
 * `kinds` lists what arrived, decoded with the test codec.
 */
function pausable(link: Link): { readonly link: Link; readonly kinds: string[]; pause(): void; resume(): void } {
	let paused = false;
	const held: Uint8Array[] = [];
	const kinds: string[] = [];
	let listener: (message: Uint8Array) => void = () => {};
	link.onMessage((message) => {
		kinds.push(testCodec().decode(message).kind);
		if (paused) held.push(message);
		else listener(message);
	});
	return {
		kinds,
		link: {
			send: (message) => link.send(message),
			close: () => link.close(),
			onClose: (close) => link.onClose(close),
			onMessage: (next) => {
				listener = next;
			},
		},
		pause: () => {
			paused = true;
		},
		resume: () => {
			paused = false;
			for (const message of held.splice(0)) listener(message);
		},
	};
}

/** A compressor that counts its inflates (`nodeCompression` underneath). */
function countingInflates(): Compression & { inflates: number } {
	const counts = {
		inflates: 0,
		deflate: (bytes: Uint8Array) => nodeCompression.deflate(bytes),
		inflate: (bytes: Uint8Array, limit: number) => {
			counts.inflates++;
			return nodeCompression.inflate(bytes, limit);
		},
	};
	return counts;
}

forEachCodec(() => {
	describe("limits and compression through a relay", () => {
		it("check an argument's size on the admitting link at the relay: too_large/part, nothing forwarded", async () => {
			const workers: RawPeer[] = [];
			const relay = await relayed({ resolve: rawWorkers(workers) });
			const [a, b] = memoryLinkPair();
			relay.server.accept(a, { principal: { kind: "owner" }, codec: testCodec(), limits: { part: 100 } }, context);
			const raw = new RawPeer(b);
			holdPlaced(raw, 0);
			const worker = await workerAt(workers);
			bindPlaced(worker, await worker.next("hold"));
			await raw.next("bound");
			raw.send({ kind: "call", call: 0, hold: 0, method: add, args: jsonPart({ text: "x".repeat(200) }) });
			expect(await raw.next("error")).toMatchObject({
				call: 0,
				error: { error: { code: "too_large", reason: "part" } },
			});
			await transported();
			expect(worker.kinds()).not.toContain("call");
		});

		it("stamp the admitting link's decoded limit on the upstream hold; a tab's own is ignored (race 12)", async () => {
			const workers: RawPeer[] = [];
			const relay = await relayed({ resolve: rawWorkers(workers) });
			const [a, b] = memoryLinkPair();
			relay.server.accept(
				a,
				{ principal: { kind: "owner" }, codec: testCodec(), limits: { decoded: 4096 } },
				context,
			);
			const raw = new RawPeer(b);
			raw.send({
				kind: "hold",
				hold: 0,
				type: PlacedNotes.name,
				version: PlacedNotes.version,
				fingerprint: PlacedNotes.fingerprint,
				params: jsonPart({ session: "S1" }),
				address: { kind: "session", params: { id: "S1" } },
				limit: 1_000_000_000,
			});
			const worker = await workerAt(workers);
			expect((await worker.next("hold")).limit).toBe(4096);
		});

		it("enforce the stamped limit where the part is decoded: the worker refuses the tab's large argument", async () => {
			const relay = await relayed({ trusted: true, limits: { decoded: 1000 } });
			const notes = await relay.tab.get(PlacedNotes, { session: "S1" }, context);
			if (notes.variant !== "editor") throw new Error("bound as the editor");
			// Within the tab link's wire limit, past its decoded limit, which the trusted worker link does not have.
			expect(await rejection(notes.add({ text: "x".repeat(2000) }, context))).toMatchObject({
				code: "too_large",
				reason: "part",
			});
			expect(await notes.add({ text: "small" }, context)).toBe(1);
		});

		it("forward deflated parts as they came: the relay inflates nothing (a counter)", async () => {
			const [server, tab] = [countingInflates(), countingInflates()];
			const relay = await relayed({ compression: { server, worker: nodeCompression, tab } });
			const notes = await relay.tab.get(PlacedNotes, { session: "S1" }, context);
			if (notes.variant !== "editor") throw new Error("bound as the editor");
			const text = "lorem ipsum ".repeat(3000);
			await notes.add({ text }, context);
			await transported();
			expect(notes.notes.value).toEqual([{ text }]);
			// The worker's state deflated once at its origin, inflated by its owner, the tab.
			expect([server.inflates, tab.inflates]).toEqual([0, 1]);
		});

		it("forward deflated parts as they came at a relay without a compressor: nothing inflated there", async () => {
			const inflated = countInflated();
			try {
				const tab = countingInflates();
				const relay = await relayed({ compression: { worker: nodeCompression, tab } });
				const notes = await relay.tab.get(PlacedNotes, { session: "S1" }, context);
				if (notes.variant !== "editor") throw new Error("bound as the editor");
				await notes.add({ text: "lorem ipsum ".repeat(3000) }, context);
				await transported();
				expect(tab.inflates).toBe(1);
				expect(inflated.bytes).toBe(0);
			} finally {
				inflated.restore();
			}
		});

		it("forward answers from upstream unchecked: the end that parses a part checks it against its own link", async () => {
			const workers: RawPeer[] = [];
			const relay = await relayed({ resolve: rawWorkers(workers, { limits: { part: 50 } }) });
			const getting = relay.tab.get(PlacedNotes, { session: "S1" }, context);
			const worker = await workerAt(workers);
			const held = await worker.next("hold");
			bindPlaced(worker, held);
			const notes = await getting;
			if (notes.variant !== "editor") throw new Error("bound as the editor");
			// A state part and a result past the route link's wire limit reach the tab, whose link has none that small.
			const ops = jsonPart([["r", 1234567890], ...Array(10).fill(["r", 7])]);
			worker.send({
				kind: "state",
				...originOf(held),
				holds: [{ hold: held.hold, members: [{ member: EDITOR.state.count!, ops }], failed: [], retired: [] }],
			});
			const added = notes.add({ text: "x" }, context);
			const call = await worker.next("call");
			worker.send({ kind: "result", ...originOf(held), call: call.call, value: jsonPart("y".repeat(60)) });
			expect(await added).toBe("y".repeat(60));
			await transported();
			expect(notes.count.value).toBe(7);
			expect(notes.state.value).toEqual({ kind: "live" });
		});

		it.each([0, 1200])(
			"detach a reference failed too_large from its route; retry %i ms after the drop places it anew, a new hold",
			async (wait) => {
				const workers: RawPeer[] = [];
				const relay = await relayed({ resolve: rawWorkers(workers, { limits: { part: 50 } }) });
				const notes = relay.server.hold(PlacedNotes, { session: "S1" }, context);
				const first = await workerAt(workers);
				const held = await first.next("hold");
				const members = [
					{ member: EDITOR.state.notes!, value: jsonPart([{ text: "z".repeat(60) }]) },
					{ member: EDITOR.state.count!, value: jsonPart(1) },
				];
				first.send({ kind: "bound", holds: [{ hold: held.hold, variant: EDITOR.variant, members, failed: [] }] });
				expect(await first.next("release")).toMatchObject({ hold: held.hold });
				expect(notes.state.value).toMatchObject({ kind: "failed", cause: { error: { code: "too_large" } } });
				// The worker's link drops: nothing holds the address, so nothing resolves it again for this reference.
				first.close();
				await new Promise((resolve) => setTimeout(resolve, wait));
				await transported();
				expect(workers).toHaveLength(1);
				// The route forgot the address: the retry places the reference anew, resolves it and holds it.
				notes.retry();
				expect(notes.state.value.kind).toBe("loading");
				for (let tries = 0; workers.length < 2 && tries < 30; tries++) await new Promise((r) => setTimeout(r, 100));
				const second = await workerAt(workers, 1);
				bindPlaced(second, await second.next("hold"), 2);
				await transported();
				expect(notes.state.value).toEqual({ kind: "live" });
				expect(notes.count.value).toBe(2);
			},
		);

		it("let a tab without a compressor inflate the worker's deflated parts asynchronously, in order", async () => {
			const relay = await relayed({ compression: { worker: nodeCompression, server: nodeCompression } });
			const notes = await relay.tab.get(PlacedNotes, { session: "S1" }, context);
			if (notes.variant !== "editor") throw new Error("bound as the editor");
			const text = "lorem ipsum ".repeat(3000);
			for (let i = 0; i < 3; i++) await notes.add({ text }, context);
			for (let i = 0; i < 100 && notes.count.value < 3; i++) await new Promise((resolve) => setTimeout(resolve, 5));
			expect(notes.notes.value).toEqual([{ text }, { text }, { text }]);
		});
	});
});

/** An `event` message from a raw worker for `held` (one entry per value), with its origin there. */
function workerEvents(held: Held, values: readonly number[], hold = held.hold): Extract<Message, { kind: "event" }> {
	return {
		kind: "event",
		...originOf(held),
		events: values.map((y) => ({ hold, member: 0, at: 1, value: jsonPart({ y }) })),
	};
}

/** The entries of the `event` messages a raw tab received, by hold and value, one list per message. */
function tabEvents(peer: RawPeer): (readonly [number, unknown])[][] {
	return peer.received.flatMap((message) =>
		message.kind === "event"
			? [message.events.map(({ hold, value }) => [hold, (partValue(value) as { y: unknown }).y] as const)]
			: [],
	);
}

/** The event acks a raw worker received, with their origins. */
function eventAcksOf(peer: RawPeer): { origin?: number; events: number }[] {
	return peer.received.flatMap((message) =>
		message.kind === "ack" && message.events !== undefined
			? [{ ...(message.origin === undefined ? {} : { origin: message.origin }), events: message.events }]
			: [],
	);
}

forEachCodec(() => {
	describe('events through a relay (decision "Events: fire-and-forget members")', () => {
		/** A server serving `Match` itself and routing sessions to raw workers, a raw tab, and the tab's holds bound. */
		async function eventRelay() {
			const workers: RawPeer[] = [];
			const probe: MatchProbe = { paddles: [], scores: [], selves: [] };
			const relay = await relayed({
				resolve: rawWorkers(workers),
				server: (h) => serveMatch(h, probe),
			});
			const raw = rawTab(relay.server);
			return { ...relay, workers, raw, probe };
		}

		/** Holds `PlacedNotes` of `session` with id `hold` from the raw tab, bound by its raw worker; the worker's view. */
		async function relayedHold(
			raw: RawPeer,
			workers: RawPeer[],
			hold: number,
			session: string,
			index: number,
		): Promise<{ readonly worker: RawPeer; readonly held: Held }> {
			holdPlaced(raw, hold, session);
			const worker = await workerAt(workers, index);
			const held = await worker.next("hold");
			bindPlaced(worker, held);
			await raw.next("bound");
			return { worker, held };
		}

		it("forward an upstream event message at once with the tab's origin, never acknowledging it themselves", async () => {
			const { raw, workers } = await eventRelay();
			const { worker, held } = await relayedHold(raw, workers, 0, "S1", 0);
			worker.send(workerEvents(held, [1, 2]));
			await transported();
			expect(tabEvents(raw)).toEqual([
				[
					[0, 1],
					[0, 2],
				],
			]);
			const forwarded = raw.received.find(({ kind }) => kind === "event") as Extract<Message, { kind: "event" }>;
			expect(forwarded.origin).toBeUndefined();
			expect(eventAcksOf(worker)).toEqual([]);
			raw.send({ kind: "ack", events: 1 });
			await transported();
			expect(eventAcksOf(worker)).toEqual([{ ...originOf(held), events: 1 }]);
		});

		it("return each ticket to its sender: the relay's own events and two workers' on one tab origin, acks spanning them", async () => {
			const { raw, workers, server, probe } = await eventRelay();
			const one = await relayedHold(raw, workers, 0, "S1", 0);
			const two = await relayedHold(raw, workers, 1, "S2", 1);
			raw.send({
				kind: "hold",
				hold: 2,
				type: Match.name,
				version: Match.version,
				fingerprint: Match.fingerprint,
				params: jsonPart({ id: 1 }),
				address: SERVER_ADDRESS,
			});
			await raw.next("bound");
			// Tickets in order: worker one, the relay's own, worker two, worker one.
			one.worker.send(workerEvents(one.held, [1]));
			await transported();
			probe.paddles[0]!.emit({ y: 2 });
			await transported();
			two.worker.send(workerEvents(two.held, [3]));
			await transported();
			one.worker.send(workerEvents(one.held, [4]));
			await transported();
			expect(tabEvents(raw).map((entries) => entries.map(([, y]) => y))).toEqual([[1], [2], [3], [4]]);
			raw.send({ kind: "ack", events: 3 });
			await transported();
			expect(eventAcksOf(one.worker)).toEqual([{ ...originOf(one.held), events: 1 }]);
			expect(eventAcksOf(two.worker)).toEqual([{ ...originOf(two.held), events: 1 }]);
			raw.send({ kind: "ack", events: 1 });
			await transported();
			expect(eventAcksOf(one.worker)).toEqual([
				{ ...originOf(one.held), events: 1 },
				{ ...originOf(one.held), events: 1 },
			]);
			expect(server).toBeDefined();
		});

		it("filter entries of holds not relayed over the link after a release: some, then all, forwarded and never acked by the relay", async () => {
			const { raw, workers } = await eventRelay();
			const { worker, held } = await relayedHold(raw, workers, 0, "S1", 0);
			holdPlaced(raw, 1, "S1");
			const other = await worker.next("hold");
			bindPlaced(worker, other);
			await raw.next("bound");
			raw.send({ kind: "release", hold: 1 });
			await worker.next("release");
			worker.send({
				...workerEvents(held, [1]),
				events: [...workerEvents(held, [1]).events, ...workerEvents(held, [2], 1).events],
			});
			worker.send(workerEvents(held, [3], 1));
			await transported();
			expect(tabEvents(raw)).toEqual([[[0, 1]], []]);
			expect(eventAcksOf(worker)).toEqual([]);
			raw.send({ kind: "ack", events: 2 });
			await transported();
			expect(eventAcksOf(worker)).toEqual([{ ...originOf(held), events: 2 }]);
		});

		it("credit two senders behind an upstream relay in order: a filtered second message behind an unconsumed first", async () => {
			// The raw worker plays a relay with two senders behind it: its acks must arrive in its messages' order.
			const { raw, workers } = await eventRelay();
			const { worker, held } = await relayedHold(raw, workers, 0, "S1", 0);
			holdPlaced(raw, 1, "S1");
			const other = await worker.next("hold");
			bindPlaced(worker, other);
			await raw.next("bound");
			raw.send({ kind: "release", hold: 1 });
			await worker.next("release");
			// The first sender's message, then the second's, all of whose entries the relay filters.
			worker.send(workerEvents(held, [1]));
			worker.send(workerEvents(held, [2], 1));
			await transported();
			// An early ack of the filtered one would credit the first sender's message, still unconsumed at the tab.
			expect(eventAcksOf(worker)).toEqual([]);
			raw.send({ kind: "ack", events: 1 });
			await transported();
			expect(eventAcksOf(worker)).toEqual([{ ...originOf(held), events: 1 }]);
			raw.send({ kind: "ack", events: 1 });
			await transported();
			expect(eventAcksOf(worker).map(({ events }) => events)).toEqual([1, 1]);
		});

		it("consume the tickets of an upstream link that dropped, never crediting its replacement", async () => {
			const { raw, workers } = await eventRelay();
			const first = await relayedHold(raw, workers, 0, "S1", 0);
			first.worker.send(workerEvents(first.held, [1]));
			await transported();
			first.worker.close();
			await transported();
			const next = await workerAt(workers, 1);
			const held = await next.next("hold");
			bindPlaced(next, held);
			await raw.next("bound");
			next.send(workerEvents(held, [2]));
			await transported();
			raw.send({ kind: "ack", events: 1 });
			await transported();
			expect(eventAcksOf(next)).toEqual([]);
			raw.send({ kind: "ack", events: 1 });
			await transported();
			expect(eventAcksOf(next)).toEqual([{ ...originOf(held), events: 1 }]);
		});

		it("retire the tab's origin only once its tickets drained: closed upstream after the last ack", async () => {
			const { raw, workers } = await eventRelay();
			const { worker, held } = await relayedHold(raw, workers, 0, "S1", 0);
			worker.send(workerEvents(held, [1]));
			await transported();
			raw.send({ kind: "release", hold: 0 });
			await worker.next("release");
			await transported();
			expect(worker.received.filter(({ kind }) => kind === "closed")).toEqual([]);
			raw.send({ kind: "ack", events: 1 });
			await transported();
			expect(worker.received.filter(({ kind }) => kind === "closed")).toEqual([
				{ kind: "closed", origin: held.origin },
			]);
		});

		it("drop the tab's tickets when it closes: one closed upstream, later events of the origin ignored", async () => {
			const { raw, workers, server } = await eventRelay();
			const { worker, held } = await relayedHold(raw, workers, 0, "S1", 0);
			worker.send(workerEvents(held, [1]));
			await transported();
			raw.close();
			await transported();
			expect(worker.received.filter(({ kind }) => kind === "closed")).toEqual([
				{ kind: "closed", origin: held.origin },
			]);
			worker.send(workerEvents(held, [2]));
			await transported();
			expect(worker.closed).toBe(false);
			expect(server).toBeDefined();
		});
	});
});

/** A worker type with an event member (placed by its session), and a server view re-exposing it. */
const PlacedMatch = remote("app.placed-match", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	variants: { player: { events: { paddle: Sample } } },
});

const Lobby = remote("app.lobby", {
	version: 1,
	params: { session: str() },
	hostAddress: () => Server(),
	variants: { player: { events: { paddle: Sample } } },
});

describe("events across real hosts", () => {
	/** A tab, a server and workers serving `PlacedMatch` (their sources in `paddles`), the server serving `Lobby`. */
	async function hosts() {
		const paddles: EventSource<Sample>[] = [];
		const relay = await relayed({
			worker: (h) =>
				h.serve(PlacedMatch, (_, _principal, self) => {
					const paddle = self.events<Sample>();
					paddles.push(paddle);
					return { variant: "player", members: { paddle } };
				}),
			server: (h) =>
				h.serve(Lobby, ({ session }, _principal, self) => ({
					variant: "player",
					members: { paddle: self.get(PlacedMatch, { session }).paddle },
				})),
		});
		return { ...relay, paddles };
	}

	it("reach a tab from a worker through the relay, and through the server's re-exposure, value and stamp unchanged", async () => {
		const { tab, paddles } = await hosts();
		const direct = await tab.get(PlacedMatch, { session: "S1" }, context);
		const lobby = await tab.get(Lobby, { session: "S1" }, context);
		const seen: string[] = [];
		const stamps = new Set<number>();
		await direct.paddle.on(({ value, at }) => {
			seen.push(`direct${value.y}`);
			stamps.add(at);
		}, context);
		await lobby.paddle.on(({ value, at }) => {
			seen.push(`lobby${value.y}`);
			stamps.add(at);
		}, context);
		// The tab's direct hold and the server's hold for the lobby are two holds on the worker's one object.
		await transported();
		paddles.at(-1)!.emit({ y: 1 });
		for (let turn = 0; turn < 4; turn++) await transported();
		expect(seen.sort()).toEqual(["direct1", "lobby1"]);
		expect(stamps.size).toBe(1);
	});
});

describe("relayed calls in a real worker's finite window", () => {
	/** A worker type whose `wait` runs until its call is aborted, each run recorded. */
	const Waiter = remote("app.waiter", {
		version: 1,
		params: { session: str(), id: int() },
		hostAddress: ({ session }) => Session({ id: session }),
		variants: { v: { methods: { wait: method(undefined, int()) } } },
	});

	it("never exceed it when a hold with a forwarded call is released: the release goes before the next call", async () => {
		const runs: number[] = [];
		const { tab, errors } = await relayed({
			workerCallWindow: 1,
			worker: (h) =>
				h.serve(Waiter, ({ id }, _principal) => ({
					variant: "v",
					members: {
						wait: async (ctx) => {
							runs.push(id);
							await untilAborted(ctx);
							return id;
						},
					},
				})),
		});
		const a = await tab.get(Waiter, { session: "S1", id: 1 }, context);
		const b = await tab.get(Waiter, { session: "S1", id: 2 }, context);
		void a.wait(context).catch(() => {});
		const second = withCancel(context);
		void b.wait(second.context).catch(() => {});
		await transported();
		// The worker's window of 1: b's call waits at the relay.
		expect(runs).toEqual([1]);
		a.release();
		await transported();
		expect(runs).toEqual([1, 2]);
		expect(errors.worker).toEqual([]);
		expect(errors.server).toEqual([]);
		expect(b.state.value).toEqual({ kind: "live" });
		second.cancel();
	});
});
