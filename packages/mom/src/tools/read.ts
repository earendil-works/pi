import type { AgentTool, ImageContent, TextContent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { extname } from "path";
import type { Executor } from "../sandbox.js";

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
	label: Type.String({ description: "Brief description of what you're reading and why (shown to user)" }),
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;

export function createReadTool(executor: Executor): AgentTool<typeof readSchema> {
	return {
		name: "read",
		label: "read",
		description:
			"Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, defaults to first 2000 lines. Use offset/limit for large files.",
		parameters: readSchema,
		execute: async (
			_toolCallId: string,
			{ path, offset, limit }: { label: string; path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
			_onProgress?: (chunk: string) => void,
		) => {
			const mimeType = isImageFile(path);

			if (mimeType) {
				// Read as image (binary) - use base64
				const result = await executor.exec(`base64 < ${shellEscape(path)}`, { signal });
				if (result.code !== 0) {
					throw new Error(result.stderr || `Failed to read file: ${path}`);
				}
				const base64 = result.stdout.replace(/\s/g, ""); // Remove whitespace from base64

				return {
					content: [
						{ type: "text", text: `Read image file [${mimeType}]` },
						{ type: "image", data: base64, mimeType },
					] as (TextContent | ImageContent)[],
					details: undefined,
				};
			}

			// Read as text using cat with offset/limit via sed/head/tail
			let cmd: string;
			const startLine = offset ? Math.max(1, offset) : 1;
			const maxLines = limit || MAX_LINES;

			if (startLine === 1) {
				cmd = `head -n ${maxLines} ${shellEscape(path)}`;
			} else {
				cmd = `sed -n '${startLine},${startLine + maxLines - 1}p' ${shellEscape(path)}`;
			}

			// Also get total line count
			const countResult = await executor.exec(`wc -l < ${shellEscape(path)}`, { signal });
			const totalLines = Number.parseInt(countResult.stdout.trim(), 10) || 0;

			const result = await executor.exec(cmd, { signal });
			if (result.code !== 0) {
				throw new Error(result.stderr || `Failed to read file: ${path}`);
			}

			const lines = result.stdout.split("\n");

			// Truncate long lines
			let hadTruncatedLines = false;
			const formattedLines = lines.map((line) => {
				if (line.length > MAX_LINE_LENGTH) {
					hadTruncatedLines = true;
					return line.slice(0, MAX_LINE_LENGTH);
				}
				return line;
			});

			let outputText = formattedLines.join("\n");

			// Add notices
			const notices: string[] = [];
			const endLine = startLine + lines.length - 1;

			if (hadTruncatedLines) {
				notices.push(`Some lines were truncated to ${MAX_LINE_LENGTH} characters for display`);
			}

			if (endLine < totalLines) {
				const remaining = totalLines - endLine;
				notices.push(`${remaining} more lines not shown. Use offset=${endLine + 1} to continue reading`);
			}

			if (notices.length > 0) {
				outputText += `\n\n... (${notices.join(". ")})`;
			}

			return {
				content: [{ type: "text", text: outputText }] as (TextContent | ImageContent)[],
				details: undefined,
			};
		},
	};
}

function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
