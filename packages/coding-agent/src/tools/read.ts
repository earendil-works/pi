import * as os from "node:os";
import type { AgentTool, ImageContent, TextContent } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { extname, resolve as resolvePath } from "path";
import { getToolDescription } from "../prompts/index.js";
import { readTextFileForTool } from "../utils/read-text-file.js";

/**
 * Expand ~ to home directory
 */
function expandPath(filePath: string): string {
	if (filePath === "~") {
		return os.homedir();
	}
	if (filePath.startsWith("~/")) {
		return os.homedir() + filePath.slice(1);
	}
	return filePath;
}

/**
 * Map of file extensions to MIME types for common image formats
 */
const IMAGE_MIME_TYPES: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
};

/**
 * Check if a file is an image based on its extension
 */
function isImageFile(filePath: string): string | null {
	const ext = extname(filePath).toLowerCase();
	return IMAGE_MIME_TYPES[ext] || null;
}

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;

export const readTool: AgentTool<typeof readSchema> = {
	name: "Read",
	label: "Read",
	description: getToolDescription("Read"),
	parameters: readSchema,
	execute: async (
		_toolCallId: string,
		{ path, offset, limit }: { path: string; offset?: number; limit?: number },
		signal?: AbortSignal,
		_onProgress?: (chunk: string) => void,
	) => {
		const absolutePath = resolvePath(expandPath(path));
		const mimeType = isImageFile(absolutePath);

		return new Promise<{ content: (TextContent | ImageContent)[]; details: undefined }>((resolve, reject) => {
			// Check if already aborted
			if (signal?.aborted) {
				reject(new Error("Operation aborted"));
				return;
			}

			let aborted = false;

			// Set up abort handler
			const onAbort = () => {
				aborted = true;
				reject(new Error("Operation aborted"));
			};

			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}

			// Perform the read operation
			(async () => {
				try {
					// Check if file exists
					await access(absolutePath, constants.R_OK);

					// Check if aborted before reading
					if (aborted) {
						return;
					}

					// Read the file based on type
					let content: (TextContent | ImageContent)[];

					if (mimeType) {
						// Read as image (binary)
						const buffer = await readFile(absolutePath);
						const base64 = buffer.toString("base64");

						content = [
							{ type: "text", text: `Read image file [${mimeType}]` },
							{ type: "image", data: base64, mimeType },
						];
					} else {
						// Read as text (streamed to avoid holding large files in memory)
						const outputText = await readTextFileForTool(absolutePath, {
							offset,
							limit,
							defaultLimit: MAX_LINES,
							maxLineLength: MAX_LINE_LENGTH,
							signal,
							hashlines: true,
						});
						content = [{ type: "text", text: outputText }];
					}

					// Check if aborted after reading
					if (aborted) {
						return;
					}

					// Clean up abort handler
					if (signal) {
						signal.removeEventListener("abort", onAbort);
					}

					resolve({ content, details: undefined });
				} catch (error: any) {
					// Clean up abort handler
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
