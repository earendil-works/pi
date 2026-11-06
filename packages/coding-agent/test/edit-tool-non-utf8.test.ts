import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import { computeEditsDiff } from "../src/core/tools/edit-diff.ts";

const REFUSAL =
	"It is not valid UTF-8 (for example UTF-16, or a legacy encoding such as Windows-1252 or GBK). The edit tool only writes UTF-8, so editing it would corrupt it. The file was left unchanged. To change it, use a shell command that keeps its encoding.";

describe("edit tool with files that are not UTF-8", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-edit-non-utf8-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function utf16(byteOrder: "le" | "be", text: string): Buffer {
		const le = Buffer.from(`\uFEFF${text}`, "utf16le");
		return byteOrder === "le" ? le : Buffer.from(le).swap16();
	}

	// https://github.com/earendil-works/pi/issues/10349, https://github.com/earendil-works/pi/issues/5797
	it("refuses legacy encodings and UTF-16 and leaves the file unchanged", async () => {
		const files = {
			"windows-1252.cpp": Buffer.from("// \xe4\xf6\xdf\nTIMEOUT = 30\n", "latin1"),
			"gbk.py": Buffer.from([0x23, 0x20, 0xc5, 0xe4, 0xd6, 0xc3, 0x0a, ...Buffer.from("TIMEOUT = 30\n")]),
			"utf16le.txt": utf16("le", "TIMEOUT = 30\n"),
			"utf16be.txt": utf16("be", "TIMEOUT = 30\n"),
		};
		const tool = createEditTool(dir);
		for (const [name, bytes] of Object.entries(files)) {
			const path = join(dir, name);
			writeFileSync(path, bytes);
			const edits = [{ oldText: "TIMEOUT = 30", newText: "TIMEOUT = 60" }];

			await expect(tool.execute("edit-non-utf8", { path, edits }), name).rejects.toThrow(
				`Could not edit file: ${path}. ${REFUSAL}`,
			);
			expect(readFileSync(path).equals(bytes), name).toBe(true);
			expect(await computeEditsDiff(path, edits, dir), name).toEqual({
				error: `Could not edit file: ${path}. ${REFUSAL}`,
			});
		}
	});

	it("still edits UTF-8 files and keeps a UTF-8 byte order mark", async () => {
		const path = join(dir, "bom.txt");
		writeFileSync(path, "\uFEFFcaf\u00e9\nTIMEOUT = 30\n");

		await createEditTool(dir).execute("edit-utf8", {
			path,
			edits: [{ oldText: "TIMEOUT = 30", newText: "TIMEOUT = 60" }],
		});

		expect(readFileSync(path, "utf-8")).toBe("\uFEFFcaf\u00e9\nTIMEOUT = 60\n");
	});
});
