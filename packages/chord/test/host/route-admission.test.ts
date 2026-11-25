// Tests of a route's admission (slice 14 §2.3; test list 15): nothing is resolved or forwarded before the first allow,
// so a denied hold starts no host; an allow binds; a denial releases the principal's holds upstream and rejects their
// calls `forbidden/revoked`; the fence after a denial (the hold forwarded again under its id only after the `pong` of a
// `ping`, everything of the released hold dropped before it; a denial before the `pong`; the link lost before it;
// three in a row); one decision per principal and address (two principals on one address, several holds sharing one,
// released with the last); a failed source; `RouteHandle.retry`; a hold behind the route's own route (`invalid/cycle`).

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../src/context/index.ts";
import { local, map, method, obj, str } from "../../src/contracts/index.ts";
import type { ChordError } from "../../src/data/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { Decision } from "../../src/host/admission.ts";
import {
	type Admission,
	allow,
	createHost,
	defineFacet,
	deny,
	type FacetHost,
	type Host,
	type RouteOptions,
} from "../../src/host/index.ts";
import { memoryLinkPair } from "../../src/link/index.ts";
import { jsonPart, type Message } from "../../src/link/internal.ts";
import { constant, type Writable } from "../../src/state/index.ts";
import { type Batch, Source } from "../../src/state/internal.ts";
import type { Watchable } from "../../src/watch.ts";
import {
	EDITOR,
	expectCollected,
	grantOf,
	instancesOf,
	NOTES_EDITOR,
	PlacedNotes,
	RawPeer,
	rawWorkers,
	rejection,
	relayed,
	Session,
	serveNotes,
	statesOf,
	type TestPrincipal,
	testCodec,
	transported,
} from "../support.ts";

/** Every decision declared while this file runs, weakly. */
const decisions = instancesOf(Decision, "declare");

const Modes = defineState("gate.modes", {
	schema: obj({ modes: map(str()) }),
	version: 1,
	initial: () => ({ modes: {} as Record<string, string> }),
});

/** Who may reach which session, by principal kind and session: the store the route's admission reads. */
const Gate = local("test.gate", {
	version: 1,
	params: {},
	members: { modes: map(str()), set: method(obj({ who: str(), mode: str() })) },
});

/** Serves `Gate` on the server. */
function serveGate(facet: FacetHost<TestPrincipal>): void {
	facet.serve(Gate, (_, self) => {
		const state = self.state(Modes);
		return {
			modes: self.derive([state], ([s]) => s.modes),
			set: async ({ who, mode }, ctx) => {
				await state.change((draft) => {
					draft.modes[who] = mode;
				}, ctx);
				return null;
			},
		};
	});
}

/** The route's admission: `yes` in the gate for the principal's kind allows; `throw` makes the decision throw. */
const admit: NonNullable<RouteOptions<TestPrincipal, typeof Session>["admit"]> = (principal, _address, self) =>
	self.derive([self.get(Gate, {}).modes], ([modes]) => {
		const mode = modes[principal.kind];
		if (mode === "throw") throw new Error("the gate threw");
		return mode === "yes" ? allow(null) : deny("no access");
	});

/** A relay whose route asks `admit`, and how the test sets a principal kind's mode. */
async function gated(options: Parameters<typeof relayed>[0] = {}) {
	const relay = await relayed({ admit, server: serveGate, ...options });
	const gate = await relay.server.get(Gate, {}, context);
	const set = (mode: string, who = "owner") => gate.set({ who, mode }, context);
	return { ...relay, set };
}

/** A client connected to `server` as `principal`. */
async function tabOf(server: Host<TestPrincipal>, principal: TestPrincipal): Promise<Host<TestPrincipal>> {
	const tab = createHost<TestPrincipal>({ onError: () => {} });
	await tab.load([], context);
	const [a, b] = memoryLinkPair();
	server.accept(a, { principal, codec: testCodec() }, context);
	tab.connect(b, { principal: { kind: "server" }, codec: testCodec() }, context);
	return tab;
}

/** `error`'s code, reason and message. */
function told(error: unknown) {
	const { code, reason, message } = error as ChordError;
	return reason === undefined ? { code, message } : { code, reason, message };
}

