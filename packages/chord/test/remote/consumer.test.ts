import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../src/context/index.ts";
import { type EventMember, evolve, int, local, map, method, remote, str } from "../../src/contracts/index.ts";
import { PluginError } from "../../src/data/index.ts";
import { type Ctx, createHost, defineFacet, type FacetHost, type HostError } from "../../src/host/index.ts";
import { resolveWatchable } from "../../src/host/reference.ts";
import { type Compression, memoryLinkPair, type PartLimits } from "../../src/link/index.ts";
import { DeflatedPart, jsonPart, type Part, wireError } from "../../src/link/internal.ts";
import { nodeCompression } from "../../src/node/compression.ts";
import { RemoteObject } from "../../src/remote/remote-object.ts";
import { constant } from "../../src/state/index.ts";
import {
	addNote,
	bindHold,
	bindNext,
	EDITOR,
	expectCollected,
	forEachCodec,
	framesOf,
	instancesOf,
	linked,
	Match,
	metered,
	Notes,
	PlacedNotes,
	RawPeer,
	rawParent,
	rawProvider,
	rejection,
	relayed,
	type Sample,
	SERVER_ADDRESS,
	Server,
	Session,
	serveNotes,
	type TestPrincipal,
	testCodec,
	transported,
	wireNames,
} from "../support.ts";

/** Every remote object bound while this file runs, weakly. */
const remoteObjects = instancesOf(RemoteObject, "hold");

