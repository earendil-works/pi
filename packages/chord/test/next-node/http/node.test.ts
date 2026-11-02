// Tests of Chord's own Node server (the listener's native): request targets (origin-form only; a malformed or
// double-slash path never crashes or reroutes), raw `Host` headers, Web requests made only when read, the request's scope lasting until its response is
// flushed (and `close` waiting for it), and a client's disconnect aborting the scope.

import { once } from "node:events";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { nodeRequest } from "../../../src/next-node/http/index.ts";
import { context, contributing, served } from "./support.ts";

/** What `port` answers a raw request `text` with: its status line and body. */
async function raw(port: number, text: string): Promise<{ readonly status: string; readonly body: string }> {
	const socket = connect(port, "127.0.0.1");
	let out = "";
	socket.on("data", (chunk) => {
		out += chunk.toString("latin1");
	});
	socket.on("error", () => {});
	await once(socket, "connect");
	socket.write(text);
	await once(socket, "close");
	const [head = "", body = ""] = out.split("\r\n\r\n");
	return { status: head.split("\r\n")[0] ?? "", body };
}

/** A route answering its path and params, under `GET /who` and `GET /n/:name`. */
const echo = contributing({
	routes: {
		"GET /who": async (request) => ({ kind: "json", value: request.path }),
		"GET /n/:name": async (request) => ({ kind: "json", value: request.params }),
	},
});

describe("targets", () => {
	// Astra's build review, Fable's security audit C1: `GET //[` threw out of the request handler and ended the process.
	it("answers a malformed or double-slash path without crashing or rerouting it (Opus's audit H5)", async () => {
		const server = await served({ "@app/echo": echo });
		const host = `Host: 127.0.0.1:${server.port}`;
		const get = (target: string) =>
			raw(server.port, `GET ${target} HTTP/1.1\r\n${host}\r\nConnection: close\r\n\r\n`);
		expect((await get("//[")).status).toBe("HTTP/1.1 404 Not Found");
		expect((await get("//evil.example/who")).status).toBe("HTTP/1.1 404 Not Found");
		expect(await get("/a/../who")).toEqual({ status: "HTTP/1.1 200 OK", body: '"/who"' });
		// The URL parser resolves `%2e%2e` as a dot segment: `/n/%2e%2e` is `/`.
		expect((await get("/n/%2e%2e")).status).toBe("HTTP/1.1 404 Not Found");
		expect((await get("/n/a%5Cb")).status).toBe("HTTP/1.1 400 Bad Request");
		expect((await get("/n/..%2F..%2Fsecret")).status).toBe("HTTP/1.1 400 Bad Request");
		expect((await get("/who")).status).toBe("HTTP/1.1 200 OK");
		await server.close();
	});

	it("refuses an absolute-form target, two Host headers and none (403)", async () => {
		const server = await served({ "@app/echo": echo });
		const host = `Host: 127.0.0.1:${server.port}`;
		const answers = await Promise.all([
			raw(server.port, `GET http://evil.example/who HTTP/1.1\r\n${host}\r\nConnection: close\r\n\r\n`),
			raw(server.port, `GET /who HTTP/1.1\r\n${host}\r\nHost: evil.example\r\nConnection: close\r\n\r\n`),
			raw(server.port, "GET /who HTTP/1.0\r\n\r\n"),
		]);
		expect(answers.map(({ status }) => status)).toEqual([
			"HTTP/1.1 403 Forbidden",
			"HTTP/1.1 403 Forbidden",
			"HTTP/1.1 403 Forbidden",
		]);
		await server.close();
	});

	it("refuses a Host with userinfo (403) and a method a Web Request cannot carry (501)", async () => {
		const server = await served({ "@app/echo": echo });
		const answers = await Promise.all([
			raw(server.port, `GET /who HTTP/1.1\r\nHost: attacker@127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`),
			raw(server.port, `TRACE /who HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`),
		]);
		// `TRACK` never reaches Chord: Node's parser refuses it (400); `CONNECT` goes to Node's `connect` event.
		expect(answers.map(({ status }) => status)).toEqual(["HTTP/1.1 403 Forbidden", "HTTP/1.1 501 Not Implemented"]);
		await server.close();
	});
});

