import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripBom } from "../../utils/text.ts";

export interface ExternalEditorOptions {
	command: string;
	content: string;
}

export type ExternalEditorResult = { status: "complete"; content: string } | { status: "failed"; message: string };

export async function editInExternalEditor(options: ExternalEditorOptions): Promise<ExternalEditorResult> {
	const directory = mkdtempSync(join(tmpdir(), "pi-editor-"));
	const filePath = join(directory, "prompt.md");
	try {
		writeFileSync(filePath, options.content, "utf-8");
		const [editor, ...editorArgs] = options.command.split(" ");
		process.stdout.write(`Launching external editor: ${options.command}\nPi will resume when the editor exits.\n`);

		// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
		// Node/libuv's console input read active after the parent pauses stdin, racing
		// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
		// Null means the editor could not be launched.
		const exit = await new Promise<number | NodeJS.Signals | null>((resolve) => {
			// The editor inherits pi's cwd so project-relative paths, integrated terminals,
			// and similar editor features keep working. A long cwd can break Windows editors:
			// Windows rejects working directories over MAX_PATH, and WSL launches Windows
			// editors (code, notepad.exe) from the cwd's \\wsl.localhost\... path (#11592).
			// The cwd is intentionally not changed; failures are reported to the user instead.
			const child = spawn(editor, [...editorArgs, filePath], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});
			child.on("error", () => resolve(null));
			child.on("close", (code, signal) => resolve(code ?? signal));
		});

		if (exit === null) {
			return { status: "failed", message: `Failed to launch external editor: ${options.command}` };
		}
		if (exit !== 0) {
			return {
				status: "failed",
				message: `External editor exited with ${typeof exit === "number" ? `code ${exit}` : exit}; prompt unchanged`,
			};
		}

		return { status: "complete", content: stripBom(readFileSync(filePath, "utf-8")).replace(/\n$/, "") };
	} finally {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Cleanup is best effort.
		}
	}
}
