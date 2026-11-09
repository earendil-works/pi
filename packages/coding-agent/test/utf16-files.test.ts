import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { processFileArguments } from "../src/cli/file-processor.ts";
import { createEditTool } from "../src/core/tools/edit.ts";
import { computeEditsDiff } from "../src/core/tools/edit-diff.ts";
import { TextFileDecoder } from "../src/core/tools/file-encoding.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

// UTF-16 files with a byte order mark: https://github.com/earendil-works/pi/issues/5797

const BYTE_ORDERS = ["le", "be"] as const;

function utf16(byteOrder: "le" | "be", text: string): Buffer {
	const le = Buffer.from(`\uFEFF${text}`, "utf16le");
	return byteOrder === "le" ? le : Buffer.from(le).swap16();
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => block.text ?? "").join("\n");
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-utf16-files-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeTestFile(name: string, content: Buffer): string {
	const path = join(dir, name);
	writeFileSync(path, content);
	return path;
}

describe("read tool with UTF-16 files", () => {
	const text = "h\u00e9llo \u{1F600}\nw\u00f6rld\r\nlast";

	it("decodes UTF-16 with a byte order mark, streamed in any chunks and from a whole buffer", async () => {
		for (const byteOrder of BYTE_ORDERS) {
			const bytes = utf16(byteOrder, text);
			const path = writeTestFile(`read-${byteOrder}.txt`, bytes);
			const readFile = async () => bytes;
			const access = async () => {};
			const chunked = (size: number) =>
				async function* () {
					for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
				};
			const tools = [
				createReadTool(dir),
				createReadTool(dir, { operations: { readFile, access } }),
				createReadTool(dir, { operations: { readFile, access, createReadStream: chunked(1) } }),
				createReadTool(dir, { operations: { readFile, access, createReadStream: chunked(3) } }),
			];
			for (const tool of tools) {
				expect(textOf(await tool.execute("read-utf16", { path })), byteOrder).toBe(text);
			}
		}
	});

	it("shows UTF-8, a UTF-8 byte order mark and invalid UTF-8 as before", async () => {
		const tool = createReadTool(dir);
		for (const bytes of [
			Buffer.from(`\uFEFF${text}`),
			Buffer.from("caf\xe9\nok", "latin1"),
			Buffer.from([0xfe, 0x41]),
		]) {
			const path = writeTestFile("read-utf8.txt", bytes);

			expect(textOf(await tool.execute("read-utf8", { path }))).toBe(bytes.toString("utf-8"));
		}
	});

	it("replaces a dangling odd byte at the end of UTF-16 with U+FFFD", () => {
		for (const byteOrder of BYTE_ORDERS) {
			const bytes = Buffer.concat([utf16(byteOrder, text), Buffer.from([0x41])]);
			const decoder = new TextFileDecoder();
			let decoded = "";
			for (let i = 0; i < bytes.length; i += 3) decoded += decoder.write(bytes.subarray(i, i + 3));

			expect(decoded + decoder.end(), byteOrder).toBe(`${text}\uFFFD`);
		}
	});
});

