import { type Static, Type } from "typebox";
import { getOrThrow } from "../env/index.ts";
import { defineTool } from "../harness/define.ts";
import { characterEnd } from "../harness/output.ts";
import type { ToolDiagnostic, ToolRegistration } from "../harness/types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "../truncate.ts";
import { requireEnv } from "./env.ts";
import { detectSupportedImageMimeType } from "./image.ts";
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
			const bytes = getOrThrow(await env.readBinaryFile(absolutePath, context));
			const mimeType = detectSupportedImageMimeType(bytes);
			if (mimeType) {
				// Image content is not supported yet.
				return {
					content: [],
					isError: true,
					diagnostics: [
						{
							severity: "error",
							code: "unsupported_image",
							message: `${path} is an image (${mimeType}); reading images is not supported`,
						},
					],
				};
			}

			const textContent = new TextDecoder().decode(bytes);
			const allLines = textContent.split("\n");
			const totalFileLines = allLines.length;
			const startLine = offset ? Math.max(0, offset - 1) : 0;
			const startLineDisplay = startLine + 1;
			if (startLine >= allLines.length) {
				throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
			}

			let selectedContent: string;
			let userLimitedLines: number | undefined;
			if (limit !== undefined) {
				const endLine = Math.min(startLine + limit, allLines.length);
				selectedContent = allLines.slice(startLine, endLine).join("\n");
				userLimitedLines = endLine - startLine;
			} else {
				selectedContent = allLines.slice(startLine).join("\n");
			}

			const { content: headText, ...truncation } = truncateHead(selectedContent);
			const diagnostics: ToolDiagnostic[] = [];
			let outputText = headText;
			let details: ReadToolDetails | undefined;
			if (truncation.firstLineExceedsLimit) {
				// Show the start of the line, cut at the byte limit on a character boundary.
				const lineBytes = new TextEncoder().encode(allLines[startLine]);
				const end = characterEnd(lineBytes, DEFAULT_MAX_BYTES);
				outputText = new TextDecoder().decode(lineBytes.subarray(0, end));
				diagnostics.push({
					severity: "warn",
					code: "truncated",
					message: `Line ${startLineDisplay} is ${formatSize(lineBytes.byteLength)}, exceeds the ${formatSize(DEFAULT_MAX_BYTES)} limit; showing its first ${formatSize(end)}. Use bash: sed -n '${startLineDisplay}p' ${path} | tail -c +${end + 1}`,
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
			} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
				const remaining = allLines.length - (startLine + userLimitedLines);
				const nextOffset = startLine + userLimitedLines + 1;
				diagnostics.push({
					severity: "info",
					message: `${remaining} more lines in file. Use offset=${nextOffset} to continue.`,
				});
			}

			return {
				content: outputText === "" ? [] : [{ type: "text", text: outputText }],
				...(details === undefined ? {} : { details }),
				diagnostics,
			};
		},
	});
}
