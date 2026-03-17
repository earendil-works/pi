import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { type Static, Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { formatDimensionNote, resizeImage } from "../../utils/image-resize.js";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.js";
import { resolveReadPath } from "./path-utils.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (e.g., SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null/undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

export interface ReadToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultReadOperations;

	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		parameters: readSchema,
		execute: async (
			_toolCallId: string,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
		) => {
			const absolutePath = resolveReadPath(path, cwd);

			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
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
							await ops.access(absolutePath);

							// Check if aborted before reading
							if (aborted) {
								return;
							}

							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;

							// Read the file based on type
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;

							if (mimeType) {
								// Read as image (binary)
								const buffer = await ops.readFile(absolutePath);
								const base64 = buffer.toString("base64");

								if (autoResizeImages) {
									// Resize image if needed
									const resized = await resizeImage({ type: "image", data: base64, mimeType });

									// Handle case where image couldn't be resized to fit limits
									if (!resized) {
										content = [
											{ type: "text", text: `Error: Image file exceeds 5MB limit and could not be resized: ${path}` },
										];
									} else {
										// Final safety check: ensure resized image is under 5MB
										const resizedBuffer = Buffer.from(resized.data, "base64");
										const maxBytes = 5 * 1024 * 1024; // 5MB Anthropic limit
										if (resizedBuffer.length > maxBytes) {
											content = [
												{ type: "text", text: `Error: Image file exceeds 5MB limit even after resize: ${path} (${Math.round(resizedBuffer.length / 1024 / 1024 * 100) / 100}MB)` },
											];
										} else {
											const dimensionNote = formatDimensionNote(resized);

											let textNote = `Read image file [${resized.mimeType}]`;
											if (dimensionNote) {
												textNote += `\n${dimensionNote}`;
											}

											content = [
												{ type: "text", text: textNote },
												{ type: "image", data: resized.data, mimeType: resized.mimeType },
											];
										}
									}
								} else {
									const textNote = `Read image file [${mimeType}]`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: base64, mimeType },
									];
								}
							} else {
								// Read as text
								const buffer = await ops.readFile(absolutePath);
								const textContent = buffer.toString("utf-8");
								const allLines = textContent.split("\n");
								const totalFileLines = allLines.length;

								// Apply offset if specified (1-indexed to 0-indexed)
								const startLine = offset ? Math.max(0, offset - 1) : 0;
								const startLineDisplay = startLine + 1; // For display (1-indexed)

								// Check if offset is out of bounds
								if (startLine >= allLines.length) {
									throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
								}

								// If limit is specified by user, use it; otherwise we'll let truncateHead decide
								let selectedContent: string;
								let userLimitedLines: number | undefined;
								if (limit !== undefined) {
									const endLine = Math.min(startLine + limit, allLines.length);
									selectedContent = allLines.slice(startLine, endLine).join("\n");
									userLimitedLines = endLine - startLine;
								} else {
									selectedContent = allLines.slice(startLine).join("\n");
								}

								// Apply truncation (respects both line and byte limits)
								const truncation = truncateHead(selectedContent);

								let outputText: string;

								if (truncation.firstLineExceedsLimit) {
									// First line at offset exceeds 30KB - tell model to use bash
									const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
									outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
									details = { truncation };
								} else if (truncation.truncated) {
									// Truncation occurred - build actionable notice
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;

									outputText = truncation.content;

									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
									} else {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
									}
									details = { truncation };
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
									// User specified limit, there's more content, but no truncation
									const remaining = allLines.length - (startLine + userLimitedLines);
									const nextOffset = startLine + userLimitedLines + 1;

									outputText = truncation.content;
									outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
								} else {
									// No truncation, no user limit exceeded
									outputText = truncation.content;
								}

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

							resolve({ content, details });
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
				},
			);
		},
	};
}

/** Default read tool using process.cwd() - for backwards compatibility */
export const readTool = createReadTool(process.cwd());
