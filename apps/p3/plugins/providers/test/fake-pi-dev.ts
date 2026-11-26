// A fake pi.dev for the catalog tests: an HTTP server on 127.0.0.1 answering `/api/models/providers/<id>` with what
// the test set for that provider (404 for the rest, as pi.dev for a provider it keeps no catalog of), recording every
// request (its provider, query, User-Agent and If-None-Match) and how many bytes of its body went out. A body may also
// be streamed in chunks without a Content-Length until the client stops reading, or left unfinished.

import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A request the fake received. */
export type CatalogHit = {
	readonly provider: string;
	readonly search: string;
	readonly userAgent: string | undefined;
	readonly ifNoneMatch: string | undefined;
	/** The body's bytes written so far. */
	sent: number;
};

/**
 * What the fake answers a provider: a status, headers and a JSON body; or a body streamed in chunks (`stream`: its
 * `prefix`, then `chunk` up to `count` times while the client reads; no Content-Length); `open` leaves the response
 * unfinished after its body.
 */
export type FakeAnswer = {
	readonly status: number;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: unknown;
	readonly stream?: { readonly prefix: string; readonly chunk: string; readonly count: number };
	readonly open?: boolean;
};

/** A running fake pi.dev. */
export type FakePiDev = {
	readonly baseUrl: string;
	readonly hits: CatalogHit[];
	/** Answers provider `provider`'s requests by `answer` from now on. */
	answer(provider: string, answer: (hit: CatalogHit) => FakeAnswer): void;
	close(): Promise<void>;
};

/** Writes `stream` through `send` while `response` is open and the client reads (waiting while its buffer is full). */
async function streamed(
	stream: NonNullable<FakeAnswer["stream"]>,
	send: (text: string) => boolean,
	response: ServerResponse,
): Promise<void> {
	send(stream.prefix);
	for (let at = 0; at < stream.count && !response.destroyed; at++) {
		if (!send(stream.chunk)) await Promise.race([once(response, "drain"), once(response, "close")]);
	}
	if (!response.destroyed) response.end();
}

/** Starts a fake pi.dev. */
export async function fakePiDev(): Promise<FakePiDev> {
	const answers = new Map<string, (hit: CatalogHit) => FakeAnswer>();
	const hits: CatalogHit[] = [];
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://fake");
		const provider = decodeURIComponent(url.pathname.replace(/^\/api\/models\/providers\//, ""));
		const hit: CatalogHit = {
			provider,
			search: url.search,
			userAgent: request.headers["user-agent"],
			ifNoneMatch: request.headers["if-none-match"],
			sent: 0,
		};
		hits.push(hit);
		const { status, headers, body, stream, open } = answers.get(provider)?.(hit) ?? { status: 404 };
		response.writeHead(status, { "content-type": "application/json", ...headers });
		const send = (text: string) => {
			hit.sent += Buffer.byteLength(text);
			return response.write(text);
		};
		if (stream !== undefined) {
			void streamed(stream, send, response);
			return;
		}
		if (body !== undefined) send(JSON.stringify(body));
		if (open !== true) response.end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		hits,
		answer: (provider, answer) => void answers.set(provider, answer),
		close: async () => {
			server.closeAllConnections();
			server.close();
			await once(server, "close");
		},
	};
}
