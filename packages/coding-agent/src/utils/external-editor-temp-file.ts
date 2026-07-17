import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExternalEditorTempFile {
	/** The private temporary directory holding the file; pass this to removeExternalEditorTempFile. */
	directory: string;
	/** The absolute path to the editable file inside the directory. */
	file: string;
}

/**
 * Create a prompt file for an external editor inside a fresh, private temporary
 * directory. Using a dedicated `mkdtemp` directory (rather than a uniquely named
 * file directly in `os.tmpdir()`) keeps editor startup fast even when the system
 * temporary directory holds many entries. If writing the file fails, the
 * directory is removed before the error propagates so no empty directory leaks.
 */
export function createExternalEditorTempFile(fileName: string, content: string): ExternalEditorTempFile {
	const directory = mkdtempSync(join(tmpdir(), "pi-editor-"));
	const file = join(directory, fileName);
	try {
		writeFileSync(file, content, "utf-8");
		return { directory, file };
	} catch (error) {
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}
}

/**
 * Recursively remove a temporary directory created by createExternalEditorTempFile.
 * Cleanup failures are swallowed so a stale temp directory can never prevent the
 * TUI from restarting after the editor exits.
 */
export function removeExternalEditorTempFile(directory: string): void {
	try {
		rmSync(directory, { recursive: true, force: true });
	} catch {
		// Cleanup must not prevent the TUI from restarting.
	}
}
