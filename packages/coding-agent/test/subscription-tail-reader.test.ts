import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { addToLimitedSet } from "../src/utils/limited-set.js";
import { readAppendedFileChunkSync } from "../src/utils/read-appended-file-chunk.js";

describe("readAppendedFileChunkSync", () => {
	it("reads only appended bytes", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "mu-sub-tail-"));
		try {
			const filePath = path.join(dir, "session.jsonl");
			await writeFile(filePath, "abc", "utf8");

			const initial = readAppendedFileChunkSync(filePath, 0);
			expect(initial.chunk).toBe("abc");

			const offset = initial.newOffset;
			await appendFile(filePath, "def", "utf8");

			const appended = readAppendedFileChunkSync(filePath, offset);
			expect(appended.chunk).toBe("def");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("handles truncation by reading from 0 when size < offset", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "mu-sub-tail-"));
		try {
			const filePath = path.join(dir, "session.jsonl");
			await writeFile(filePath, "hello", "utf8");
			const before = readAppendedFileChunkSync(filePath, 0);
			const offset = before.newOffset;

			// Truncate and rewrite
			await writeFile(filePath, "x", "utf8");
			const after = readAppendedFileChunkSync(filePath, offset);
			expect(after.chunk).toBe("x");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("addToLimitedSet", () => {
	it("evicts oldest keys when max size is exceeded", () => {
		const set = new Set<string>();
		const order: string[] = [];

		addToLimitedSet(set, order, "a", 2);
		addToLimitedSet(set, order, "b", 2);
		addToLimitedSet(set, order, "c", 2);

		expect([...set]).toEqual(["b", "c"]);
		expect(order).toEqual(["b", "c"]);
	});

	it("does not grow when adding a duplicate key", () => {
		const set = new Set<string>();
		const order: string[] = [];

		expect(addToLimitedSet(set, order, "a", 10)).toBe(true);
		expect(addToLimitedSet(set, order, "a", 10)).toBe(false);
		expect([...set]).toEqual(["a"]);
		expect(order).toEqual(["a"]);
	});
});
