/**
 * The size limit of the model-facing text of MCP results. Longer text keeps its start and end with the
 * middle cut out, like Codex does, and the caller may save the full text where the model can read it.
 */

import type { LlmContent } from "./protocol/content.ts";

/** Model-facing text of an MCP result beyond this is cut in the middle. */
export const MCP_OUTPUT_MAX_BYTES = 20 * 1024;

/**
 * Saves data the model cannot get in full, such as the full text of a truncated result, and returns
 * where it was saved (a path the model can read). `extension` includes the dot, for example `.txt`.
 */
export type McpOutputSaver = (data: string | Uint8Array, extension: string) => Promise<string>;

/** Model-facing content within the limit, and where the full text went when it was saved. */
export interface LimitedMcpContent {
	content: LlmContent[];
	fullOutputPath?: string;
}

/**
 * Keep model-facing text within {@link MCP_OUTPUT_MAX_BYTES}. Longer text becomes one text block in
 * Codex's truncation format, followed by the path of the file with the full text when `saveOutput`
 * is given; images follow it. Content within the limit is returned as it is.
 */
export async function limitMcpContent(content: LlmContent[], saveOutput?: McpOutputSaver): Promise<LimitedMcpContent> {
	const combined = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const truncation = truncateMiddle(combined, MCP_OUTPUT_MAX_BYTES);
	if (!truncation) return { content };
	let fullOutputPath: string | undefined;
	let where = "";
	if (saveOutput) {
		try {
			fullOutputPath = await saveOutput(combined, ".txt");
			where = `\n\n[Full output: ${fullOutputPath} (read it with offset/limit)]`;
		} catch (error) {
			where = `\n\n[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
		}
	}
	const tokens = Math.ceil(truncation.totalBytes / 4);
	const text = `Warning: truncated output (original token count: ${tokens})\nTotal output lines: ${truncation.totalLines}\n\n${truncation.content}${where}`;
	return {
		content: [{ type: "text", text }, ...content.filter((block) => block.type === "image")],
		...(fullOutputPath ? { fullOutputPath } : {}),
	};
}

/** Text cut in the middle, with the size of the whole text. */
interface MiddleTruncation {
	/** The start and the end of the text with a `…N chars truncated…` marker between them. */
	content: string;
	totalBytes: number;
	totalLines: number;
}

/**
 * Keep the start and the end of `text`, half of `maxBytes` each, and replace the middle with a
 * `…N chars truncated…` marker. Cuts only at character boundaries. Undefined when `text` fits.
 */
function truncateMiddle(text: string, maxBytes: number): MiddleTruncation | undefined {
	const buf = Buffer.from(text, "utf-8");
	if (buf.length <= maxBytes) return undefined;
	// Continuation bytes (10xxxxxx) are not character starts.
	const isBoundary = (index: number) => index >= buf.length || (buf[index] & 0xc0) !== 0x80;
	let headEnd = Math.floor(maxBytes / 2);
	while (headEnd > 0 && !isBoundary(headEnd)) headEnd--;
	let tailStart = buf.length - (maxBytes - Math.floor(maxBytes / 2));
	while (tailStart < buf.length && !isBoundary(tailStart)) tailStart++;
	const head = buf.subarray(0, headEnd).toString("utf-8");
	const tail = buf.subarray(tailStart).toString("utf-8");
	const removedChars = Array.from(buf.subarray(headEnd, tailStart).toString("utf-8")).length;
	// A final newline ends the last line instead of starting another.
	const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
	return { content: `${head}…${removedChars} chars truncated…${tail}`, totalBytes: buf.length, totalLines: lines };
}
