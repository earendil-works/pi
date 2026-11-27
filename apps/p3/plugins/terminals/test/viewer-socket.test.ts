// One viewer's socket (viewer-socket.ts) on a stand-in transport whose writes complete when the test says, over a
// stand-in terminal: a size that waits for room in the buffer never comes after a newer one (Astra, round 3); while an
// election waits for room, no output goes past the offset it names (Opus, round 3); the first output frame says where
// it starts in the terminal's output, and so does one after bytes skipped.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/p3/v1";
import type { WebSocketHandle } from "@earendil-works/p3/v1/server";
import type { TerminalHost } from "../../environments/contract.terminal-host.server.ts";
import { type Answerer, Answering } from "../answering.ts";
import { Ghostty } from "../ghostty.ts";
import { ViewerSocket, WINDOW } from "../viewer-socket.ts";

/** A transport whose writes complete only when `complete` is called; what it was sent, text frames parsed. */
function transport() {
	const told: unknown[] = [];
	const output: number[] = [];
	const waiting: (() => void)[] = [];
	const socket = {
		send: (data: string | Uint8Array, sent: () => void) => {
			if (typeof data === "string") told.push(JSON.parse(data));
			else output.push(data.length);
			waiting.push(sent);
		},
		close: () => {},
	};
	// The handler uses `send` and `close` of ws's WebSocket only.
	return {
		socket: socket as unknown as WebSocketHandle,
		told,
		output,
		complete: () => {
			for (const sent of waiting.splice(0)) sent();
		},
	};
}

/** A terminal whose output is `end` bytes, from offset `start`, never ending: `next` waits at the end. */
function terminal(start: number, end: number, reached: () => void): TerminalHost {
	return {
		next: async (_id: string, from: number) => {
			const at = Math.max(from, start);
			if (at >= end) {
				reached();
				return new Promise(() => {});
			}
			return { from: at, bytes: new Uint8Array(Math.min(64 * 1024, end - at)) };
		},
	} as unknown as TerminalHost;
}

describe("a viewer's socket", () => {
	it("never sends a size after a newer one, though the newer is shorter and fits first (Astra, round 3)", async () => {
		const { socket, told, complete } = transport();
		const viewer = new ViewerSocket(socket);
		const reached = Promise.withResolvers<void>();
		const small = { kind: "size", columns: 80, rows: 24 } as const;
		const large = { kind: "size", columns: 100, rows: 100 } as const;
		// Room for the smaller size and no more (Astra, round 4: the boundary exact, so the newer would fit at once).
		const from = Buffer.byteLength(JSON.stringify({ kind: "from", offset: 0 }));
		const end = WINDOW - Buffer.byteLength(JSON.stringify(small)) - from;
		void viewer.stream(terminal(0, end, reached.resolve), "t", context);
		await reached.promise;
		viewer.size(large.columns, large.rows);
		viewer.size(small.columns, small.rows);
		assert.equal(
			told.some((frame) => (frame as { kind: string }).kind === "size"),
			false,
			"neither size went before the buffer drained",
		);
		complete();
		complete();
		assert.deepEqual(told.filter((frame) => (frame as { kind: string }).kind === "size").at(-1), small);
	});

	it("sends no output past an election that waits for room, and says where its output starts (Opus, round 3)", async () => {
		const { socket, told, output, complete } = transport();
		const viewer = new ViewerSocket(socket);
		const reached = Promise.withResolvers<void>();
		void viewer.stream(terminal(1000, 1000 + WINDOW + 4096, reached.resolve), "t", context);
		// The window is full: the stream waits for room.
		await new Promise((resolve) => setImmediate(resolve));
		viewer.answer(true, 1000 + WINDOW);
		viewer.drawn(WINDOW);
		const before = output.reduce((sum, size) => sum + size, 0);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(
			output.reduce((sum, size) => sum + size, 0),
			before,
			"no output while the election waits",
		);
		complete();
		await reached.promise;
		const kinds = told.map((frame) => (frame as { kind: string }).kind);
		assert.deepEqual(kinds, ["from", "answer"]);
		assert.deepEqual(told[0], { kind: "from", offset: 1000 });
	});

	// Astra, round 4: A, then B, then A again while A's buffer is full; the query between was B's.
	it("tells every election in order: a query between two of them is answered once, by its viewer", async () => {
		const wasm = await readFile(new URL("../vendor/ghostty/ghostty-vt.wasm", import.meta.url));
		const ghostty = await Ghostty.load(`data:application/wasm;base64,${wasm.toString("base64")}`);
		let output = Buffer.alloc(0);
		let more = Promise.withResolvers<void>();
		const host = {
			next: async (_id: string, from: number) => {
				while (from === output.length) await more.promise;
				return { from, bytes: output.subarray(from, from + 64 * 1024) };
			},
		} as unknown as TerminalHost;
		const print = (bytes: Buffer) => {
			output = Buffer.concat([output, bytes]);
			const woken = more;
			more = Promise.withResolvers();
			woken.resolve();
		};
		const election = new Answering(() => output.length);
		const replies: string[] = [];
		/** A page as the screen is: it applies each change at its offset, and answers only while it answers. */
		const page = (name: string) => {
			let offset = 0;
			let answering = false;
			const changes: { yes: boolean; at: number }[] = [];
			const held: (() => void)[] = [];
			let holding = false;
			const vt = ghostty.terminal({
				cols: 80,
				rows: 24,
				scrollback: 8,
				onReply: () => {
					if (answering) replies.push(name);
				},
			});
			const viewer = new ViewerSocket({
				send: (frame: string | Uint8Array, sent: () => void) => {
					if (typeof frame === "string") {
						const told = JSON.parse(frame) as { kind: string; offset?: number; yes?: boolean; at?: number };
						if (told.kind === "from") offset = told.offset!;
						if (told.kind === "answer") changes.push({ yes: told.yes!, at: told.at! });
					} else {
						for (let at = 0; at < frame.length; ) {
							while (changes[0] !== undefined && changes[0].at <= offset) answering = changes.shift()!.yes;
							const piece = Math.min(frame.length - at, (changes[0]?.at ?? Number.POSITIVE_INFINITY) - offset);
							vt.write(frame.subarray(at, at + piece));
							offset += piece;
							at += piece;
						}
						queueMicrotask(() => viewer.drawn(frame.length));
					}
					if (holding) held.push(sent);
					else queueMicrotask(sent);
				},
				close: () => {},
			} as unknown as WebSocketHandle);
			const answerer: Answerer = { typable: () => true, answer: (yes, at) => viewer.answer(yes, at) };
			election.add(answerer);
			void viewer.stream(host, "t", context);
			return {
				answerer,
				hold: () => {
					holding = true;
				},
				drain: () => {
					holding = false;
					for (const sent of held.splice(0)) sent();
				},
			};
		};
		const tick = () => new Promise((resolve) => setImmediate(resolve));
		const a = page("A");
		const b = page("B");
		await tick();
		a.hold();
		print(Buffer.alloc(WINDOW));
		await tick();
		election.typed(b.answerer);
		print(Buffer.from("\u001b[c"));
		await tick();
		election.typed(a.answerer);
		a.drain();
		await tick();
		assert.deepEqual(replies, ["B"]);
	});
});
