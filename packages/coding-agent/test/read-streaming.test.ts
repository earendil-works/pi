import { execFileSync } from "child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
import type * as util from "util";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createReadToolDefinition, type ReadOperations } from "../src/core/tools/read.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "../src/core/tools/truncate.ts";

// Runs when the read tool decodes a chunk: the file is open and partly read, so a test can change it mid-read.
const decodeHook = vi.hoisted(() => ({ run: undefined as (() => void) | undefined }));
vi.mock("util", async (importOriginal) => {
	const actual = await importOriginal<typeof util>();
	class HookedTextDecoder extends actual.TextDecoder {
		decode(...args: Parameters<util.TextDecoder["decode"]>): string {
			decodeHook.run?.();
			return super.decode(...args);
		}
	}
	return { ...actual, TextDecoder: HookedTextDecoder };
});

// The read tool's text path before it streamed (#9654), kept as the reference the new path must match.
function referenceRead(
	textContent: string,
	path: string,
	offset: number | undefined,
	limit: number | undefined,
): { text: string; details: { truncation: TruncationResult } | undefined } {
	const allLines = textContent.split("\n");
	const totalFileLines = allLines.length;
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	const startLineDisplay = startLine + 1;
	if (startLine >= allLines.length) {
		throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
	}
	let selectedContent: string;
	let userLimitedLines: number | undefined;
	if (limit !== undefined) {
		const endLine = Math.min(startLine + limit, allLines.length);
		selectedContent = allLines.slice(startLine, endLine).join("\n");
		userLimitedLines = endLine - startLine;
	} else {
		selectedContent = allLines.slice(startLine).join("\n");
	}
	const truncation = truncateHead(selectedContent);
	let outputText: string;
	let details: { truncation: TruncationResult } | undefined;
	if (truncation.firstLineExceedsLimit) {
		const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
		outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
		details = { truncation };
	} else if (truncation.truncated) {
		const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		outputText = truncation.content;
		if (truncation.truncatedBy === "lines") {
			outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
		} else {
			outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
		}
		details = { truncation };
	} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
		const remaining = allLines.length - (startLine + userLimitedLines);
		const nextOffset = startLine + userLimitedLines + 1;
		outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
	} else {
		outputText = truncation.content;
	}
	return { text: outputText, details };
}

type ReadOutcome = { text: string; details: unknown } | { error: string };

const FILE_PATH = join(tmpdir(), "pi-read-streaming-test-missing", "file.txt");

function referenceOutcome(text: string, offset: number | undefined, limit: number | undefined): ReadOutcome {
	try {
		return referenceRead(text, FILE_PATH, offset, limit);
	} catch (error) {
		return { error: (error as Error).message };
	}
}

async function outcome(
	run: () => Promise<{ content: { type: string; text?: string }[]; details: unknown }>,
): Promise<ReadOutcome> {
	try {
		const result = await run();
		return { text: result.content[0].text ?? "", details: result.details };
	} catch (error) {
		return { error: (error as Error).message };
	}
}

/** Splits bytes into chunks of `size`, so characters and lines split at chunk ends. */
async function* chunked(bytes: Buffer, size: number): AsyncIterable<Uint8Array> {
	for (let position = 0; position < bytes.length; position += size) {
		yield bytes.subarray(position, position + size);
	}
}

function streamingOps(bytes: Buffer, chunkSize: number): ReadOperations {
	return {
		readFile: async () => {
			throw new Error("readFile must not be used when createReadStream is present");
		},
		access: async () => {},
		createReadStream: () => chunked(bytes, chunkSize),
	};
}

function readWith(ops: ReadOperations, offset: number | undefined, limit: number | undefined): Promise<ReadOutcome> {
	const tool = createReadToolDefinition(process.cwd(), { operations: ops });
	return outcome(() =>
		tool.execute("call", { path: FILE_PATH, offset, limit }, undefined, undefined, undefined as never),
	);
}

function lines(count: number, make: (i: number) => string): string {
	return Array.from({ length: count }, (_, i) => make(i)).join("\n");
}

