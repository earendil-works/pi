import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSize, truncateHead, truncateTail, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

const MAX_BYTES = 64 * 1024;
const MAX_LINES = 2000;

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event) => {
		const textParts = event.content.filter((part): part is TextContent => part.type === "text");
		const fullOutput = textParts.map((part) => part.text).join("\n\n");
		const totalBytes = Buffer.byteLength(fullOutput, "utf-8");
		const totalLines = countLines(fullOutput);

		if (fullOutput.length === 0 || (totalBytes <= MAX_BYTES && totalLines <= MAX_LINES)) {
			return;
		}

		const tempDir = await mkdtemp(join(tmpdir(), "pi-tool-output-"));
		const fullOutputPath = join(tempDir, "output.txt");
		await withFileMutationQueue(fullOutputPath, async () => {
			await writeFile(fullOutputPath, fullOutput, "utf8");
		});

		const preview = createHeadTailPreview(fullOutput);
		const imageParts = event.content.filter((part): part is ImageContent => part.type === "image");

		return {
			content: [
				{
					type: "text",
					text: `${preview}\n\n${formatTruncationNotice({ fullOutputPath, totalBytes, totalLines })}`,
				},
				...imageParts,
			],
			details: addTruncationDetails(event.details, {
				fullOutputPath,
				maxBytes: MAX_BYTES,
				maxLines: MAX_LINES,
				totalBytes,
				totalLines,
			}),
		};
	});
}

function createHeadTailPreview(fullOutput: string) {
	const previewOptions = {
		maxBytes: Math.floor(MAX_BYTES / 2),
		maxLines: Math.floor(MAX_LINES / 2),
	};
	const head = truncateHead(fullOutput, previewOptions);
	const tail = truncateTail(fullOutput, previewOptions);
	const omittedLines = Math.max(0, head.totalLines - head.outputLines - tail.outputLines);
	const omittedBytes = Math.max(0, head.totalBytes - head.outputBytes - tail.outputBytes);

	return [
		head.content,
		`[Tool output truncated: omitted ${omittedLines} lines (${formatSize(omittedBytes)}).]`,
		tail.content,
	]
		.filter(Boolean)
		.join("\n\n");
}

function formatTruncationNotice({
	fullOutputPath,
	totalBytes,
	totalLines,
}: {
	fullOutputPath: string;
	totalBytes: number;
	totalLines: number;
}) {
	return `[Full tool output saved to: ${fullOutputPath}. Original size: ${totalLines} lines (${formatSize(totalBytes)}). Use the read tool with offset/limit on that path if the omitted content matters.]`;
}

function addTruncationDetails(details: unknown, truncation: Record<string, unknown>) {
	const base = isRecord(details) ? details : { originalDetails: details };
	return {
		...base,
		piToolResultTruncation: truncation,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countLines(content: string) {
	if (content.length === 0) {
		return 0;
	}
	return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
}
