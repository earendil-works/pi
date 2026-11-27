// One viewer's socket (viewer-socket.ts) on a stand-in transport whose writes complete when the test says, over a
// stand-in terminal: a size that waits for room in the buffer never comes after a newer one (Astra, round 3); while an
// election waits for room, no output goes past the offset it names (Opus, round 3); the first output frame says where
// it starts in the terminal's output, and so does one after bytes skipped.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/p3/v1";
import type { WebSocketHandle } from "@earendil-works/p3/v1/server";
import type { TerminalHost } from "../../environments/contract.terminal-host.server.ts";
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
		void viewer.stream(
			terminal(0, WINDOW - Buffer.byteLength(JSON.stringify(small)) - 40, reached.resolve),
			"t",
			context,
		);
		await reached.promise;
		viewer.tell(large);
		viewer.tell(small);
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
		viewer.tell({ kind: "answer", yes: true, at: 1000 + WINDOW });
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
});
