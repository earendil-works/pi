// How a `p3` command talks to a running server. A `running` record is believed only once the server on its port
// proves who it is (`kit/identity.ts`: the record's run id and pid, and the proof for a nonce of the command's own),
// and the owner's requests (the owner link, the stop) go over the very connection that proof came over, kept open: a
// server that closes meanwhile frees its port before its record and lock go, and a program of another user waiting
// for it would get a request sent on a new connection, the owner token with it. Every request has a deadline for the
// whole of it (connecting, the headers, the body) and a cap on its answer's size, so nothing on the port holds a
// command longer than it allows.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import { IDENTITY_PATH, type Identity, proves } from "./kit/identity.ts";
import { ifExists, layoutOf } from "./kit/layout.ts";
import type { Running } from "./kit/running.ts";

/** A request to a server: its method and path. */
export type Asking = { readonly method: "GET" | "POST"; readonly path: string };

/** An answer: its status and its body. */
export type Answer = { readonly status: number | undefined; readonly body: string };

/** How long a server may take to say who it is, at most. */
const IDENTITY_MS = 2000;

/** How long a server may take to answer the owner's request, at most. */
const ANSWER_MS = 10_000;

/**
 * Whether the server `record` names is the one listening on its port: it proved itself, within `deadline` (ms since
 * the epoch) and 2 s. The question carries no token.
 */
export async function proven(dataDir: string, record: Running, deadline: number): Promise<boolean> {
	const connection = new Connection(record.port);
	try {
		return await provesItself(connection, dataDir, record, deadline);
	} finally {
		connection.close();
	}
}

/**
 * Sends `request` as the owner (the owner token as a bearer) to the server `record` names, on a connection over which
 * it proved itself first, within `deadline` (ms since the epoch) and 10 s: its answer, or `undefined` when it did not
 * prove itself, or did not answer in time (nothing was sent to anything else).
 */
export async function ask(
	dataDir: string,
	record: Running,
	request: Asking,
	deadline: number,
): Promise<Answer | undefined> {
	const connection = new Connection(record.port);
	try {
		if (!(await provesItself(connection, dataDir, record, deadline))) return undefined;
		const token = (await readFile(layoutOf(dataDir).ownerToken, "utf8")).trim();
		const headers = { authorization: `Bearer ${token}` };
		return await connection.send(request, headers, Math.min(ANSWER_MS, deadline - Date.now()));
	} finally {
		connection.close();
	}
}

/** Whether the server on `connection` proves it is the one `record` names (`kit/identity.ts`). */
async function provesItself(
	connection: Connection,
	dataDir: string,
	record: Running,
	deadline: number,
): Promise<boolean> {
	const nonce = randomBytes(16).toString("hex");
	const asking = { method: "GET", path: `${IDENTITY_PATH}?nonce=${nonce}` } as const;
	const answer = await connection.send(asking, {}, Math.min(IDENTITY_MS, deadline - Date.now()));
	if (answer?.status !== 200) return false;
	// A trust boundary: whatever listens on the port answered.
	const said = parsed(answer.body) as Partial<Identity> | undefined;
	// No token file: no server of this directory ever ran to answer for it.
	const token = (await ifExists(readFile(layoutOf(dataDir).ownerToken, "utf8")))?.trim();
	return (
		token !== undefined && said?.run === record.run && said.pid === record.pid && proves(said.proof, token, nonce)
	);
}

/** `text` as JSON; `undefined` when it is none. */
function parsed(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** The most an answer may hold: an identity is a few hundred bytes, an owner link less. */
const ANSWER_BYTES = 64 * 1024;

/**
 * One TCP connection to a port on loopback, for requests one after the other (HTTP/1.1, kept alive). Once it closed,
 * a request on it fails: it is never opened again.
 */
class Connection {
	readonly #socket: Socket;
	readonly #port: number;
	#closed = false;

	constructor(port: number) {
		this.#port = port;
		this.#socket = connect(port, "127.0.0.1");
		this.#socket.on("error", () => {});
		this.#socket.once("close", () => {
			this.#closed = true;
		});
	}

	/**
	 * Sends `request` with `headers`: its answer, or `undefined` when the connection closed or failed, the answer was
	 * larger than `ANSWER_BYTES`, or did not come whole within `ms` (the connection is closed then).
	 */
	send(request: Asking, headers: Readonly<Record<string, string>>, ms: number): Promise<Answer | undefined> {
		if (this.#closed || ms <= 0) return Promise.resolve(undefined);
		const answered = Promise.withResolvers<Answer | undefined>();
		const end = (answer: Answer | undefined): void => {
			clearTimeout(timer);
			this.#socket.off("close", lost);
			answered.resolve(answer);
		};
		const lost = (): void => end(undefined);
		// A deadline for all of it, not an inactivity timeout: a byte a second must not keep the command waiting.
		const timer = setTimeout(() => {
			this.close();
			end(undefined);
		}, ms);
		this.#socket.once("close", lost);
		// `host` and `port` name the server in the `Host` header (its check refuses another), the socket is ours.
		const options = {
			...request,
			host: "127.0.0.1",
			port: this.#port,
			headers: { ...headers, connection: "keep-alive" },
		};
		const asked = httpRequest({ ...options, createConnection: () => this.#socket }, (response) => {
			const chunks: Buffer[] = [];
			let bytes = 0;
			response.on("data", (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > ANSWER_BYTES) {
					this.close();
					end(undefined);
				} else chunks.push(chunk);
			});
			response.on("end", () => end({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
			response.on("error", lost);
		});
		asked.on("error", lost);
		asked.end();
		return answered.promise;
	}

	/** Closes the connection: no request goes over it any more. */
	close(): void {
		this.#closed = true;
		this.#socket.destroy();
	}
}
