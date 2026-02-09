import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { readTextFileForTool } from "../src/utils/read-text-file.js";

describe("readTextFileForTool", () => {
	it("matches split(\\n) semantics (includes trailing empty line) and prints remaining-lines notice", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "mu-read-test-"));
		try {
			const filePath = path.join(dir, "file.txt");
			// Trailing \n produces a trailing empty line with `split("\n")`.
			await writeFile(filePath, "line1\nline2\n", "utf8");

			const text = await readTextFileForTool(filePath, {
				offset: 2,
				limit: 1,
				defaultLimit: 2000,
				maxLineLength: 2000,
			});

			expect(text).toContain("line2");
			expect(text).toContain("1 more lines not shown. Use offset=3");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("truncates long lines and prints truncation notice", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "mu-read-test-"));
		try {
			const filePath = path.join(dir, "long.txt");
			const longLine = "a".repeat(2100);
			await writeFile(filePath, `ok\n${longLine}\nend\n`, "utf8");

			const text = await readTextFileForTool(filePath, {
				offset: 1,
				limit: 10,
				defaultLimit: 2000,
				maxLineLength: 2000,
			});

			// Ensure we truncated exactly to maxLineLength.
			expect(text).toContain("a".repeat(2000));
			expect(text).toContain("Some lines were truncated to 2000 characters for display");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("throws when offset is beyond end of file", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "mu-read-test-"));
		try {
			const filePath = path.join(dir, "small.txt");
			await writeFile(filePath, "one\n", "utf8");

			await expect(
				readTextFileForTool(filePath, {
					offset: 5,
					defaultLimit: 2000,
					maxLineLength: 2000,
				}),
			).rejects.toThrow(/Offset 5 is beyond end of file/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
