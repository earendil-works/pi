import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { encodeServerMessage, type ServerHelloError, ServerMessageDecoder } from "@earendil-works/pi-protocol";
import { expect, test, vi } from "vitest";
import { UnixByteConnection } from "../src/transports/unix/listener.ts";

class ControlledSocket extends EventEmitter {
	destroyed = false;
	writable = true;
	writableLength = 0;
	ended = false;
	finalChunk?: Uint8Array;
	private writeCallback?: (error?: Error | null) => void;

	write(_chunk: Uint8Array, callback: (error?: Error | null) => void): boolean {
		this.writableLength = 1;
		this.writeCallback = callback;
		return false;
	}

	end(chunk?: Uint8Array): this {
		this.ended = true;
		this.finalChunk = chunk?.slice();
		return this;
	}

	destroy(): this {
		if (this.destroyed) return this;
		this.destroyed = true;
		this.writable = false;
		this.emit("close");
		return this;
	}

	completeWrite(): void {
		const callback = this.writeCallback;
		if (!callback) throw new Error("No pending write");
		this.writeCallback = undefined;
		this.writableLength = 0;
		callback(null);
	}
}

test("queues a final protocol error behind pending output before closing", async () => {
	const socket = new ControlledSocket();
	const connection = new UnixByteConnection(socket as unknown as Socket, 1_000, 64 * 1024);
	const pendingWrite = connection.send(new Uint8Array([1, 2, 3]));
	await vi.waitFor(() => expect(socket.writableLength).toBe(1));
	const finalMessage: ServerHelloError = {
		type: "hello_error",
		error: { code: "invalid_request", message: "Protocol violation" },
	};
	const closing = connection.close(encodeServerMessage(finalMessage));

	expect(socket.ended).toBe(false);
	expect(socket.destroyed).toBe(false);

	socket.completeWrite();
	await pendingWrite;
	await vi.waitFor(() => expect(socket.ended).toBe(true));
	expect(new ServerMessageDecoder().push(socket.finalChunk!)).toEqual([finalMessage]);

	connection.markClosed();
	await closing;
});