const FIFTY_KB_OF_LINES = `${lines(512, () => "y".repeat(99))}y`;

// Inputs around the boundaries the notices and truncation depend on.
const TEXT_CASES: Record<string, string> = {
	empty: "",
	"no trailing newline": "alpha\nbeta\ngamma",
	"trailing newline": "alpha\nbeta\n",
	CRLF: "alpha\r\nbeta\r\n\r\ngamma\r\n",
	"multi-byte characters and UTF-8 byte order mark": "\uFEFFé€😀\nñ\u{10348}字\n😀😀😀",
	"2001 lines": lines(2001, (i) => `line ${i}`),
	// truncateHead drops a trailing empty line: the empty line at the line cap must not end the stored lines.
	"2001 lines, an empty line and more": `${lines(2001, (i) => `line ${i}`)}\n\nmore`,
	"first line over 50KB": `${"é".repeat(DEFAULT_MAX_BYTES / 2 + 1)}\nsecond`,
	"line over 50KB after short lines": `a\nb\n${"z".repeat(60 * 1024)}\nc`,
	// 50KB + 1 byte: truncated, yet every line fits, so truncateHead reports truncatedBy "lines".
	"exactly 50KB and a trailing newline": `${FIFTY_KB_OF_LINES}\n`,
	"exactly 50KB, an empty line and more": `${FIFTY_KB_OF_LINES}\n\nmore`,
	"multi-byte characters over 50KB": lines(700, (i) => `${i} ${"€😀".repeat(13)}`),
};

