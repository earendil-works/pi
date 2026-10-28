// Tests of a host's end of a link: the handshake, checks, the heartbeat, trusted links, and in-order handling while a
// message waits for an asynchronous inflate.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, remote } from "../../../src/next/contracts/index.ts";
import { PROTOCOL_VERSION } from "../../../src/next/data/internal.ts";
import { createHost, type HostError } from "../../../src/next/host/index.ts";
import { memoryLinkPair } from "../../../src/next/link/index.ts";
import { binaryCodec, Channel, type Message, textCodec } from "../../../src/next/link/internal.ts";
import {
	bindNext,
	expectCollected,
	flushed,
	forEachCodec,
	linked,
	metered,
	Notes,
	RAW_PEER,
	RawPeer,
	rawLinked,
	rawProvider,
	testCodec,
	transported,
} from "../support.ts";

const Thing = remote("app.thing", { version: 1, params: {}, variants: { only: { state: { n: int() } } } });

const hold = {
	kind: "hold",
	hold: 0,
	type: "app.thing",
	version: 1,
	fingerprint: "0000000000000000",
	params: "{}",
} as const;

const problems = (errors: readonly HostError[]) =>
	errors.flatMap((error) => (error.kind === "protocol_error" ? [(error.error as Error).message] : []));

forEachCodec(() =>
	describe("the handshake", () => {
		it("sends hello with the protocol version and the host's incarnation first", async () => {
			const { peer } = await rawLinked(() => {});
			const hello = await peer.next("hello");
			expect(hello.protocol).toBe(PROTOCOL_VERSION);
			expect(hello.incarnation).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		});

		it("closes the link on traffic before hello", async () => {
			const { peer, errors } = await rawLinked(() => {}, { hello: false });
			peer.send(hold);
			await transported();
			expect(peer.closed).toBe(true);
			expect(problems(errors)).toEqual(["handshake: hold before hello"]);
		});

		it("closes the link on a second hello", async () => {
			const { peer, errors } = await rawLinked(() => {});
			peer.send({ kind: "hello", protocol: PROTOCOL_VERSION, incarnation: RAW_PEER, calls: 256 });
			await transported();
			expect(peer.closed).toBe(true);
			expect(problems(errors)).toEqual(["handshake: a second hello"]);
		});

		it("closes the link on another protocol version", async () => {
			const { peer, errors } = await rawLinked(() => {}, { hello: false });
			peer.send({ kind: "hello", protocol: PROTOCOL_VERSION + 1, incarnation: RAW_PEER, calls: 256 });
			await transported();
			expect(peer.closed).toBe(true);
			expect(problems(errors)).toEqual([
				`handshake: protocol ${PROTOCOL_VERSION + 1}, this host speaks ${PROTOCOL_VERSION}`,
			]);
		});

		it("closes the link on a message failing its checks", async () => {
			const { peer, errors } = await rawLinked(() => {});
			peer.sendBytes(testCodec().encode({ kind: "error", call: 0, error: { kind: "nope" } } as never));
			await transported();
			expect(peer.closed).toBe(true);
			expect(problems(errors)).toEqual(["message: fails the message schema"]);
		});

		it("queues a consumer's messages until the peer's hello; a get over a link that never greets waits for its deadline", async () => {
			const client = createHost({ onError: () => {} });
			await client.load([], context);
			const [a, b] = memoryLinkPair();
			client.connect(a, { principal: { kind: "server" }, codec: testCodec() }, context);
			const peer = new RawPeer(b, { hello: false });
			const got = client.get(Thing, {}, context, { readyTimeout: 20 });
			await flushed();
			expect(peer.kinds()).toEqual(["hello"]);
			await expect(got).rejects.toThrow("app.thing: did not become live within 20 ms");
			peer.send({ kind: "hello", protocol: PROTOCOL_VERSION, incarnation: RAW_PEER, calls: 256 });
			await transported();
			expect(peer.kinds()).toEqual(["hello", "hold", "release"]);
		});
	}),
);

describe("a codec mismatch", () => {
	it("fails the first hello as a protocol error naming the expected codec", async () => {
		const errors: HostError[] = [];
		const server = createHost({ onError: (error) => errors.push(error) });
		await server.load([], context);
		const client = createHost({ onError: () => {} });
		await client.load([], context);
		const [a, b] = memoryLinkPair();
		server.accept(a, { principal: { kind: "owner" }, codec: binaryCodec }, context);
		client.connect(b, { principal: { kind: "server" }, codec: textCodec }, context);
		await transported();
		expect(problems(errors)).toEqual(["handshake: the first message is no binary message"]);
	});
});

