// Per-connection limits of Chord client sockets, as Pi Mobile's: 1 MiB frames and 4 MiB unsent output (the socket is
// cut off).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import type { WebSocket } from "ws";
import { WebSocket as NodeWebSocket } from "ws";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { limitedSocket, MAX_CLIENT_FRAME, MAX_UNSENT_BYTES } from "../../src/hosts/socket-limits.ts";
import { clientHost, type Fixture, holdIn, startFixture } from "./helpers.ts";

/** A `ws` socket double: frames out recorded, a settable buffer. */
function fakeSocket() {
	const sent: Uint8Array[] = [];
	const callbacks: ((error?: Error) => void)[] = [];
	const fake = {
		OPEN: 1,
		on: () => {},
		readyState: 1,
		bufferedAmount: 0,
		terminated: false,
		addEventListener: () => {},
		removeEventListener: () => {},
		send: (data: Uint8Array, callback: (error?: Error) => void) => {
			sent.push(data);
			callbacks.push(callback);
		},
		terminate: () => {
			fake.terminated = true;
		},
		close: () => {},
	};
	return {
		fake,
		sent,
		flush: () => {
			for (const callback of callbacks.splice(0)) callback();
		},
	};
}

describe("chord2 socket limits", () => {
	it("cuts off a client that stops reading, but not for the frame being sent", () => {
		const { fake, flush } = fakeSocket();
		const socket = limitedSocket(fake as unknown as WebSocket);
		// One snapshot larger than the limit is fine while it is the frame being sent.
		const snapshot = new Uint8Array(MAX_UNSENT_BYTES + 1000);
		socket.send(snapshot);
		fake.bufferedAmount = snapshot.byteLength;
		socket.send(new Uint8Array(5));
		assert.equal(fake.terminated, false);
		// Once it was written, the same backlog of other frames is too much.
		flush();
		fake.bufferedAmount = MAX_UNSENT_BYTES + 1;
		socket.send(new Uint8Array(4));
		assert.equal(fake.terminated, true);
	});
});

describe("chord2 socket limits on the server", () => {
	let fixture: Fixture;
	before(async () => {
		fixture = await startFixture();
	});
	after(async () => {
		await fixture?.close();
	});

	it("closes a connection that sends a frame over 1 MiB", async () => {
		const socket = new NodeWebSocket(`ws://127.0.0.1:${fixture.server.port}/chord`);
		await new Promise((resolve) => socket.once("open", resolve));
		const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
		socket.send(new Uint8Array(MAX_CLIENT_FRAME + 1));
		assert.equal(await closed, 1009);
		// The server lives on (an unhandled socket error would have ended the process).
		// A browser-sized message still goes through a normal client.
		const host = clientHost(fixture.server.port);
		try {
			const sessions = await holdIn(host, Sessions, {}, "owner");
			await assert.rejects(
				sessions.create({ cwd: `/${"x".repeat(900_000)}` }, BACKGROUND_CONTEXT),
				/Not a directory|ENAMETOOLONG|name/i,
			);
		} finally {
			await host.close(BACKGROUND_CONTEXT);
		}
	});
});
