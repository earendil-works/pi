import { describe, expect, it } from "vitest";
import { type ServerSentEvent, SseDecoder } from "../src/utils/sse.ts";

function decode(bytes: Uint8Array, chunkSize: number): ServerSentEvent[] {
	const decoder = new SseDecoder();
	const events: ServerSentEvent[] = [];
	for (let i = 0; i < bytes.length; i += chunkSize) events.push(...decoder.push(bytes.subarray(i, i + chunkSize)));
	events.push(...decoder.end());
	return events;
}

describe("SseDecoder", () => {
	it("gives the same events for every chunking and line ending", () => {
		for (const separator of ["\n", "\r\n", "\r"]) {
			const text = [": keepalive", "event: delta", 'data: {"a":', 'data:  "é"}', "", "data: tail"].join(separator);
			const bytes = new TextEncoder().encode(text);
			for (let chunkSize = 1; chunkSize <= bytes.length; chunkSize++) {
				expect(decode(bytes, chunkSize)).toEqual([
					{
						event: "delta",
						data: '{"a":\n "é"}',
						raw: [": keepalive", "event: delta", 'data: {"a":', 'data:  "é"}'],
					},
					{ event: null, data: "tail", raw: ["data: tail"] },
				]);
			}
		}
	});

	it("does not end an event at a CRLF split across chunks", () => {
		const decoder = new SseDecoder();
		const encoder = new TextEncoder();
		expect(decoder.push(encoder.encode("data: a\r"))).toEqual([]);
		expect(decoder.push(encoder.encode("\ndata: b\r\n\r\n"))).toEqual([
			{ event: null, data: "a\nb", raw: ["data: a", "data: b"] },
		]);
	});

	it("does not carry an empty event name into the next event", () => {
		const decoder = new SseDecoder();
		expect(decoder.push(new TextEncoder().encode("event:\n\ndata: x\n\n"))).toEqual([
			{ event: null, data: "x", raw: ["data: x"] },
		]);
	});

	it("drops comment lines of events without data", () => {
		const decoder = new SseDecoder();
		const encoder = new TextEncoder();
		expect(decoder.push(encoder.encode(": ping\n\ndata: x\n\n"))).toEqual([
			{ event: null, data: "x", raw: ["data: x"] },
		]);
	});
});