describe("the heartbeat", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: 0 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	/** Advances fake time by `ms` in heartbeat ticks, letting links deliver between them. */
	async function elapse(ms: number): Promise<void> {
		for (let step = 0; step < ms; step += 1500) {
			await vi.advanceTimersByTimeAsync(Math.min(1500, ms - step));
			await transported();
		}
	}

	it("closes a link whose peer never sends hello after 30 s (race 30)", async () => {
		const { peer } = await rawLinked(() => {}, { hello: false });
		await elapse(29_000);
		expect(peer.closed).toBe(false);
		await elapse(1_500);
		expect(peer.closed).toBe(true);
	});

	it("pings a silent link after 15 s and closes it after 30 s without an answer: references go loading", async () => {
		const { client, peer } = await rawProvider();
		const got = client.get(Notes, { session: "S1" }, context);
		await bindNext(peer);
		const notes = await got;
		await elapse(13_500);
		expect(peer.kinds()).not.toContain("ping");
		await elapse(3_000);
		expect(peer.kinds().filter((kind) => kind === "ping")).toEqual(["ping"]);
		await elapse(15_000);
		expect(peer.closed).toBe(true);
		expect(notes.state.value).toEqual({ kind: "loading" });
	});

	it("sends no pings on a busy link", async () => {
		const { peer } = await rawLinked(() => {});
		for (let second = 0; second < 60; second += 5) {
			peer.send({ kind: "release", hold: 99 });
			await elapse(5_000);
		}
		expect(peer.kinds()).toEqual(["hello"]);
		expect(peer.closed).toBe(false);
	});

	it("answers each ping with a pong at once; two sides pinging at once both answer", async () => {
		const { client, server } = await linked(() => {});
		await elapse(60_000);
		// Both sides pinged at 15 s and were answered: neither closed the link.
		const notes = client.hold(Notes, { session: "S1" }, context);
		await transported();
		expect(notes.state.value).toMatchObject({ kind: "failed" });
		expect(server).toBeDefined();
		const { peer } = await rawLinked(() => {});
		peer.send({ kind: "ping" });
		expect(await peer.next("pong")).toEqual({ kind: "pong" });
	});

	it("runs one timer per host, only while it has links: none per message", async () => {
		const host = createHost({ onError: () => {} });
		await host.load([], context);
		expect(vi.getTimerCount()).toBe(0);
		const [a, b] = memoryLinkPair();
		host.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
		const [c, d] = memoryLinkPair();
		host.accept(c, { principal: { kind: "owner" }, codec: testCodec() }, context);
		const peers = [new RawPeer(b), new RawPeer(d)];
		for (let round = 0; round < 50; round++) peers[0]!.send({ kind: "release", hold: round });
		await transported();
		expect(vi.getTimerCount()).toBe(1);
		for (const peer of peers) peer.close();
		await transported();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("takes its numbers from the host's options", async () => {
		const host = createHost({ onError: () => {}, heartbeat: { ping: 1_000, close: 2_000 } });
		await host.load([], context);
		const [a, b] = memoryLinkPair();
		host.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
		const peer = new RawPeer(b);
		await vi.advanceTimersByTimeAsync(1_100);
		await transported();
		expect(peer.kinds()).toEqual(["hello", "ping"]);
		await vi.advanceTimersByTimeAsync(1_000);
		await transported();
		expect(peer.closed).toBe(true);
	});
});

describe("trusted links", () => {
	it("skip the message schema check: no chord.link.checks, the codec and the owners' checks still run", async () => {
		const run = async (trusted: boolean) => {
			const { context: counting, counts } = await metered();
			const host = createHost({ onError: () => {} });
			await host.load([], context);
			const [a, b] = memoryLinkPair();
			host.accept(a, { principal: { kind: "owner" }, trusted, codec: testCodec() }, counting);
			const peer = new RawPeer(b);
			peer.send({ kind: "release", hold: 1 });
			peer.sendBytes(new Uint8Array([0xff]));
			await transported();
			return { checks: counts()["chord.link.checks"] ?? 0, closed: peer.closed };
		};
		expect(await run(false)).toEqual({ checks: 2, closed: true });
		expect(await run(true)).toEqual({ checks: 0, closed: true });
	});
});

describe("in-order handling", () => {
	/** A channel whose handler handles `release` of hold 0 asynchronously (until `finish`), every other message at once. */
	async function holding() {
		const [a, b] = memoryLinkPair();
		const handled: string[] = [];
		const reports: unknown[] = [];
		let finish: { resolve(): void; reject(error: Error): void } | undefined;
		let closed = false;
		const handler = {
			opened: () => {},
			closed: () => {
				closed = true;
			},
			message: (message: Message): void | Promise<void> => {
				const name = message.kind === "release" ? `release ${message.hold}` : message.kind;
				if (message.kind !== "release" || message.hold !== 0) {
					handled.push(name);
					return;
				}
				const { promise, resolve, reject } = Promise.withResolvers<void>();
				finish = { resolve, reject };
				return promise.then(() => void handled.push(name));
			},
		};
		const options = {
			codec: testCodec(),
			incarnation: RAW_PEER,
			calls: 1,
			trusted: true,
			report: (e: unknown) => reports.push(e),
		};
		new Channel(a, handler, options, context).start();
		const peer = new RawPeer(b);
		await peer.next("hello");
		return { peer, handled, reports, finish: () => finish!, isClosed: () => closed };
	}

	forEachCodec(() => {
		it("holds every later message, a ping included, until the asynchronous one was handled, then handles them in order", async () => {
			const { peer, handled, finish } = await holding();
			peer.send({ kind: "release", hold: 0 });
			peer.send({ kind: "release", hold: 1 });
			peer.send({ kind: "ping" });
			peer.send({ kind: "release", hold: 2 });
			await transported();
			expect(handled).toEqual([]);
			expect(peer.kinds()).toEqual([]);
			finish().resolve();
			await transported();
			expect(handled).toEqual(["release 0", "release 1", "release 2"]);
			expect(peer.kinds()).toEqual(["pong"]);
		});

		it("keeps the rest behind a held message that holds again, in order, a long queue included", async () => {
			const { peer, handled, finish } = await holding();
			const release = (hold: number) => testCodec().encode({ kind: "release", hold });
			peer.sendBytes(release(0));
			peer.sendBytes(release(1));
			peer.sendBytes(release(0));
			// Beyond what a spread into function arguments takes: the queue is read by index.
			const many = release(2);
			for (let i = 0; i < 70_000; i++) peer.sendBytes(many);
			await transported();
			expect(handled).toEqual([]);
			finish().resolve();
			await transported();
			expect(handled).toEqual(["release 0", "release 1"]);
			finish().resolve();
			await transported();
			expect(handled.length).toBe(70_003);
			expect(handled.slice(0, 4)).toEqual(["release 0", "release 1", "release 0", "release 2"]);
		});

		it("drops the held message's successors when the link closes meanwhile (race 13)", async () => {
			const { peer, handled, finish, isClosed } = await holding();
			peer.send({ kind: "release", hold: 0 });
			peer.send({ kind: "release", hold: 1 });
			await transported();
			peer.close();
			await transported();
			expect(isClosed()).toBe(true);
			finish().resolve();
			await transported();
			expect(handled).toEqual(["release 0"]);
		});

		it("keeps no held message once the link closed (GC)", async () => {
			const { peer, finish, refs } = await (async () => {
				const { peer, finish } = await holding();
				peer.send({ kind: "release", hold: 0 });
				const held = testCodec().encode({ kind: "release", hold: 1 });
				peer.sendBytes(held);
				await transported();
				peer.close();
				await transported();
				return { peer, finish, refs: [new WeakRef(held)] };
			})();
			await expectCollected(...refs);
			finish().resolve();
			expect(peer.closed).toBe(true);
		});

		it("treats a rejected asynchronous handling as a protocol error: reported, the link closes", async () => {
			const { peer, handled, finish, reports } = await holding();
			peer.send({ kind: "release", hold: 0 });
			peer.send({ kind: "release", hold: 1 });
			await transported();
			finish().reject(new Error("corrupt"));
			await transported();
			expect(peer.closed).toBe(true);
			expect(reports).toEqual([new Error("corrupt")]);
			expect(handled).toEqual([]);
		});
	});
});