forEachCodec(() => {
	describe("references over a link", () => {
		it("are live and hydrated when got, with the variant of the link's principal", async () => {
			const { client, server } = await linked((h) => void serveNotes(h), {
				child: { kind: "guest", session: "S1" },
			});
			await addNote(server, "S1", "a");
			const notes = await client.get(Notes, { session: "S1" }, context);
			expect(notes.variant).toBe("reader");
			expect(notes.notes.value).toEqual([{ text: "a" }]);
			expect(notes.count.value).toBe(1);
			const frames = framesOf(await notes.notes.watch(context));
			await addNote(server, "S1", "b");
			await transported();
			expect(frames).toEqual([[[{ text: "a" }, { text: "b" }], [["p", [], 1, 0, [{ text: "b" }]]]]]);
			expect(notes.count.value).toBe(2);
		});

		it("apply one state message as one batch: a derive over two members never sees half a commit", async () => {
			const View = local("app.view", { version: 1, params: {}, members: { pair: str() } });
			const { server } = await linked((h) => void serveNotes(h));
			const seen: string[] = [];
			const client = createHost({ onError: () => {} });
			// Connected first (W6): the view's factory references a server type.
			const [a, b] = memoryLinkPair();
			server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
			client.connect(b, { principal: { kind: "server" }, codec: testCodec() }, context);
			await client.load(
				[
					{
						name: "@test/view",
						facet: defineFacet((h) =>
							h.serve(View, (_, self) => {
								const notes = self.get(Notes, { session: "S1" });
								return {
									pair: self.derive([notes.notes, notes.count], ([list, count]) => {
										seen.push(`${list.length}/${count}`);
										return `${list.length}/${count}`;
									}),
								};
							}),
						),
					},
				],
				context,
			);
			const view = await client.get(View, {}, context);
			const frames = framesOf(await view.pair.watch(context));
			await addNote(server, "S1", "a");
			await addNote(server, "S1", "b");
			await transported();
			expect(frames.map(([value]) => value)).toEqual(["1/1", "2/2"]);
			expect(seen.every((pair) => pair.split("/")[0] === pair.split("/")[1])).toBe(true);
		});

		it("call methods: results, ChordErrors, PluginErrors and other throws", async () => {
			const { client } = await linked((h) => void serveNotes(h));
			const notes = await client.get(Notes, { session: "S1" }, context);
			if (notes.variant !== "editor") throw new Error("expected the editor");
			expect(await notes.add({ text: "x" }, context)).toBe(1);
			const chord = await rejection(notes.fail({ how: "chord" }, context));
			expect(chord).toEqual({ code: "forbidden", message: "not yours" });
			const plugin = await notes.fail({ how: "plugin" }, context).catch((error: unknown) => error);
			expect(plugin).toBeInstanceOf(PluginError);
			expect(plugin).toMatchObject({ code: "quota", message: "too many", details: { limit: 1 } });
			expect(await notes.fail({ how: "plain" }, context).catch((error: unknown) => error)).toMatchObject({
				name: "PluginError",
				code: "internal",
				message: "plain",
			});
			expect(await rejection(notes.add({ text: 1 } as never, context))).toMatchObject({
				code: "invalid",
				reason: "args",
			});
		});

		it("carry bytes as raw segments both ways", async () => {
			const { client } = await linked((h) => void serveNotes(h));
			const notes = await client.get(Notes, { session: "S1" }, context);
			if (notes.variant !== "editor") throw new Error("expected the editor");
			const data = new Uint8Array([1, 2, 3]);
			const echoed = await notes.echo({ data }, context);
			expect(echoed).toBeInstanceOf(Uint8Array);
			expect([...echoed]).toEqual([1, 2, 3]);
		});

		it("cancel a call: the caller is rejected at once, the provider's handler aborted", async () => {
			let probe: ReturnType<typeof serveNotes> | undefined;
			const { client } = await linked((h) => {
				probe = serveNotes(h);
			});
			const notes = await client.get(Notes, { session: "S1" }, context);
			const { context: cancellable, cancel } = withCancel(context);
			const call = notes.wait(cancellable);
			await transported();
			cancel(new Error("user cancelled"));
			await expect(call).rejects.toThrow("user cancelled");
			await transported();
			expect(probe!.waits[0]!.abortSignal?.aborted).toBe(true);
		});

		it("release: pending calls reject released, the provider aborts their handlers and lets the object go", async () => {
			let probe: ReturnType<typeof serveNotes> | undefined;
			const { client } = await linked((h) => {
				probe = serveNotes(h);
			});
			const notes = await client.get(Notes, { session: "S1" }, context);
			const watch = await notes.notes.watch(context);
			const call = notes.wait(context);
			await transported();
			notes.release();
			expect(await rejection(call)).toEqual({ code: "released", message: "app.notes(S1): released" });
			expect(await watch.closed).toEqual({ kind: "ended" });
			await transported();
			expect(probe!.waits[0]!.abortSignal?.aborted).toBe(true);
			// The object ended with its last reference: a new get runs the factory again.
			await client.get(Notes, { session: "S1" }, context);
			expect(probe!.factories).toEqual(["S1 owner", "S1 owner"]);
		});

		it("a closing link rejects sent calls unavailable; references go loading, gets keep waiting", async () => {
			const { client, peer } = await rawProvider();
			const got = client.get(Notes, { session: "S1" }, context);
			await bindNext(peer);
			const notes = await got;
			const call = notes.wait(context);
			const pending = client.get(Notes, { session: "S2" }, context, { readyTimeout: 50 });
			await peer.next("call");
			peer.close();
			expect(await rejection(call)).toEqual({ code: "unavailable", message: "the link closed" });
			expect(notes.state.value).toEqual({ kind: "loading" });
			expect(await rejection(pending)).toEqual({
				code: "unavailable",
				message: "app.notes(S2): did not become live within 50 ms",
			});
		});
	});

	describe("races at the consumer", () => {
		it("ignores a bound and a state for a hold it released, and a result crossing its cancel", async () => {
			const { client, peer, errors } = await rawProvider();
			const late = client.get(Notes, { session: "S1" }, context, { readyTimeout: 10 });
			const { hold } = await peer.next("hold");
			await expect(late).rejects.toThrow("did not become live");
			const members = [
				{ member: EDITOR.state.notes!, value: "[]" },
				{ member: EDITOR.state.count!, value: "0" },
			];
			peer.send({ kind: "bound", holds: [{ hold, variant: EDITOR.variant, members, failed: [] }] });
			peer.send({
				kind: "state",
				holds: [
					{ hold, members: [{ member: EDITOR.state.count!, ops: jsonPart([["r", 1]]) }], failed: [], retired: [] },
				],
			});
			const got = client.get(Notes, { session: "S1" }, context);
			await bindNext(peer);
			const notes = await got;
			const { context: cancellable, cancel } = withCancel(context);
			const call = notes.wait(cancellable);
			const { call: id } = await peer.next("call");
			cancel(new Error("cancelled"));
			await expect(call).rejects.toThrow("cancelled");
			await peer.next("abort");
			peer.send({ kind: "result", call: id });
			await transported();
			expect(peer.closed).toBe(false);
			expect(errors).toEqual([]);
		});
	});

	describe("protocol errors at the consumer", () => {
		it.each([
			["wire ops failing Delta's checks", [{ member: EDITOR.state.count!, ops: '[["x"]]' }]],
			["a member index outside the variant", [{ member: 9, ops: '[["r",1]]' }]],
			[
				"a member twice",
				[
					{ member: EDITOR.state.count!, ops: '[["r",1]]' },
					{ member: EDITOR.state.count!, ops: '[["r",2]]' },
				],
			],
			["a member's changes that are no list", [{ member: EDITOR.state.count!, ops: "1" }]],
			["ops that are no JSON", [{ member: EDITOR.state.count!, ops: "[" }]],
			["ops that do not apply to the member", [{ member: EDITOR.state.count!, ops: '[["s",["x"],1]]' }]],
		])("close the link: %s", async (_, members) => {
			const { client, peer, errors } = await rawProvider();
			const got = client.get(Notes, { session: "S1" }, context);
			const hold = await bindNext(peer);
			const notes = await got;
			peer.send({ kind: "state", holds: [{ hold, members, failed: [], retired: [] }] });
			await transported();
			expect(peer.closed).toBe(true);
			expect(errors.map(({ kind }) => kind)).toEqual(["protocol_error"]);
			// Nothing of the message was applied; the reference waits for the next link.
			expect(notes.state.value).toEqual({ kind: "loading" });
			expect(notes.count.value).toBe(0);
		});

		it.each([
			["a result that is no JSON", { kind: "result", call: 0, value: "{" }],
			["a $bytes reference without its segment", { kind: "result", call: 0, value: '{"$bytes":0}', segments: [] }],
			["a malformed ChordError envelope", { kind: "error", call: 0, error: { kind: "chord", error: { code: 1 } } }],
		] as const)("reject the call and close the link on a malformed reply: %s", async (_, reply) => {
			const { client, peer, errors } = await rawProvider();
			const got = client.get(Notes, { session: "S1" }, context);
			await bindNext(peer);
			const notes = await got;
			const call = notes.wait(context);
			await peer.next("call");
			peer.send(reply);
			// The text codec cannot even decode a result that is no JSON: the link closes and the call with it.
			expect(await rejection(call)).toMatchObject({ code: "unavailable" });
			expect(peer.closed).toBe(true);
			expect(errors.map(({ kind }) => kind)).toEqual(["protocol_error"]);
		});

		it("ignore a gone for a hold it does not know before reading its error (Q1)", async () => {
			const { client, peer, errors } = await rawProvider();
			const got = client.get(Notes, { session: "S1" }, context);
			await bindNext(peer);
			await got;
			peer.send({ kind: "gone", hold: 9, error: { kind: "chord", error: { code: "nope" } } });
			await transported();
			expect(peer.closed).toBe(false);
			expect(errors).toEqual([]);
		});

		it("close the link on a malformed error envelope", async () => {
			const { client, peer } = await rawProvider();
			const notes = client.hold(Notes, { session: "S1" }, context);
			const { hold } = await peer.next("hold");
			peer.send({
				kind: "failed",
				hold,
				cause: { kind: "broken", error: { kind: "chord", error: { code: "nope", message: "m" } } },
			});
			await transported();
			expect(peer.closed).toBe(true);
			expect(notes.state.value).toEqual({ kind: "loading" });
		});
	});

	describe("the wire format of a hold", () => {
		it("is the snapshot by member, then each commit's changed members with their ops", async () => {
			const { server } = await linked((h) => void serveNotes(h));
			const [a, b] = memoryLinkPair();
			server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
			const peer = new RawPeer(b);
			peer.send({
				kind: "hold",
				hold: 7,
				type: Notes.name,
				version: Notes.version,
				fingerprint: Notes.fingerprint,
				params: jsonPart({ session: "S1" }),
				address: SERVER_ADDRESS,
			});
			const [bound] = (await peer.next("bound")).holds;
			expect(bound!.variant).toBe(EDITOR.variant);
			expect(EDITOR.named(bound!.members)).toEqual({ notes: [], count: 0 });
			await addNote(server, "S1", "a");
			const state = await peer.next("state");
			expect(state.holds).toMatchObject([{ hold: 7, failed: [] }]);
			expect(EDITOR.named(state.holds[0]!.members)).toEqual({
				notes: [["p", [], 0, 0, [{ text: "a" }]]],
				count: [["r", 1]],
			});
		});
	});

	describe("cost guards at the consumer", () => {
		it("applies state without validating, walking or copying it: unchanged parts stay the same objects", async () => {
			const { context: counting, counts } = await metered();
			const { server } = await linked((h) => void serveNotes(h));
			const client = createHost({ onError: () => {} });
			await client.load([], context);
			const [a, b] = memoryLinkPair();
			server.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
			client.connect(b, { principal: { kind: "server" }, codec: testCodec() }, counting);
			await addNote(server, "S1", "a");
			const notes = await client.get(Notes, { session: "S1" }, context);
			const first = notes.notes.value[0];
			await addNote(server, "S1", "b");
			await transported();
			expect(notes.notes.value).toEqual([{ text: "a" }, { text: "b" }]);
			expect(notes.notes.value[0]).toBe(first);
			expect(counts()["chord.data.validations"]).toBeUndefined();
			expect(counts()["chord.data.walks"]).toBeUndefined();
		});
	});

	describe("GC at the consumer", () => {
		it("a closed link retained by the test, with its host, keeps no hold, replica or released reference", async () => {
			const { client, link, refs } = await (async () => {
				const { client, peer } = await rawProvider();
				const made = remoteObjects.length;
				const got = client.get(Notes, { session: "S1" }, context);
				await bindNext(peer);
				const notes = await got;
				const refs: WeakRef<object>[] = [new WeakRef(resolveWatchable(notes.notes)!), new WeakRef(notes)];
				refs.push(...remoteObjects.slice(made));
				expect(refs).toHaveLength(3);
				peer.close();
				await transported();
				// Across the drop the host keeps the reference's object for the next link; released, nothing stays.
				notes.release();
				return { client, link: peer, refs };
			})();
			await expectCollected(...refs);
			expect([client, link]).toBeDefined();
		});
	});

	describe("one state message over several holds", () => {
		const Pair = local("app.pair", { version: 1, params: {}, members: { pair: str() } });

		/** A client whose `Pair` derives over the counts of two holds (S1, S2), both bound by a raw provider. */
		async function pair() {
			const seen: string[] = [];
			const errors: HostError[] = [];
			const client = createHost({ onError: (error) => errors.push(error) });
			const [a, b] = memoryLinkPair();
			client.connect(a, { principal: { kind: "server" }, codec: testCodec() }, context);
			const peer = new RawPeer(b);
			const facet = defineFacet((h) =>
				h.serve(Pair, (_, self) => {
					const one = self.get(Notes, { session: "S1" });
					const two = self.get(Notes, { session: "S2" });
					return {
						pair: self.derive([one.count, two.count], ([x, y]) => {
							seen.push(`${x}/${y}`);
							return `${x}/${y}`;
						}),
					};
				}),
			);
			const loading = client.load([{ name: "@test/pair", facet }], context);
			await bindNext(peer);
			await bindNext(peer);
			await loading;
			const view = await client.get(Pair, {}, context);
			const frames = framesOf(await view.pair.watch(context));
			return { client, peer, seen, frames, errors, view };
		}

		it("is applied as one batch: a derive over both holds never sees half of it, a failed member included", async () => {
			const { peer, seen, frames, view } = await pair();
			const failed = [{ member: EDITOR.state.notes!, error: wireError(new PluginError("derive", "notes threw")) }];
			const count = [{ member: EDITOR.state.count!, ops: '[["r",1]]' }];
			peer.send({
				kind: "state",
				holds: [
					{ hold: 0, members: count, failed: [], retired: [] },
					{ hold: 1, members: count, failed, retired: [] },
				],
			});
			await transported();
			expect(frames.map(([value]) => value)).toEqual(["1/1"]);
			expect(seen).toEqual(["0/0", "1/1"]);
			expect(view.pair.value).toBe("1/1");
		});

		it("with a malformed later entry applies nothing and closes the link", async () => {
			const { peer, seen, frames, errors } = await pair();
			peer.send({
				kind: "state",
				holds: [
					{ hold: 0, members: [{ member: EDITOR.state.count!, ops: '[["r",1]]' }], failed: [], retired: [] },
					{ hold: 1, members: [{ member: EDITOR.state.count!, ops: '[["x"]]' }], failed: [], retired: [] },
				],
			});
			await transported();
			expect(frames).toEqual([]);
			expect(seen).toEqual(["0/0"]);
			expect(peer.closed).toBe(true);
			expect(errors.map(({ kind }) => kind)).toEqual(["protocol_error"]);
		});
	});

	describe("$bytes outside methods with bytes", () => {
		it("is plain data: {$bytes: 0} round-trips unchanged through a method without bytes", async () => {
			const Echo = remote("app.echo", {
				version: 1,
				params: {},
				hostAddress: () => Server(),
				variants: { v: { methods: { echo: method(map(int()), map(int())) } } },
			});
			const { client } = await linked((h) =>
				h.serve(Echo, () => ({ variant: "v", members: { echo: async (args) => args } })),
			);
			const echo = await client.get(Echo, {}, context);
			expect(await echo.echo({ $bytes: 0 }, context)).toEqual({ $bytes: 0 });
		});
	});
});

