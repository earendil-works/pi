import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TextFileDecoder } from "../src/core/tools/file-encoding.ts";
import { createEditTool, createReadTool } from "../src/index.ts";

function utf16(byteOrder: "le" | "be", text: string): Buffer {
	const le = Buffer.from(`\uFEFF${text}`, "utf16le");
	return byteOrder === "le" ? le : Buffer.from(le).swap16();
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => block.text ?? "").join("\n");
}

let testDir: string;

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), "coding-agent-encodings-"));
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

function writeTestFile(name: string, content: Buffer): string {
	const path = join(testDir, name);
	writeFileSync(path, content);
	return path;
}

describe("edit tool encodings", () => {
	const editTool = createEditTool(process.cwd());
	const latin1Content = Buffer.from("caf\xe9\nTIMEOUT = 30\n", "latin1");

	// #10349, #5797
	it("applies ASCII edits to files that are not valid UTF-8 without changing other bytes", async () => {
		const path = writeTestFile("latin1.py", latin1Content);

		await editTool.execute("latin1", { path, edits: [{ oldText: "TIMEOUT = 30", newText: "TIMEOUT = 60" }] });

		expect(readFileSync(path).equals(Buffer.from("caf\xe9\nTIMEOUT = 60\n", "latin1"))).toBe(true);
	});

	// #10349
	it("refuses non-ASCII edits to files that are not valid UTF-8", async () => {
		const path = writeTestFile("latin1-non-ascii.py", latin1Content);

		await expect(
			editTool.execute("latin1-non-ascii", {
				path,
				edits: [{ oldText: "TIMEOUT = 30", newText: "TIMEOUT = 30 # caf\u00e9" }],
			}),
		).rejects.toThrow(
			`Cannot apply the edit to ${path}: the file is not valid UTF-8 (it may use a legacy encoding such as Windows-1252, GBK or Shift-JIS), so its encoding is unknown. Edits to such files are only applied when oldText and newText are ASCII, which keeps every other byte unchanged. Anchor the edit on ASCII-only text. The file was left unchanged. For such changes, use bash (for example iconv, or a script that reads and writes the file in its encoding), or, if converting the file to UTF-8 is acceptable, rewrite it with write.`,
		);
		expect(readFileSync(path).equals(latin1Content)).toBe(true);
	});

	// #10349
	it("refuses fuzzy matches in files that are not valid UTF-8", async () => {
		const content = Buffer.from("caf\xe9\nTIMEOUT = 30  \n", "latin1");
		const path = writeTestFile("latin1-fuzzy.py", content);

		await expect(
			editTool.execute("latin1-fuzzy", { path, edits: [{ oldText: "TIMEOUT = 30\n", newText: "TIMEOUT = 60\n" }] }),
		).rejects.toThrow(/only matches after normalizing whitespace or Unicode punctuation.*only exact matches/);
		expect(readFileSync(path).equals(content)).toBe(true);
	});

	// #10349
	it("refuses changes within 3 bytes after a non-ASCII byte, which can belong to a multi-byte character", async () => {
		// U+20000 in GB18030 is 95 32 82 36: its second and fourth bytes read as the digits 2 and 6.
		const gb18030 = Buffer.from([0x95, 0x32, 0x82, 0x36, 0x0a]);
		// "表" in Shift-JIS is 95 5C: its second byte reads as a backslash.
		const shiftJis = Buffer.concat([Buffer.from([0x95, 0x5c]), Buffer.from("abc\n")]);
		const cases = [
			{ content: gb18030, edit: { oldText: "2", newText: "2X" } },
			{ content: shiftJis, edit: { oldText: "\\abc", newText: "Xabc" } },
			{ content: shiftJis, edit: { oldText: "\\abc", newText: "\\Xbc" } },
		];
		for (const [index, { content, edit }] of cases.entries()) {
			const path = writeTestFile(`split-${index}.txt`, content);

			await expect(editTool.execute("split", { path, edits: [edit] })).rejects.toThrow(
				/changes text within 3 bytes after a non-ASCII byte/,
			);
			expect(readFileSync(path).equals(content)).toBe(true);
		}
	});

	it("applies ASCII changes at least 3 bytes after a non-ASCII byte", async () => {
		const path = writeTestFile("shift-jis-far.txt", Buffer.concat([Buffer.from([0x95, 0x5c]), Buffer.from("abc\n")]));

		await editTool.execute("sjis-far", { path, edits: [{ oldText: "\\abc", newText: "\\abd" }] });

		expect(readFileSync(path).equals(Buffer.concat([Buffer.from([0x95, 0x5c]), Buffer.from("abd\n")]))).toBe(true);
	});

	// #10349
	it("counts only exact occurrences as duplicates in files that are not valid UTF-8", async () => {
		// X\xa0= 1 only matches "X = 1" after fuzzy normalization, which these files do not use.
		const path = writeTestFile("latin1-nbsp.txt", Buffer.from("X = 1\nX\xa0= 1\n", "latin1"));

		await editTool.execute("latin1-nbsp", { path, edits: [{ oldText: "X = 1", newText: "X = 2" }] });

		expect(readFileSync(path).equals(Buffer.from("X = 2\nX\xa0= 1\n", "latin1"))).toBe(true);
	});

	it("refuses UTF-16 files with an odd number of bytes", async () => {
		for (const byteOrder of ["le", "be"] as const) {
			const content = Buffer.concat([utf16(byteOrder, "X=1\n"), Buffer.from([0x41])]);
			const path = writeTestFile(`utf16${byteOrder}-odd.txt`, content);

			await expect(
				editTool.execute("utf16-odd", { path, edits: [{ oldText: "1", newText: "20" }] }),
				byteOrder,
			).rejects.toThrow(
				`Could not edit file: ${path}. It starts with a UTF-16${byteOrder.toUpperCase()} byte order mark but has an odd number of bytes, so it is not valid UTF-16. The file was left unchanged.`,
			);
			expect(readFileSync(path).equals(content)).toBe(true);
		}
	});

	it("edits UTF-16 files with a byte order mark and writes them back in the same encoding", async () => {
		for (const byteOrder of ["le", "be"] as const) {
			const path = writeTestFile(`utf16${byteOrder}.txt`, utf16(byteOrder, "caf\u00e9\r\nX = 1\r\n"));

			await editTool.execute(`utf16${byteOrder}`, {
				path,
				edits: [{ oldText: "X = 1", newText: "X = \u00e9\u{1F600}" }],
			});

			expect(readFileSync(path).equals(utf16(byteOrder, "caf\u00e9\r\nX = \u00e9\u{1F600}\r\n")), byteOrder).toBe(
				true,
			);
		}
	});

	it("keeps the UTF-8 byte order mark", async () => {
		const path = writeTestFile("bom.txt", Buffer.from("\uFEFFa\nb\n"));

		await editTool.execute("bom", { path, edits: [{ oldText: "b", newText: "B" }] });

		expect(readFileSync(path).equals(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("a\nB\n")]))).toBe(true);
	});

	it("refuses files that are not UTF-8 when custom operations cannot write bytes", async () => {
		let written: string | undefined;
		const textOnlyTool = createEditTool(testDir, {
			operations: {
				access: async () => {},
				readFile: async () => latin1Content,
				writeFile: async (_path, content) => {
					written = content;
				},
			},
		});

		await expect(
			textOnlyTool.execute("text-only-ops", {
				path: "latin1.py",
				edits: [{ oldText: "TIMEOUT = 30", newText: "TIMEOUT = 60" }],
			}),
		).rejects.toThrow(
			"Could not edit file: latin1.py. The file is not valid UTF-8, and the configured edit operations can only write UTF-8 text. The file was left unchanged.",
		);
		expect(written).toBeUndefined();
	});
});

