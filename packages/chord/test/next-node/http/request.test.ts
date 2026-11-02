// Tests of requests (slice 10 §2, D4): the summary a route gets, `json` and `body` with their limits and statuses
// (400, 413, an `HttpFailure` escaping a route answering its status), and a body nobody read (drained or closed).

import { Agent, request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import type { HttpRequest } from "../../../src/next-node/http/index.ts";
import { contributing, send, served } from "./support.ts";

describe("the request a route gets", () => {
	it("has its method, path, params, query, headers, origin, provenance and the response's nonce", async () => {
		let seen: HttpRequest | undefined;
		const server = await served({
			"@app/a": contributing({
				routes: {
					"GET /notes/:id": async (request) => {
						seen = request;
						return { kind: "json", value: null };
					},
				},
			}),
		});
		await send(server.port, "GET", "/notes/a%20b?x=1&x=2", { headers: { "X-Thing": "t" } });
		expect(seen).toMatchObject({
			method: "GET",
			path: "/notes/a%20b",
			params: { id: "a b" },
			origin: `http://127.0.0.1:${server.port}`,
			provenance: { kind: "local" },
		});
		expect([seen?.query.getAll("x"), seen?.headers.get("x-thing")]).toEqual([["1", "2"], "t"]);
		expect(seen?.nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
		await server.close();
	});
});

describe("bodies", () => {
	/** A server whose `POST /json` answers the JSON it read (limit 16), `POST /body` the bytes it read (limit 16). */
	const reading = () =>
		served({
			"@app/a": contributing({
				routes: {
					"POST /json": async (request) => ({ kind: "json", value: await request.json(16) }),
					"POST /body": async (request) => {
						let bytes = 0;
						for await (const chunk of request.body(16)) bytes += chunk.byteLength;
						return { kind: "json", value: bytes };
					},
				},
			}),
		});

	it("parses JSON within its limit; malformed is 400, larger is 413 (declared or streamed)", async () => {
		const server = await reading();
		const { port } = server;
		expect((await send(port, "POST", "/json", { body: '{"a":1}' })).body.toString()).toBe('{"a":1}');
		expect((await send(port, "POST", "/json", { body: "{nope" })).status).toBe(400);
		expect((await send(port, "POST", "/json", { body: JSON.stringify({ long: "x".repeat(40) }) })).status).toBe(413);
		const chunked = await send(port, "POST", "/body", {
			headers: { "transfer-encoding": "chunked" },
			body: "y".repeat(40),
		});
		expect(chunked.status).toBe(413);
		expect((await send(port, "POST", "/body", { body: "y".repeat(10) })).body.toString()).toBe("10");
		expect(server.errors).toEqual([]);
		await server.close();
	});

	// Sol's and Astra's build reviews: an unfinished chunked upload past the limit got no answer.
	it("answers 413 before a chunked upload past the limit has ended", async () => {
		const server = await reading();
		const request = httpRequest({
			host: "127.0.0.1",
			port: server.port,
			path: "/json",
			method: "POST",
			headers: { "transfer-encoding": "chunked" },
			agent: false,
		});
		request.on("error", () => {});
		const status = new Promise<number>((resolve) => {
			request.on("response", (response) => {
				response.resume();
				resolve(response.statusCode ?? 0);
			});
		});
		request.write(`"${"x".repeat(40)}`);
		expect(await status).toBe(413);
		request.destroy();
		await server.close();
	});

	it("drains a small body nobody read and keeps the connection; a large one closes it", async () => {
		const server = await served({
			"@app/a": contributing({ routes: { "POST /ignore": async () => ({ kind: "json", value: 1 }) } }),
		});
		const agent = new Agent({ keepAlive: true, maxSockets: 1 });
		const post = (body: string) =>
			new Promise<{ connection: string | undefined; socket: unknown }>((resolve, reject) => {
				const request = httpRequest(
					{ host: "127.0.0.1", port: server.port, method: "POST", path: "/ignore", agent },
					(response) => {
						response.resume();
						response.on("end", () =>
							resolve({ connection: response.headers.connection, socket: request.socket }),
						);
					},
				);
				request.on("error", reject);
				request.end(body);
			});
		const first = await post("x".repeat(1000));
		const second = await post("x".repeat(1000));
		expect(first.connection).toBe("keep-alive");
		expect(second.socket).toBe(first.socket);
		expect((await post("x".repeat(100_000))).connection).toBe("close");
		agent.destroy();
		await server.close();
	});
});
