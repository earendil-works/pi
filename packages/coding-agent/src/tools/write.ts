import * as os from "node:os";
import type { AgentTool } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, resolve as resolvePath } from "path";
import { getToolDescription } from "../prompts/index.js";

function expandPath(filePath: string): string {
	if (filePath === "~") {
		return os.homedir();
	}
	if (filePath.startsWith("~/")) {
		return os.homedir() + filePath.slice(1);
	}
	return filePath;
}

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export const writeTool: AgentTool<typeof writeSchema> = {
	name: "write",
	label: "write",
	description: getToolDescription("write"),
	parameters: writeSchema,
	getResourceKey: ({ path }) => `file:${resolvePath(expandPath(path))}`,
	execute: async (
		_toolCallId: string,
		{ path, content }: { path: string; content: string },
		signal?: AbortSignal,
		_onProgress?: (chunk: string) => void,
	) => {
		const absolutePath = resolvePath(expandPath(path));
		const dir = dirname(absolutePath);

		return new Promise<{
			content: Array<{ type: "text"; text: string }>;
			details:
				| { path: string; created: boolean; previousContent: string | null; newContentHash: string }
				| undefined;
		}>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("Operation aborted"));
				return;
			}

			let aborted = false;
			const onAbort = () => {
				aborted = true;
				reject(new Error("Operation aborted"));
			};

			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}

			(async () => {
				try {
					// Capture file state for undo support
					let previousContent: string | null = null;
					let created = false;

					try {
						previousContent = await readFile(absolutePath, "utf-8");
						created = false;
					} catch (error: any) {
						if (error.code === "ENOENT") {
							created = true;
						} else {
							// Unreadable file - proceed but undo won't work
							previousContent = null;
							created = false;
						}
					}

					if (aborted) return;

					await mkdir(dir, { recursive: true });

					if (aborted) return;

					await writeFile(absolutePath, content, "utf-8");

					if (aborted) return;

					if (signal) {
						signal.removeEventListener("abort", onAbort);
					}

					resolve({
						content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
						details: {
							path: absolutePath,
							created,
							previousContent,
							newContentHash: hashContent(content),
						},
					});
				} catch (error: any) {
					if (signal) {
						signal.removeEventListener("abort", onAbort);
					}
					if (!aborted) {
						reject(error);
					}
				}
			})();
		});
	},
};
