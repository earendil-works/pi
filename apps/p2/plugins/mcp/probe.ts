// The loopback probe, a native of the manager: a listener on the p2 host's 127.0.0.1 that tells a sign-in page whether
// its browser runs on the p2 host. The page (on p2's Radius or public origin) fetches `http://127.0.0.1:<port>/<nonce>`:
// only a browser on this machine reaches this listener, and only this p2 knows the nonce, so another program or p2 on
// the browser's machine cannot answer for it. A wrong answer costs nothing more than a sign-in to paste.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** How long a nonce answers. */
const NONCE_MS = 5 * 60_000;

/** The probe listener, started on first use. */
export class LoopbackProbe {
	/** The origin of the page each nonce was handed to, and when it expires. */
	readonly #nonces = new Map<string, { readonly origin: string; readonly expires: number }>();
	#server: Promise<Server> | undefined;
	#closed = false;

	/** A probe URL for a page on `origin`: it answers that origin's requests, with CORS, for a few minutes. */
	async url(origin: string): Promise<string> {
		if (this.#closed) throw new Error("The loopback probe is closed");
		const now = Date.now();
		for (const [nonce, entry] of this.#nonces) if (entry.expires <= now) this.#nonces.delete(nonce);
		const nonce = randomBytes(24).toString("hex");
		this.#nonces.set(nonce, { origin, expires: now + NONCE_MS });
		this.#server ??= listen((request, response) => this.#handle(request, response));
		const server = await this.#server;
		const address = server.address();
		// A TCP listener's address is an object.
		const port = typeof address === "object" && address !== null ? address.port : 0;
		return `http://127.0.0.1:${port}/${nonce}`;
	}

	async close(): Promise<void> {
		this.#closed = true;
		const server = await this.#server?.catch(() => undefined);
		if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	/**
	 * 204 with CORS for the nonce's origin, else 404 without: other pages learn nothing. Preflights (Chrome's private
	 * network access asked for one) get the same answer, allowing the private network request.
	 */
	#handle(request: IncomingMessage, response: ServerResponse): void {
		request.resume();
		const nonce = new URL(request.url ?? "/", "http://127.0.0.1").pathname.slice(1);
		const entry = this.#nonces.get(nonce);
		const origin = request.headers.origin;
		if (entry === undefined || entry.expires <= Date.now() || origin !== entry.origin) {
			response.writeHead(404, { "Cache-Control": "no-store" }).end();
			return;
		}
		const cors = { "Access-Control-Allow-Origin": origin, Vary: "Origin", "Cache-Control": "no-store" };
		if (request.method === "OPTIONS")
			response
				.writeHead(204, {
					...cors,
					"Access-Control-Allow-Methods": "GET",
					"Access-Control-Allow-Private-Network": "true",
				})
				.end();
		else if (request.method === "GET") response.writeHead(204, cors).end();
		else response.writeHead(405, cors).end();
	}
}

/** A listener on a free port of 127.0.0.1. */
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<Server> {
	const server = createServer(handler);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	server.unref();
	return server;
}
