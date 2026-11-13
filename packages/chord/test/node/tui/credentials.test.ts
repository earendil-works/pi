// Tests of the launcher's credentials (slice 11 §4; fix round 1, Fable M2): a pairing answer the server sends is shown
// on the real terminal only when it is a plain code; anything else (an escape sequence) fails the pairing.

import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { tokenOf } from "../../../src/node/tui/credentials.ts";

/** A server answering every pairing request with `answer`. */
async function pairingServer(answer: unknown): Promise<{ url: URL; close(): void }> {
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(answer));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };
	return { url: new URL(`http://127.0.0.1:${port}`), close: () => server.close() };
}

describe("pairing", () => {
	it("refuses a code that is no plain code, showing nothing", async () => {
		for (const code of ["\x1b]52;c;Y3VybA==\x07", "AB\r\nCD", "x".repeat(40), 7]) {
			const server = await pairingServer({ code, poll: "p" });
			const said: string[] = [];
			await expect(
				tokenOf(
					{ kind: "pairing", label: "t" },
					server.url,
					(line) => said.push(line),
					new AbortController().signal,
				),
			).rejects.toThrow("pairing answer is malformed");
			expect(said).toEqual([]);
			server.close();
		}
	});
});
