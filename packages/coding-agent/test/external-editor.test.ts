import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ExternalEditorResult, editInExternalEditor } from "../src/modes/interactive/external-editor.ts";

const editorFixturePath = fileURLToPath(new URL("./fixtures/external-editor.mjs", import.meta.url));

interface EditorCapture {
	filePath: string;
	content: string;
	entries: string[];
	mode: number;
}

async function runExternalEditor(exitUnsuccessfully = false): Promise<{
	result: ExternalEditorResult;
	capture: EditorCapture;
}> {
	const testDirectory = mkdtempSync(join(tmpdir(), "pi-external-editor-test-"));
	const capturePath = join(testDirectory, "capture.json");
	try {
		const result = await editInExternalEditor({
			command: `${process.execPath} ${editorFixturePath} ${capturePath}${exitUnsuccessfully ? " fail" : ""}`,
			content: "original",
		});
		const capture = JSON.parse(readFileSync(capturePath, "utf-8")) as EditorCapture;
		return { result, capture };
	} finally {
		rmSync(testDirectory, { recursive: true, force: true });
	}
}

describe("editInExternalEditor", () => {
	it("edits a prompt inside a private temporary directory", async () => {
		const { result, capture } = await runExternalEditor();
		const directory = dirname(capture.filePath);

		expect(result).toEqual({ status: "success", content: "edited" });
		expect(dirname(directory)).toBe(tmpdir());
		expect(basename(directory)).toMatch(/^pi-editor-/);
		expect(basename(capture.filePath)).toBe("prompt.md");
		expect(capture.entries).toEqual(["prompt.md"]);
		expect(capture.content).toBe("original");
		if (process.platform !== "win32") {
			expect(capture.mode).toBe(0o700);
		}
		expect(existsSync(directory)).toBe(false);
	});

	it("keeps the original content when the editor exits unsuccessfully", async () => {
		const { result, capture } = await runExternalEditor(true);

		expect(result).toEqual({ status: "unchanged" });
		expect(existsSync(dirname(capture.filePath))).toBe(false);
	});
});
