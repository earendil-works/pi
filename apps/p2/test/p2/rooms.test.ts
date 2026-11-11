// Rooms of custom views (plugins/views/rooms.ts, docs/rooms.md) with the fake provider: tokens and the view link, the
// view principal's reach and revocation, presence and the leader, keyed and unkeyed messages, log and text rooms, and
// the agent's calls to methods a frame offers. Each case opens its own session and view.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { withCancel } from "@p2/app/v1";
import { WebSocket as NodeWebSocket } from "ws";
import { Chat } from "../../plugins/chat/contract.ts";
import { ModelConfig } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { ViewState, Views } from "../../plugins/views/contract.ts";
import { TextClient } from "../../plugins/views/kit/text-client.ts";
import { ViewLinks, ViewRoom } from "../../plugins/views/room-contract.ts";
import { loadText } from "../../plugins/views/text.ts";
import { createHost, type Host, type RefIn } from "../../src/runtime/chord.ts";
import { type P2Principal, revokedBy, SERVER, type ViewPrincipal, viewKey } from "../../src/runtime/principals.ts";
import { Server } from "../../src/runtime/server.ts";
import {
	clientHost,
	expectChord,
	type Fixture,
	failureOf,
	holdIn,
	memoryLinkPair,
	startFixture,
	TEST,
	until,
} from "./helpers.ts";

const PAGE = "<!doctype html><html><head><title>Room</title></head><body>room</body></html>";

const toolResults = (view: ConversationView | null | undefined, tool: string): ToolResultMessage[] =>
	(view?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === tool,
		),
	);