forEachCodec(() => {
	describe("the call window at the consumer", () => {
		/** A client connected to a raw provider announcing one concurrent call, and two bound references. */
		async function narrow() {
			const client = createHost({ onError: () => {} });
			await client.load([], context);
			const [a, b] = memoryLinkPair();
			client.connect(a, { principal: { kind: "server" }, codec: testCodec() }, context);
			const peer = new RawPeer(b, { calls: 1 });
			const one = client.get(Notes, { session: "S1" }, context);
			const first = await bindNext(peer);
			const two = client.get(Notes, { session: "S2" }, context);
			const second = await bindNext(peer);
			return { peer, one: await one, two: await two, holds: [first, second] as const };
		}

		/** The calls the provider received, by hold. */
		const calls = (peer: RawPeer) =>
			peer.received.flatMap((message) => (message.kind === "call" ? [message.hold] : []));

		it("frees a slot once when a hold with a call in flight and one waiting is released", async () => {
			const { peer, one, two, holds } = await narrow();
			const sent = one.wait(context);
			const waiting = one.wait(context);
			const other = [two.wait(context), two.wait(context)];
			await transported();
			expect(calls(peer)).toEqual([holds[0]]);
			one.release();
			expect(await rejection(sent)).toMatchObject({ code: "released" });
			expect(await rejection(waiting)).toMatchObject({ code: "released" });
			await transported();
			expect(calls(peer)).toEqual([holds[0], holds[1]]);
			expect(other).toHaveLength(2);
		});

		it("frees a slot once on gone", async () => {
			const { peer, one, two, holds } = await narrow();
			const sent = one.wait(context);
			const other = [two.wait(context), two.wait(context)];
			await transported();
			peer.send({
				kind: "gone",
				hold: holds[0],
				error: { kind: "chord", error: { code: "unavailable", message: "revoked" } },
			});
			expect(await rejection(sent)).toMatchObject({ message: "revoked" });
			await transported();
			expect(calls(peer)).toEqual([holds[0], holds[1]]);
			expect(other).toHaveLength(2);
		});

		it("sends every call at once to a peer that announced no window (a trusted link's)", async () => {
			const client = createHost({ onError: () => {} });
			await client.load([], context);
			const [a, b] = memoryLinkPair();
			client.connect(a, { principal: { kind: "server" }, codec: testCodec() }, context);
			const peer = new RawPeer(b, { calls: null });
			const got = client.get(Notes, { session: "S1" }, context);
			const hold = await bindNext(peer);
			const notes = await got;
			for (let call = 0; call < 300; call++) void notes.wait(context);
			await transported();
			expect(calls(peer)).toEqual(Array.from({ length: 300 }, () => hold));
		});

		it("sends the calls parked while rebinding after the ack of the new bound: decoded by its indexes", async () => {
			const { peer, one, holds } = await narrow();
			peer.send({ kind: "loading", hold: holds[0] });
			await transported();
			void one.wait(context);
			const before = peer.received.length;
			bindHold(peer, holds[0]);
			await transported();
			const after = peer.received.slice(before);
			expect(after.map(({ kind }) => kind)).toEqual(["ack", "call"]);
			expect(after[1]).toMatchObject({ hold: holds[0] });
		});

		it("rejects a call still waiting when its hold rebinds: unavailable (race 26)", async () => {
			const { peer, one, holds } = await narrow();
			const sent = one.wait(context);
			const waiting = one.wait(context);
			await transported();
			peer.send({ kind: "loading", hold: holds[0] });
			expect(await rejection(waiting)).toEqual({ code: "unavailable", message: `hold ${holds[0]}: rebinding` });
			const { call } = await peer.next("call");
			peer.send({ kind: "result", call });
			expect(await sent).toBe(null);
		});
	});
});

