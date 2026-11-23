import assert from "node:assert/strict";
import { Socket } from "node:net";
import { test } from "node:test";
import { encodeFrame, readFrames } from "../../plugins/terminals/protocol.ts";

function feed(bytes: Buffer, chunkSize: number): unknown[] {
	const socket = new Socket();
	const frames: unknown[] = [];
	readFrames(socket, (frame) => frames.push(frame));
	for (let i = 0; i < bytes.length; i += chunkSize) socket.emit("data", bytes.subarray(i, i + chunkSize));
	return frames;
}

test("terminal frames read the same at every chunk size", () => {
	const binary = new Uint8Array([1, 2, 3, 4, 5]);
	const bytes = Buffer.concat([encodeFrame({ type: "list" }), encodeFrame(binary), encodeFrame({ type: "exit" })]);
	for (let chunkSize = 1; chunkSize <= bytes.length; chunkSize++) {
		assert.deepEqual(feed(bytes, chunkSize), [{ type: "list" }, binary, { type: "exit" }], `chunk size ${chunkSize}`);
	}
});

test("a large terminal frame split across many chunks is joined once", (t) => {
	const payload = new Uint8Array(1024 * 1024).fill(7);
	const bytes = encodeFrame(payload);
	const concat = t.mock.method(Buffer, "concat");
	const frames = feed(bytes, 4096);
	assert.equal(concat.mock.callCount(), 1);
	assert.deepEqual(frames, [payload]);
});
