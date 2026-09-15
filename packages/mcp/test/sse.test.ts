import { describe, expect, it } from "vitest";
import { consumeSseStream, type SseEvent } from "../src/sse.ts";

describe("consumeSseStream", () => {
	it("parses chunked CRLF events, comments, IDs, and multiline data", async () => {
		const encoder = new TextEncoder();
		const chunks = [': keepalive\r\nid: 7\r\ndata: {"one":\r\n', "data: 1}\r\n\r\n"];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		});
		const events: SseEvent[] = [];
		await consumeSseStream(stream, { onEvent: (event) => events.push(event) });
		expect(events).toEqual([{ id: "7", data: '{"one":\n1}' }]);
	});
});