forEachCodec(() => {
	describe("limits per part at the consumer", () => {
		/** `[member, value]` of `Notes`'s editor variant: `notes` and `count`, the notes' JSON given as text. */
		const members = (notes: string): { member: number; value: Part }[] => [
			{ member: EDITOR.state.notes!, value: notes },
			{ member: EDITOR.state.count!, value: "1" },
		];

		it("rejects a call whose result is past the link's limits with too_large/part; the link stays", async () => {
			const { client, peer } = await rawProvider({ limits: { part: 50 } });
			const notes = client.hold(Notes, { session: "S1" }, context);
			await bindNext(peer);
			await transported();
			if (notes.variant !== "editor") throw new Error("bound as the editor");
			const added = notes.add({ text: "x" }, context);
			const { call } = await peer.next("call");
			peer.send({ kind: "result", call, value: jsonPart("y".repeat(60)) });
			expect(await rejection(added)).toMatchObject({ code: "too_large", reason: "part" });
			const again = notes.add({ text: "x" }, context);
			peer.send({ kind: "result", call: (await peer.next("call")).call, value: "2" });
			expect(await again).toBe(2);
		});

		it("fails a hold whose snapshot is past the limits broken, releases it, and binds the message's others", async () => {
			const { client, peer } = await rawProvider({ limits: { part: 50 } });
			const big = client.hold(Notes, { session: "S1" }, context);
			const small = client.hold(Notes, { session: "S2" }, context);
			const [one, two] = [await peer.next("hold"), await peer.next("hold")];
			const holds = [
				{
					hold: one.hold,
					variant: EDITOR.variant,
					members: members(jsonPart([{ text: "z".repeat(60) }])),
					failed: [],
				},
				{ hold: two.hold, variant: EDITOR.variant, members: members('[{"text":"a"}]'), failed: [] },
			];
			peer.send({ kind: "bound", holds });
			expect(await peer.next("release")).toEqual({ kind: "release", hold: one.hold });
			expect(await peer.next("ack")).toEqual({ kind: "ack" });
			expect(big.state.value).toMatchObject({
				kind: "failed",
				cause: { kind: "broken", error: { code: "too_large" } },
			});
			expect(small.notes.value).toEqual([{ text: "a" }]);
			// No automatic re-hold; a retry holds again.
			await transported();
			expect(peer.kinds()).toEqual([]);
			big.retry();
			expect(big.state.value.kind).toBe("loading");
			const again = await peer.next("hold");
			expect(again.hold).toBeGreaterThan(two.hold);
		});

		it("acknowledges a message waiting for its asynchronous inflate only once applied, in order (race 14)", async () => {
			const { client, peer } = await rawProvider();
			const notes = client.hold(Notes, { session: "S1" }, context);
			const { hold } = await peer.next("hold");
			const list = [{ text: "q".repeat(30_000) }];
			const value = new DeflatedPart(nodeCompression.deflate(new TextEncoder().encode(JSON.stringify(list))));
			const bound = { hold, variant: EDITOR.variant, members: [...members("[]")], failed: [] };
			bound.members[0] = { member: EDITOR.state.notes!, value };
			peer.send({ kind: "bound", holds: [bound] });
			const ops = jsonPart([["r", 2]]);
			peer.send({
				kind: "state",
				holds: [{ hold, members: [{ member: EDITOR.state.count!, ops }], failed: [], retired: [] }],
			});
			await peer.next("ack");
			expect(notes.notes.value).toEqual(list);
			await peer.next("ack");
			expect(notes.count.value).toBe(2);
		});

		it("drops a message whose asynchronous inflate is in flight when the link closes, and those behind it (race 13)", async () => {
			const { client, peer, errors } = await rawProvider();
			const notes = client.hold(Notes, { session: "S1" }, context);
			const { hold } = await peer.next("hold");
			const list = [{ text: "q".repeat(30_000) }];
			const value = new DeflatedPart(nodeCompression.deflate(new TextEncoder().encode(JSON.stringify(list))));
			const bound = { hold, variant: EDITOR.variant, members: [...members("[]")], failed: [] };
			bound.members[0] = { member: EDITOR.state.notes!, value };
			peer.send({ kind: "bound", holds: [bound] });
			peer.close();
			for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 1));
			expect(notes.state.value.kind).toBe("loading");
			expect(errors).toEqual([]);
		});

		it("inflates nothing it gave up (Q1): a corrupt deflated result of an unknown call, an entry of a released hold (both paths)", async () => {
			for (const compression of [nodeCompression, undefined]) {
				const { client, peer, errors } = await rawProvider({ compression });
				const kept = client.hold(Notes, { session: "S1" }, context);
				const released = client.hold(Notes, { session: "S2" }, context);
				const [a, b] = [await bindNext(peer), await bindNext(peer)];
				await transported();
				released.release();
				await peer.next("release");
				const corrupt = () => new DeflatedPart(new Uint8Array([255, 255, 255]));
				peer.send({ kind: "result", call: 999, value: corrupt() });
				const ops = jsonPart([["r", 4]]);
				peer.send({
					kind: "state",
					holds: [
						{ hold: b, members: [{ member: EDITOR.state.count!, ops: corrupt() }], failed: [], retired: [] },
						{ hold: a, members: [{ member: EDITOR.state.count!, ops }], failed: [], retired: [] },
					],
				});
				await peer.next("ack");
				expect(kept.count.value).toBe(4);
				expect(peer.closed).toBe(false);
				expect(errors).toEqual([]);
			}
		});

		it("checks a deflated part's wire size before inflating it: corrupt data past the limit only fails its hold", async () => {
			for (const compression of [nodeCompression, undefined]) {
				const { client, peer, errors } = await rawProvider({ compression, limits: { part: 10 } });
				const notes = client.hold(Notes, { session: "S1" }, context);
				const { hold } = await peer.next("hold");
				const value = new DeflatedPart(new Uint8Array(20).fill(255));
				peer.send({
					kind: "bound",
					holds: [
						{
							hold,
							variant: EDITOR.variant,
							members: [
								{ member: EDITOR.state.notes!, value },
								{ member: EDITOR.state.count!, value: "1" },
							],
							failed: [],
						},
					],
				});
				expect(await peer.next("release")).toEqual({ kind: "release", hold });
				expect(notes.state.value).toMatchObject({ kind: "failed", cause: { error: { code: "too_large" } } });
				expect(errors).toEqual([]);
			}
		});

		it("keeps a hold failed for a part past the limits off the next link until retry, offline retry included", async () => {
			const { client, peer } = await rawProvider({ limits: { part: 50 } });
			const notes = client.hold(Notes, { session: "S1" }, context);
			const { hold } = await peer.next("hold");
			peer.send({
				kind: "bound",
				holds: [
					{ hold, variant: EDITOR.variant, members: members(jsonPart([{ text: "z".repeat(60) }])), failed: [] },
				],
			});
			await peer.next("release");
			peer.close();
			await transported();
			const next = await rawParent(client, { part: 50 });
			await transported();
			// A reconnect holds nothing again: the failure is final until retry.
			expect(next.kinds()).toEqual([]);
			expect(notes.state.value.kind).toBe("failed");
			next.close();
			await transported();
			// A retry while offline holds it on the next link.
			notes.retry();
			expect(notes.state.value.kind).toBe("loading");
			const third = await rawParent(client);
			expect((await third.next("hold")).type).toBe(Notes.name);
		});

		it("stops an asynchronous inflate at once when the link closes: nothing of the link stays (GC)", async () => {
			// Decompression that never yields: only the close ends it.
			const streams: WeakRef<object>[] = [];
			class Stalled {
				readonly writable: WritableStream<BufferSource>;
				readonly readable: ReadableStream<Uint8Array>;
				constructor() {
					const stream = new TransformStream<BufferSource, Uint8Array>({ transform() {} });
					[this.writable, this.readable] = [stream.writable, stream.readable];
					streams.push(new WeakRef(this));
				}
			}
			vi.stubGlobal("DecompressionStream", Stalled);
			try {
				const refs = await (async () => {
					const { client, peer } = await rawProvider();
					client.hold(Notes, { session: "S1" }, context);
					const { hold } = await peer.next("hold");
					const value = new DeflatedPart(nodeCompression.deflate(new TextEncoder().encode("[]")));
					const entry = { hold, variant: EDITOR.variant, members: members("[]"), failed: [] };
					entry.members[0] = { member: EDITOR.state.notes!, value };
					peer.send({ kind: "bound", holds: [entry] });
					await transported();
					expect(streams).toHaveLength(1);
					peer.close();
					await transported();
					await client.close(context);
					return [new WeakRef(client), ...streams];
				})();
				await expectCollected(...refs);
			} finally {
				vi.unstubAllGlobals();
			}
		});

		it("fails only the hold of a state part past the limits (race 10); the others of the message apply", async () => {
			const { client, peer } = await rawProvider({ limits: { part: 50 } });
			const one = client.hold(Notes, { session: "S1" }, context);
			const two = client.hold(Notes, { session: "S2" }, context);
			const [a, b] = [await bindNext(peer), await bindNext(peer)];
			await transported();
			const ops = (count: number, pad: number) => jsonPart([["r", count], ...Array(pad).fill(["r", count])]);
			peer.send({
				kind: "state",
				holds: [
					{ hold: a, members: [{ member: EDITOR.state.count!, ops: ops(5, 10) }], failed: [], retired: [] },
					{ hold: b, members: [{ member: EDITOR.state.count!, ops: ops(7, 0) }], failed: [], retired: [] },
				],
			});
			expect(await peer.next("release")).toEqual({ kind: "release", hold: a });
			await transported();
			expect(one.state.value).toMatchObject({ kind: "failed", cause: { error: { code: "too_large" } } });
			expect(two.count.value).toBe(7);
			expect(peer.closed).toBe(false);
		});
	});
});

