import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonRpcMessage } from "../src/index.ts";
import { JsonRpcLineReader } from "../src/transports/lines.ts";

function startReader(maxMessageBytes?: number) {
	const messages: JsonRpcMessage[] = [];
	const errors: string[] = [];
	const reader = new JsonRpcLineReader({
		maxMessageBytes,
		onMessage: (message) => messages.push(message),
		onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
	});
	return { reader, messages, errors };
}

function feed(reader: JsonRpcLineReader, bytes: Buffer, chunkSize: number): void {
	for (let i = 0; i < bytes.length; i += chunkSize) reader.readStdout(bytes.subarray(i, i + chunkSize));
}

describe("JsonRpcLineReader", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("joins a message split across many chunks once, when its newline arrives", () => {
		const { reader, messages, errors } = startReader();
		const text = "x".repeat(1024 * 1024);
		const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text } })}\n`);
		const concat = vi.spyOn(Buffer, "concat");
		feed(reader, bytes, 4096);
		expect(concat).toHaveBeenCalledTimes(1);
		expect(errors).toEqual([]);
		expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, result: { text } }]);
	});

	it("handles multi-byte characters, CRLF, blank lines, and several messages per chunk at any split", () => {
		const input = Buffer.from(
			[
				JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "héllo 🌍" } }),
				"",
				`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/x" })}\r`,
				"not json",
				JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }),
				"",
			].join("\n"),
		);
		for (let chunkSize = 1; chunkSize <= input.length; chunkSize++) {
			const { reader, messages, errors } = startReader();
			feed(reader, input, chunkSize);
			reader.end();
			expect(messages).toEqual([
				{ jsonrpc: "2.0", id: 1, result: { text: "héllo 🌍" } },
				{ jsonrpc: "2.0", method: "notifications/x" },
				{ jsonrpc: "2.0", id: 2, result: {} },
			]);
			expect(errors).toHaveLength(1);
		}
	});

	it("drops an oversized message and keeps reading the next one", () => {
		const { reader, messages, errors } = startReader(64);
		const next = JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} });
		feed(reader, Buffer.from(`${"a".repeat(50)}`), 10);
		feed(reader, Buffer.from(`${"a".repeat(50)}\n${next}\n`), 10);
		expect(errors[0]).toBe("MCP stdio message exceeds 64 bytes");
		expect(messages).toEqual([{ jsonrpc: "2.0", id: 2, result: {} }]);
	});

	it("reports a message without its newline at the end", () => {
		const { reader, errors } = startReader();
		feed(reader, Buffer.from('{"jsonrpc":"2.0",'), 4);
		reader.end();
		expect(errors).toEqual(["MCP stdio server closed with an incomplete JSON-RPC message"]);
	});
});