describe("read tool encodings", () => {
	const readTool = createReadTool(process.cwd());
	const text = "h\u00e9llo \u{1F600}\nw\u00f6rld\r\nlast";

	it("decodes UTF-16 files with a byte order mark, without the mark", async () => {
		for (const byteOrder of ["le", "be"] as const) {
			const path = writeTestFile(`read-utf16${byteOrder}.txt`, utf16(byteOrder, text));

			expect(textOf(await readTool.execute("read-utf16", { path })), byteOrder).toBe(text);
		}
	});

	it("decodes UTF-16 the same when streamed in small chunks and without a stream", async () => {
		for (const byteOrder of ["le", "be"] as const) {
			const bytes = utf16(byteOrder, text);
			const readFile = async () => bytes;
			const access = async () => {};
			const chunked = (size: number) =>
				async function* () {
					for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
				};
			const tools = [
				createReadTool(process.cwd(), { operations: { readFile, access } }),
				createReadTool(process.cwd(), { operations: { readFile, access, createReadStream: chunked(1) } }),
				createReadTool(process.cwd(), { operations: { readFile, access, createReadStream: chunked(3) } }),
			];
			for (const tool of tools) {
				expect(textOf(await tool.execute("read-utf16-chunks", { path: "x.txt" })), byteOrder).toBe(text);
			}
		}
	});

	it("shows UTF-8 files, a UTF-8 byte order mark and invalid UTF-8 as before", async () => {
		for (const bytes of [
			Buffer.from(`\uFEFF${text}`),
			Buffer.from("caf\xe9\nok", "latin1"),
			Buffer.from([0xfe, 0x41]),
		]) {
			const path = writeTestFile("read-utf8.txt", bytes);

			expect(textOf(await readTool.execute("read-utf8", { path }))).toBe(bytes.toString("utf-8"));
		}
	});

	it("decodes UTF-16 across chunk boundaries and replaces a dangling odd byte", () => {
		for (const byteOrder of ["le", "be"] as const) {
			const bytes = Buffer.concat([utf16(byteOrder, text), Buffer.from([0x41])]);
			const decoder = new TextFileDecoder();
			let decoded = "";
			for (let i = 0; i < bytes.length; i += 3) decoded += decoder.write(bytes.subarray(i, i + 3));
			expect(decoded + decoder.end(), byteOrder).toBe(`${text}\uFFFD`);
		}
	});
});