describe('old work across hosts (decision "Reload restarts every affected object", `call.old`)', () => {
	type Side = "server" | "worker";
	const at = { server: () => Server(), worker: () => Session({ id: "S1" }) } as const;

	/**
	 * A provider on `side` whose `work` (after its gate) calls a dependent on the other host, which holds the provider
	 * and calls its `x` back over the link: both reload at once while `work` runs. `work` runs as the worker's principal:
	 * the server's link to the worker is trusted, so the dependent's hold of the provider names it either way, and the
	 * back-call reaches the very object running `work`. When `raised`, the reload raises the provider's version (no
	 * `accepts`) and the dependent's new code needs it; `dependentFirst` reloads the dependent's host first and the
	 * provider's 50 ms later.
	 */
	async function backCall(side: Side, options: { readonly raised?: boolean; readonly dependentFirst?: boolean } = {}) {
		const { raised = false, dependentFirst = false } = options;
		const other: Side = side === "server" ? "worker" : "server";
		const Provider = remote(`app.provider-${side}`, {
			version: 1,
			params: {},
			hostAddress: at[side],
			variants: { v: { state: {}, methods: { work: method(undefined, str()), x: method(undefined, str()) } } },
		});
		const ProviderV2 = evolve(Provider, (e) => e.addState("v", "more", str()));
		const Dependent = remote(`app.dependent-${other}`, {
			version: 1,
			params: {},
			hostAddress: at[other],
			variants: { v: { state: {}, methods: { ping: method(undefined, str()) } } },
		});
		const gates: Promise<void>[] = [];
		const serve = (h: FacetHost<TestPrincipal>, onSide: Side, code: string) => {
			const P = raised && code === "v2" ? ProviderV2 : Provider;
			const more = P === ProviderV2 ? { more: constant("m") } : {};
			if (onSide === side)
				h.serve(P as typeof Provider, () => ({
					variant: "v",
					members: {
						...more,
						work: async (ctx: Ctx) => {
							await gates.shift();
							return `${code} work -> ${await (await ctx.get(Dependent, {})).ping(ctx)}`;
						},
						x: async () => `${code} x`,
					},
				}));
			else
				h.serve(Dependent, (_, _principal, self) => {
					const provider = self.get(P as typeof Provider, {});
					return {
						variant: "v",
						members: { ping: async (ctx: Ctx) => `${code} ping -> ${await provider.x(ctx)}` },
					};
				});
		};
		const workerFacet = (code: string) =>
			defineFacet<TestPrincipal>((h) => {
				serveNotes(h, PlacedNotes);
				serve(h, "worker", code);
			});
		const { tab, server, workers } = await relayed({
			trusted: true,
			server: (h) => serve(h, "server", "v1"),
			worker: (h) => serve(h, "worker", "v1"),
		});
		// The worker exists once a hold reached it.
		await tab.get(PlacedNotes, { session: "S1" }, context);
		const worker = workers.get("session|S1")!;
		const host = side === "server" ? server : worker;
		const principal: TestPrincipal = { kind: "worker", session: "S1" };
		const work = () => host.root(async (ctx) => (await ctx.get(Provider, {})).work(ctx), context, { principal });
		// A root keeps the dependent referenced (else it ends after each run, and the work would create it afresh).
		const held = Promise.withResolvers<void>();
		const kept = host.root(
			async (ctx) => {
				await ctx.get(Dependent, {});
				await held.promise;
			},
			context,
			{ principal },
		);
		expect(await work()).toBe("v1 work -> v1 ping -> v1 x");
		const gate = Promise.withResolvers<void>();
		gates.push(gate.promise);
		const running = work();
		await transported();
		const reloadServer = () =>
			server.reload(
				[{ name: "@test/server", facet: defineFacet<TestPrincipal>((h) => serve(h, "server", "v2")) }],
				context,
			);
		const reloadWorker = () => worker.reload([{ name: "@test/worker", facet: workerFacet("v2") }], context);
		const [first, second] = side === "server" ? [reloadWorker, reloadServer] : [reloadServer, reloadWorker];
		const reports = dependentFirst
			? [await first(), await new Promise((resolve) => setTimeout(resolve, 50)).then(second)]
			: await Promise.all([first(), second()]);
		expect(reports.flatMap(({ failed }) => failed)).toEqual([]);
		const opened = performance.now();
		gate.resolve();
		const answer = await running;
		const took = performance.now() - opened;
		held.resolve();
		await kept;
		await server.close(context);
		return { answer, took };
	}

	it("a back-call from the dependent on the worker runs on the server provider's open old attempt", async () => {
		const { answer, took } = await backCall("server");
		// Without the flag, `x` would wait for the provider's new attempt, which waits for this very call's drain.
		expect(answer).toBe("v1 work -> v2 ping -> v1 x");
		expect(took).toBeLessThan(1_000);
	});

	it("a back-call from the dependent on the server runs on the worker provider's open old attempt", async () => {
		const { answer, took } = await backCall("worker");
		expect(answer).toBe("v1 work -> v2 ping -> v1 x");
		expect(took).toBeLessThan(1_000);
	});

	it("the provider's version raised, which the dependent's new code needs: the work runs on the dependent's old attempt", async () => {
		for (const side of ["server", "worker"] as const) {
			const { answer, took } = await backCall(side, { raised: true });
			// The dependent's successor waits for the provider's: its old attempt stays open for the work.
			expect(answer).toBe("v1 work -> v1 ping -> v1 x");
			expect(took).toBeLessThan(1_000);
		}
	});

	it("the same with the dependent's host reloaded first: its readiness waits out the other host's version refusal", async () => {
		for (const side of ["server", "worker"] as const) {
			const { answer, took } = await backCall(side, { raised: true, dependentFirst: true });
			expect(answer).toBe("v1 work -> v1 ping -> v1 x");
			expect(took).toBeLessThan(1_000);
		}
	});
});

