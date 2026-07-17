import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExternalEditorTempFile, removeExternalEditorTempFile } from "../src/utils/external-editor-temp-file.ts";

const createdDirectories: string[] = [];

afterEach(() => {
	for (const directory of createdDirectories) {
		rmSync(directory, { recursive: true, force: true });
	}
	createdDirectories.length = 0;
});

describe("external editor temp files", () => {
	it("places the prompt in a private sparse directory", () => {
		const tempFile = createExternalEditorTempFile("prompt.pi.md", "hello");
		createdDirectories.push(tempFile.directory);

		expect(dirname(tempFile.directory)).toBe(tmpdir());
		expect(basename(tempFile.directory)).toMatch(/^pi-editor-/);
		expect(dirname(tempFile.file)).toBe(tempFile.directory);
		expect(basename(tempFile.file)).toBe("prompt.pi.md");
		expect(readFileSync(tempFile.file, "utf-8")).toBe("hello");
		if (process.platform !== "win32") {
			expect(statSync(tempFile.directory).mode & 0o777).toBe(0o700);
		}
	});

	it("removes the entire temporary directory", () => {
		const tempFile = createExternalEditorTempFile("prompt.md", "hello");
		removeExternalEditorTempFile(tempFile.directory);

		expect(existsSync(tempFile.directory)).toBe(false);
		expect(() => removeExternalEditorTempFile(tempFile.directory)).not.toThrow();
	});
});
