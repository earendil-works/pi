// Tests of file responses (slice 10 §2): the type by extension (no active types), a `root` refusing a file whose real
// path lies outside it, and the file handle opened by the first read and closed when the request's scope seals, on
// every path (a full read, `HEAD`, a 416, a wrap replacing the response, a disconnect).

import { readdirSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileResponse, HttpFailure } from "../../../src/next-node/http/index.ts";
import { contributing, send, served } from "./support.ts";

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A file of `size` bytes named `name` in a fresh directory. */
async function file(name: string, size: number): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "chord-http-"));
	dirs.push(dir);
	const path = join(dir, name);
	await writeFile(path, Buffer.alloc(size, 97));
	return path;
}

/** How many descriptors of this process are open on `path` (Linux). */
function opened(path: string): number {
	let count = 0;
	for (const fd of readdirSync("/proc/self/fd")) {
		try {
			if (readlinkSync(`/proc/self/fd/${fd}`) === path) count++;
		} catch {
			// Closed meanwhile.
		}
	}
	return count;
}

describe("fileResponse", () => {
	// Fable's recheck N1: a missing file was a reported 500, one report per request from anyone.
	it("answers a missing file 404 (HttpFailure), with or without root", async () => {
		const dir = join(await file("a.txt", 1), "..");
		for (const options of [{}, { root: dir }]) {
			for (const name of ["missing.txt", "a.txt/below"]) {
				const refused = await fileResponse(join(dir, name), options).catch((error: unknown) => error);
				expect(refused).toBeInstanceOf(HttpFailure);
				expect((refused as HttpFailure).status).toBe(404);
			}
		}
	});

	// Fable's security audit M1: a symbolic link inside a served directory reached any file.
	it("with a root, refuses a file whose real path lies outside it (403); serves one inside", async () => {
		const secret = await file("secret.txt", 3);
		const root = join(secret, "..", "pub");
		await mkdir(root);
		await writeFile(join(root, "a.txt"), "a");
		await symlink(secret, join(root, "link.txt"));
		await expect(fileResponse(join(root, "a.txt"), { root })).resolves.toMatchObject({ size: 1 });
		for (const name of ["link.txt", "../secret.txt"]) {
			const refused = await fileResponse(join(root, name), { root }).catch((error: unknown) => error);
			expect(refused).toBeInstanceOf(HttpFailure);
			expect((refused as HttpFailure).status).toBe(403);
		}
		await expect(fileResponse(join(root, "link.txt"))).resolves.toMatchObject({ size: 3 });
	});

	it("types by extension: text, images, audio, video; never HTML or SVG unless named", async () => {
		const types = await Promise.all(
			["a.txt", "a.png", "a.mp3", "a.webm", "a.html", "a.svg", "a.bin"].map(async (name) => {
				const response = await fileResponse(await file(name, 1));
				return response.kind === "bytes" ? response.mime : response.kind;
			}),
		);
		expect(types).toEqual([
			"text/plain; charset=utf-8",
			"image/png",
			"audio/mpeg",
			"video/webm",
			"application/octet-stream",
			"application/octet-stream",
			"application/octet-stream",
		]);
		expect(await fileResponse(await file("b.svg", 1), { mime: "image/svg+xml" })).toMatchObject({
			mime: "image/svg+xml",
		});
		await expect(fileResponse(join(tmpdir(), "chord-http-missing"))).rejects.toThrow();
	});

	it.skipIf(process.platform !== "linux")(
		"closes its handle on every path; opens none when nothing is written",
		async () => {
			const path = await file("big.bin", 50 * 1024 * 1024);
			const server = await served({
				"@app/a": contributing({
					routes: {
						"GET /f": async () => fileResponse(path, { ranges: true, download: "big.bin" }),
						"GET /wrapped": async () => fileResponse(path),
					},
					wraps: [
						{
							name: "replace",
							phase: "transform",
							route: "GET /wrapped",
							wrap: async () => ({ kind: "error", status: 403 }),
						},
					],
				}),
			});
			const { port } = server;
			const full = await send(port, "GET", "/f");
			expect([full.status, full.body.length, opened(path)]).toEqual([200, 50 * 1024 * 1024, 0]);
			expect([(await send(port, "HEAD", "/f")).status, opened(path)]).toEqual([200, 0]);
			const past = await send(port, "GET", "/f", { headers: { range: "bytes=999999999-" } });
			expect([past.status, opened(path)]).toEqual([416, 0]);
			expect([(await send(port, "GET", "/wrapped")).status, opened(path)]).toEqual([403, 0]);
			await new Promise<void>((resolve) => {
				const request = httpRequest({ host: "127.0.0.1", port, path: "/f", agent: false }, (response) => {
					response.once("data", () => {
						expect(opened(path)).toBe(1);
						request.destroy();
						resolve();
					});
				});
				request.end();
			});
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(opened(path)).toBe(0);
			await server.close();
		},
	);
});