/** The wire's indexes of `Match`'s variants. */
const PLAYER = wireNames(Match, "player");

const WATCHER = wireNames(Match, "watcher");

/**
 * A client connected to a raw provider with `limits` and `compression`, holding `Match` bound (the player variant
 * unless `variant` says otherwise); its background errors and its telemetry's counters.
 */
async function eventClient(
	options: { readonly limits?: PartLimits; readonly compression?: Compression; readonly variant?: "watcher" } = {},
) {
	const errors: HostError[] = [];
	const telemetry = new InMemoryTelemetryContext();
	const client = createHost<TestPrincipal>({
		compression: options.compression,
		telemetry,
		onError: (error) => errors.push(error),
	});
	await client.load([], context);
	const [a, b] = memoryLinkPair();
	client.connect(a, { principal: { kind: "server" }, codec: testCodec(), limits: options.limits }, context);
	const peer = new RawPeer(b);
	const got = client.get(Match, { id: 1 }, context);
	const { hold } = await peer.next("hold");
	bindMatch(peer, hold, options.variant);
	const match = await got;
	// Every variant's members are on a reference; the paddle's subscriptions are dormant while a variant lacks it.
	const paddle = (match as unknown as { readonly paddle: EventMember<Sample> }).paddle;
	const counts = (): Record<string, number> => {
		const result: Record<string, number> = {};
		for (const { name, value, attributes } of telemetry.getMetrics()) {
			const key = attributes?.reason === undefined ? name : `${name}.${String(attributes.reason)}`;
			result[key] = (result[key] ?? 0) + value;
		}
		return result;
	};
	return { client, peer, match, paddle, hold, errors, counts };
}

