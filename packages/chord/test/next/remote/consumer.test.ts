import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../../src/context/index.ts";
import { int, local, map, method, remote, str } from "../../../src/next/contracts/index.ts";
import { PluginError } from "../../../src/next/data/index.ts";
import { createHost, defineFacet, type HostError } from "../../../src/next/host/index.ts";
import { resolveWatchable } from "../../../src/next/host/reference.ts";
import { memoryLinkPair } from "../../../src/next/link/index.ts";
import { DeflatedPart, jsonPart, type Part, wireError } from "../../../src/next/link/internal.ts";
import { RemoteObject } from "../../../src/next/remote/remote-object.ts";
import { nodeCompression } from "../../../src/next-node/compression.ts";
import {
	addNote,
	bindNext,
	EDITOR,
	expectCollected,
	forEachCodec,
	framesOf,
	instancesOf,
	linked,
	metered,
	Notes,
	RawPeer,
	rawParent,
	rawProvider,
	rejection,
	serveNotes,
	testCodec,
	transported,
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
