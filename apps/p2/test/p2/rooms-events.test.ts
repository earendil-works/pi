// Rooms with events (docs/rooms.md, packages/chord/docs/events/spec.md §7): `ViewRoom` 2 serving version 1's kits,
// motion as events (read-only peers receive, cannot emit, nothing counted or replayed), monotonic acknowledgements, and
// the view kit's connection run in Node over a real socket: its motion outbox, its listeners across a reconnect,
// pipelined sends with their outcomes, which failures it reports, and its acknowledgements of keyed messages (no lag
// eviction of a room that sends keyed messages only). Each case opens its own session and view.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { WebSocket as NodeWebSocket } from "ws";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Connection, type Delivered, type Event } from "../../plugins/views/kit/connection.ts";
import { type SendOutcome, Sends } from "../../plugins/views/kit/outbox.ts";
import { ViewLinks, ViewRoom, ViewRoomV1 } from "../../plugins/views/room-contract.ts";
import type { Host } from "../../src/runtime/chord.ts";
import { revokedBy, type ViewPrincipal } from "../../src/runtime/principals.ts";
import { Server } from "../../src/runtime/server.ts";
import { expectChord, type Fixture, holdIn, startFixture, TEST, until } from "./helpers.ts";

const PAGE = "<!doctype html><html><head><title>Room</title></head><body>room</body></html>";

const toolResults = (view: ConversationView | null | undefined, tool: string): ToolResultMessage[] =>
	(view?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === tool,
		),
	);
const idle = (view: ConversationView | null | undefined) => !(view?.docs["pi.live"] as { run?: unknown })?.run;

/** Resolves after `ms`. */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `done()` holds, polling (what the kit exposes is plain values). */
async function eventually(done: () => boolean, what: string, timeout = 10_000): Promise<void> {
	for (const start = Date.now(); !done(); await pause(20))
		if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
}

/**
 * A frame's socket in Node: `Origin: null`, as a sandboxed frame's; its deliveries to the kit can be held back
 * (`stall`), so the server's answers wait while its calls go out, or come over a slow path (`slow`).
 */
class FrameSocket extends NodeWebSocket {
	static all: FrameSocket[] = [];
	held: (() => void)[] | undefined;
	/** A slow path's one-way delay (ms), and what arrived and waits for its burst. */
	#oneWay: number | undefined;
	readonly #arrived: (() => void)[] = [];
	#burst: ReturnType<typeof setTimeout> | undefined;

	constructor(url: string | URL) {
		super(url, { headers: { Origin: "null" } });
		FrameSocket.all.push(this);
	}

