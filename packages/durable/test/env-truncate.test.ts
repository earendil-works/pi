import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatSize, truncateHead } from "../src/truncate.ts";

const encoder = new TextEncoder();

function byteLength(content: string): number {
	return encoder.encode(content).length;
}

describe("truncate utilities", () => {
	it("reports UTF-8 byte counts in truncation results", () => {
		const content = "aé🙂\nb";
		const result = truncateHead(content, { maxBytes: 100, maxLines: 10 });

		expect(result.truncated).toBe(false);
		expect(result.totalBytes).toBe(byteLength(content));
		expect(result.outputBytes).toBe(byteLength(content));
		expect(result.totalBytes).toBe(9);
	});

	it("counts UTF-8 bytes and truncates correctly in a runtime without Buffer", () => {
		const inputs = ["", "ascii", "é", "中", "🙂", "\ud83d", "\ude42", "a\ud83d\ude42b", "\u07ff\u0800\uffff"];
		const output = execFileSync(
			process.execPath,
			[
				"--import",
				new URL("./fixtures/delete-buffer.ts", import.meta.url).href,
				fileURLToPath(new URL("./fixtures/utf8-byte-length-without-buffer.ts", import.meta.url)),
				JSON.stringify(inputs),
			],
			{ encoding: "utf8" },
		);
		const result = JSON.parse(output) as {
			bufferAvailable: boolean;
			lengths: number[];
			head: { content: string; outputBytes: number; truncatedBy: string | null };
		};
		expect(result.bufferAvailable).toBe(false);
		expect(result.lengths).toEqual(inputs.map(byteLength));
		expect(result.head).toMatchObject({ content: "aé🙂", outputBytes: 7, truncatedBy: "bytes" });
	});

	it("does not count a trailing newline as an extra line", () => {
		const content = `${Array.from({ length: 3 }, () => "line").join("\n")}\n`;
		const head = truncateHead(content, { maxBytes: 100, maxLines: 3 });

		expect(head).toMatchObject({ truncated: false, totalLines: 3, outputLines: 3 });
	});

	it("truncates head by line limits", () => {
		const content = "one\ntwo\nthree\nfour";
		expect(truncateHead(content, { maxBytes: 100, maxLines: 2 })).toMatchObject({
			content: "one\ntwo",
			truncated: true,
			truncatedBy: "lines",
			totalLines: 4,
			outputLines: 2,
		});
	});

	it("reports bytes when only a trailing newline exceeds limits at the line cap", () => {
		expect(truncateHead("hello\nworld\n", { maxBytes: 11, maxLines: 2 })).toMatchObject({
			content: "hello\nworld",
			truncated: true,
			truncatedBy: "bytes",
			totalLines: 2,
			outputLines: 2,
		});
	});

	it("truncates head on UTF-8 byte limits without partial lines", () => {
		const content = "éé\nabc";
		const result = truncateHead(content, { maxBytes: 4, maxLines: 10 });

		expect(result.content).toBe("éé");
		expect(result.truncated).toBe(true);
		expect(result.truncatedBy).toBe("bytes");
		expect(result.outputBytes).toBe(4);
		expect(result.firstLineExceedsLimit).toBe(false);
	});

	it("reports head truncation when the first line exceeds the byte limit", () => {
		const result = truncateHead("éé\nabc", { maxBytes: 3, maxLines: 10 });

		expect(result.content).toBe("");
		expect(result.truncated).toBe(true);
		expect(result.truncatedBy).toBe("bytes");
		expect(result.firstLineExceedsLimit).toBe(true);
	});

	it("formats sizes", () => {
		expect(formatSize(1023)).toBe("1023B");
		expect(formatSize(1536)).toBe("1.5KB");
		expect(formatSize(3 * 1024 * 1024)).toBe("3.0MB");
	});
});
