// Tests of `Files` (slice 13 §4), on the server's host: small and chunked writes, ranged reads, the index, removal,
// the caps (per file, in total, per call), and uploads left by a previous run dropped.

import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { Files } from "../../../src/next-node/app/index.ts";
import { rejection } from "../../next/support.ts";
import { testApp } from "./support.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("writing, reading and removing", () => {
	it("puts a small file, lists it, reads ranges of it, removes it", async () => {
		const { app, dataDir } = await testApp();
		const files = await app.host.get(Files, {}, context);
		const id = await files.put({ name: "a.txt", mime: "text/plain", bytes: encoder.encode("hello files") }, context);
		expect(files.list.value).toEqual([
			{ id, name: "a.txt", mime: "text/plain", size: 11, created: expect.any(Number) },
		]);
		expect(decoder.decode(await files.read({ id, offset: 6, length: 100 }, context))).toBe("files");
		expect(decoder.decode(await files.read({ id, offset: 0, length: 5 }, context))).toBe("hello");
		expect((await files.read({ id, offset: 50, length: 5 }, context)).length).toBe(0);
		expect(await readdir(join(dataDir, "server", "files"))).toContain(id);
		await files.remove(id, context);
		await files.remove(id, context);
		expect(files.list.value).toEqual([]);
		expect((await readdir(join(dataDir, "server", "files"))).filter((name) => name !== ".uploads")).toEqual([]);
		expect(await rejection(files.read({ id, offset: 0, length: 1 }, context))).toMatchObject({ code: "invalid" });
		files.release();
		await app.close(context);
	});

	it("writes a large file in chunks: begin, append at the stored offset, finish", async () => {
		const { app, errors } = await testApp();
		const files = await app.host.get(Files, {}, context);
		const upload = await files.begin({ name: "big.bin", mime: "application/octet-stream" }, context);
		const chunk = new Uint8Array(1024 * 1024).fill(7);
		for (let index = 0; index < 4; index++)
			await files.append({ upload, offset: index * chunk.length, bytes: chunk }, context);
		// A writer after a drop asks where to resume; an append elsewhere is refused with the stored offset.
		const offset = await files.uploaded(upload, context);
		expect(offset).toBe(4 * chunk.length);
		expect(await rejection(files.append({ upload, offset: 3 * chunk.length, bytes: chunk }, context))).toMatchObject({
			code: "invalid",
			details: { offset },
		});
		await files.append({ upload, offset, bytes: chunk }, context);
		expect(files.list.value).toEqual([]);
		const id = await files.finish(upload, context);
		expect(files.list.value.map(({ size }) => size)).toEqual([5 * 1024 * 1024]);
		const tail = await files.read({ id, offset: 5 * 1024 * 1024 - 2, length: 10 }, context);
		expect([...tail]).toEqual([7, 7]);
		expect(await rejection(files.append({ upload, offset: 0, bytes: chunk }, context))).toMatchObject({
			code: "invalid",
		});
		expect(await rejection(files.uploaded(upload, context))).toMatchObject({ code: "invalid" });
		files.release();
		await app.close(context);
		// The routine sweeping expired uploads ends with the object, quietly.
		expect(errors).toEqual([]);
	});

	it("writes appends sent without waiting at their own offsets, byte for byte (review H1)", async () => {
		const { app } = await testApp();
		const files = await app.host.get(Files, {}, context);
		const upload = await files.begin({ name: "big.bin", mime: "application/octet-stream" }, context);
		const size = 32 * 1024;
		const chunks = Array.from({ length: 250 }, (_, index) => new Uint8Array(size).fill(index));
		await Promise.all(chunks.map((bytes, index) => files.append({ upload, offset: index * size, bytes }, context)));
		expect(await files.uploaded(upload, context)).toBe(250 * size);
		const id = await files.finish(upload, context);
		for (let index = 0; index < chunks.length; index++) {
			const piece = await files.read({ id, offset: index * size, length: size }, context);
			expect(piece.every((byte) => byte === index % 256)).toBe(true);
		}
		files.release();
		await app.close(context);
	});

	it("finishes an upload only once the appends sent before it landed (review H1)", async () => {
		const { app } = await testApp();
		const files = await app.host.get(Files, {}, context);
		const upload = await files.begin({ name: "x", mime: "x" }, context);
		const size = 512 * 1024;
		const appends = Array.from({ length: 8 }, (_, index) =>
			files.append({ upload, offset: index * size, bytes: new Uint8Array(size).fill(index + 1) }, context),
		);
		const id = await files.finish(upload, context);
		await Promise.all(appends);
		expect(files.list.value.find((file) => file.id === id)?.size).toBe(8 * size);
		expect([...(await files.read({ id, offset: 8 * size - 1, length: 10 }, context))]).toEqual([8]);
		files.release();
		await app.close(context);
	});

	it("answers ids that are prototype keys as unknown files (review L1)", async () => {
		const { app, errors } = await testApp();
		const files = await app.host.get(Files, {}, context);
		for (const id of ["constructor", "__proto__", "toString"]) {
			expect(await rejection(files.read({ id, offset: 0, length: 1 }, context))).toMatchObject({ code: "invalid" });
			await files.remove(id, context);
		}
		expect(files.list.value).toEqual([]);
		expect(errors).toEqual([]);
		files.release();
		await app.close(context);
	});

	it("caps the uploads under way per object: past it begin is refused busy; an ending one frees its slot (recheck N1)", async () => {
		const { app } = await testApp({ limits: { uploads: 3 } });
		const files = await app.host.get(Files, {}, context);
		const fds = async () => (await readdir("/proc/self/fd")).length;
		const before = await fds();
		const begun = [];
		for (let index = 0; index < 3; index++) begun.push(await files.begin({ name: `u${index}`, mime: "x" }, context));
		expect(await rejection(files.begin({ name: "u3", mime: "x" }, context))).toMatchObject({
			code: "unavailable",
			reason: "busy",
		});
		expect((await fds()) - before).toBeLessThanOrEqual(3);
		await files.finish(begun[0]!, context);
		expect(await files.begin({ name: "u4", mime: "x" }, context)).toEqual(expect.any(String));
		files.release();
		await app.close(context);
	});

	it("drops the uploads a previous run left", async () => {
		const first = await testApp();
		const files = await first.app.host.get(Files, {}, context);
		await files.begin({ name: "left", mime: "text/plain" }, context);
		files.release();
		await first.app.close(context);
		const uploads = join(first.dataDir, "server", "files", ".uploads");
		const [left] = await readdir(uploads);
		await writeFile(join(uploads, "stray"), "x");
		const second = await testApp({ dataDir: first.dataDir, root: first.root });
		const again = await second.app.host.get(Files, {}, context);
		const upload = await again.begin({ name: "new", mime: "text/plain" }, context);
		// The routine dropping them runs once the object is live; this run's upload stays.
		const dropped = async () => !(await readdir(uploads)).some((name) => name === left || name === "stray");
		while (!(await dropped())) await new Promise((resolve) => setTimeout(resolve, 10));
		expect((await readdir(uploads)).length).toBe(1);
		await again.append({ upload, offset: 0, bytes: encoder.encode("kept") }, context);
		expect(await again.finish(upload, context)).toEqual(expect.any(String));
		again.release();
		await second.app.close(context);
	});
});

