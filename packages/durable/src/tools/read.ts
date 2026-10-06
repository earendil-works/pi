import type { Context } from "@earendil-works/chord";
import { type Static, Type } from "typebox";
import {
	type BinaryReader,
	type FileInfo,
	getOrThrow,
	type LineScan,
	rangeDecoder,
	startsWithBom,
} from "../env/index.ts";
import { defineTool } from "../harness/define.ts";
import { characterEnd } from "../harness/output.ts";
import type { ToolDiagnostic, ToolRegistration } from "../harness/types.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHeadOf,
	utf8ByteLength,
} from "../truncate.ts";
import { requireEnv } from "./env.ts";
import { detectSupportedImageMimeTypeOf } from "./image.ts";
import { resolveReadToolPath } from "./path-utils.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export type ReadToolInput = Static<typeof readSchema>;

export type ReadToolDetails = {
	/** How the shown text was cut; the text itself is the result content. */
	truncation?: Omit<TruncationResult, "content">;
};

const READ_CHUNK = 64 * 1024;

/** `Array.prototype.slice`'s conversion of an index: NaN is 0, other values truncate toward zero. */
function sliceIndex(value: number): number {
	return Number.isNaN(value) ? 0 : Math.trunc(value);
}

/**
 * The decoded start of bytes `[start, end)` of the file, decoded as part of the whole file: all of it, or enough for
 * `truncateHeadOf` (more than `DEFAULT_MAX_BYTES + 1` bytes, or `DEFAULT_MAX_LINES` newlines).
 */
async function readHead(
	reader: BinaryReader,
	start: number,
	end: number,
	skipBom: boolean,
	context: Context,
): Promise<string> {
	const decoder = rangeDecoder();
	let text = "";
	let newlines = 0;
	for (let position = skipBom && start === 0 ? 3 : start; position < end; ) {
		const bytes = getOrThrow(await reader.read(position, Math.min(READ_CHUNK, end - position), context));
		if (bytes.length === 0) break;
		position += bytes.length;
		const decoded = decoder.decode(bytes, { stream: true });
		text += decoded;
		for (let index = decoded.indexOf("\n"); index !== -1; index = decoded.indexOf("\n", index + 1)) newlines++;
		if (newlines >= DEFAULT_MAX_LINES || utf8ByteLength(text) > DEFAULT_MAX_BYTES + 1) return text;
	}
	return text + decoder.decode();
}

