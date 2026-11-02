// Tests of responses (slice 10 §2, D5, R6; security baseline (4), (6)): every kind written by a running server, the
// response's headers over the default ones (an invalid one reported, 500), ranges (206, 416, multi-range), `HEAD`,
// attachments and inline bodies, safe download names, bodies without `size`, a short or throwing read, a disconnect
// stopping the reads.

import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../../../src/next/host/index.ts";
import type { HttpResponse } from "../../../src/next-node/http/index.ts";
import { contributing, send, served } from "./support.ts";

/** A server answering `GET /r` with `response`. */
async function answering(response: HttpResponse) {
	return served({ "@app/r": contributing({ routes: { "GET /r": async () => response } }) });
}

/** A `bytes` response over `data` that records its reads. */
function bytesOf(data: Buffer, extra: Partial<Extract<HttpResponse, { kind: "bytes" }>> = {}) {
	const reads: [number, number][] = [];
	const response: HttpResponse = {
		kind: "bytes",
		mime: "application/octet-stream",
		size: data.length,
		read: async (offset, length) => {
			reads.push([offset, length]);
			return data.subarray(offset, offset + length);
		},
		...extra,
	};
	return { response, reads };
}

describe("descriptions", () => {
	it("writes json, html, redirect and error, the default headers first, the response's replacing same-named ones", async () => {
		const cases: [HttpResponse, number, string, string | undefined][] = [
			[{ kind: "json", value: { a: 1 } }, 200, '{"a":1}', "application/json; charset=utf-8"],
			[
				{ kind: "html", body: "<p>x</p>", status: 201, headers: { "content-security-policy": "own" } },
				201,
				"<p>x</p>",
				"text/html; charset=utf-8",
			],
			[{ kind: "redirect", to: "/next", status: 303 }, 303, "", undefined],
			[{ kind: "error", status: 418 }, 418, "I'm a Teapot", "text/plain; charset=utf-8"],
			[{ kind: "error", status: 409, message: "taken" }, 409, "taken", "text/plain; charset=utf-8"],
		];
		for (const [response, status, body, type] of cases) {
			const server = await answering(response);
			const answer = await send(server.port, "GET", "/r");
			expect([answer.status, answer.body.toString(), answer.headers["content-type"]]).toEqual([status, body, type]);
			expect([answer.headers["cache-control"], answer.headers["x-content-type-options"]]).toEqual([
				"no-store",
				"nosniff",
			]);
			expect(answer.headers["content-security-policy"]).toMatch(
				response.headers === undefined ? /^default-src 'none'/ : /^own$/,
			);
			if (response.kind === "redirect") expect(answer.headers.location).toBe("/next");
			await server.close();
		}
	});

	it("answers 500 for a header with a CR or LF and a value that is no JSON, reported response_failed", async () => {
		const server = await served({
			"@app/r": contributing({
				routes: {
					"GET /header": async () => ({ kind: "json", value: 1, headers: { "X-Split": "a\r\nSet-Cookie: x=1" } }),
					"GET /bigint": async () => ({ kind: "json", value: { n: 1n } as never }),
				},
			}),
		});
		for (const path of ["/header", "/bigint"]) {
			const answer = await send(server.port, "GET", path);
			expect([answer.status, answer.headers["set-cookie"], answer.headers["x-content-type-options"]]).toEqual([
				500,
				undefined,
				"nosniff",
			]);
		}
		expect(server.errors).toMatchObject([
			{ kind: "response_failed", pattern: "GET /header" },
			{ kind: "response_failed", pattern: "GET /bigint" },
		]);
		await server.close();
	});
});

