import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { computeLineHash } from "./hashline.js";

export interface ReadTextFileForToolOptions {
	/** 1-indexed line number to start reading from */
	offset?: number;
	/** max number of lines to return (if undefined, defaultLimit is used) */
	limit?: number;
	defaultLimit: number;
	maxLineLength: number;
	signal?: AbortSignal;
	/** Format output with hashlines (LINE:HASH|CONTENT) */
	hashlines?: boolean;
}

/**
 * Stream a UTF-8 text file and return an output string that matches the historical
 * `readFile(...).split("\n")` semantics used by the Read tool:
 * - Splits ONLY on `\n` (preserves `\r` if present)
 * - Always returns at least 1 line for empty files
 * - Preserves a trailing empty line when the file ends with `\n`
 */
export async function readTextFileForTool(path: string, options: ReadTextFileForToolOptions): Promise<string> {
	const { offset, limit, defaultLimit, maxLineLength, signal } = options;

	const startLine = offset ? Math.max(0, offset - 1) : 0; // 1-indexed -> 0-indexed
	// Match historical behavior: `limit || MAX_LINES` (so limit=0 behaves like "unset")
	const maxLines = limit || defaultLimit;
	const endLineExclusive = startLine + maxLines;

	const selectedLines: string[] = [];
	const selectedLineNumbers: number[] = []; // Track absolute line numbers
	let hadTruncatedLines = false;
	let totalLines = 0;

	const decoder = new StringDecoder("utf8");
	let remainder = "";

	const handleLine = (line: string): void => {
		const lineIndex = totalLines;
		totalLines++;

		if (lineIndex < startLine) {
			return;
		}
		if (lineIndex >= endLineExclusive) {
			return;
		}

		selectedLineNumbers.push(lineIndex + 1); // 1-indexed absolute line number
		if (line.length > maxLineLength) {
			hadTruncatedLines = true;
			selectedLines.push(line.slice(0, maxLineLength));
			return;
		}
		selectedLines.push(line);
	};

	await new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}

		const stream = fs.createReadStream(path);
		let aborted = false;

		const onAbort = () => {
			aborted = true;
			stream.destroy(new Error("Operation aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		stream.on("data", (chunk) => {
			if (aborted) return;
			const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
			remainder += decoder.write(buf);
			const parts = remainder.split("\n");
			remainder = parts.pop() ?? "";
			for (const part of parts) {
				handleLine(part);
			}
		});

		stream.on("end", () => {
			if (aborted) return;
			remainder += decoder.end();
			// Match `split("\n")`: always process the final segment, even if empty.
			handleLine(remainder);
			signal?.removeEventListener("abort", onAbort);
			resolve();
		});

		stream.on("error", (err) => {
			signal?.removeEventListener("abort", onAbort);
			reject(err);
		});
	});

	// Match historical out-of-bounds behavior
	if (startLine >= totalLines) {
		throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines total)`);
	}

	const effectiveEndLineExclusive = Math.min(endLineExclusive, totalLines);
	const remaining = Math.max(0, totalLines - effectiveEndLineExclusive);

	let outputText: string;

	if (options.hashlines) {
		// Format with hashlines: LINE:HASH|CONTENT
		outputText = selectedLines
			.map((line, i) => {
				const lineNum = selectedLineNumbers[i];
				const hash = computeLineHash(lineNum, line);
				return `${lineNum}:${hash}|${line}`;
			})
			.join("\n");
	} else {
		outputText = selectedLines.join("\n");
	}

	const notices: string[] = [];
	if (hadTruncatedLines) {
		notices.push(`Some lines were truncated to ${maxLineLength} characters for display`);
	}
	if (remaining > 0) {
		notices.push(
			`${remaining} more lines not shown. Use offset=${effectiveEndLineExclusive + 1} to continue reading`,
		);
	}
	if (notices.length > 0) {
		outputText += `\n\n... (${notices.join(". ")})`;
	}

	return outputText;
}
