import { readFile, unlink } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";

async function executeChunks(chunks: Buffer[], abort = false) {
	const streamed: string[] = [];
	const controller = new AbortController();
	const operations: BashOperations = {
		exec: async (_command, _cwd, { onData }) => {
			for (const chunk of chunks) onData(chunk);
			if (abort) {
				controller.abort();
				throw new Error("aborted");
			}
			return { exitCode: 0 };
		},
	};
	const result = await executeBashWithOperations("fixture", process.cwd(), operations, {
		onChunk: (text) => streamed.push(text),
		signal: controller.signal,
	});
	return { result, streamed: streamed.join("") };
}

describe("user bash output streaming", () => {
	it.each([
		["plain", "ERROR: file.py:1\n", "ERROR: file.py:1\n"],
		["SGR", "\x1b[31mERROR: file.py:1\x1b[0m\n", "ERROR: file.py:1\n"],
		["CSI parameters", "\x1b[38:2:255:0:0mred\x1b[0m", "red"],
		["C1 CSI", "\x9b31mred\x9b0m", "red"],
		["OSC BEL", "\x1b]8;;https://example.com\x07link\x1b]8;;\x07", "link"],
		["OSC ST", "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\", "link"],
		["OSC C1 ST", "\x1b]8;;https://example.com\x9clink\x1b]8;;\x9c", "link"],
		["UTF-8 and controls", "\x1b[32mשלום € 😀\x1b[0m\r\n\x00", "שלום € 😀\n"],
		["ESC charset and reset", "\x1b(0x\x1bcok", "xok"],
	])("preserves %s at every byte boundary", async (_name, input, expected) => {
		const bytes = Buffer.from(input);
		for (let split = 0; split <= bytes.length; split++) {
			const { result, streamed } = await executeChunks([bytes.subarray(0, split), bytes.subarray(split)]);
			expect(result.output, `split ${split}`).toBe(expected);
			expect(streamed, `split ${split}`).toBe(expected);
		}
		const { result, streamed } = await executeChunks(Array.from(bytes, (byte) => Buffer.from([byte])));
		expect(result.output).toBe(expected);
		expect(streamed).toBe(expected);
	});

	it.each([false, true])("discards unfinished terminal sequences on completion/abort (%s)", async (abort) => {
		for (const suffix of ["\x1b", "\x1b[31", "\x1b]8;;unfinished", "\x1b]8;;unfinished\x1b"]) {
			const { result, streamed } = await executeChunks([Buffer.from(`visible${suffix}`)], abort);
			expect(result.output).toBe("visible");
			expect(streamed).toBe("visible");
			expect(result.cancelled).toBe(abort);
		}
	});

	it("preserves completed output when cancelled after a split reset", async () => {
		const { result, streamed } = await executeChunks([Buffer.from("\x1b[31merror\x1b[0"), Buffer.from("m\n")], true);
		expect(result.output).toBe("error\n");
		expect(streamed).toBe("error\n");
		expect(result.cancelled).toBe(true);
	});

	it("streams long OSC payloads without leaking them into saved output", async () => {
		const { result, streamed } = await executeChunks([
			Buffer.from("start\x1b]8;;"),
			...Array.from({ length: 16 }, () => Buffer.alloc(8192, "x")),
			Buffer.from("\x1b"),
			Buffer.from("\\end"),
		]);
		expect(result.output).toBe("startend");
		expect(streamed).toBe("startend");
		if (result.fullOutputPath) {
			await expect.poll(() => readFile(result.fullOutputPath!, "utf8")).toBe("startend");
			await unlink(result.fullOutputPath);
		}
	});

	it("writes the same sanitized text to the full-output log", async () => {
		const prefix = "x".repeat(DEFAULT_MAX_BYTES);
		const { result, streamed } = await executeChunks([
			Buffer.from(`${prefix}\x1b[31`),
			Buffer.from("mERROR: file.py:1\x1b[0"),
			Buffer.from("m\n"),
		]);
		expect(streamed).toBe(`${prefix}ERROR: file.py:1\n`);
		expect(result.fullOutputPath).toBeDefined();
		try {
			await expect.poll(() => readFile(result.fullOutputPath!, "utf8")).toBe(streamed);
		} finally {
			await unlink(result.fullOutputPath!);
		}
	});
});