describe("caps", () => {
	it("refuses a file over the per-file cap, writes over the total, and calls over 4 MiB", async () => {
		const { app } = await testApp({ files: { maxFile: 1000, maxTotal: 1500 } });
		const files = await app.host.get(Files, {}, context);
		const put = (size: number) => files.put({ name: "f", mime: "x", bytes: new Uint8Array(size) }, context);
		expect(await rejection(put(1001))).toMatchObject({ code: "too_large" });
		await put(1000);
		expect(await rejection(put(501))).toMatchObject({ code: "too_large" });
		// An upload under way counts against the total.
		const upload = await files.begin({ name: "u", mime: "x" }, context);
		await files.append({ upload, offset: 0, bytes: new Uint8Array(400) }, context);
		expect(await rejection(put(101))).toMatchObject({ code: "too_large" });
		await put(100);
		expect(await rejection(files.append({ upload, offset: 400, bytes: new Uint8Array(1) }, context))).toMatchObject({
			code: "too_large",
		});
		expect(files.list.value.map(({ size }) => size).sort()).toEqual([100, 1000]);
		files.release();
		await app.close(context);
	});

	it("refuses a put and a read of more than 4 MiB", async () => {
		const { app } = await testApp();
		const files = await app.host.get(Files, {}, context);
		const limit = 4 * 1024 * 1024;
		const id = await files.put({ name: "f", mime: "x", bytes: new Uint8Array(10) }, context);
		expect(await rejection(files.read({ id, offset: 0, length: limit + 1 }, context))).toMatchObject({
			code: "too_large",
		});
		expect(
			await rejection(files.put({ name: "f", mime: "x", bytes: new Uint8Array(limit + 1) }, context)),
		).toMatchObject({
			code: "too_large",
		});
		files.release();
		await app.close(context);
	});
});