describe("before the first allow", () => {
	it("nothing is resolved or forwarded: a denied hold starts no host; an allow later binds it", async () => {
		const { tab, server, workers, resolves, set, errors } = await gated();
		const notes = tab.hold(PlacedNotes, { session: "S1" }, context);
		expect(notes.state.value.kind).toBe("loading");
		await transported();
		expect(notes.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "denied", error: { code: "forbidden", message: "no access" } },
		});
		expect(told(await rejection(tab.get(PlacedNotes, { session: "S1" }, context)))).toEqual({
			code: "forbidden",
			message: "no access",
		});
		expect([resolves, workers.size]).toEqual([[], 0]);
		await set("yes");
		await transported();
		expect([notes.state.value.kind, notes.count.value]).toEqual(["live", 0]);
		expect(resolves).toEqual(["session|S1"]);
		expect([errors.server, errors.tab, errors.worker]).toEqual([[], [], []]);
		await server.close(context);
	});

	it("RouteHandle.retry resolves nothing while every hold of the address is denied or undecided", async () => {
		const { tab, server, route, resolves, set } = await gated();
		const notes = tab.hold(PlacedNotes, { session: "S1" }, context);
		route.retry(Session({ id: "S1" }));
		await transported();
		route.retry(Session({ id: "S1" }));
		await transported();
		expect(notes.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		expect(resolves).toEqual([]);
		await set("yes");
		await transported();
		expect(resolves).toEqual(["session|S1"]);
		await server.close(context);
	});

	it("an admission holding a type placed behind its own route fails the hold invalid/cycle; a throwing admit breaks it", async () => {
		const cyclic = await relayed({
			admit: (_principal, address, self) => {
				const behind = self.get(PlacedNotes, { session: address.params.id });
				return self.derive([behind.count], () => allow(null));
			},
		});
		const notes = cyclic.tab.hold(PlacedNotes, { session: "S1" }, context);
		await transported();
		expect(notes.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "broken", error: { code: "invalid", reason: "cycle" } },
		});
		expect(cyclic.resolves).toEqual([]);
		await cyclic.server.close(context);

		const throwing = await relayed({
			admit: () => {
				throw new Error("admit threw");
			},
		});
		const broken = throwing.tab.hold(PlacedNotes, { session: "S1" }, context);
		await transported();
		expect(broken.state.value).toMatchObject({ kind: "failed", cause: { kind: "broken" } });
		expect((broken.state.value as { cause: { error: Error } }).cause.error.message).toContain("admit threw");
		expect(throwing.resolves).toEqual([]);
		await throwing.server.close(context);
	});
});