	override emit(event: string | symbol, ...args: unknown[]): boolean {
		if (event !== "message" || (!this.held && this.#oneWay === undefined)) return super.emit(event, ...args);
		const deliver = () => super.emit(event, ...args);
		if (this.held) this.held.push(deliver);
		else this.#later(deliver);
		return true;
	}

	stall(): void {
		this.held = [];
	}

	/** From now on what it sends is delayed by `oneWay` ms, and what arrives comes in bursts, as over a mobile path. */
	slow(oneWay: number): void {
		this.#oneWay = oneWay;
		const send = this.send.bind(this);
		// The kit's link sends bytes only (`send(data)`), the first of `ws`'s overloads.
		this.send = ((data: Uint8Array) =>
			setTimeout(() => {
				if (this.readyState === NodeWebSocket.OPEN) send(data);
			}, oneWay)) as unknown as NodeWebSocket["send"];
	}

	/** Delivers at the next burst: after the one-way delay and a gap of up to 40 ms (one in ten up to 120 ms). */
	#later(deliver: () => void): void {
		this.#arrived.push(deliver);
		if (this.#burst) return;
		const gap = Math.random() < 0.1 ? 40 + Math.random() * 80 : Math.random() * 40;
		this.#burst = setTimeout(
			() => {
				this.#burst = undefined;
				for (const each of this.#arrived.splice(0)) each();
			},
			(this.#oneWay ?? 0) + gap,
		);
	}
}

/**
 * The page side of the kit in Node: the globals a frame has (`parent`, its message events, `location`, `WebSocket`),
 * and token requests answered as the owner's page answers them, for the current session's view (or held, or refused).
 */
type PageMode = { kind: "answer" } | { kind: "hold" } | { kind: "refuse"; error: string };

describe("view rooms with events", () => {
	let fixture: Fixture;
	let owner: Host;
	let sent = 0;
	let current = "";
	let mode: PageMode = { kind: "answer" };
	const listeners: ((event: { source: unknown; data: unknown }) => void)[] = [];
	const held: (() => void)[] = [];
	const saved = new Map<string, PropertyDescriptor | undefined>();
	const connections: Connection[] = [];
	const page = {
		postMessage: (message: { channel: string; type: string; id: string; editor?: string }) => {
			if (message.type !== "token") return;
			const answer = async () => {
				const reply = (data: object) => {
					for (const listener of [...listeners])
						listener({
							source: page,
							data: { channel: message.channel, type: "token", id: message.id, ...data },
						});
				};
				if (mode.kind === "refuse") return reply({ error: mode.error });
				const links = await holdIn(owner, ViewLinks, { session: current }, "viewer");
				reply(await links.token({ view: "room", ...(message.editor ? { editor: message.editor } : {}) }, TEST));
			};
			if (mode.kind === "hold") held.push(() => void answer());
			else void answer();
		},
	};
	/** Sets a global as a frame has it, kept to restore. */
	const define = (name: string, value: unknown) => {
		saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
	};

	before(async () => {
		fixture = await startFixture();
		owner = fixture.browser();
		define("parent", page);
		define("addEventListener", (type: string, listener: (event: { source: unknown; data: unknown }) => void) => {
			if (type === "message") listeners.push(listener);
		});
		define("location", { href: `http://127.0.0.1:${fixture.server.port}/view-frame`, reload: () => {} });
		define("WebSocket", FrameSocket);
	});
	after(async () => {
		for (const connection of connections) await connection.close();
		for (const socket of FrameSocket.all) socket.terminate();
		for (const [name, descriptor] of saved)
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		await fixture?.close();
	});
	beforeEach(() => {
		mode = { kind: "answer" };
	});

	/** A new session with the custom view `room` open; the kit's page answers for it from now on. */
	const session = async () => {
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const id = (await sessions.create({ cwd: fixture.workspace }, TEST)).id;
		const chat = await holdIn(owner, Chat, { session: id, conversation: 1 }, "participant");
		const before = toolResults(chat.view.value, "view").length;
		await chat.send(
			{
				text: `view ${JSON.stringify({ action: "open", kind: "custom", title: "Room", id: "room", html: PAGE })}`,
				requestId: `events-${++sent}`,
			},
			TEST,
		);
		await until(chat.view, (value) => toolResults(value, "view").length === before + 1 && idle(value));
		current = id;
		const links = await holdIn(owner, ViewLinks, { session: id }, "viewer");
		const { opening } = await links.token({ view: "room" }, TEST);
		return { id, opening };
	};

	/** A view principal made here: `link` is its peer ID. */
	const principalOf = (id: string, opening: string, link: string, mode: "read" | "write"): ViewPrincipal => ({
		kind: "view",
		session: id,
		view: "room",
		opening,
		mode,
		for: { name: link, role: "owner" },
		link,
		editor: `editor-${link}`,
		viewer: revokedBy({ kind: "owner", access: "local" }),
	});

	/** A frame's room over a memory link, as `link`. */
	const crafted = (id: string, opening: string, link: string, frameMode: "read" | "write" = "write") =>
		holdIn(
			fixture.as(principalOf(id, opening, link, frameMode)),
			ViewRoom,
			{ session: id, view: "room", opening },
			"peer",
		);

	/** A frame of a kit built with version 1, as `link`. */
	const craftedV1 = (id: string, opening: string, link: string) =>
		holdIn(
			fixture.as(principalOf(id, opening, link, "write")),
			ViewRoomV1,
			{ session: id, view: "room", opening },
			"peer",
		);

	/** A frame running the kit's connection, joined to a live room, recording what it gets. */
	const kitFrame = async (id: string, maxInFlight?: number) => {
		const first = FrameSocket.all.length;
		const connection = new Connection(id, "room", maxInFlight === undefined ? {} : { maxInFlight });
		connections.push(connection);
		const messages: Delivered[] = [];
		const events: Event[] = [];
		connection.onEvent((event) => events.push(event));
		await connection.join("live", { deliver: (list) => messages.push(...list) });
		// Its first socket (frames are made one at a time here).
		const socket = FrameSocket.all[first];
		assert.ok(socket);
		return { connection, messages, events, socket };
	};

	/** Cuts link `link` (a frame's peer ID), as a lag eviction does. */
	const cut = (link: string) =>
		fixture.server.host.root(async (ctx) => (await ctx.get(Server, {})).revokeFrames({ link }, ctx), TEST);

	it("serves kits of version 1: they bind without events, and their send answers null", async () => {
		const { id, opening } = await session();
		const old = await craftedV1(id, opening, "old");
		const current = await crafted(id, opening, "current");
		await old.join({ kind: "live" }, TEST);
		assert.equal(await old.send({ messages: [{ data: '"old"' }] }, TEST), null);
		assert.deepEqual(await current.send({ messages: [{ data: '"new"' }, { data: '"newer"' }] }, TEST), [2, 3]);
		const log = await until(old.log, (value) => value.messages.length === 3);
		assert.deepEqual(
			log.messages.map((message) => message.data),
			['"old"', '"new"', '"newer"'],
		);
		// An emit reaches version 2's frames; version 1's has no stream and keeps working.
		await current.emit({ messages: [{ data: '"move"' }] }, TEST);
		assert.deepEqual(await old.send({ messages: [{ data: '"after"' }] }, TEST), null);
	});

	it("streams emits to every frame there, read-only ones too, unnumbered, never kept, never replayed", async () => {
		const { id, opening } = await session();
		const writer = await crafted(id, opening, "writer");
		const reader = await crafted(id, opening, "reader", "read");
		await writer.join({ kind: "live" }, TEST);
		const got: { from: string; key?: string; data: string }[] = [];
		await reader.stream.on(({ value }) => got.push(value), TEST);
		await writer.emit({ messages: [{ key: "paddle", data: "1" }, { data: "2" }] }, TEST);
		await eventually(() => got.length === 2, "two events");
		assert.deepEqual(got, [
			{ from: "writer", key: "paddle", data: "1" },
			{ from: "writer", data: "2" },
		]);
		await expectChord(reader.emit({ messages: [{ data: "3" }] }, TEST), "forbidden");
		// Nothing numbered, kept or keyed: the room's accounting did not move.
		assert.equal(writer.room.value.seq, 0);
		assert.deepEqual(writer.log.value.messages, []);
		assert.deepEqual(writer.keyed.value.peers, {});
		// A joiner gets none of them.
		const joiner = await crafted(id, opening, "joiner");
		const late: unknown[] = [];
		await joiner.stream.on(({ value }) => late.push(value), TEST);
		await pause(100);
		assert.deepEqual(late, []);
	});

	it("keeps a peer's acknowledgement at the highest it saw", async () => {
		const { id, opening } = await session();
		const left = await crafted(id, opening, "left");
		const right = await crafted(id, opening, "right");
		await left.join({ kind: "live" }, TEST);
		await right.join({ kind: "live" }, TEST);
		await left.send({ messages: Array.from({ length: 10 }, (_, n) => ({ data: String(n) })) }, TEST);
		await right.ack({ seq: 10 }, TEST);
		// A send carrying an older acknowledgement (sends pipelined) does not move it back.
		await right.send({ messages: [{ data: '"late"' }], ack: 3 }, TEST);
		await left.ack({ seq: 10 }, TEST);
		const window = await until(right.log, (value) => value.start >= 10);
		assert.deepEqual(
			window.messages.map((message) => message.data),
			['"late"'],
		);
	});

	it("gives a frame's events to its listeners, also after a reconnect, without replaying what it missed", async () => {
		const { id } = await session();
		const sender = await kitFrame(id);
		const watcher = await kitFrame(id);
		sender.connection.emit({ n: 1 });
		await eventually(() => watcher.events.length === 1, "the first event");
		assert.equal(watcher.events[0]?.from, sender.connection.me);
		// The watcher's link is cut and it stays away (its page holds the token) while the sender emits.
		const away = watcher.connection.me;
		mode = { kind: "hold" };
		await cut(away);
		await pause(200);
		sender.connection.emit({ n: 2 });
		await pause(200);
		mode = { kind: "answer" };
		for (const release of held.splice(0)) release();
		await eventually(() => watcher.connection.me !== away && watcher.connection.me !== "", "a new link");
		await eventually(() => sender.connection.emitsInFlight === 0, "the sender's emits answered");
		sender.connection.emit({ n: 3 });
		await eventually(() => watcher.events.length === 2, "the event after the reconnect");
		assert.deepEqual(
			watcher.events.map((event) => event.data),
			[{ n: 1 }, { n: 3 }],
		);
	});

	it(
		"keeps both frames of a room with keyed messages only joined past the lag limit, one over a slow path",
		{ timeout: 120_000 },
		async () => {
			const { id } = await session();
			const near = await kitFrame(id);
			// Numbered before the far frame joins: the near frame's join is behind the far one's.
			const ready = await near.connection.send({ ready: true }, "stats");
			assert.equal(ready.kind, "sent");
			const far = await kitFrame(id);
			far.socket.slow(33);
			const frames = [near, far];
			const ids = frames.map((frame) => new Set([frame.connection.me]));
			// What the Pong view sends: a paddle per animation frame, a keyed report every 2 s; never an unkeyed message.
			let y = 0;
			const paddles = setInterval(() => {
				for (const [index, frame] of frames.entries()) {
					frame.connection.emit({ y: y++ }, "paddle");
					if (frame.connection.me) ids[index]?.add(frame.connection.me);
				}
			}, 16);
			const reports = setInterval(() => {
				for (const frame of frames) void frame.connection.send({ events: frame.events.length }, "stats");
			}, 2000);
			const fromNear = () => far.events.filter((event) => event.from === near.connection.me).length;
			const gaps: number[] = [];
			try {
				// Past the room's lag limit (30 s, checked every 5 s): a frame behind every other one would be cut by now.
				for (let second = 0; second < 40; second++) {
					const before = fromNear();
					await pause(1000);
					if (fromNear() === before) gaps.push(second);
				}
			} finally {
				clearInterval(paddles);
				clearInterval(reports);
			}
			assert.deepEqual(
				ids.map((each) => each.size),
				[1, 1],
				"no frame reconnected",
			);
			// The far frame got the near one's paddle every second.
			assert.deepEqual(gaps, []);
		},
	);

	it("sends without waiting for each answer: in order, each with its number, a replaced one superseded", async () => {
		const { id } = await session();
		const sender = await kitFrame(id);
		const watcher = await kitFrame(id);
		const outcomes = await Promise.all(Array.from({ length: 50 }, (_, n) => sender.connection.send({ n })));
		const seqs = outcomes.map((outcome) => (outcome.kind === "sent" ? outcome.seq : -1));
		assert.ok(seqs.every((seq, index) => seq > 0 && (index === 0 || seq > (seqs[index - 1] ?? 0))));
		await eventually(() => watcher.messages.length === 50, "fifty messages");
		assert.deepEqual(
			watcher.messages.map((message) => [message.seq, message.data]),
			seqs.map((seq, n) => [seq, { n }]),
		);
		// Two keyed sends in one turn: the first never leaves.
		const [first, second] = await Promise.all([
			sender.connection.send({ x: 1 }, "ball"),
			sender.connection.send({ x: 2 }, "ball"),
		]);
		assert.deepEqual(first, { kind: "superseded" });
		assert.equal(second?.kind, "sent");
	});

	it("sends a command made before the join after it, so a log room's new base never passes over it", async () => {
		const { id } = await session();
		const connection = new Connection(id, "room");
		connections.push(connection);
		const messages: Delivered[] = [];
		// The page's usual pattern: the room, then a command at once, before the join answered.
		const joined = connection.join("log", { deliver: (list) => messages.push(...list) });
		const outcome = await connection.send({ command: "first" });
		await joined;
		assert.equal(outcome.kind, "sent");
		const seq = outcome.kind === "sent" ? outcome.seq : -1;
		const { room } = await connection.state();
		assert.ok(seq > (room.base?.seq ?? Number.POSITIVE_INFINITY), `seq ${seq}, base ${room.base?.seq}`);
		await eventually(() => messages.some((message) => message.seq === seq), "the command delivered");
		assert.deepEqual(messages.find((message) => message.seq === seq)?.data, { command: "first" });
	});

	it("sends a command made while away after the rejoin, also to a new store", async () => {
		const { id } = await session();
		const frame = await kitFrame(id);
		const away = frame.connection.me;
		// The frame stays away past the store's linger (its page holds the token): the store ends.
		mode = { kind: "hold" };
		await cut(away);
		await eventually(() => frame.socket.readyState === NodeWebSocket.CLOSED, "the link closed");
		const outcome = frame.connection.send({ command: "while away" });
		await pause(11_000);
		mode = { kind: "answer" };
		for (const release of held.splice(0)) release();
		const settled = await outcome;
		assert.equal(settled.kind, "sent", JSON.stringify(settled));
		const seq = settled.kind === "sent" ? settled.seq : -1;
		await eventually(() => frame.messages.some((message) => message.seq === seq), "the command delivered");
		assert.deepEqual(frame.messages.find((message) => message.seq === seq)?.data, { command: "while away" });
	});

	it("resolves what waits, and later sends, as uncertain once the connection is closed", async () => {
		const { id } = await session();
		const connection = new Connection(id, "room");
		// Never joined: the send waits.
		const waiting = connection.send({ command: "never sent" });
		await connection.close();
		assert.deepEqual(await waiting, { kind: "uncertain" });
		assert.deepEqual(await connection.send({ command: "after" }), { kind: "uncertain" });
	});

	it("resolves a send the room refuses as refused, with the error", async () => {
		const sends = new Sends();
		sends.attach({
			send: () => Promise.reject(new Error("The views' rooms keep too much memory now")),
			lost: () => false,
		});
		assert.deepEqual(await sends.send({ data: "1" }), {
			kind: "refused",
			error: "The views' rooms keep too much memory now",
		});
	});

	it("resolves a send whose link closed before its answer as uncertain", async () => {
		const { id } = await session();
		const sender = await kitFrame(id);
		const watcher = await kitFrame(id);
		// The sender's socket holds back what the server answers: the send is numbered, its answer waits.
		sender.socket.stall();
		const outcome = sender.connection.send({ late: true });
		await eventually(() => watcher.messages.length === 1, "the message numbered");
		await cut(sender.connection.me);
		const settled: SendOutcome = await outcome;
		assert.deepEqual(settled, { kind: "uncertain" });
	});

	it("drops unkeyed emits past maxInFlight, keeps the newest keyed one, and empties all of it on a reconnect", async () => {
		const { id } = await session();
		const sender = await kitFrame(id, 2);
		const watcher = await kitFrame(id);
		sender.socket.stall();
		for (let n = 0; n < 5; n++) sender.connection.emit({ n });
		sender.connection.emit({ y: 1 }, "paddle");
		sender.connection.emit({ y: 2 }, "paddle");
		assert.equal(sender.connection.emitsInFlight, 2);
		await eventually(() => watcher.events.length === 2, "the two in flight");
		await pause(200);
		assert.deepEqual(
			watcher.events.map((event) => event.data),
			[{ n: 0 }, { n: 1 }],
		);
		// A reconnect with the outbox full: nothing waiting is sent, and the new count starts at zero.
		const away = sender.connection.me;
		await cut(away);
		await eventually(() => sender.connection.me !== away && sender.connection.me !== "", "a new link");
		assert.equal(sender.connection.emitsInFlight, 0);
		await pause(200);
		assert.equal(watcher.events.length, 2);
		sender.connection.emit({ y: 3 }, "paddle");
		await eventually(() => watcher.events.length === 3, "an emit after the reconnect");
		assert.deepEqual(watcher.events.at(-1)?.data, { y: 3 });
	});

	it("keeps a reconnect after a cut link quiet, and reports a refused token", async () => {
		const { id } = await session();
		const frame = await kitFrame(id);
		const reported: unknown[][] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			if (args[0] === "p2 view kit:") reported.push(args);
		};
		try {
			// Calls in flight when the link is cut fail; the frame reconnects by itself and says nothing.
			for (let n = 0; n < 20; n++) void frame.connection.send({ n });
			frame.connection.emit({ moving: true });
			const away = frame.connection.me;
			await cut(away);
			await eventually(() => frame.connection.me !== away && frame.connection.me !== "", "a new link");
			await pause(300);
			assert.deepEqual(reported, []);
			// A refused token (a revoked grant, a closed view) is reported.
			mode = { kind: "refuse", error: "this session is no longer shared with you" };
			await cut(frame.connection.me);
			await eventually(() => reported.length > 0, "a report");
			assert.match(String(reported[0]?.[1]), /no longer shared/);
		} finally {
			console.error = original;
		}
	});
});