/** Sends `bound` for `hold` with the player (or watcher) variant and a score of 0. */
function bindMatch(peer: RawPeer, hold: number, variant: "player" | "watcher" = "player"): void {
	const names = variant === "player" ? PLAYER : WATCHER;
	const members = [{ member: names.state.score!, value: "0" }];
	peer.send({ kind: "bound", holds: [{ hold, variant: names.variant, members, failed: [] }] });
}

/** An event entry of the paddle (or `member`) of `hold` with `y`, stamped `at`. */
function paddleEvent(hold: number, y: number, at = 1, member = PLAYER.events.paddle!) {
	return { hold, member, at, value: jsonPart({ y }) };
}

/** The event acks a raw provider received, by their counts. */
function eventAcks(peer: RawPeer): number[] {
	return peer.received.flatMap((message) =>
		message.kind === "ack" && message.events !== undefined ? [message.events] : [],
	);
}

forEachCodec(() => {
	describe('events at the consumer (decision "Events: fire-and-forget members")', () => {
		it("deliver the entries in order with their stamps, and acknowledge once per inbound turn, after the flush", async () => {
			const { peer, paddle, hold } = await eventClient();
			const seen: { value: Sample; at: number }[] = [];
			const acksAtDelivery: number[] = [];
			await paddle.on((e) => {
				seen.push(e);
				acksAtDelivery.push(eventAcks(peer).length);
			}, context);
			peer.send({ kind: "event", events: [paddleEvent(hold, 1, 10), paddleEvent(hold, 2, 11)] });
			peer.send({ kind: "event", events: [paddleEvent(hold, 3, 12)] });
			await transported();
			expect(seen).toEqual([
				{ value: { y: 1 }, at: 10 },
				{ value: { y: 2 }, at: 11 },
				{ value: { y: 3 }, at: 12 },
			]);
			expect(acksAtDelivery).toEqual([0, 0, 0]);
			expect(eventAcks(peer)).toEqual([2]);
		});

		it("acknowledge dropped entries too: an unknown hold, a member nobody listens to, a value past the part limit", async () => {
			const { peer, match, paddle, hold, counts } = await eventClient({ limits: { part: 16 } });
			const seen: unknown[] = [];
			await paddle.on(({ value }) => void seen.push(value.y), context);
			peer.send({ kind: "event", events: [paddleEvent(hold + 7, 1)] });
			peer.send({ kind: "event", events: [paddleEvent(hold, 2, 1, PLAYER.events.ball!)] });
			peer.send({
				kind: "event",
				events: [{ hold, member: PLAYER.events.paddle!, at: 1, value: jsonPart({ y: 3, pad: "x".repeat(32) }) }],
			});
			peer.send({ kind: "event", events: [paddleEvent(hold, 4)] });
			await transported();
			expect(seen).toEqual([4]);
			expect(eventAcks(peer)).toEqual([4]);
			expect(counts()["chord.events.dropped.too_large"]).toBe(1);
			// The oversized value failed nothing: the hold stays bound.
			expect(match.state.value).toEqual({ kind: "live" });
		});

		it("inflate nothing for a member nobody listens to, nor parse it; acknowledged all the same", async () => {
			const { peer, paddle, hold, counts } = await eventClient();
			const seen: unknown[] = [];
			await paddle.on(({ value }) => void seen.push(value.y), context);
			const deflated = (y: number) =>
				new DeflatedPart(nodeCompression.deflate(new TextEncoder().encode(JSON.stringify({ y }))));
			peer.send({ kind: "event", events: [{ hold, member: PLAYER.events.ball!, at: 1, value: deflated(1) }] });
			await transported();
			expect(counts()["chord.link.inflates"]).toBeUndefined();
			peer.send({ kind: "event", events: [{ hold, member: PLAYER.events.paddle!, at: 1, value: deflated(2) }] });
			// The web inflate takes a few turns of its own.
			for (let turn = 0; turn < 50 && seen.length === 0; turn++) await transported();
			await transported();
			expect(seen).toEqual([2]);
			expect(counts()["chord.link.inflates"]).toBe(1);
			expect(eventAcks(peer).reduce((sum, events) => sum + events, 0)).toBe(2);
		});

		it("close the link for a member index outside the bound version (a protocol error)", async () => {
			const { peer, hold, errors } = await eventClient();
			peer.send({ kind: "event", events: [paddleEvent(hold, 1, 1, 9)] });
			await transported();
			expect(peer.closed).toBe(true);
			expect(errors).toMatchObject([{ kind: "protocol_error" }]);
		});

		it("deliver nothing of an earlier binding: an event, a loading and a bound (the same variant, another) in one turn", async () => {
			const { peer, match, paddle, hold } = await eventClient();
			const seen: unknown[] = [];
			await paddle.on(({ value }) => void seen.push(value.y), context);
			for (const variant of ["player", "watcher"] as const) {
				peer.send({ kind: "event", events: [paddleEvent(hold, 1)] });
				peer.send({ kind: "loading", hold });
				bindMatch(peer, hold, variant);
				await transported();
			}
			expect(seen).toEqual([]);
			expect(match.variant).toBe("watcher");
		});

		it("deliver none while bound to a variant without the member, and again once a binding has it", async () => {
			const { peer, paddle, hold } = await eventClient({ variant: "watcher" });
			const seen: unknown[] = [];
			await paddle.on(({ value }) => void seen.push(value.y), context);
			peer.send({ kind: "loading", hold });
			bindMatch(peer, hold, "player");
			await transported();
			peer.send({ kind: "event", events: [paddleEvent(hold, 5)] });
			await transported();
			expect(seen).toEqual([5]);
		});

		it("keep the event window exhausted while an asynchronous inflate holds the message: acknowledged once consumed", async () => {
			const gate = Promise.withResolvers<void>();
			const Real = globalThis.DecompressionStream;
			class Held {
				readonly writable: WritableStream<BufferSource>;
				readonly readable: ReadableStream<Uint8Array>;
				constructor(format: CompressionFormat) {
					const real = new Real(format);
					this.writable = real.writable;
					this.readable = real.readable.pipeThrough(
						new TransformStream<Uint8Array, Uint8Array>({
							async transform(chunk, controller) {
								await gate.promise;
								controller.enqueue(chunk);
							},
						}),
					);
				}
			}
			vi.stubGlobal("DecompressionStream", Held);
			try {
				const { peer, paddle, hold } = await eventClient();
				const seen: unknown[] = [];
				await paddle.on(({ value }) => void seen.push(value.y), context);
				const json = new TextEncoder().encode(JSON.stringify({ y: 1 }));
				const value = new DeflatedPart(nodeCompression.deflate(json));
				peer.send({ kind: "event", events: [{ hold, member: PLAYER.events.paddle!, at: 1, value }] });
				for (let turn = 0; turn < 5; turn++) await transported();
				expect(eventAcks(peer)).toEqual([]);
				gate.resolve();
				for (let turn = 0; turn < 5 && seen.length === 0; turn++) await transported();
				await transported();
				expect(seen).toEqual([1]);
				expect(eventAcks(peer)).toEqual([1]);
			} finally {
				vi.unstubAllGlobals();
			}
		});
	});
});
