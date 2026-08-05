/**
 * Process @file CLI arguments into text content and image attachments
 */

import { access, readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { processImage } from "../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export interface ProcessFileOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
}

interface LineRange {
	start: number;
	end: number;
}

interface ResolvedFileArgument {
	absolutePath: string;
	lineRange?: LineRange;
}

const LINE_RANGE_SUFFIX = /#L(\d+)-L(\d+)$/;

function exitWithError(message: string): never {
	console.error(chalk.red(`Error: ${message}`));
	process.exit(1);
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function resolveFileArgument(fileArg: string): Promise<ResolvedFileArgument> {
	const match = LINE_RANGE_SUFFIX.exec(fileArg);
	const literalPath = resolve(resolveReadPath(fileArg, process.cwd()));
	const hasFileUrlRange = fileArg.startsWith("file://") && match !== null;
	if (!hasFileUrlRange && (await pathExists(literalPath))) {
		return { absolutePath: literalPath };
	}

	if (!match || match.index === 0) {
		exitWithError(`File not found: ${literalPath}`);
	}

	const start = Number(match[1]);
	const end = Number(match[2]);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
		exitWithError(`Invalid line range: #L${match[1]}-L${match[2]}`);
	}

	const basePath = resolve(resolveReadPath(fileArg.slice(0, match.index), process.cwd()));
	if (!(await pathExists(basePath))) {
		exitWithError(`File not found: ${basePath}`);
	}

	return { absolutePath: basePath, lineRange: { start, end } };
}

/** Process @file arguments into text content and image attachments */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		const { absolutePath, lineRange } = await resolveFileArgument(fileArg);

		// Check if file is empty
		const stats = await stat(absolutePath);
		if (stats.size === 0) {
			// Skip empty files
			continue;
		}

		const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);

		if (mimeType) {
			if (lineRange) {
				exitWithError(`Line ranges are only supported for text files: ${absolutePath}`);
			}

			// Handle image file
			const content = await readFile(absolutePath);
			const processed = await processImage(content, mimeType, { autoResizeImages });

			if (!processed.ok) {
				text += `<file name="${absolutePath}">${processed.message}</file>\n`;
				continue;
			}

			const attachment: ImageContent = {
				type: "image",
				mimeType: processed.mimeType,
				data: processed.data,
			};
			images.push(attachment);

			// Add text reference to image with optional processing hints
			if (processed.hints.length > 0) {
				text += `<file name="${absolutePath}">${processed.hints.join("\n")}</file>\n`;
			} else {
				text += `<file name="${absolutePath}"></file>\n`;
			}
		} else {
			// Handle text file
			let content: string;
			try {
				content = await readFile(absolutePath, "utf-8");
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				exitWithError(`Could not read file ${absolutePath}: ${message}`);
			}

			if (lineRange) {
				const lines = content.split("\n");
				if (lineRange.start > lines.length) {
					exitWithError(
						`Line range start ${lineRange.start} is beyond end of file (${lines.length} lines total): ${absolutePath}`,
					);
				}
				const effectiveEnd = Math.min(lineRange.end, lines.length);
				const selectedContent = lines.slice(lineRange.start - 1, effectiveEnd).join("\n");
				text += `<file name="${absolutePath}" lines="${lineRange.start}-${effectiveEnd}">\n${selectedContent}\n</file>\n`;
			} else {
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			}
		}
	}

	return { text, images };
}