describe("mounting on an app's own Node server", () => {
	// Sol's recheck N6: a hand-made `Request` threw unhandled on `Host: [` or an absolute-form target (the process
	// ended) and kept only the first of two `Host`s.
	it("converts with the listener's checks, never throwing: bad targets, userinfo, TRACE refused; duplicate Hosts kept", async () => {
		const server = await served({ "@app/echo": echo }, { config: { listen: undefined } });
		const own = createServer(async (message, res) => {
			const converted = nodeRequest(message, res);
			if (converted.kind === "refused") return void res.writeHead(converted.status).end();
			const response = await server.http.fetch(converted.request, converted.connection);
			for (const [name, value] of response.headers) res.appendHeader(name, value);
			res.writeHead(response.status).end(Buffer.from(await response.arrayBuffer()));
		});
		await new Promise<void>((resolve) => own.listen(0, "127.0.0.1", resolve));
		const address = own.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		const host = `Host: 127.0.0.1:${port}`;
		const get = (text: string) => raw(port, `${text}Connection: close\r\n\r\n`);
		expect(await get(`GET /who HTTP/1.1\r\n${host}\r\n`)).toEqual({ status: "HTTP/1.1 200 OK", body: '"/who"' });
		expect((await get("GET /who HTTP/1.1\r\nHost: [\r\n")).status).toBe("HTTP/1.1 400 Bad Request");
		expect((await get(`GET http://evil.example/who HTTP/1.1\r\n${host}\r\n`)).status).toBe("HTTP/1.1 403 Forbidden");
		expect((await get(`GET /who HTTP/1.1\r\n${host}\r\nHost: evil.example\r\n`)).status).toBe(
			"HTTP/1.1 403 Forbidden",
		);
		// Sol's second recheck A: both threw out of the conversion; the app's callback ended the process.
		expect((await get(`TRACE /who HTTP/1.1\r\n${host}\r\n`)).status).toBe("HTTP/1.1 501 Not Implemented");
		expect((await get(`GET /who HTTP/1.1\r\nHost: attacker@127.0.0.1:${port}\r\n`)).status).toBe(
			"HTTP/1.1 403 Forbidden",
		);
		expect((await get(`GET /who HTTP/1.1\r\n${host}\r\n`)).status).toBe("HTTP/1.1 200 OK");
		await new Promise((resolve) => own.close(resolve));
		await server.close();
	});
});

describe("Web requests", () => {
	it("makes a Web Request only when something reads the headers or the body (here: no authenticator does)", async () => {
		const server = await served(
			{
				"@app/r": contributing({
					routes: {
						"GET /plain": async (request) => ({ kind: "json", value: request.path }),
						"GET /headers": async (request) => ({ kind: "json", value: request.headers.get("x-thing") }),
						"POST /body": async (request) => ({ kind: "json", value: await request.json() }),
					},
				}),
			},
			{ authenticate: () => undefined },
		);
		const original = globalThis.Request;
		let made = 0;
		globalThis.Request = class extends original {
			constructor(...args: ConstructorParameters<typeof Request>) {
				super(...args);
				made++;
			}
		};
		try {
			const host = `Host: 127.0.0.1:${server.port}\r\nConnection: close`;
			await raw(server.port, `GET /plain HTTP/1.1\r\n${host}\r\n\r\n`);
			expect(made).toBe(0);
			const read = await raw(server.port, `GET /headers HTTP/1.1\r\n${host}\r\nX-Thing: t\r\n\r\n`);
			const posted = await raw(server.port, `POST /body HTTP/1.1\r\n${host}\r\nContent-Length: 3\r\n\r\n"a"`);
			expect([read.body, posted.body, made]).toEqual(['"t"', '"a"', 2]);
		} finally {
			globalThis.Request = original;
		}
		await server.close();
	});
});

describe("the request's scope", () => {
	// Sol's build review: the scope sealed, and `close` stopped waiting, before a large response was flushed.
	it("lasts until the response is flushed; close waits for it", async () => {
		const size = 32 * 1024 * 1024;
		let signal: AbortSignal | undefined;
		const server = await served(
			{
				"@app/large": contributing({
					routes: {
						"GET /large": async (_request, ctx) => {
							signal = ctx.abortSignal;
							return { kind: "html", body: "x".repeat(size) };
						},
					},
				}),
			},
			{ config: { listen: { host: "127.0.0.1", port: 0 }, closeTimeout: 2000 } },
		);
		const request = httpRequest({ host: "127.0.0.1", port: server.port, path: "/large", agent: false });
		const response = await new Promise<IncomingMessage>((resolve) => {
			request.on("response", (arrived: IncomingMessage) => {
				arrived.pause();
				resolve(arrived);
			});
			request.end();
		});
		let length = 0;
		response.on("data", (chunk: Buffer) => {
			length += chunk.length;
		});
		response.pause();
		await new Promise((resolve) => setTimeout(resolve, 20));
		const sealedBeforeFlush = signal?.aborted;
		const closing = server.http.close(context);
		await new Promise((resolve) => setTimeout(resolve, 20));
		response.resume();
		await once(response, "end");
		await closing;
		expect({ sealedBeforeFlush, length }).toEqual({ sealedBeforeFlush: false, length: size });
		await server.close();
	});

	it("is aborted when the client disconnects", async () => {
		const entered = Promise.withResolvers<AbortSignal>();
		const server = await served({
			"@app/slow": contributing({
				routes: {
					"GET /slow": async (_request, ctx) => {
						entered.resolve(ctx.abortSignal!);
						return new Promise(() => {});
					},
				},
			}),
		});
		const request = httpRequest({ host: "127.0.0.1", port: server.port, path: "/slow", agent: false });
		request.on("error", () => {});
		request.end();
		const signal = await entered.promise;
		const aborted = new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
		request.destroy();
		await aborted;
		expect(signal.aborted).toBe(true);
		await server.close();
	});
});
