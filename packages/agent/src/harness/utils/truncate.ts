/**
 * 工具输出的共享截断工具函数。
 *
 * 截断基于两个独立的限制——以先触发者为准：
 * - 行数限制（默认：2000 行）
 * - 字节数限制（默认：50KB）
 *
 * 从不返回不完整的行（bash 尾部截断边缘情况除外）。
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
export const GREP_MAX_LINE_LENGTH = 500; // grep 匹配行的最大字符数

export interface TruncationResult {
	/** 截断后的内容 */
	content: string;
	/** 是否发生了截断 */
	truncated: boolean;
	/** 触发截断的限制："lines"（行数）、"bytes"（字节数），未截断时为 null */
	truncatedBy: "lines" | "bytes" | null;
	/** 原始内容的总行数 */
	totalLines: number;
	/** 原始内容的总字节数 */
	totalBytes: number;
	/** 截断输出中的完整行数 */
	outputLines: number;
	/** 截断输出的字节数 */
	outputBytes: number;
	/** 最后一行是否被部分截断（仅尾部截断边缘情况） */
	lastLinePartial: boolean;
	/** 第一行是否超过字节限制（用于头部截断） */
	firstLineExceedsLimit: boolean;
	/** 应用的最大行数限制 */
	maxLines: number;
	/** 应用的最大字节数限制 */
	maxBytes: number;
}

export interface TruncationOptions {
	/** 最大行数（默认：2000） */
	maxLines?: number;
	/** 最大字节数（默认：50KB） */
	maxBytes?: number;
}

interface RuntimeBuffer {
	byteLength(content: string, encoding: "utf8"): number;
}

const runtimeBuffer = (globalThis as { Buffer?: RuntimeBuffer }).Buffer;
const nonAsciiPattern = /[^\x00-\x7f]/;

function utf8ByteLength(content: string): number {
	if (runtimeBuffer) return runtimeBuffer.byteLength(content, "utf8");

	const firstNonAscii = content.search(nonAsciiPattern);
	if (firstNonAscii === -1) return content.length;

	let bytes = firstNonAscii;
	for (let i = firstNonAscii; i < content.length; i++) {
		const code = content.charCodeAt(i);
		if (code <= 0x7f) {
			bytes += 1;
		} else if (code <= 0x7ff) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff && i + 1 < content.length) {
			const next = content.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				i++;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines;
}

function replaceUnpairedSurrogates(content: string): string {
	let output = "";
	for (let i = 0; i < content.length; i++) {
		const code = content.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			if (i + 1 < content.length) {
				const next = content.charCodeAt(i + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					output += content[i] + content[i + 1];
					i++;
					continue;
				}
			}
			output += "�";
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			output += "�";
		} else {
			output += content[i];
		}
	}
	return output;
}

/**
 * 将字节数格式化为人类可读的大小。
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}

/**
 * 从头部截断内容（保留前 N 行/字节）。
 * 适用于需要查看开头的文件读取场景。
 *
 * 从不返回不完整的行。如果第一行就超过字节限制，
 * 则返回空内容并将 firstLineExceedsLimit 设为 true。
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = utf8ByteLength(content);
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	// 检查是否不需要截断
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// 检查第一行是否单独就超过字节限制
	const firstLineBytes = utf8ByteLength(lines[0]);
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	// 收集能容纳的完整行
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		const lineBytes = utf8ByteLength(line) + (i > 0 ? 1 : 0); // +1 表示换行符

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	// 如果是因行数限制而退出的
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = utf8ByteLength(outputContent);

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * 从尾部截断内容（保留最后 N 行/字节）。
 * 适用于需要查看末尾（错误信息、最终结果）的 bash 输出场景。
 *
 * 如果原始内容的最后一行超过字节限制，可能返回不完整的第一行。
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = utf8ByteLength(content);
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	// 检查是否不需要截断
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// 从末尾反向遍历
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const line = lines[i];
		const lineBytes = utf8ByteLength(line) + (outputLinesArr.length > 0 ? 1 : 0); // +1 表示换行符

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// 边缘情况：如果还没有添加任何行且该行超过 maxBytes，
			// 则截取行的末尾部分（不完整）
			if (outputLinesArr.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLinesArr.unshift(truncatedLine);
				outputBytesCount = utf8ByteLength(truncatedLine);
				lastLinePartial = true;
			}
			break;
		}

		outputLinesArr.unshift(line);
		outputBytesCount += lineBytes;
	}

	// 如果是因行数限制而退出的
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = utf8ByteLength(outputContent);

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * 从末尾截断字符串以适应字节限制。
 * 正确处理多字节 UTF-8 字符。
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";

	let outputBytes = 0;
	let start = str.length;
	let needsReplacement = false;
	for (let i = str.length; i > 0; ) {
		let characterStart = i - 1;
		const code = str.charCodeAt(characterStart);
		let characterBytes: number;
		let unpairedSurrogate = false;
		if (code >= 0xdc00 && code <= 0xdfff && characterStart > 0) {
			const previous = str.charCodeAt(characterStart - 1);
			if (previous >= 0xd800 && previous <= 0xdbff) {
				characterStart--;
				characterBytes = 4;
			} else {
				characterBytes = 3;
				unpairedSurrogate = true;
			}
		} else if (code >= 0xd800 && code <= 0xdfff) {
			characterBytes = 3;
			unpairedSurrogate = true;
		} else {
			characterBytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
		}
		if (outputBytes + characterBytes > maxBytes) break;
		outputBytes += characterBytes;
		start = characterStart;
		needsReplacement ||= unpairedSurrogate;
		i = characterStart;
	}

	const output = str.slice(start);
	return needsReplacement ? replaceUnpairedSurrogates(output) : output;
}

/**
 * 将单行截断到最大字符数，并添加 [truncated] 后缀。
 * 用于 grep 匹配行。
 */
export function truncateLine(
	line: string,
	maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
