// Tests of the kit's tar writer and reader (slice 13 §4): a round trip (long paths, empty and multi-block files, data
// left unread), and the reader refusing what an address archive may not hold: paths leaving the target (absolute,
// `..`), symbolic and hard links, devices, a bad checksum, a truncated archive.

import { describe, expect, it } from "vitest";
import { readTar, type TarEntry, writeTar } from "../../../src/node/app/tar.ts";

/** The bytes `writeTar` makes of `entries`. */
async function archiveOf(entries: readonly TarEntry[]): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of writeTar(entries)) chunks.push(chunk);
	return Buffer.concat(chunks);
}

/** An entry of `text`. */
function entry(path: string, text: string): TarEntry {
	const bytes = new TextEncoder().encode(text);
	return {
		path,
		size: bytes.length,
		data: (async function* () {
			yield bytes;
		})(),
	};
}

/** Every entry of `archive`: path and text (files) or `dir`; `skip` names files whose data is left unread. */
async function entriesOf(archive: Uint8Array, skip: readonly string[] = []): Promise<Array<[string, string]>> {
	const read: Array<[string, string]> = [];
	for await (const each of readTar(
		(async function* () {
			yield archive;
		})(),
	)) {
		if (each.kind === "directory") read.push([each.path, "dir"]);
		else if (skip.includes(each.path)) read.push([each.path, "skipped"]);
		else {
			const chunks: Uint8Array[] = [];
			for await (const chunk of each.data) chunks.push(chunk);
			read.push([each.path, Buffer.concat(chunks).toString()]);
		}
	}
	return read;
}

/** A single-entry archive with header field `offset` set to `value`, its checksum recomputed. */
async function patched(offset: number, value: string): Promise<Uint8Array> {
	const archive = await archiveOf([entry("files/a", "x")]);
	const block = archive.subarray(0, 512);
	block.fill(0, offset, offset + (offset === 0 ? 100 : 1));
	block.set(new TextEncoder().encode(value), offset);
	block.fill(0x20, 148, 156);
	const sum = block.reduce((total, byte) => total + byte, 0);
	block.set(new TextEncoder().encode(`${sum.toString(8).padStart(6, "0")}\u0000 `), 148);
	return archive;
}

describe("round trip", () => {
	it("reads back what it wrote: long paths, empty and multi-block files, data left unread", async () => {
		const long = `files/${"d".repeat(90)}/${"f".repeat(90)}`;
		const big = "y".repeat(1500);
		const archive = await archiveOf([
			entry("manifest.json", "{}"),
			entry(long, "long"),
			entry("files/empty", ""),
			entry("files/big", big),
			entry("files/last", "z"),
		]);
		expect(archive.length % 512).toBe(0);
		expect(await entriesOf(archive, ["files/big"])).toEqual([
			["manifest.json", "{}"],
			[long, "long"],
			["files/empty", ""],
			["files/big", "skipped"],
			["files/last", "z"],
		]);
	});

	it("refuses to write a path it would refuse to read", async () => {
		for (const path of ["/abs", "a/../b", "a//b", "./a", "a\\b"]) {
			await expect(archiveOf([entry(path, "x")])).rejects.toThrow("is refused");
		}
	});
});

describe("refusals when reading", () => {
	it("refuses absolute paths and `..`", async () => {
		await expect(entriesOf(await patched(0, "/etc/passwd"))).rejects.toThrow("is refused");
		await expect(entriesOf(await patched(0, "files/../../evil"))).rejects.toThrow("is refused");
		await expect(entriesOf(await patched(0, "../evil"))).rejects.toThrow("is refused");
	});

	it("refuses symbolic links, hard links, devices and FIFOs", async () => {
		for (const flag of ["1", "2", "3", "4", "6"]) {
			await expect(entriesOf(await patched(156, flag))).rejects.toThrow("is refused (files only)");
		}
	});

	it("refuses a header whose checksum does not hold, and a truncated archive", async () => {
		const tampered = await archiveOf([entry("files/a", "x")]);
		tampered[6] = "b".charCodeAt(0);
		await expect(entriesOf(tampered)).rejects.toThrow("checksum");
		const archive = await archiveOf([entry("files/a", "x".repeat(600))]);
		await expect(entriesOf(archive.subarray(0, 700))).rejects.toThrow("ends");
		await expect(entriesOf(archive.subarray(0, 100))).rejects.toThrow("ends inside a header");
	});
});