describe("a decision that changes while it is settled", () => {
	/** A decision that allows when first read and is denied by a commit queued in that very read. */
	class DeniedAfterItsRead extends Source {
		#decision: Admission<null> = allow(null);
		#queued = false;

		get value(): Admission<null> {
			if (!this.#queued) {
				this.#queued = true;
				queueMicrotask(() =>
					this.batch.within(() => {
						this.#decision = deny("withdrawn");
						this.changed();
					}, context),
				);
			}
			return this.#decision;
		}

		deliver(): void {}
	}

	it("is not answered with what the settle read before: a denial between the read and its continuation starts nothing", async () => {
		let source: DeniedAfterItsRead | undefined;
		const relay = await relayed({
			admit: () => {
				// The server is a `ChordHost`: its batch is what its sources commit in.
				source ??= new DeniedAfterItsRead((relay.server as unknown as { readonly batch: Batch }).batch);
				return source as unknown as Watchable<Admission<null>>;
			},
		});
		const notes = relay.tab.hold(PlacedNotes, { session: "S1" }, context);
		await transported();
		expect(notes.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		expect([relay.resolves, relay.workers.size]).toEqual([[], 0]);
		await relay.server.close(context);
	});

	// The same through an ordinary source that changes `turns` microtasks after `admit` ran: whichever step of the
	// settle the denial meets, the hold ends denied and holds nothing at a host.
	for (let turns = 0; turns < 8; turns++) {
		it(`ends denied whenever the denial arrives: ${turns} turns into the settle`, async () => {
			const Open = local("test.open", { version: 1, params: {}, members: { open: str() } });
			let flag: Writable<string> | undefined;
			const relay = await relayed({
				server: (h) =>
					h.serve(Open, (_, self) => {
						const open = self.writable("yes");
						flag = open;
						return { open: self.derive([open], ([value]) => value) };
					}),
				admit: (_principal, _address, self) => {
					let remaining = turns;
					const flip = (): void => {
						if (remaining-- > 0) queueMicrotask(flip);
						else flag?.set("no");
					};
					queueMicrotask(flip);
					return self.derive([self.get(Open, {}).open], ([open]) =>
						open === "yes" ? allow(null) : deny("closed"),
					);
				},
			});
			const notes = relay.tab.hold(PlacedNotes, { session: "S1" }, context);
			await transported();
			expect(notes.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
			expect(relay.workers.get("session|S1")?.activity.value.references ?? 0).toBe(0);
			await relay.server.close(context);
		});
	}
});

describe("a denial", () => {
	it("unbinds the principal's holds: released at the worker, replicas dropped, calls in flight forbidden/revoked", async () => {
		const { tab, server, workers, set } = await gated();
		await set("yes");
		const notes = await tab.get(PlacedNotes, { session: "S1" }, context);
		const worker = workers.get("session|S1")!;
		expect(worker.activity.value.references).toBe(1);
		const waiting = rejection(notes.wait(context));
		await transported();
		await set("no");
		expect(told(await waiting)).toMatchObject({ code: "forbidden", reason: "revoked" });
		await transported();
		expect(notes.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		expect(told(await rejection((async () => notes.count.value)()))).toEqual({
			code: "forbidden",
			message: "no access",
		});
		expect([grantOf(notes), notes.add]).toEqual([[], undefined]);
		expect(worker.activity.value.references).toBe(0);
		// Allowed again: `loading` at once, not "no access" until the hold is bound; then forwarded behind the fence (the
		// worker answers the `ping`), under the tab's hold.
		const states = statesOf(await notes.state.watch(context));
		await set("yes");
		await transported();
		expect(states).toEqual(["loading", "live"]);
		expect([notes.state.value.kind, notes.count.value]).toEqual(["live", 0]);
		expect(worker.activity.value.references).toBe(1);
		await server.close(context);
	});

	it("is per principal and address: another principal's holds on the address stay bound", async () => {
		const { tab, server, workers, set } = await gated();
		await set("yes");
		await set("yes", "guest");
		const guest = await tabOf(server, { kind: "guest", session: "S1" });
		const owners = await tab.get(PlacedNotes, { session: "S1" }, context);
		const guests = await guest.get(PlacedNotes, { session: "S1" }, context);
		expect([grantOf(owners), grantOf(guests)]).toEqual([NOTES_EDITOR, []]);
		await set("no", "guest");
		await transported();
		expect(guests.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		expect(owners.state.value.kind).toBe("live");
		expect(workers.get("session|S1")!.activity.value.references).toBe(1);
		await server.close(context);
	});
});

describe("one decision per principal and address", () => {
	it("is shared by its holds and released with the last (GC)", async () => {
		const { tab, server, set } = await gated();
		await set("yes");
		const second = await tabOf(server, { kind: "owner" });
		const before = decisions.length;
		const a = await tab.get(PlacedNotes, { session: "S1" }, context);
		const b = await second.get(PlacedNotes, { session: "S1" }, context);
		// Two holds of one principal on one address: one decision of the route (and one of its object's admission,
		// slice 15). Another address: another of each.
		expect(decisions.length - before).toBe(2);
		const other = await tab.get(PlacedNotes, { session: "S2" }, context);
		expect(decisions.length - before).toBe(4);
		a.release();
		await transported();
		// Still held by the second tab: denied with it.
		await set("no");
		await transported();
		expect(b.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		b.release();
		other.release();
		await transported();
		await expectCollected(...decisions.slice(before));
		await server.close(context);
	});

	// From the review of the hold-memory pass (2026-11-25): a decision's follows of its references end where a wait
	// under its context would, after the listeners of that context's own signal. Ended before them, the hold below
	// stayed `loading`.
	it("is still told of a reference that fails in a listener of its route's aborted context: the waiting hold shows it", async () => {
		const stopping = withCancel(context);
		const Health = local("test.health", { version: 1, params: {}, members: { status: str() } });
		let fail = (): void => {
			throw new Error("the monitor is not followed yet");
		};
		const resolving = Promise.withResolvers<void>();
		const cleaned = Promise.withResolvers<void>();
		const relay = await relayed({
			context: stopping.context,
			server: (facet) =>
				facet.serve(Health, (_, self) => ({
					status: self.follow(async (observer) => {
						fail = () => observer.end({ kind: "failed", error: new Error("the monitor stopped") });
						return { value: "ok", detach() {} };
					}),
				})),
			admit: (_principal, _address, self) => {
				self.get(Health, {});
				return constant(allow(null));
			},
			// A resolver that stops the monitor when its context is aborted, and goes on cleaning up.
			resolve: async (_address, _worker, ctx) => {
				ctx.abortSignal!.addEventListener("abort", fail, { once: true });
				resolving.resolve();
				await cleaned.promise;
				throw new Error("the resolver stopped");
			},
		});
		const hold = relay.tab.hold(PlacedNotes, { session: "S1" }, context);
		await resolving.promise;
		expect(hold.state.value.kind).toBe("loading");
		stopping.cancel();
		await transported();
		expect(hold.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		cleaned.resolve();
		hold.release();
		await relay.server.close(context);
		await relay.tab.close(context);
	});

	it("a failed source leaves bound holds alone and fails new ones waiting; it heals with the source", async () => {
		const { tab, server, set } = await gated();
		await set("yes");
		const bound = await tab.get(PlacedNotes, { session: "S1" }, context);
		await set("throw");
		await transported();
		expect(bound.state.value.kind).toBe("live");
		const second = await tabOf(server, { kind: "owner" });
		const late = second.hold(PlacedNotes, { session: "S1" }, context);
		await transported();
		expect(late.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		expect((late.state.value as { cause: { error: Error } }).cause.error.message).toContain("the gate threw");
		await set("yes");
		await transported();
		expect([bound.state.value.kind, late.state.value.kind]).toEqual(["live", "live"]);
		await server.close(context);
	});

	it("a source that fails again, and again, still leaves the holds forwarded under the last allow alone", async () => {
		const { tab, server, workers, set } = await gated();
		await set("yes");
		const bound = await tab.get(PlacedNotes, { session: "S1" }, context);
		await set("throw");
		await transported();
		// The source changes for another principal: this one's decision is read again, and throws again.
		await set("no", "guest");
		await set("yes", "guest");
		await transported();
		expect(bound.state.value.kind).toBe("live");
		expect(workers.get("session|S1")!.activity.value.references).toBe(1);
		// A denial is what takes them back.
		await set("no");
		await transported();
		expect(bound.state.value).toMatchObject({ kind: "failed", cause: { kind: "denied" } });
		await server.close(context);
	});

	it("a new link of the address holds nothing while the source is failed: forwarded holds wait until it recovers (fail closed)", async () => {
		const raw: RawPeer[] = [];
		const { tab, server, set } = await gated({ resolve: rawWorkers(raw) });
		await set("yes");
		const notes = tab.hold(PlacedNotes, { session: "S1" }, context);
		await transported();
		await set("throw");
		await transported();
		// Still held on its link: left alone.
		expect(raw[0]!.kinds().filter((kind) => kind === "release")).toEqual([]);
		raw[0]!.close();
		await transported();
		// A new link is new work at the address's host: nothing is resolved without an allow that can be read.
		expect(raw.length).toBe(1);
		expect(notes.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		expect((notes.state.value as { cause: { error: Error } }).cause.error.message).toContain("the gate threw");
		await set("yes");
		await transported();
		// The source is back with its allow: resolved, and held once.
		expect(raw[1]?.kinds()).toEqual(["hello", "hold"]);
		expect(notes.state.value.kind).toBe("loading");
		await server.close(context);
	});

	it("a source that fails while the address's link is down takes the forwarded holds back; one that only loads does not", async () => {
		const pending = Promise.withResolvers<void>();
		const raw: RawPeer[] = [];
		const workers = rawWorkers(raw);
		const { tab, server, set } = await gated({
			resolve: async (address) => {
				if (raw.length > 0) await pending.promise;
				return workers(address);
			},
		});
		await set("yes");
		const notes = tab.hold(PlacedNotes, { session: "S1" }, context);
		await transported();
		// The link drops under an allow: the hold waits for the next link, which is being resolved.
		raw[0]!.close();
		await transported();
		expect(notes.state.value.kind).toBe("loading");
		// The source fails before that link is there: the link, once made, holds nothing.
		await set("throw");
		await transported();
		expect(notes.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		pending.resolve();
		await transported();
		expect(raw[1]!.kinds()).toEqual(["hello"]);
		await set("yes");
		await transported();
		expect(raw[1]!.kinds()).toEqual(["hello", "hold"]);
		await server.close(context);
	});
});

/** A raw tab on a new link the server accepts as `principal`. */
function rawTab(server: Host<TestPrincipal>, principal: TestPrincipal): RawPeer {
	const [a, b] = memoryLinkPair();
	server.accept(a, { principal, codec: testCodec() }, context);
	return new RawPeer(b);
}

/** Sends a hold of `PlacedNotes` for S1 with id `hold`. */
function holdPlaced(peer: RawPeer, hold: number): void {
	peer.send({
		kind: "hold",
		hold,
		type: PlacedNotes.name,
		version: PlacedNotes.version,
		fingerprint: PlacedNotes.fingerprint,
		params: jsonPart({ session: "S1" }),
		address: { kind: "session", params: { id: "S1" } },
	});
}

/** A hold as a raw worker received it. */
type Held = Extract<Message, { readonly kind: "hold" }>;

/** `held`'s binding on the raw worker: an editor's grant with `count`. */
function bound(held: Held, count: number): Message {
	const members = [
		{ member: EDITOR.state.notes!, value: "[]" },
		{ member: EDITOR.state.count!, value: jsonPart(count) },
	];
	return {
		kind: "bound",
		origin: held.origin,
		holds: [{ hold: held.hold, granted: EDITOR.granted, members, failed: [] }],
	};
}

/** A `state` of `count` for `held` on the raw worker. */
function state(held: Held, count: number): Message {
	const members = [{ member: EDITOR.state.count!, ops: jsonPart([["r", count]]) }];
	return { kind: "state", origin: held.origin, holds: [{ hold: held.hold, members, failed: [], retired: [] }] };
}

/** The kinds of the messages `peer` received since `from`, without `hello`. */
function since(peer: RawPeer, from: number): string[] {
	return peer.kinds().slice(from);
}

describe("the fence after a denial", () => {
	/**
	 * A server routing to a raw worker, an owner's raw tab and a guest's, each holding S1 as its hold 0, both bound
	 * (count 0); the worker's holds by tab.
	 */
	async function fenced() {
		const raw: RawPeer[] = [];
		const relay = await gated({ resolve: rawWorkers(raw) });
		await relay.set("yes");
		await relay.set("yes", "guest");
		const owner = rawTab(relay.server, { kind: "owner" });
		const guest = rawTab(relay.server, { kind: "guest", session: "S1" });
		holdPlaced(owner, 0);
		await transported();
		holdPlaced(guest, 0);
		await transported();
		const worker = raw[0]!;
		const [mine, theirs] = worker.received.filter((message) => message.kind === "hold") as Held[];
		worker.send(bound(mine!, 0));
		worker.send(bound(theirs!, 0));
		await transported();
		expect([owner.kinds(), guest.kinds()]).toEqual([
			["hello", "bound"],
			["hello", "bound"],
		]);
		return { ...relay, raw, worker, owner, guest, mine: mine!, theirs: theirs! };
	}

	it("drops what was in transit for the released hold, and forwards it again under its id only after the pong", async () => {
		const { server, worker, owner, guest, mine, theirs, set } = await fenced();
		const call = { kind: "call", call: 7, hold: 0, method: EDITOR.methods.wait! } as const;
		owner.send(call);
		await transported();
		const seen = worker.received.length;
		await set("no");
		await transported();
		// The denial: released upstream, the call in flight answered, the hold failed.
		expect(since(worker, seen)).toEqual(["release"]);
		expect(owner.kinds().slice(2)).toEqual(["error", "failed"]);
		expect(owner.received[2]).toMatchObject({ error: { error: { code: "forbidden", reason: "revoked" } } });
		expect(owner.received[3]).toMatchObject({ cause: { kind: "denied" } });
		// What the worker sent before it saw the release, arriving now: a state, an event, the call's result.
		const stale: Message[] = [
			state(mine, 1),
			{ kind: "event", origin: mine.origin, events: [{ hold: mine.hold, member: 0, at: 1, value: jsonPart(1) }] },
			{ kind: "result", origin: mine.origin, call: 7 },
		];
		const tabSeen = owner.received.length;
		const acks = () => worker.received.filter((message) => message.kind === "ack").length;
		const acked = acks();
		for (const message of stale) worker.send(message);
		await transported();
		// An `event` message is forwarded with what is left of it (its ticket is the downstream's to return): nothing.
		expect(owner.received.slice(tabSeen)).toEqual([{ kind: "event", events: [] }]);
		// The dropped state is still acknowledged: the worker's window does not stall.
		expect(acks() - acked).toBe(1);
		await set("yes");
		await transported();
		// Allowed: the tab is told `loading` at once (the person has access again), the worker gets a `ping`, and no hold
		// before its `pong`.
		expect(since(owner, tabSeen)).toEqual(["event", "loading"]);
		expect(since(worker, seen).filter((kind) => kind !== "ack")).toEqual(["release", "ping"]);
		worker.send(state(mine, 2));
		worker.send(bound(mine, 3));
		// The other principal's hold of the same id is undisturbed meanwhile.
		worker.send(state(theirs, 5));
		await transported();
		expect(since(owner, tabSeen)).toEqual(["event", "loading"]);
		expect(guest.kinds()).toEqual(["hello", "bound", "state"]);
		worker.send({ kind: "pong" });
		await transported();
		const again = worker.received.at(-1) as Held;
		expect([again.kind, again.hold, again.origin]).toEqual(["hold", mine.hold, mine.origin]);
		worker.send(bound(again, 9));
		await transported();
		expect(since(owner, tabSeen)).toEqual(["event", "loading", "bound"]);
		await server.close(context);
	});

	it("a call that crossed the denial on the wire is answered forbidden/revoked by the relay, and forwarded nowhere", async () => {
		const { server, worker, owner, set } = await fenced();
		await set("no");
		await transported();
		const seen = worker.received.length;
		// Sent by a tab that has not read its `failed` yet.
		owner.send({ kind: "call", call: 9, hold: 0, method: EDITOR.methods.wait! });
		await transported();
		expect(owner.received.at(-1)).toMatchObject({
			kind: "error",
			call: 9,
			error: { error: { code: "forbidden", reason: "revoked", message: "hold 0: no access" } },
		});
		expect(since(worker, seen)).toEqual([]);
		await server.close(context);
	});

	it("a denial before the pong ends the fence; the next allow sends a new one", async () => {
		const { server, worker, mine, set } = await fenced();
		await set("no");
		await set("yes");
		await set("no");
		await transported();
		const seen = worker.received.length;
		// The first fence's pong: nothing is forwarded for a denied principal.
		worker.send({ kind: "pong" });
		await transported();
		expect(since(worker, seen)).toEqual([]);
		await set("yes");
		await transported();
		expect(since(worker, seen)).toEqual(["ping"]);
		worker.send({ kind: "pong" });
		await transported();
		expect((worker.received.at(-1) as Held).hold).toBe(mine.hold);
		await server.close(context);
	});

	it("deny and allow three times in a row forward the hold once, after the last pong", async () => {
		const { server, worker, set } = await fenced();
		const seen = worker.received.length;
		for (let round = 0; round < 3; round++) {
			await set("no");
			await set("yes");
		}
		await transported();
		expect(since(worker, seen)).toEqual(["release", "ping", "ping", "ping"]);
		worker.send({ kind: "pong" });
		worker.send({ kind: "pong" });
		await transported();
		expect(since(worker, seen).includes("hold")).toBe(false);
		worker.send({ kind: "pong" });
		await transported();
		expect(since(worker, seen)).toEqual(["release", "ping", "ping", "ping", "hold"]);
		await server.close(context);
	});

	it("the link lost before the pong: the next link holds what the decision allows then, with no fence", async () => {
		const { server, raw, worker, owner, set } = await fenced();
		await set("no");
		await set("yes");
		await transported();
		worker.close();
		await transported();
		const next = raw[1]!;
		// Both principals are allowed: both holds, no `ping` first.
		expect(next.kinds()).toEqual(["hello", "hold", "hold"]);
		expect(owner.closed).toBe(false);
		// Denied while the link is down: the next link holds only the other principal's.
		await set("no");
		next.close();
		await transported();
		expect(raw[2]!.kinds()).toEqual(["hello", "hold"]);
		await server.close(context);
	});
});

describe("across reloads (test 21)", () => {
	/** The server's facet again, as a new value: a reload restarts the gate's store. */
	const again = (setup: (facet: FacetHost<TestPrincipal>) => void = serveGate) => [
		{ name: "@test/server", facet: defineFacet<TestPrincipal>(setup) },
	];

	it("the source's plugin reloaded to an equal allow: no resolve, no new upstream hold, the call across it completes", async () => {
		const { tab, server, workers, resolves, set } = await gated();
		await set("yes");
		const notes = await tab.get(PlacedNotes, { session: "S1" }, context);
		const worker = workers.get("session|S1")!;
		const adding = notes.add ? notes.add({ text: "x" }, context) : undefined;
		await server.reload(again(), context);
		await transported();
		expect(await adding).toBe(1);
		expect([notes.state.value.kind, notes.count.value]).toEqual(["live", 1]);
		expect([resolves, worker.activity.value.references]).toEqual([["session|S1"], 1]);
		await server.close(context);
	});

	it("the source removed leaves bound holds alone and fails new ones; restored, its new store decides again", async () => {
		const { tab, server, set } = await gated();
		await set("yes");
		const bound = await tab.get(PlacedNotes, { session: "S1" }, context);
		await server.reload(
			again(() => {}),
			context,
		);
		await transported();
		expect(bound.state.value.kind).toBe("live");
		const second = await tabOf(server, { kind: "owner" });
		const late = second.hold(PlacedNotes, { session: "S1" }, context);
		await transported();
		expect(late.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		await server.reload(again(), context);
		await transported();
		// A new store object: its modes start over, so the principal is denied until allowed again (the fence).
		expect([bound.state.value, late.state.value]).toMatchObject([
			{ kind: "failed", cause: { kind: "denied" } },
			{ kind: "failed", cause: { kind: "denied" } },
		]);
		const gate = await server.get(Gate, {}, context);
		await gate.set({ who: "owner", mode: "yes" }, context);
		await transported();
		expect([bound.state.value.kind, late.state.value.kind]).toEqual(["live", "live"]);
		await server.close(context);
	});

	it("the source reloaded while a resolve is pending: the hold binds once the link is there", async () => {
		const pending = Promise.withResolvers<void>();
		const { tab, server, resolves, set } = await gated({
			resolve: async (_address, worker) => {
				await pending.promise;
				return worker();
			},
		});
		await set("yes");
		const notes = tab.hold(PlacedNotes, { session: "S1" }, context);
		await transported();
		await server.reload(again(), context);
		await transported();
		expect(notes.state.value.kind).toBe("loading");
		pending.resolve();
		await transported();
		expect(notes.state.value.kind).toBe("live");
		// One resolve, not one per decision change.
		expect(resolves).toEqual(["session|S1"]);
		await server.close(context);
	});

	it("an object behind the route reloaded is an ordinary rebind: no decision is asked, nothing resolved", async () => {
		const { tab, server, workers, resolves, set } = await gated();
		await set("yes");
		const notes = await tab.get(PlacedNotes, { session: "S1" }, context);
		const before = decisions.length;
		const worker = workers.get("session|S1")!;
		await worker.reload(
			[{ name: "@test/worker", facet: defineFacet<TestPrincipal>((h) => serveNotes(h, PlacedNotes)) }],
			context,
		);
		await transported();
		// The route's decision is not asked again; the object's own admission runs in its new attempt (slice 15).
		expect([notes.state.value.kind, decisions.length - before, resolves]).toEqual(["live", 1, ["session|S1"]]);
		await server.close(context);
	});
});
