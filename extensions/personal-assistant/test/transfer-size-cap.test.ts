import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, openSync, ftruncateSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileForTransfer } from "../tools.ts";

const impl = readFileForTransfer;

describe("readFileForTransfer — size cap", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "transfer-size-"));
	});
	afterEach(() => {
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
	});

	it("small file → ok", async () => {
		const f = join(tmpDir, "small.txt");
		writeFileSync(f, "hello");
		const r = await impl(f);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.content).toBe("hello");
			expect(r.bytes).toBe(5);
		}
	});

	it("non-existent file → error", async () => {
		const r = await impl(join(tmpDir, "missing.txt"));
		expect(r.ok).toBe(false);
	});

	it("directory → error (not a regular file)", async () => {
		const r = await impl(tmpDir);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/not a regular file/);
	});

	it("sparse file over the cap is rejected based on stat.size", async () => {
		// We don't actually want to write 100MB to disk just to test the
		// cap. Use a sparse file: create it large, then stat it.
		// On Linux, seeking past the end and writing one byte gives a
		// sparse file with high stat.size but low actual disk usage.
		const f = join(tmpDir, "huge.txt");
		const fd = openSync(f, "w");
		ftruncateSync(fd, 200 * 1024 * 1024); // 200MB
		closeSync(fd);

		const r = await impl(f);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/file too large/);
	});
});
