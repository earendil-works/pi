// The server pings a viewer's terminal socket (TERMINAL_PING_MS): an idle terminal sends nothing else.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { WebSocket } from "ws";
import { TERMINAL_PING_MS, TerminalView } from "../../plugins/terminals/service.ts";
import { APP } from "./helpers.ts";

test("a viewer's terminal socket is pinged while open, and no longer once closed", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const sent: string[] = [];
	const socket = Object.assign(new EventEmitter(), {
		readyState: 1,
		send: (data: string) => sent.push(data),
		terminate: () => {},
		close: () => {},
	});
	new TerminalView(tmpdir(), APP, "session", "version").bind(socket as unknown as WebSocket);
	t.mock.timers.tick(TERMINAL_PING_MS - 1);
	assert.deepEqual(sent, []);
	t.mock.timers.tick(1);
	t.mock.timers.tick(TERMINAL_PING_MS);
	assert.deepEqual(sent, ['{"type":"ping"}', '{"type":"ping"}']);
	socket.emit("close");
	t.mock.timers.tick(TERMINAL_PING_MS * 3);
	assert.equal(sent.length, 2);
});
