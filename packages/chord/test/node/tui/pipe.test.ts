// Tests of the launcher's end of the sandbox's pipes (slice 11 §4; fix round 2): length-prefixed frames cut from the
// sandbox's output however it chunks them, each message checked, and anything malformed or oversized refused, so the
// sandbox ends and the launcher goes on (Opus E3).

import { describe, expect, it } from "vitest";
import { FrameReader, launcherFrame, MAX_PIPE_FRAME } from "../../../src/node/tui/pipe.ts";

/** A frame from the sandbox: `header` as JSON, then `body`. */
function frame(header: unknown, body: Uint8Array = new Uint8Array(0)): Buffer {
	const json = Buffer.from(JSON.stringify(header));
	const prefix = Buffer.alloc(8);
	prefix.writeUInt32BE(4 + json.length + body.length, 0);
	prefix.writeUInt32BE(json.length, 4);
	return Buffer.concat([prefix, json, body]);
}

describe("reading the sandbox's frames", () => {
	it("cuts messages from chunks of any size, a byte at a time included", () => {
		const bytes = Buffer.concat([
			frame({ kind: "write" }, Buffer.from("héllo")),
			frame({ kind: "socket_send", socket: 1 }, new Uint8Array([1, 2, 3])),
			frame({ kind: "request", id: 7, request: { kind: "copy", text: "x" } }),
		]);
		const whole = new FrameReader().push(bytes);
		const reader = new FrameReader();
		const bytewise = [...bytes].flatMap((byte) => reader.push(Buffer.from([byte])));
		for (const messages of [whole, bytewise]) {
			expect(messages).toEqual([
				{ kind: "write", data: "héllo" },
				{ kind: "socket_send", socket: 1, bytes: new Uint8Array([1, 2, 3]) },
				{ kind: "request", id: 7, request: { kind: "copy", text: "x" } },
			]);
		}
	});

	it("refuses a frame over 17 MiB before reading it, and messages of no known shape", () => {
		const huge = Buffer.alloc(8);
		huge.writeUInt32BE(MAX_PIPE_FRAME + 1, 0);
		expect(() => new FrameReader().push(huge)).toThrow("malformed frame");
		for (const header of [
			null,
			{ kind: "nope" },
			{ kind: "socket_send", socket: "1" },
			{ kind: "request", id: 1, request: { kind: "copy", text: 5 } },
			{ kind: "request", id: 1, request: { kind: "run", command: "sh" } },
		]) {
			expect(() => new FrameReader().push(frame(header))).toThrow("malformed message");
		}
		const garbage = Buffer.from("ESCAPE-MARK");
		expect(() => new FrameReader().push(garbage)).toThrow("malformed frame");
	});

	it("writes the launcher's messages with their text or bytes as the body", () => {
		const input = launcherFrame({ kind: "input", data: "y" });
		expect(input.readUInt32BE(0)).toBe(input.length - 4);
		const headerLength = input.readUInt32BE(4);
		expect(JSON.parse(input.toString("utf8", 8, 8 + headerLength))).toEqual({ kind: "input" });
		expect(input.toString("utf8", 8 + headerLength)).toBe("y");
	});
});