describe("bytes", () => {
	const data = Buffer.from("0123456789".repeat(60_000));

	it("sends Content-Length, reads 256 KiB pieces, answers a single range 206 and an unsatisfiable one 416", async () => {
		const { response, reads } = bytesOf(data, { ranges: true });
		const server = await answering(response);
		const whole = await send(server.port, "GET", "/r");
		expect([whole.status, whole.headers["content-length"], whole.headers["accept-ranges"]]).toEqual([
			200,
			"600000",
			"bytes",
		]);
		expect(whole.body.equals(data)).toBe(true);
		expect(reads).toEqual([
			[0, 262144],
			[262144, 262144],
			[524288, 75712],
		]);
		const range = await send(server.port, "GET", "/r", { headers: { range: "bytes=10-19" } });
		expect([range.status, range.body.toString(), range.headers["content-range"]]).toEqual([
			206,
			"0123456789",
			"bytes 10-19/600000",
		]);
		const suffix = await send(server.port, "GET", "/r", { headers: { range: "bytes=-3" } });
		expect([suffix.status, suffix.body.toString()]).toEqual([206, "789"]);
		const past = await send(server.port, "GET", "/r", { headers: { range: "bytes=600000-" } });
		expect([past.status, past.headers["content-range"]]).toEqual([416, "bytes */600000"]);
		const multi = await send(server.port, "GET", "/r", { headers: { range: "bytes=0-1,5-6" } });
		expect([multi.status, multi.body.length]).toEqual([200, 600000]);
		await server.close();
	});

	it("ignores ranges unless asked; HEAD sends headers only and reads nothing", async () => {
		const { response, reads } = bytesOf(data);
		const server = await answering(response);
		const ranged = await send(server.port, "GET", "/r", { headers: { range: "bytes=0-1" } });
		expect([ranged.status, ranged.headers["accept-ranges"]]).toEqual([200, undefined]);
		reads.length = 0;
		const head = await send(server.port, "HEAD", "/r");
		expect([head.status, head.headers["content-length"], head.body.length, reads]).toEqual([200, "600000", 0, []]);
		await server.close();
	});

	it("names a download with an ASCII fallback and the UTF-8 name, control and bidi characters dropped", async () => {
		const server = await answering(bytesOf(Buffer.from("x"), { download: 'Grüße "1"\r\n\u202etxt.exe' }).response);
		const answer = await send(server.port, "GET", "/r");
		expect(answer.headers["content-disposition"]).toBe(
			`attachment; filename="Gr__e _1_txt.exe"; filename*=UTF-8''Gr%C3%BC%C3%9Fe%20%221%22txt.exe`,
		);
		await server.close();
	});

	it("is an attachment unless inline; an inline one gets a sandbox CSP", async () => {
		const attached = await answering(bytesOf(Buffer.from("x")).response);
		expect((await send(attached.port, "GET", "/r")).headers["content-disposition"]).toBe("attachment");
		await attached.close();
		const shown = await answering(bytesOf(Buffer.from("x"), { inline: true }).response);
		const answer = await send(shown.port, "GET", "/r");
		expect(answer.headers["content-disposition"]).toBe("inline");
		expect(answer.headers["content-security-policy"]).toMatch(/; sandbox$/);
		await shown.close();
	});

	it("refuses a foreign request (another site's) 403, reading nothing", async () => {
		const { response, reads } = bytesOf(Buffer.from("secret"));
		const server = await answering(response);
		const foreign = await send(server.port, "GET", "/r", { headers: { "sec-fetch-site": "cross-site" } });
		expect([foreign.status, reads]).toEqual([403, []]);
		expect((await send(server.port, "GET", "/r", { headers: { "sec-fetch-site": "same-origin" } })).status).toBe(200);
		await server.close();
	});

	it("without a size: chunked, read with growing offsets until an empty chunk, no ranges (R6)", async () => {
		const pieces = [Buffer.from("ab"), Buffer.from("cde"), Buffer.alloc(0)];
		const offsets: number[] = [];
		const server = await answering({
			kind: "bytes",
			mime: "text/plain",
			ranges: true,
			read: async (offset) => {
				offsets.push(offset);
				return pieces.shift()!;
			},
		});
		const answer = await send(server.port, "GET", "/r", { headers: { range: "bytes=0-1" } });
		expect([
			answer.status,
			answer.body.toString(),
			answer.headers["transfer-encoding"],
			answer.headers["accept-ranges"],
		]).toEqual([200, "abcde", "chunked", undefined]);
		expect(offsets).toEqual([0, 2, 5]);
		await server.close();
	});

	it("destroys the connection on a short or a throwing read, reported response_failed", async () => {
		const server = await served({
			"@app/r": contributing({
				routes: {
					"GET /short": async () => ({
						kind: "bytes",
						mime: "text/plain",
						size: 10,
						read: async () => Buffer.from("abc"),
					}),
					// Astra's build review: a throwing read hung the response, unreported.
					"GET /throws": async () => ({
						kind: "bytes",
						mime: "text/plain",
						size: 10,
						read: async () => {
							throw new Error("read failed");
						},
					}),
				},
			}),
		});
		await expect(send(server.port, "GET", "/short")).rejects.toThrow();
		await expect(send(server.port, "GET", "/throws")).rejects.toThrow();
		expect(server.errors).toMatchObject([
			{ kind: "response_failed", pattern: "GET /short" },
			{ kind: "response_failed", pattern: "GET /throws", error: { message: "read failed" } },
		]);
		await server.close();
	});

	it("stops reading when the client disconnects: the read's context is aborted", async () => {
		let reads = 0;
		let signal: AbortSignal | undefined;
		const server = await answering({
			kind: "bytes",
			mime: "application/octet-stream",
			size: 1024 * 1024 * 1024,
			read: async (_offset, length, ctx: Ctx) => {
				reads++;
				signal = ctx.abortSignal;
				return Buffer.alloc(length);
			},
		});
		await new Promise<void>((resolve) => {
			const request = httpRequest({ host: "127.0.0.1", port: server.port, path: "/r", agent: false }, (response) => {
				response.once("data", () => {
					request.destroy();
					resolve();
				});
			});
			request.end();
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		const after = reads;
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(signal?.aborted).toBe(true);
		expect(reads).toBe(after);
		expect(after).toBeLessThan(1000);
		await server.close();
	});
});