describe("read tool streaming", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-read-streaming-"));
	afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

	it("gives the same output as the whole-file algorithm", async () => {
		for (const [name, text] of Object.entries(TEXT_CASES)) {
			const bytes = Buffer.from(text, "utf-8");
			const total = text.split("\n").length;
			for (const offset of [undefined, 2, 3, total, total + 1]) {
				for (const limit of [undefined, 0, 1, total]) {
					const expected = referenceOutcome(text, offset, limit);
					for (const chunkSize of [1, 4096]) {
						const label = `${name}, offset ${offset}, limit ${limit}, chunks of ${chunkSize}`;
						expect(await readWith(streamingOps(bytes, chunkSize), offset, limit), label).toEqual(expected);
					}
				}
			}
		}
	});

	it("keeps details key order, which session files serialize", async () => {
		const text = TEXT_CASES["2001 lines"];
		const streamed = (await readWith(streamingOps(Buffer.from(text), 4096), 1, undefined)) as { details: unknown };
		const expected = referenceOutcome(text, 1, undefined) as { details: unknown };
		expect(JSON.stringify(streamed.details)).toBe(JSON.stringify(expected.details));
	});

	it("decodes multi-byte characters split across chunks and invalid UTF-8 like Buffer.toString", async () => {
		const bytes = Buffer.concat([
			Buffer.from("aé€😀\n😀b\u{10348}\n", "utf-8"),
			Buffer.from([0x61, 0xc3, 0x0a, 0xe2, 0x82, 0x0a, 0xff, 0xfe, 0x80, 0xf0, 0x9f, 0x98, 0x0a, 0xed, 0xa0, 0x80]),
		]);
		for (const chunkSize of [1, 2, 3]) {
			expect(await readWith(streamingOps(bytes, chunkSize), undefined, undefined)).toEqual(
				referenceOutcome(bytes.toString("utf-8"), undefined, undefined),
			);
		}
	});

	it("uses readFile for operations without createReadStream and for fractional or negative ranges", async () => {
		const text = "one\ntwo\nthree\nfour";
		const ops: ReadOperations = { readFile: async () => Buffer.from(text), access: async () => {} };
		const withStream: ReadOperations = { ...streamingOps(Buffer.from(text), 1), readFile: ops.readFile };
		for (const [offset, limit] of [
			[undefined, undefined],
			[2, 1],
			[9, undefined],
		] as const) {
			expect(await readWith(ops, offset, limit)).toEqual(referenceOutcome(text, offset, limit));
		}
		// Array slicing defines these: limit -1 selects all lines but the last.
		for (const [offset, limit] of [
			[2.5, 1],
			[undefined, -1],
			[1, 1.5],
		] as const) {
			expect(await readWith(withStream, offset, limit)).toEqual(referenceOutcome(text, offset, limit));
		}
	});

	it("reads local files through the default stream", async () => {
		const path = join(tempDir, "local.txt");
		const text = lines(3000, (i) => `${i} ${"w".repeat(i % 40)}`);
		writeFileSync(path, text);
		const tool = createReadToolDefinition(tempDir);
		for (const [offset, limit] of [
			[undefined, undefined],
			[1500, 10],
		] as const) {
			const result = await outcome(() =>
				tool.execute("call", { path, offset, limit }, undefined, undefined, undefined as never),
			);
			expect(result).toEqual(referenceRead(text, path, offset, limit));
		}
		await expect(tool.execute("call", { path: tempDir }, undefined, undefined, undefined as never)).rejects.toThrow(
			"EISDIR",
		);
	});

	it("reads a local file up to its size when opened, like fs.readFile", async () => {
		const path = join(tempDir, "growing.txt");
		// Larger than one 64 KB stream chunk, so the append lands before the stream reaches the end.
		writeFileSync(path, `head\n${"x".repeat(200_000)}`);
		decodeHook.run = () => {
			decodeHook.run = undefined;
			appendFileSync(path, "\nadded");
		};
		const tool = createReadToolDefinition(tempDir);
		const result = await tool.execute("call", { path, limit: 1 }, undefined, undefined, undefined as never);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "head\n\n[1 more lines in file. Use offset=2 to continue.]",
		});
	});

	it("reads a 200 MB line with a 64 MB heap", () => {
		// A child process, so a regression that stores the whole line runs out of memory instead of passing.
		const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
		const readToolUrl = pathToFileURL(resolve(__dirname, "../src/core/tools/read.ts")).href;
		const script = `
			import { createReadToolDefinition } from ${JSON.stringify(readToolUrl)};
			// 64 KB chunks, as fs streams them: larger decoded strings live outside the V8 heap and its limit.
			const chunk = Buffer.alloc(64 * 1024, "x");
			async function* createReadStream() { for (let i = 0; i < 3200; i++) yield chunk; }
			const operations = { readFile: async () => Buffer.alloc(0), access: async () => {}, createReadStream };
			const tool = createReadToolDefinition(process.cwd(), { operations });
			const result = await tool.execute("call", { path: "big.log" });
			process.stdout.write(result.content[0].text);
		`;
		const output = execFileSync(
			process.execPath,
			["--max-old-space-size=64", "--import", sourceResolverUrl, "--input-type=module", "--eval", script],
			{ encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
		);
		expect(output).toBe(
			`[Line 1 is 200.0MB, exceeds 50.0KB limit. Use bash: sed -n '1p' big.log | head -c ${DEFAULT_MAX_BYTES}]`,
		);
	});

	it("stops consuming the stream when aborted", async () => {
		const controller = new AbortController();
		let chunksRead = 0;
		let closed = false;
		const ops: ReadOperations = {
			readFile: async () => Buffer.alloc(0),
			access: async () => {},
			async *createReadStream(_path, { signal }) {
				expect(signal).toBe(controller.signal);
				try {
					while (true) {
						chunksRead++;
						if (chunksRead === 3) controller.abort();
						await new Promise((resolve) => setTimeout(resolve, 1));
						yield Buffer.from("line\n");
					}
				} finally {
					closed = true;
				}
			},
		};
		const tool = createReadToolDefinition(process.cwd(), { operations: ops });
		await expect(
			tool.execute("call", { path: FILE_PATH }, controller.signal, undefined, undefined as never),
		).rejects.toThrow("Operation aborted");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(closed).toBe(true);
		expect(chunksRead).toBe(3);
	});
});
