import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processFileArguments } from "../../../src/cli/file-processor.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

class ProcessExitError extends Error {
	readonly code: string | number | null | undefined;

	constructor(code: string | number | null | undefined) {
		super(`process.exit(${code})`);
		this.code = code;
	}
}

describe("issue #7673 CLI file line ranges", () => {
	let testDir: string;
	let consoleError: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-7673-"));
		consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			throw new ProcessExitError(code);
		}) as typeof process.exit);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(testDir, { recursive: true, force: true });
	});

	async function expectFatal(fileArg: string, message: string): Promise<void> {
		await expect(processFileArguments([fileArg])).rejects.toMatchObject({
			code: 1,
		});
		expect(consoleError.mock.calls.flat().join("\n")).toContain(message);
	}

	it("includes the requested 1-based inclusive range", async () => {
		const filePath = join(testDir, "example.txt");
		writeFileSync(filePath, "one\ntwo\nthree\nfour");

		const result = await processFileArguments([`${filePath}#L2-L3`]);

		expect(result.images).toEqual([]);
		expect(result.text).toBe(`<file name="${filePath}" lines="2-3">\ntwo\nthree\n</file>\n`);
	});

	it("parses a line range from a file URL fragment", async () => {
		const filePath = join(testDir, "url.txt");
		writeFileSync(filePath, "one\ntwo\nthree\nfour");

		const result = await processFileArguments([`${pathToFileURL(filePath).href}#L2-L3`]);

		expect(result.text).toBe(`<file name="${filePath}" lines="2-3">\ntwo\nthree\n</file>\n`);
	});

	it("prefers an existing literal path over parsing a range suffix", async () => {
		const basePath = join(testDir, "example.txt");
		const literalPath = `${basePath}#L2-L3`;
		writeFileSync(basePath, "base one\nbase two\nbase three");
		writeFileSync(literalPath, "literal filename");

		const result = await processFileArguments([literalPath]);

		expect(result.text).toBe(`<file name="${literalPath}">\nliteral filename\n</file>\n`);
	});

	it("clamps the end to EOF and reports the effective range", async () => {
		const filePath = join(testDir, "short.txt");
		writeFileSync(filePath, "one\ntwo\nthree");

		const result = await processFileArguments([`${filePath}#L2-L99`]);

		expect(result.text).toBe(`<file name="${filePath}" lines="2-3">\ntwo\nthree\n</file>\n`);
	});

	it("preserves CRLF line endings within the selected content", async () => {
		const filePath = join(testDir, "windows.txt");
		writeFileSync(filePath, "one\r\ntwo\r\nthree\r\nfour");

		const result = await processFileArguments([`${filePath}#L2-L3`]);

		expect(result.text).toBe(`<file name="${filePath}" lines="2-3">\ntwo\r\nthree\r\n</file>\n`);
	});

	it("leaves whole-file references unchanged", async () => {
		const filePath = join(testDir, "whole.txt");
		writeFileSync(filePath, "one\ntwo");

		const result = await processFileArguments([filePath]);

		expect(result.text).toBe(`<file name="${filePath}">\none\ntwo\n</file>\n`);
	});

	it("rejects non-positive and reversed ranges", async () => {
		const filePath = join(testDir, "invalid.txt");
		writeFileSync(filePath, "one\ntwo\nthree");

		await expectFatal(`${filePath}#L0-L2`, "Invalid line range: #L0-L2");
		await expectFatal(`${filePath}#L3-L2`, "Invalid line range: #L3-L2");
	});

	it("rejects a range starting beyond EOF", async () => {
		const filePath = join(testDir, "short.txt");
		writeFileSync(filePath, "one\ntwo\nthree");

		await expectFatal(`${filePath}#L4-L5`, "Line range start 4 is beyond end of file (3 lines total)");
	});

	it("rejects line ranges for images", async () => {
		const filePath = join(testDir, "image.png");
		writeFileSync(filePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		await expectFatal(`${filePath}#L1-L2`, "Line ranges are only supported for text files");
	});
});