describe("edit tool with UTF-16 files", () => {
	const edits = [{ oldText: "X = 1", newText: "X = \u00e9\u{1F600}" }];

	it("edits UTF-16 with a byte order mark and writes it back byte-exactly in the same byte order", async () => {
		for (const byteOrder of BYTE_ORDERS) {
			const path = writeTestFile(`edit-${byteOrder}.txt`, utf16(byteOrder, "caf\u00e9\r\nX = 1\r\nend\n"));

			const preview = await computeEditsDiff(path, edits, dir);
			const result = await createEditTool(dir).execute("edit-utf16", { path, edits });

			expect(
				readFileSync(path).equals(utf16(byteOrder, "caf\u00e9\r\nX = \u00e9\u{1F600}\r\nend\n")),
				byteOrder,
			).toBe(true);
			expect(preview, byteOrder).toEqual({ diff: result.details?.diff, firstChangedLine: 2 });
		}
	});

	it("refuses UTF-16 with an odd number of bytes and leaves the file unchanged", async () => {
		for (const byteOrder of BYTE_ORDERS) {
			const content = Buffer.concat([utf16(byteOrder, "X = 1\n"), Buffer.from([0x41])]);
			const path = writeTestFile(`edit-odd-${byteOrder}.txt`, content);
			const error = `Could not edit file: ${path}. It starts with a UTF-16${byteOrder.toUpperCase()} byte order mark but has an odd number of bytes, so it is not valid UTF-16. The file was left unchanged.`;

			await expect(createEditTool(dir).execute("edit-odd", { path, edits }), byteOrder).rejects.toThrow(error);
			expect(readFileSync(path).equals(content), byteOrder).toBe(true);
			expect(await computeEditsDiff(path, edits, dir), byteOrder).toEqual({ error });
		}
	});

	it("refuses UTF-16 when custom operations cannot write bytes", async () => {
		let written: string | undefined;
		const tool = createEditTool(dir, {
			operations: {
				access: async () => {},
				readFile: async () => utf16("le", "X = 1\n"),
				writeFile: async (_path, content) => {
					written = content;
				},
			},
		});

		await expect(tool.execute("edit-text-ops", { path: "a.txt", edits })).rejects.toThrow(
			"Could not edit file: a.txt. It is not valid UTF-8",
		);
		expect(written).toBeUndefined();
	});
});

describe("write tool with UTF-16 files", () => {
	it("overwrites an existing UTF-16 file in the same byte order with one byte order mark", async () => {
		for (const byteOrder of BYTE_ORDERS) {
			for (const content of ["new \u{1F600}\r\n", "\uFEFFnew \u{1F600}\r\n"]) {
				const path = writeTestFile(`write-${byteOrder}.txt`, utf16(byteOrder, "old\n"));

				const result = await createWriteTool(dir).execute("write-utf16", { path, content });

				expect(readFileSync(path).equals(utf16(byteOrder, "new \u{1F600}\r\n")), byteOrder).toBe(true);
				expect(textOf(result)).toBe(`Successfully wrote to ${path}`);
			}
		}
	});

	it("writes new files, UTF-8 files and UTF-8 files with a byte order mark as UTF-8 as before", async () => {
		const tool = createWriteTool(dir);
		for (const existing of [undefined, Buffer.from("old\n"), Buffer.from("\uFEFFold\n")]) {
			const path = join(dir, "write-utf8.txt");
			rmSync(path, { force: true });
			if (existing) writeFileSync(path, existing);

			await tool.execute("write-utf8", { path, content: "caf\u00e9\n" });

			expect(readFileSync(path, "utf-8")).toBe("caf\u00e9\n");
		}
	});

	it("writes UTF-8 over UTF-16 files when custom operations cannot read and write bytes", async () => {
		const path = writeTestFile("write-text-ops.txt", utf16("le", "old\n"));
		const tool = createWriteTool(dir, {
			operations: {
				mkdir: async () => {},
				writeFile: async (absolutePath, content) => writeFileSync(absolutePath, content, "utf-8"),
			},
		});

		await tool.execute("write-text-ops", { path, content: "new\n" });

		expect(readFileSync(path, "utf-8")).toBe("new\n");
	});
});

describe("@file attachments with UTF-16 files", () => {
	it("attaches UTF-16 files as text without the byte order mark, like UTF-8 files", async () => {
		const files = [
			...BYTE_ORDERS.map((byteOrder) => utf16(byteOrder, "caf\u00e9 \u{1F600}\n")),
			Buffer.from("\uFEFFcaf\u00e9 \u{1F600}\n"),
		];
		for (const [index, bytes] of files.entries()) {
			const path = writeTestFile(`attach-${index}.txt`, bytes);

			const { text } = await processFileArguments([path]);

			expect(text, path).toBe(`<file name="${path}">\ncaf\u00e9 \u{1F600}\n\n</file>\n`);
		}
	});
});