const idle = (view: ConversationView | null | undefined) => !(view?.docs["pi.live"] as { run?: unknown })?.run;
const text = (message: ToolResultMessage | undefined) =>
	(message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");

describe("view rooms", () => {
	let fixture: Fixture;
	let owner: Host;
	let sent = 0;

	const closers: Host[] = [];

	before(async () => {
		fixture = await startFixture();
		owner = fixture.browser();
	});
	after(async () => {
		for (const host of closers) await host.close(TEST).catch(() => {});
		await fixture?.close();
	});

	/** A new session with the custom view `room` open; its chat. */
	const session = async () => {
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const id = (await sessions.create({ cwd: fixture.workspace }, TEST)).id;
		const chat = await holdIn(owner, Chat, { session: id, conversation: 1 }, "participant");
		await prompt(
			chat,
			"view",
			`view ${JSON.stringify({ action: "open", kind: "custom", title: "Room", id: "room", html: PAGE })}`,
		);
		return { id, chat };
	};

	/** Has the agent run `line` (a fake-provider prompt calling `tool`); that call's result text. */
	const prompt = async (chat: RefIn<typeof Chat, "participant">, tool: string, line: string): Promise<string> => {
		const before = toolResults(chat.view.value, tool).length;
		await chat.send({ text: line, requestId: `rooms-${++sent}` }, TEST);
		const view = await until(chat.view, (value) => toolResults(value, tool).length === before + 1 && idle(value));
		return text(toolResults(view, tool).at(-1));
	};

	/** A token for `view` of `session`, as the owner's page asks for one (its tokens live while the page holds it). */
	const token = async (session: string, view = "room", editor?: string) => {
		const links = await holdIn(owner, ViewLinks, { session }, "viewer");
		return links.token({ view, ...(editor ? { editor } : {}) }, TEST);
	};

	/** A socket to `/chord/view` as a sandboxed frame opens it (Origin null), with `headers` besides. */
	const viewSocket = (value: string, headers: Record<string, string> = {}) =>
		new NodeWebSocket(`ws://127.0.0.1:${fixture.server.port}/chord/view?token=${encodeURIComponent(value)}`, {
			headers: { Origin: "null", ...headers },
		});

	/** Whether `socket` was refused at its upgrade (closed or errored before it opened). */
	const refused = (socket: NodeWebSocket) =>
		new Promise<boolean>((resolve) => {
			socket.once("open", () => resolve(false));
			socket.once("error", () => resolve(true));
			socket.once("unexpected-response", () => resolve(true));
		});

	/** A frame of `session`'s view over the real token path: its host and its room. */
	const frame = async (session: string) => {
		const { token: value, opening } = await token(session);
		const host = clientHost(viewSocket(value));
		const room = await holdIn(host, ViewRoom, { session, view: "room", opening }, "peer");
		return { host, room, opening };
	};

	/** A view principal made here: `link` is its peer ID. */
	const principalOf = (
		session: string,
		opening: string,
		link: string,
		mode: "read" | "write" = "write",
		viewer: P2Principal = { kind: "owner", access: "local" },
	): ViewPrincipal => ({
		kind: "view",
		session,
		view: "room",
		opening,
		mode,
		for: { name: link, role: "owner" },
		link,
		editor: `editor-${link}`,
		viewer: revokedBy(viewer),
	});

	/** A frame over a memory link whose server-to-frame side can stall (deliveries held back) and be released. */
	const stalledFrame = (session: string, opening: string, link: string) => {
		const [down, up] = memoryLinkPair();
		fixture.server.host.accept(down, { principal: principalOf(session, opening, link) }, TEST);
		let held: Uint8Array[] | undefined;
		let counting = false;
		let after = 0;
		let deliver: (message: Uint8Array) => void = () => {};
		const stalling = {
			send: (message: Uint8Array) => up.send(message),
			onMessage: (listener: (message: Uint8Array) => void) => {
				deliver = (message) => {
					if (counting) after += message.byteLength;
					listener(message);
				};
				up.onMessage((message) => {
					if (held) held.push(message);
					else deliver(message);
				});
			},
			close: () => up.close(),
			onClose: (listener: () => void) => up.onClose(listener),
		};
		const host = createHost({ onError: () => {} });
		host.connect(stalling, { principal: SERVER }, TEST);
		void host.load([], TEST);
		closers.push(host);
		return {
			host,
			stall: () => {
				held = [];
			},
			/** Delivers what was held and everything after; the bytes delivered from then on, once quiet. */
			release: () => {
				const queued = held ?? [];
				held = undefined;
				counting = true;
				for (const message of queued) deliver(message);
				return async () => {
					await new Promise((resolve) => setTimeout(resolve, 200));
					return after;
				};
			},
		};
	};

	/** A frame accepted with a principal made here (memory link): `link` is its peer ID. */
	const crafted = async (
		session: string,
		opening: string,
		link: string,
		mode: "read" | "write" = "write",
		viewer: P2Principal = { kind: "owner", access: "local" },
	) => {
		const host = fixture.as(principalOf(session, opening, link, mode, viewer));
		return holdIn(host, ViewRoom, { session, view: "room", opening }, "peer");
	};

	it("admits a frame's link by its token alone, once", async () => {
		const { id } = await session();
		const { token: value, opening } = await token(id);
		// The wrong Host with a valid token is refused (DNS rebinding), and the token is not spent by it.
		assert.equal(await refused(viewSocket(value, { Host: "evil.example" })), true);
		const socket = viewSocket(value);
		const host = clientHost(socket);
		const room = await holdIn(host, ViewRoom, { session: id, view: "room", opening }, "peer");
		assert.equal((await room.join({ kind: "live" }, TEST)).me.length > 0, true);
		// Used: refused now. No token, cookies only: refused. Origin null on the ordinary /chord: refused.
		assert.equal(await refused(viewSocket(value)), true);
		const cookieOnly = new NodeWebSocket(`ws://127.0.0.1:${fixture.server.port}/chord/view`, {
			headers: { Origin: "null", Cookie: fixture.owner.cookie },
		});
		assert.equal(await refused(cookieOnly), true);
		const nullOrigin = new NodeWebSocket(`ws://127.0.0.1:${fixture.server.port}/chord`, {
			headers: { Origin: "null", Cookie: fixture.owner.cookie },
		});
		assert.equal(await refused(nullOrigin), true);
		// A sandboxed frame's `Origin: null` reaches the view kit only.
		const kit = /src="(\/view-kit\/[0-9a-f]{64}\.js)"/.exec(
			(await fixture.http(`/view-frame?session=${id}&view=room&version=1`)).body,
		)?.[1];
		assert.ok(kit);
		assert.equal((await fixture.http(kit, { headers: { Origin: "null", Cookie: "" } })).status, 200);
		assert.equal((await fixture.http("/health", { headers: { Origin: "null" } })).status, 403);
		assert.equal(
			(await fixture.http(`/view-frame?session=${id}&view=room&version=1`, { headers: { Origin: "null" } })).status,
			403,
		);
		// Two redemptions at once: one link.
		const { token: twice } = await token(id);
		const outcomes = await Promise.all([refused(viewSocket(twice)), refused(viewSocket(twice))]);
		assert.deepEqual(outcomes.sort(), [false, true]);
	});

	it("reaches nothing but its own view's room", async () => {
		const { id } = await session();
		const { host, opening } = await frame(id);
		for (const ref of [
			host.hold(Sessions, {}, TEST),
			host.hold(Views, { session: id }, TEST),
			host.hold(ViewState, { session: id, view: "room" }, TEST),
			host.hold(ViewLinks, { session: id }, TEST),
			host.hold(ViewRoom, { session: id, view: "other", opening }, TEST),
		])
			assert.equal((await failureOf(ref)).code, "forbidden");
	});

	it("ends a frame's room when its view closes, and refuses the old opening's tokens after it reopens", async () => {
		const { id, chat } = await session();
		const { room } = await frame(id);
		const stale = await token(id);
		await prompt(chat, "view", `view ${JSON.stringify({ action: "close", id: "room" })}`);
		const ended = await failureOf(room);
		assert.equal(ended.code, "forbidden");
		await prompt(
			chat,
			"view",
			`view ${JSON.stringify({ action: "open", kind: "custom", title: "Room", id: "room", html: PAGE })}`,
		);
		assert.equal(await refused(viewSocket(stale.token)), true);
		assert.notEqual((await token(id)).opening, stale.opening);
	});

	it("ends a frame's room when its viewer's grant is revoked", async () => {
		const { id } = await session();
		const { opening } = await token(id);
		const room = await crafted(id, opening, "guest-frame", "read", {
			kind: "guest",
			id: "g1",
			name: "Guest",
			home: id,
			sessions: { [id]: "view" },
			revision: 1,
		});
		await fixture.server.host.root(async (ctx) => (await ctx.get(Server, {})).revokeGuests({ id: "g1" }, ctx), TEST);
		assert.equal((await failureOf(room)).code, "forbidden");
	});

	it("ends every frame of a view's opening when the server revokes it", async () => {
		const { id } = await session();
		const { opening } = await token(id);
		const room = await crafted(id, opening, "doomed");
		const real = (await frame(id)).room;
		await fixture.server.host.root(
			async (ctx) => (await ctx.get(Server, {})).revokeFrames({ view: viewKey(id, "room", opening) }, ctx),
			TEST,
		);
		// Read by polling: a socket's reference ends as its link closes.
		for (const ref of [room, real]) {
			for (let n = 0; n < 100 && ref.state.value.kind !== "ended"; n++)
				await new Promise((resolve) => setTimeout(resolve, 50));
			const state = ref.state.value;
			assert.equal(state.kind === "ended" ? state.error.code : state.kind, "forbidden");
		}
	});

	it("names the oldest frame that may write the leader, and hands over when it leaves", async () => {
		const { id } = await session();
		const { opening } = await token(id);
		const reader = await crafted(id, opening, "reader", "read");
		const first = await crafted(id, opening, "first");
		const second = await crafted(id, opening, "second");
		await until(second.presence, (value) => value.peers.length === 3);
		assert.equal(second.presence.value.leader, "first");
		assert.deepEqual(
			second.presence.value.peers.map((peer) => [peer.id, peer.mode]),
			[
				["reader", "read"],
				["first", "write"],
				["second", "write"],
			],
		);
		await expectChord(reader.send({ messages: [{ data: "1" }] }, TEST), "forbidden");
		first.release();
		await until(second.presence, (value) => value.leader === "second");
	});

	it("folds a key's updates for a peer whose link stalls, and gives joiners each peer's latest", async () => {
		const { id } = await session();
		const { opening } = await token(id);
		const sender = await crafted(id, opening, "sender");
		await sender.join({ kind: "live" }, TEST);
		await sender.send({ messages: [{ key: "cursor", data: '"start"' }] }, TEST);
		// The slow peer's link holds back what the server sends until released: its acknowledgements stop too, so
		// the server's window fills and the rest waits in its pending queue.
		const slow = stalledFrame(id, opening, "slow");
		const room = await holdIn(slow.host, ViewRoom, { session: id, view: "room", opening }, "peer");
		await until(room.keyed, (value) => value.peers.sender?.cursor?.data.slice(1) === '"start"');
		slow.stall();
		const big = (n: number) => JSON.stringify(`${n}:${"x".repeat(2000)}`);
		for (let n = 1; n <= 50; n++) await sender.send({ messages: [{ key: "cursor", data: big(n) }] }, TEST);
		const bytes = slow.release();
		await until(room.keyed, (value) => value.peers.sender?.cursor?.data.slice(1) === big(50));
		// What reached the slow peer: the messages in its window and one folded update, not fifty values of 2 KB.
		const received = await bytes();
		assert.ok(received < 12 * 1024, `bytes: ${received}`);
		const joiner = await crafted(id, opening, "joiner");
		assert.equal(joiner.keyed.value.peers.sender?.cursor?.data.slice(1), big(50));
	});

	it("refuses a keyed message that would make the keyed snapshot too large for a joiner", async () => {
		const { id } = await session();
		const { opening } = await token(id);
		const sender = await crafted(id, opening, "sender");
		await sender.join({ kind: "live" }, TEST);
		const value = JSON.stringify("y".repeat(250 * 1024));
		for (let n = 0; n < 4; n++) await sender.send({ messages: [{ key: `k${n}`, data: value }] }, TEST);
		await assert.rejects(sender.send({ messages: [{ key: "k4", data: value }] }, TEST), /part limit/);
		const joiner = await crafted(id, opening, "joiner");
		assert.equal(Object.keys(joiner.keyed.value.peers.sender ?? {}).length, 4);
	});

	it("counts the keyed snapshot as encoded: escapes and non-ASCII text", async () => {
		const { id } = await session();
		const { opening } = await token(id);
		for (const [name, unit] of [
			["quotes", '"'],
			["backslashes", "\\"],
			["non-ASCII", "€"],
		] as const) {
			const sender = await crafted(id, opening, `sender-${name}`);
			await sender.join({ kind: "live" }, TEST);
			// 100,000 characters each: escaped or UTF-8, each key encodes to 200-300 KB.
			let accepted = 0;
			for (let n = 0; n < 8; n++)
				await sender.send({ messages: [{ key: `k${n}`, data: unit.repeat(100_000) }] }, TEST).then(
					() => accepted++,
					(error: unknown) => assert.match(String(error), /part limit/),
				);
			assert.ok(accepted < 8, `${name}: some refused`);
			// What a joiner gets fits the link's part limit.
			const joiner = await crafted(id, opening, `joiner-${name}`);
			assert.equal(Object.keys(joiner.keyed.value.peers[`sender-${name}`] ?? {}).length, accepted);
			assert.ok(Buffer.byteLength(JSON.stringify(joiner.keyed.value)) <= 1024 * 1024, name);
			sender.release();
			joiner.release();
		}
	});

	it("never lets a frame that may only watch change or reset the room", async () => {
		const { id } = await session();
		const { opening } = await token(id);
		const writer = await crafted(id, opening, "writer");
		await writer.join({ kind: "log" }, TEST);
		await writer.send({ messages: [{ data: '"move"' }] }, TEST);
		const reader = await crafted(id, opening, "reader", "read");
		await reader.join({ kind: "log" }, TEST);
		writer.release();
		await until(reader.presence, (value) => value.peers.length === 1);
		await expectChord(reader.join({ kind: "live" }, TEST), "forbidden");
		assert.equal(reader.room.value.kind, "log");
		assert.deepEqual(
			reader.log.value.messages.map((message) => message.data),
			['"move"'],
		);
	});

	it("keeps appending at a flat cost however many messages the room keeps", async () => {
		const { id } = await session();
		const { opening } = await token(id);
		const sender = await crafted(id, opening, "sender");
		// A peer that never acknowledges: the room keeps everything.
		const quiet = await crafted(id, opening, "quiet");
		await sender.join({ kind: "live" }, TEST);
		await quiet.join({ kind: "live" }, TEST);
		const batch = Array.from({ length: 500 }, (_, n) => ({ data: String(n) }));
		const timed = async () => {
			const start = performance.now();
			for (let n = 0; n < 4; n++) await sender.send({ messages: batch }, TEST);
			return performance.now() - start;
		};
		const early = await timed();
		for (let n = 0; n < 40; n++) await sender.send({ messages: batch }, TEST);
		const late = await timed();
		// 22,000 kept messages: an append drafts one block of the journal, never all of it.
		assert.ok(late < early * 3 + 100, `early ${early.toFixed(0)} ms, late ${late.toFixed(0)} ms`);
		const page = await quiet.history({ after: 0, limit: 1000 }, TEST);
		assert.equal(page.messages.length, 1000);
		assert.equal(page.more, true);
	});

	it("charges every kept message to the memory budget, empty ones too", async () => {
		const { id } = await session();
		const { opening } = await token(id);
		const sender = await crafted(id, opening, "sender");
		await crafted(id, opening, "quiet");
		await sender.join({ kind: "live" }, TEST);
		const settings = join(fixture.dataDir, "settings.json");
		writeFileSync(settings, JSON.stringify({ viewRoomsMemory: 1 }));
		try {
			const empty = Array.from({ length: 1000 }, () => ({ data: "" }));
			let refused: unknown;
			// settings.json is read when it changes: sending goes on until the budget applies and the room is full.
			for (let n = 0; n < 100 && refused === undefined; n++) {
				await sender.send({ messages: empty }, TEST).catch((error: unknown) => {
					refused = error;
				});
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.match(String(refused), /keep too much memory/);
		} finally {
			writeFileSync(settings, "{}");
		}
	});

	it("delivers unkeyed messages in order to every peer and drops them once all acknowledged", async () => {
		const { id } = await session();
		const { opening } = await token(id);
		const left = await crafted(id, opening, "left");
		const right = await crafted(id, opening, "right");
		await left.join({ kind: "live" }, TEST);
		await right.join({ kind: "live" }, TEST);
		await left.send({ messages: [{ data: '"a"' }, { key: "pos", data: "1" }, { data: '"b"' }] }, TEST);
		await right.send({ messages: [{ data: '"c"' }] }, TEST);
		const log = await until(left.log, (value) => value.messages.length === 3);
		assert.deepEqual(
			log.messages.map((message) => [message.from, message.data]),
			[
				["left", '"a"'],
				["left", '"b"'],
				["right", '"c"'],
			],
		);
		// Keyed and unkeyed share one numbering: the keyed message sits between a and b.
		const pos = left.keyed.value.peers.left?.pos?.seq ?? 0;
		assert.ok((log.messages[0]?.seq ?? 0) < pos && pos < (log.messages[1]?.seq ?? 0));
		const last = log.messages.at(-1)?.seq ?? 0;
		await left.ack({ seq: last }, TEST);
		assert.equal(right.log.value.messages.length, 3, "kept while one peer has not acknowledged");
		await right.ack({ seq: last }, TEST);
		await until(right.log, (value) => value.messages.length === 0);
	});

	it("keeps a log room's messages since the leader's snapshot, and resets it to the agent's state", async () => {
		const { id, chat } = await session();
		const { opening } = await token(id);
		const leader = await crafted(id, opening, "leader");
		await leader.join({ kind: "log" }, TEST);
		await leader.send({ messages: [{ data: "1" }, { data: "2" }] }, TEST);
		const room = await until(leader.room, (value) => value.seq === 2);
		const base = room.base;
		assert.ok(base);
		await expectChord(
			leader.snapshot({ seq: 2, epoch: base.epoch, term: room.term - 1, value: { total: 3 } }, TEST),
			"invalid",
		);
		await leader.snapshot({ seq: 2, epoch: base.epoch, term: room.term, value: { total: 3 } }, TEST);
		await until(leader.log, (value) => value.messages.length === 0);
		const state = await holdIn(owner, ViewState, { session: id, view: "room" }, "editor");
		await until(state.value, (value) => JSON.stringify(value) === '{"total":3}');
		await prompt(chat, "view", `view ${JSON.stringify({ action: "update", id: "room", state: { total: 10 } })}`);
		const reset = await until(leader.room, (value) => JSON.stringify(value.base?.value) === '{"total":10}');
		assert.equal(reset.base?.epoch, base.epoch + 1);
		state.release();
	});

	it("converges two editors of a text room, and takes the agent's text as an edit", async () => {
		const { id, chat } = await session();
		const { opening } = await token(id);
		const a = await crafted(id, opening, "a");
		const b = await crafted(id, opening, "b");
		const joined = await a.join({ kind: "text" }, TEST);
		await b.join({ kind: "text" }, TEST);
		const base = loadText((await until(a.room, (value) => value.base !== null)).base?.value);
		assert.ok(base);
		const left = new TextClient("editor-a", base.doc);
		const right = new TextClient("editor-b", base.doc);
		assert.equal(joined.editor, "editor-a");
		// "hello" from both at once, then a delete over b's insert.
		const one = left.input("hello");
		const two = right.input("HELLO");
		assert.ok(one && two);
		await Promise.all([
			a.edit({ n: one.n, edits: [...one.edits] }, TEST),
			b.edit({ n: two.n, edits: [...two.edits] }, TEST),
		]);
		const apply = (
			log: { messages: readonly { seq: number; from: string; n?: number; data: string }[] },
			after: number,
		) => {
			for (const message of log.messages)
				if (message.seq > after && message.n !== undefined)
					for (const client of [left, right]) client.confirm(message.from, message.n, JSON.parse(message.data));
		};
		apply(await until(a.log, (value) => value.messages.length === 2), 0);
		assert.equal(left.doc.text, right.doc.text);
		const merged = left.doc.text;
		assert.ok(merged === "helloHELLO" || merged === "HELLOhello", merged);
		const cut = left.input("");
		const add = right.input(`${merged}!`);
		assert.ok(cut && add);
		await Promise.all([
			b.edit({ n: add.n, edits: [...add.edits] }, TEST),
			a.edit({ n: cut.n, edits: [...cut.edits] }, TEST),
		]);
		apply(await until(a.log, (value) => value.messages.length === 4), 2);
		assert.equal(left.doc.text, right.doc.text);
		// A batch sent again (a reconnect) is a no-op: its number is at or below the editor's watermark.
		await a.edit({ n: one.n, edits: [...one.edits] }, TEST);
		const echoed = await until(a.log, (value) => value.messages.length === 5);
		assert.equal(echoed.messages.at(-1)?.data, "[]");
		// The view's state gets the text; the agent's text becomes one edit.
		const state = await holdIn(owner, ViewState, { session: id, view: "room" }, "editor");
		await until(state.value, (value) => (value as { text?: string } | null)?.text === left.doc.text);
		await prompt(
			chat,
			"view",
			`view ${JSON.stringify({ action: "update", id: "room", merge: { text: "from the agent" } })}`,
		);
		const agent = await until(a.log, (value) =>
			value.messages.some((message) => message.from === "server" && message.n !== undefined),
		);
		apply(agent, 5);
		assert.equal(left.doc.text, "from the agent");
		// A page's text over the limit is not taken: the room's text is written back.
		await state.set({ value: { text: "x".repeat(100_001) } }, TEST);
		await until(state.value, (value) => (value as { text?: string } | null)?.text === "from the agent");
		state.release();
	});

	it("runs the agent's call in the leader's frame, and fails at once without one", async () => {
		const { id, chat } = await session();
		const script = (method: string) =>
			`codemode return JSON.stringify(await tools.view_call({ view: "room", method: "${method}", args: { x: 2 } }).catch((error) => "failed: " + error.message))`;
		assert.match(await prompt(chat, "codemode", script("zoom")), /not open/);
		const { opening } = await token(id);
		const leader = await crafted(id, opening, "leader");
		await leader.offer(
			{
				methods: [
					{
						name: "zoom",
						description: "Zooms",
						args: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
					},
				],
			},
			TEST,
		);
		// The frame answers each call given to it.
		const watch = await leader.room.watch(TEST);
		const answered = new Set<string>();
		watch.start(async (call) => {
			if (call.kind !== "value") return;
			for (const each of call.value.calls)
				if (each.peer === "leader" && !answered.has(each.id)) {
					answered.add(each.id);
					await leader.answer({ id: each.id, result: { zoomed: (each.args as { x: number }).x * 10 } }, TEST);
				}
		});
		assert.match(await prompt(chat, "codemode", script("zoom")), /zoomed.*20/);
		await watch.stop();
	});

	it("fails a call as uncertain when its frame leaves before answering", async () => {
		const { id, chat } = await session();
		const { opening } = await token(id);
		const leader = await crafted(id, opening, "leader");
		const next = await crafted(id, opening, "next");
		await leader.offer({ methods: [{ name: "zoom", description: "Zooms", args: { type: "object" } }] }, TEST);
		await next.offer({ methods: [{ name: "zoom", description: "Zooms", args: { type: "object" } }] }, TEST);
		const asked = prompt(
			chat,
			"codemode",
			`codemode return JSON.stringify(await tools.view_call({ view: "room", method: "zoom", args: {} }).catch((error) => "failed: " + error.message))`,
		);
		await until(leader.room, (value) => value.calls.some((call) => call.peer === "leader"));
		leader.release();
		assert.match(await asked, /may or may not have run/);
		// Not given to the next leader: it was not offered as idempotent.
		assert.equal(next.room.value.calls.length, 0);
	});

	it("fails a call as uncertain when its frame, the last one, leaves before answering", async () => {
		const { id, chat } = await session();
		const { opening } = await token(id);
		const leader = await crafted(id, opening, "leader");
		await leader.offer({ methods: [{ name: "zoom", description: "Zooms", args: { type: "object" } }] }, TEST);
		const asked = prompt(
			chat,
			"codemode",
			`codemode return JSON.stringify(await tools.view_call({ view: "room", method: "zoom", args: {} }).catch((error) => "failed: " + error.message))`,
		);
		await until(leader.room, (value) => value.calls.some((call) => call.peer === "leader"));
		leader.release();
		assert.match(await asked, /may or may not have run/);
	});

	it("takes a snapshot that is overtaken by a newer one as stale", async () => {
		const { id } = await session();
		const { opening } = await token(id);
		const leader = await crafted(id, opening, "leader");
		await leader.join({ kind: "log" }, TEST);
		await leader.send({ messages: [{ data: "1" }, { data: "2" }] }, TEST);
		const room = await until(leader.room, (value) => value.seq === 2);
		const base = room.base;
		assert.ok(base);
		const snapshot = (seq: number) =>
			leader.snapshot({ seq, epoch: base.epoch, term: room.term, value: { upTo: seq } }, TEST).then(
				() => "written",
				() => "stale",
			);
		// Sent together: the newer goes first, the older one after it must not move the base back.
		assert.deepEqual(await Promise.all([snapshot(2), snapshot(1)]), ["written", "stale"]);
		assert.equal(leader.room.value.base?.seq, 2);
	});

	it("ends a call its caller cancels, and takes it out of the room", async () => {
		const { id } = await session();
		const { opening } = await token(id);
		const leader = await crafted(id, opening, "leader");
		await leader.offer({ methods: [{ name: "slow", description: "Never answers", args: { type: "object" } }] }, TEST);
		const worker = await holdIn(
			fixture.as({ kind: "worker", session: id, generation: 1 }),
			ViewRoom,
			{ session: id, view: "room", opening },
			"worker",
		);
		const call = withCancel(TEST);
		const result = worker.call({ method: "slow", args: {} }, call.context);
		await until(leader.room, (value) => value.calls.length === 1);
		call.cancel(new Error("cancelled by the test"));
		await assert.rejects(result);
		await until(leader.room, (value) => value.calls.length === 0);
	});

	it("writes a text room's text when the plugin reloads before its save", async () => {
		const { id } = await session();
		const { opening } = await token(id);
		const editor = await crafted(id, opening, "editor");
		await editor.join({ kind: "text" }, TEST);
		const base = loadText((await until(editor.room, (value) => value.base !== null)).base?.value);
		assert.ok(base);
		const client = new TextClient("editor-editor", base.doc);
		const batch = client.input("kept across a reload");
		assert.ok(batch);
		await editor.edit({ n: batch.n, edits: [...batch.edits] }, TEST);
		await fixture.server.reload(["views"]);
		const state = await holdIn(owner, ViewState, { session: id, view: "room" }, "editor");
		await until(state.value, (value) => (value as { text?: string } | null)?.text === "kept across a reload");
		state.release();
	});

	it("takes the agent's change of the view's state made while the plugin reloads", async () => {
		const { id, chat } = await session();
		const { opening } = await token(id);
		const leader = await crafted(id, opening, "leader");
		await leader.join({ kind: "log" }, TEST);
		await leader.send({ messages: [{ data: "1" }] }, TEST);
		const before = (await until(leader.room, (value) => value.base !== null)).base;
		await Promise.all([
			fixture.server.reload(["views"]),
			prompt(
				chat,
				"view",
				`view ${JSON.stringify({ action: "update", id: "room", state: { reset: "by the agent" } })}`,
			),
		]);
		const after = await until(
			leader.room,
			(value) => JSON.stringify(value.base?.value) === '{"reset":"by the agent"}',
		);
		assert.ok((after.base?.epoch ?? 0) > (before?.epoch ?? 0));
	});

	it("takes the view's text changed while no room was open", async () => {
		const { id, chat } = await session();
		const { opening } = await token(id);
		const first = await crafted(id, opening, "first");
		await first.join({ kind: "text" }, TEST);
		const base = loadText((await until(first.room, (value) => value.base !== null)).base?.value);
		assert.ok(base);
		const client = new TextClient("editor-first", base.doc);
		const batch = client.input("A");
		assert.ok(batch);
		await first.edit({ n: batch.n, edits: [...batch.edits] }, TEST);
		const state = await holdIn(owner, ViewState, { session: id, view: "room" }, "editor");
		await until(state.value, (value) => (value as { text?: string } | null)?.text === "A");
		// The last frame leaves and the room ends after its linger; then the agent writes the text.
		first.release();
		await new Promise((resolve) => setTimeout(resolve, 11_000));
		await prompt(chat, "view", `view ${JSON.stringify({ action: "update", id: "room", merge: { text: "B" } })}`);
		await until(state.value, (value) => (value as { text?: string } | null)?.text === "B");
		const next = await crafted(id, opening, "next");
		await next.join({ kind: "text" }, TEST);
		const reopened = loadText((await until(next.room, (value) => value.base !== null)).base?.value);
		assert.equal(reopened?.doc.text, "B");
		// Still B after the room's next write (an edit of its own would have written A back before the fix).
		const edit = new TextClient("editor-next", reopened?.doc ?? base.doc).input("B!");
		assert.ok(edit);
		await next.edit({ n: edit.n, edits: [...edit.edits] }, TEST);
		await until(state.value, (value) => (value as { text?: string } | null)?.text === "B!");
		state.release();
	});

	it("lets a frame that only offers methods answer calls", async () => {
		const { id, chat } = await session();
		const { opening } = await token(id);
		const frame = await crafted(id, opening, "only");
		// No room asked for: joining without a kind gives the frame its peer ID and keeps the room's kind open.
		assert.equal((await frame.join({}, TEST)).me, "only");
		assert.equal(frame.room.value.kind, null);
		await frame.offer({ methods: [{ name: "ping", description: "Pings", args: { type: "object" } }] }, TEST);
		const watch = await frame.room.watch(TEST);
		watch.start(async (call) => {
			if (call.kind !== "value") return;
			for (const each of call.value.calls) await frame.answer({ id: each.id, result: "pong" }, TEST).catch(() => {});
		});
		assert.match(
			await prompt(
				chat,
				"codemode",
				`codemode return JSON.stringify(await tools.view_call({ view: "room", method: "ping", args: {} }))`,
			),
			/pong/,
		);
		await watch.stop();
	});
});

describe("view rooms' memory budget", () => {
	let fixture: Fixture;

	// Each case its own server: a room keeps what it was charged until it ends, which would spend the next case's
	// budget.
	beforeEach(async () => {
		fixture = await startFixture();
		// A small budget from the start: this fixture's rooms are the only ones counted.
		writeFileSync(join(fixture.dataDir, "settings.json"), JSON.stringify({ viewRoomsMemory: 1 }));
		// Read when the file changes: wait until the server's configuration has it.
		const config = await fixture.server.host.get(ModelConfig, {}, TEST);
		await until(config.snapshot, (value) => value.settings.viewRoomsMemory === 1);
		config.release();
	});
	afterEach(async () => {
		await fixture?.close();
	});

	/** Opens the custom view `room` in `session` (the agent's tool) and waits for its opening. */
	const openRoom = async (owner: Host, id: string) => {
		const chat = await holdIn(owner, Chat, { session: id, conversation: 1 }, "participant");
		await chat.send(
			{
				text: `view ${JSON.stringify({ action: "open", kind: "custom", title: "Room", id: "room", html: PAGE })}`,
				requestId: `budget-open-${id}`,
			},
			TEST,
		);
		const links = await holdIn(owner, ViewLinks, { session: id }, "viewer");
		let opening = "";
		for (let n = 0; n < 100 && !opening; n++)
			opening = await links.token({ view: "room" }, TEST).then(
				(answer) => answer.opening,
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 100));
					return "";
				},
			);
		return { opening, links };
	};
	/** A view principal that may write, made here. */
	const writer = (id: string, opening: string, link: string): ViewPrincipal => ({
		kind: "view",
		session: id,
		view: "room",
		opening,
		mode: "write",
		for: { name: link, role: "owner" },
		link,
		editor: link,
		viewer: [],
	});

	it("refuses a snapshot the room cannot take before anything is written", async () => {
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const id = (await sessions.create({ cwd: fixture.workspace }, TEST)).id;
		const { opening, links } = await openRoom(owner, id);
		const leader = await holdIn(
			fixture.as(writer(id, opening, "leader")),
			ViewRoom,
			{ session: id, view: "room", opening },
			"peer",
		);
		await leader.join({ kind: "log" }, TEST);
		// About 920 KB kept: a small message, then two large ones.
		await leader.send(
			{ messages: [{ data: "1" }, { data: "a".repeat(230_000) }, { data: "b".repeat(230_000) }] },
			TEST,
		);
		const room = await until(leader.room, (value) => value.seq === 3);
		const base = room.base;
		assert.ok(base);
		// A snapshot after the small message frees almost nothing, and its 240 KB base would pass the budget.
		await assert.rejects(
			leader.snapshot({ seq: 1, epoch: base.epoch, term: room.term, value: { text: "z".repeat(120_000) } }, TEST),
			/keep too much memory/,
		);
		// Nothing persisted, the room as it was.
		const state = await holdIn(owner, ViewState, { session: id, view: "room" }, "editor");
		assert.equal(JSON.stringify(state.value.value).length < 1000, true);
		assert.equal(leader.room.value.base?.seq, 0);
		assert.equal((await leader.history({ after: 0, limit: 10 }, TEST)).messages[0]?.seq, 1);
		links.release();
	});

	it("counts concurrent trims of the same messages once", async () => {
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const id = (await sessions.create({ cwd: fixture.workspace }, TEST)).id;
		const { opening } = await openRoom(owner, id);
		const frame = (link: string) =>
			holdIn(fixture.as(writer(id, opening, link)), ViewRoom, { session: id, view: "room", opening }, "peer");
		const left = await frame("left");
		const right = await frame("right");
		await left.join({ kind: "live" }, TEST);
		await right.join({ kind: "live" }, TEST);
		// About 2 KiB a message as charged: 400 of them are most of the 1 MiB budget.
		const batch = Array.from({ length: 100 }, () => ({ data: "z".repeat(1000) }));
		const fill = async () => {
			for (let n = 0; n < 4; n++) await left.send({ messages: batch }, TEST);
		};
		// The budget applies once settings.json was read.
		await until(left.room, () => true);
		let applied = false;
		for (let n = 0; n < 100 && !applied; n++) {
			await left.send({ messages: Array.from({ length: 1000 }, () => ({ data: "" })) }, TEST).catch(() => {
				applied = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(applied, "the budget applies");
		// Everything acknowledged by both peers at once, several times over: trims race for the same blocks.
		const everything = () => {
			const seq = left.room.value.seq;
			return Promise.all([
				left.ack({ seq }, TEST),
				right.ack({ seq }, TEST),
				left.ack({ seq }, TEST),
				right.ack({ seq }, TEST),
			]);
		};
		await everything();
		await fill();
		await everything();
		// Counted once, the room is empty again: 400 messages fit, 800 do not.
		await fill();
		await assert.rejects(fill(), /keep too much memory/);
	});
});
