// Tests of a host's end of a link: the handshake, checks, the heartbeat (and why a link closed), trusted links,
// in-order handling while a message waits for an asynchronous inflate, and a stall of a server in another process
// (slice 15 §4).

import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { int, remote } from "../../src/contracts/index.ts";
import { PROTOCOL_VERSION } from "../../src/data/internal.ts";
import { createHost, type Host, type HostError, type Reference } from "../../src/host/index.ts";
import { type Link, memoryLinkPair } from "../../src/link/index.ts";
import { binaryCodec, Channel, type Message, textCodec } from "../../src/link/internal.ts";
import { chordMetrics } from "../../src/telemetry.ts";
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
	SERVER_ADDRESS,
	Server,
	testCodec,
	transported,
} from "../support.ts";
import { socketLink } from "./fixtures/socket-link.ts";
import { Counter } from "./fixtures/stall.ts";

const Thing = remote("app.thing", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	state: { n: int() },
});

const hold = {
	kind: "hold",
	hold: 0,
	type: "app.thing",
	version: 1,
	fingerprint: "0000000000000000",
	params: "{}",
	address: SERVER_ADDRESS,
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

		for (const trusted of [false, true]) {
			it(`refuses a peer of protocol 1, before grantable members, at its hello (${trusted ? "trusted" : "untrusted"} link)`, async () => {
				const { peer, errors } = await rawLinked(() => {}, { hello: false, trusted });
				peer.send({ kind: "hello", protocol: 1, incarnation: RAW_PEER, ...(trusted ? {} : { calls: 256 }) });
				await transported();
				expect(peer.closed).toBe(true);
				expect(problems(errors)).toEqual(["handshake: protocol 1, this host speaks 2"]);
			});
		}

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
			// The expectation is attached at once: on a slow machine the 20 ms pass before `flushed` returns.
			const failed = expect(client.get(Thing, {}, context, { readyTimeout: 20 })).rejects.toThrow(
				"app.thing: did not become live within 20 ms",
			);
			await flushed();
			expect(peer.kinds()).toEqual(["hello"]);
			await failed;
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
		const meter = await metered();
		const { client, peer, errors } = await rawProvider({ telemetry: meter.context.telemetry });
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
		// Reported once, and counted with its reason (slice 15 §4): nothing else would tell that holders wait.
		expect(errors).toEqual([{ kind: "link_closed", reason: "heartbeat", role: "parent" }]);
		expect(closedReasons(meter)).toEqual(["heartbeat"]);
	});

	it("counts every closed link by its reason, and reports only the heartbeat's", async () => {
		const meter = await metered();
		const { server, peer, errors } = await rawLinked(() => {}, { telemetry: meter.context.telemetry });
		// The peer closes: `peer`. A protocol error: `protocol` (reported as such). This host closes: `local`.
		peer.close();
		await transported();
		const broken = new RawPeer(acceptOn(server));
		broken.sendBytes(new Uint8Array([0xff]));
		await transported();
		acceptOn(server);
		await transported();
		await server.close(context);
		expect(closedReasons(meter)).toEqual(["peer", "protocol", "local"]);
		expect(errors.map((error) => error.kind)).toEqual(["protocol_error"]);
	});

	it("counts no pause of this process as silence (a sleeping laptop): pings at once, closes 15 s later unanswered", async () => {
		const { peer } = await rawLinked(() => {});
		await elapse(3_000);
		// The process sleeps 10 minutes: no timer runs meanwhile, the clock jumps.
		vi.setSystemTime(Date.now() + 600_000);
		await elapse(1_500);
		expect(peer.closed).toBe(false);
		expect(peer.kinds()).toEqual(["hello", "ping"]);
		await elapse(13_500);
		expect(peer.closed).toBe(false);
		await elapse(1_500);
		expect(peer.closed).toBe(true);
	});

	it("keeps a link through a pause when its peer answers the ping", async () => {
		const { peer } = await rawLinked(() => {});
		await elapse(20_000);
		vi.setSystemTime(Date.now() + 600_000);
		await elapse(1_500);
		peer.send({ kind: "pong" });
		await elapse(25_000);
		expect(peer.closed).toBe(false);
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

/** The reasons of the `chord.links.closed` counts, in order. */
function closedReasons(meter: Awaited<ReturnType<typeof metered>>): unknown[] {
	return meter.telemetry
		.getMetrics()
		.filter(({ name }) => name === "chord.links.closed")
		.map(({ attributes }) => attributes.reason);
}

/** A new link `host` accepts from an owner; returns the other end. */
function acceptOn(host: { accept: Host["accept"] }): Link {
	const [a, b] = memoryLinkPair();
	host.accept(a, { principal: { kind: "owner" }, codec: testCodec() }, context);
	return b;
}

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

describe("a fence (slice 14 §2.3)", () => {
	/** An open channel and the raw peer at its other end, which answers no `ping` by itself. */
	async function fenced() {
		const [a, b] = memoryLinkPair();
		const handler = { opened: () => {}, closed: () => {}, message: () => {} };
		const options = {
			codec: testCodec(),
			incarnation: RAW_PEER,
			calls: 1,
			trusted: true,
			report: () => {},
			metrics: chordMetrics(undefined),
		};
		const channel = new Channel(a, handler, options, context);
		channel.start();
		const peer = new RawPeer(b);
		await peer.next("hello");
		await transported();
		return { channel, peer };
	}

	forEachCodec(() => {
		it("runs after the pong of its own ping: a liveness pong in transit does not end it", async () => {
			const { channel, peer } = await fenced();
			const ran: string[] = [];
			// A liveness `ping` goes out (the link was silent); its `pong` is still in transit when the fence starts.
			channel.tick(Date.now() + 20_000, 0, 15_000, 30_000);
			channel.fence(() => void ran.push("first"));
			channel.fence(() => void ran.push("second"));
			await transported();
			expect(peer.kinds().filter((kind) => kind === "ping").length).toBe(3);
			peer.send({ kind: "pong" });
			await transported();
			expect(ran).toEqual([]);
			peer.send({ kind: "pong" });
			await transported();
			expect(ran).toEqual(["first"]);
			peer.send({ kind: "pong" });
			await transported();
			expect(ran).toEqual(["first", "second"]);
		});

		it("is cancelled by what it returned, and runs nothing once the link closed", async () => {
			const { channel, peer } = await fenced();
			const ran: string[] = [];
			const cancel = channel.fence(() => void ran.push("cancelled"));
			channel.fence(() => void ran.push("kept"));
			cancel();
			peer.send({ kind: "pong" });
			peer.send({ kind: "pong" });
			await transported();
			expect(ran).toEqual(["kept"]);
			channel.fence(() => void ran.push("closed"));
			channel.close();
			await transported();
			expect(ran).toEqual(["kept"]);
		});
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
			metrics: chordMetrics(undefined),
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

describe("a stall of the server (slice 15 §4)", () => {
	/** The forked server, its socket and its answers, and `clients` hosts of `holds` counters each over socket links. */
	async function stalled(
		heartbeat: { readonly ping: number; readonly close: number },
		clients: number,
		holds: number,
	) {
		// Under /tmp, not tmpdir(): a deep TMPDIR (macOS, test.sh) pushes the socket path past sun_path's 104 bytes.
		const directory = mkdtempSync("/tmp/chord-stall-");
		const path = join(directory, "server.sock");
		const server = fork(
			fileURLToPath(new URL("./fixtures/stall.ts", import.meta.url)),
			["serve", path, String(heartbeat.ping), String(heartbeat.close)],
			{ execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"] },
		);
		const answer = <T>(): Promise<T> =>
			new Promise((resolve) => server.once("message", resolve as (value: unknown) => void));
		await answer();
		const meter = await metered();
		const errors: HostError[] = [];
		const hosts: Host[] = [];
		const references: Reference<typeof Counter>[] = [];
		for (let client = 0; client < clients; client++) {
			const host = createHost({
				heartbeat,
				telemetry: meter.context.telemetry,
				onError: (error) => errors.push(error),
			});
			await host.load([], context);
			host.connect(socketLink(connect(path)), { principal: { kind: "server" } }, context);
			hosts.push(host);
			for (let hold = 0; hold < holds; hold++)
				references.push(host.hold(Counter, { id: `${client}.${hold}` }, context));
		}
		const command = (message: object): void => void server.send(message);
		/** How many references are live with each value, and how many are not live, by state. */
		const shown = (): Record<string, number> => {
			const counts: Record<string, number> = {};
			for (const reference of references) {
				const { kind } = reference.state.value;
				const key = kind === "live" ? `live ${reference.value.value}` : kind;
				counts[key] = (counts[key] ?? 0) + 1;
			}
			return counts;
		};
		const close = async (): Promise<void> => {
			for (const host of hosts) await host.close(context);
			server.kill();
			rmSync(directory, { recursive: true, force: true });
		};
		return { hosts, path, answer, command, shown, errors, meter, close };
	}

	const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	it("past `close`: no holder stays live with an old value; each closed link is reported once; a new link brings the value", async () => {
		// The reproduction of bench round 1's stale holders: the server blocked past its clients' `close`. Its own
		// heartbeat counts the stall as no silence and closes nothing; each client's finds the server silent and closes
		// its link: the holders wait `loading` (never live and old), and the close is reported and counted.
		const world = await stalled({ ping: 50, close: 100 }, 5, 10);
		try {
			await until(() => world.shown()["live 0"] === 50);
			world.command({ kind: "stall", stall: 300, value: 1 });
			await world.answer();
			await settle(400);
			const shown = world.shown();
			expect(shown["live 0"]).toBeUndefined();
			expect(shown).toEqual({ loading: 50 });
			expect(world.errors).toEqual(Array(5).fill({ kind: "link_closed", reason: "heartbeat", role: "parent" }));
			expect(closedReasons(world.meter)).toEqual(Array(5).fill("heartbeat"));
			world.command({ kind: "report" });
			expect(await world.answer()).toEqual({ closed: 0 });
			// A page's connection makes a new link: every holder is live with the current value again.
			for (const host of world.hosts)
				host.connect(socketLink(connect(world.path)), { principal: { kind: "server" } }, context);
			await until(() => world.shown()["live 1"] === 50);
			world.command({ kind: "set", set: 2 });
			await until(() => world.shown()["live 2"] === 50);
		} finally {
			await world.close();
		}
	}, 40_000);

	it("shorter than `close` − `ping`: no link closes, every holder gets the change", async () => {
		// A link may have been quiet for up to `ping` before the stall began: only a stall shorter than `close − ping`
		// is sure to keep it.
		const world = await stalled({ ping: 50, close: 600 }, 5, 10);
		try {
			await until(() => world.shown()["live 0"] === 50);
			world.command({ kind: "stall", stall: 300, value: 1 });
			await world.answer();
			await until(() => world.shown()["live 1"] === 50);
			await settle(200);
			expect(world.shown()).toEqual({ "live 1": 50 });
			expect(world.errors).toEqual([]);
			world.command({ kind: "report" });
			expect(await world.answer()).toEqual({ closed: 0 });
		} finally {
			await world.close();
		}
	}, 40_000);
});

/** Resolves once `done` holds, polling; throws after 15 s (a full parallel run is slow to fork). */
async function until(done: () => boolean): Promise<void> {
	for (const end = Date.now() + 15_000; !done(); ) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
