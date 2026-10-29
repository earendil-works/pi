import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../../src/context/index.ts";
import { local, str } from "../../../src/next/contracts/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";
import { type Compression, type Link, memoryLinkPair } from "../../../src/next/link/index.ts";
import { binaryCodec, jsonPart, type Message, textCodec } from "../../../src/next/link/internal.ts";
import type * as Values from "../../../src/next/link/values.ts";
import { RelayedHold } from "../../../src/next/remote/relay.ts";
import { nodeCompression } from "../../../src/next-node/compression.ts";
import {
	addNote,
	countInflated,
	EDITOR,
	expectCollected,
	fakeTimers,
	forEachCodec,
	instancesOf,
	Notes,
	PlacedNotes,
	RawPeer,
	rawWorkers,
	rejection,
	relayed,
	Server,
	serveNotes,
	type TestPrincipal,
	testCodec,
	transported,
	wireNames,
} from "../support.ts";

/** How often a part was parsed in this file, by anyone. */
const parses = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../../src/next/link/values.ts", async (importOriginal) => {
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

/** A raw tab on a new link the server accepts as `principal` (owner by default). */
function rawTab(server: Awaited<ReturnType<typeof relayed>>["server"], principal?: TestPrincipal): RawPeer {
	const [a, b] = memoryLinkPair();
	server.accept(a, { principal: principal ?? { kind: "owner" }, codec: testCodec() }, context);
	return new RawPeer(b);
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
			raw.send({ kind: "retry", hold: 7 });
			expect(await worker.next("retry")).toEqual({ kind: "retry", origin: 1, hold: 7 });
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
			expect(notes.state.value).toEqual({ kind: "loading" });
			await vi.advanceTimersByTimeAsync(1000);
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
			const { raw, workers } = await rawRelay();
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
			const server = createHost<TestPrincipal>({
				address: Server(),
				principal: { kind: "server" },
				onError: () => {},
			});
			await server.load(
				[{ name: "@test/app", facet: defineFacet<TestPrincipal>((h) => void serveNotes(h)) }],
				context,
			);
			const middle = createHost<TestPrincipal>({ principal: { kind: "server" }, onError: () => {} });
			await middle.load([], context);
			/** Connects the middle host to the server over a new link; returns the server's end. */
			const up = (): Link => {
				const [a, b] = memoryLinkPair();
				server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
				middle.connect(b, { principal: { kind: "server" }, codec: testCodec() }, context);
				return a;
			};
			const first = up();
			await transported();
			first.close();
			await transported();
			const tab = createHost<TestPrincipal>({ onError: () => {} });
			await tab.load([], context);
			const [a, b] = memoryLinkPair();
			middle.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
			tab.connect(b, { principal: { kind: "server" }, codec: testCodec() }, context);
			const notes = tab.hold(Notes, { session: "S1" }, context);
			await transported();
			expect(notes.state.value).toEqual({ kind: "loading" });
			up();
			await transported();
			expect(notes.state.value).toEqual({ kind: "live" });
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
			// The relay no longer relays the hold: dropped there (Q1), each message acknowledged to the worker at once.
			expect(raw.kinds()).toEqual(["hello"]);
			expect(worker.received.filter(({ kind }) => kind === "ack")).toHaveLength(2);
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
