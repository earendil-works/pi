// A fake pi.dev for the catalog tests: an HTTP server on 127.0.0.1 answering `/api/models/providers/<id>` with what
// the test set for that provider (404 for the rest, as pi.dev for a provider it keeps no catalog of), recording every
// request (its provider, query, User-Agent and If-None-Match).

import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A request the fake received. */
export type CatalogHit = {
	readonly provider: string;
	readonly search: string;
	readonly userAgent: string | undefined;
	readonly ifNoneMatch: string | undefined;
};

/** What the fake answers a provider: a status, headers and a JSON body. */
export type FakeAnswer = {
	readonly status: number;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: unknown;
};

/** A running fake pi.dev. */
export type FakePiDev = {
	readonly baseUrl: string;
	readonly hits: CatalogHit[];
	/** Answers provider `provider`'s requests by `answer` from now on. */
	answer(provider: string, answer: (hit: CatalogHit) => FakeAnswer): void;
	close(): Promise<void>;
};

/** Starts a fake pi.dev. */
export async function fakePiDev(): Promise<FakePiDev> {
	const answers = new Map<string, (hit: CatalogHit) => FakeAnswer>();
	const hits: CatalogHit[] = [];
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://fake");
		const provider = decodeURIComponent(url.pathname.replace(/^\/api\/models\/providers\//, ""));
		const hit = {
			provider,
			search: url.search,
			userAgent: request.headers["user-agent"],
			ifNoneMatch: request.headers["if-none-match"],
		};
		hits.push(hit);
		const { status, headers, body } = answers.get(provider)?.(hit) ?? { status: 404 };
		response.writeHead(status, { "content-type": "application/json", ...headers });
		response.end(body === undefined ? undefined : JSON.stringify(body));
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
