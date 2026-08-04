import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { readPipedStdin } from "../src/cli/piped-stdin.ts";

function pipeStream(): NodeJS.ReadStream {
	// A PassThrough is a real non-TTY stream: isTTY is undefined, and it
	// supports setEncoding/resume/pause/on exactly like a piped stdin.
	return new PassThrough() as unknown as NodeJS.ReadStream;
}

describe("readPipedStdin", () => {
	test("returns undefined immediately for a TTY stdin", async () => {
		const tty = { isTTY: true } as NodeJS.ReadStream;
		await expect(readPipedStdin(tty, 50)).resolves.toBeUndefined();
	});

	test("reads piped content to EOF", async () => {
		const stream = pipeStream();
		const result = readPipedStdin(stream, 50);
		(stream as unknown as PassThrough).end("piped prompt\n");
		await expect(result).resolves.toBe("piped prompt");
	});

	test("returns undefined for an immediately closed stdin (</dev/null)", async () => {
		const stream = pipeStream();
		const result = readPipedStdin(stream, 50);
		(stream as unknown as PassThrough).end();
		await expect(result).resolves.toBeUndefined();
	});

	test("proceeds without content when an open pipe stays silent past the grace window", async () => {
		const stream = pipeStream();
		// Never write, never end: before the fix this promise never settled and
		// startup parked forever (pi#2078 family, silent inherited pipe).
		await expect(readPipedStdin(stream, 50)).resolves.toBeUndefined();
	});

	test("keeps reading a slow stream to EOF once the first chunk arrived in time", async () => {
		const stream = pipeStream();
		const result = readPipedStdin(stream, 50);
		const pass = stream as unknown as PassThrough;
		pass.write("first ");
		await new Promise((r) => setTimeout(r, 120));
		pass.write("second");
		pass.end();
		await expect(result).resolves.toBe("first second");
	});
});