/** Reads text files. Remarks about truncation and continuation are diagnostics; the content is only file text. */
export function createReadTool(): ToolRegistration<typeof readSchema, ReadToolDetails> {
	return defineTool({
		name: "read",
		description: `Read the contents of a text file. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		parameters: readSchema,
		async execute(args, api, context) {
			const { path, offset, limit } = args;
			const env = requireEnv(api);
			const absolutePath = await resolveReadToolPath(env, path, context);
			const reader = getOrThrow(await env.openBinaryReader(absolutePath, undefined, context));
			try {
				// A concurrent writer can change the file between the scan and the reads. Appending (a growing log) leaves
				// the scanned bytes as they were; a file that shrank or was rewritten in place is read again once.
				for (let attempt = 0; ; attempt++) {
					const before = getOrThrow(await reader.info(context));
					const result = await readText(reader, before, path, offset, limit, context);
					const after = getOrThrow(await reader.info(context));
					if (after.size > before.size || (after.size === before.size && after.mtimeMs === before.mtimeMs)) {
						return result;
					}
					if (attempt === 1) throw new Error(`${path} changed while it was read`);
				}
			} finally {
				await reader.close(context);
			}
		},
	});
}

/**
 * The read result for the opened file. It equals decoding the whole file with `TextDecoder`, splitting it on `\n`,
 * and bounding the selected lines with `truncateHead`, while reading only one scan's worth of the file plus the head.
 */
async function readText(
	reader: BinaryReader,
	info: FileInfo,
	path: string,
	offset: number | undefined,
	limit: number | undefined,
	context: Context,
) {
	const mimeType = await detectSupportedImageMimeTypeOf({
		size: info.size,
		read: async (position, length) => getOrThrow(await reader.read(position, length, context)),
	});
	if (mimeType) {
		// Image content is not supported yet.
		return {
			content: [],
			isError: true,
			diagnostics: [
				{
					severity: "error" as const,
					code: "unsupported_image",
					message: `${path} is an image (${mimeType}); reading images is not supported`,
				},
			],
		};
	}

	const startLine = offset ? Math.max(0, offset - 1) : 0;
	const startLineDisplay = startLine + 1;
	// Lines are selected like `allLines.slice(startLine, endLine)`, which truncates fractional indices.
	const sliceStart = sliceIndex(startLine);
	// One pass finds the line count and the selection; a selection past the last line ends with it, as `slice` does,
	// and an empty one (a zero or negative limit) is scanned as one line and then ignored.
	// A start beyond any file is scanned from 0 only to count lines; the offset check below then fails as before.
	const scanStart = Number.isSafeInteger(sliceStart) ? sliceStart : 0;
	const requestedEnd = limit === undefined ? undefined : Math.max(scanStart + 1, sliceIndex(startLine + limit));
	const scanEnd = requestedEnd !== undefined && Number.isSafeInteger(requestedEnd) ? requestedEnd : undefined;
	const scanOf = async (endLine: number | undefined): Promise<LineScan> =>
		getOrThrow(
			await reader.scanLines({ startLine: scanStart, ...(endLine === undefined ? {} : { endLine }) }, context),
		);
	let scan = await scanOf(scanEnd);
	const totalFileLines = scan.newlines + 1;
	if (startLine >= totalFileLines) {
		throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
	}

	let userLimitedLines: number | undefined;
	let selectedLineCount = totalFileLines - sliceStart;
	if (limit !== undefined) {
		const endLine = Math.min(startLine + limit, totalFileLines);
		userLimitedLines = endLine - startLine;
		// `slice` counts a negative end from the end of the lines, which only the line count tells; scan again for it.
		const relativeEnd = sliceIndex(endLine);
		const sliceEnd = relativeEnd < 0 ? Math.max(totalFileLines + relativeEnd, 0) : relativeEnd;
		selectedLineCount = Math.max(0, sliceEnd - sliceStart);
		if (selectedLineCount > 0 && relativeEnd < 0) scan = await scanOf(sliceEnd);
	}
	const empty = selectedLineCount === 0;
	// Counted like `truncateHead`: a trailing newline adds no line, and empty text has none.
	const endsWithNewline = !empty && scan.lastLineStart === scan.end && scan.lastLineStart > scan.start;
	const totals = {
		lines: empty || scan.selectedBytes === 0 ? 0 : selectedLineCount - (endsWithNewline ? 1 : 0),
		bytes: empty ? 0 : scan.selectedBytes,
	};
	const firstBytes = getOrThrow(await reader.read(0, 3, context));
	const head = empty ? "" : await readHead(reader, scan.start, scan.end, startsWithBom(firstBytes), context);

	const { content: headText, ...truncation } = truncateHeadOf(head, totals);
	const diagnostics: ToolDiagnostic[] = [];
	let outputText = headText;
	let details: ReadToolDetails | undefined;
	if (truncation.firstLineExceedsLimit) {
		// Show the start of the line, cut at the byte limit on a character boundary. Like `allLines[startLine]`, a
		// fractional start line names no line.
		const integral = Number.isInteger(startLine);
		const lineBytes = new TextEncoder().encode(integral ? (head.split("\n")[0] ?? "") : "");
		const lineSize = integral ? scan.firstLineBytes : 0;
		const end = characterEnd(lineBytes, DEFAULT_MAX_BYTES);
		outputText = new TextDecoder().decode(lineBytes.subarray(0, end));
		diagnostics.push({
			severity: "warn",
			code: "truncated",
			message: `Line ${startLineDisplay} is ${formatSize(lineSize)}, exceeds the ${formatSize(DEFAULT_MAX_BYTES)} limit; showing its first ${formatSize(end)}. Use bash: sed -n '${startLineDisplay}p' ${path} | tail -c +${end + 1}`,
		});
		details = { truncation: { ...truncation, outputBytes: end, outputLines: 1 } };
	} else if (truncation.truncated) {
		const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		const limitText = truncation.truncatedBy === "lines" ? "" : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`;
		diagnostics.push({
			severity: "info",
			code: "truncated",
			message: `Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}${limitText}. Use offset=${nextOffset} to continue.`,
		});
		details = { truncation };
	} else if (userLimitedLines !== undefined && startLine + userLimitedLines < totalFileLines) {
		const remaining = totalFileLines - (startLine + userLimitedLines);
		const nextOffset = startLine + userLimitedLines + 1;
		diagnostics.push({
			severity: "info",
			message: `${remaining} more lines in file. Use offset=${nextOffset} to continue.`,
		});
	}

	return {
		content: outputText === "" ? [] : [{ type: "text" as const, text: outputText }],
		...(details === undefined ? {} : { details }),
		diagnostics,
	};
}
