import { open } from "node:fs/promises";
import { createOutputFileStream, type OutputFileResult, type OutputFileStream } from "../../utils/output-files.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	/** Set once the full output goes to a file. While output streams in, `saved` means the file is being written. */
	fullOutputFile?: OutputFileResult;
}

export interface FullOutput {
	content: string;
	/** Whether `content` omits part of the output. */
	truncated: boolean;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;
	private readonly decoder = new TextDecoder();

	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private currentLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;

	private tempFile: OutputFileStream | undefined;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "pi-output";
	}

	append(data: Buffer): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		this.totalRawBytes += data.length;
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));

		if (this.tempFile || this.shouldUseTempFile()) {
			this.ensureTempFile().write(data);
		} else if (data.length > 0) {
			this.rawChunks.push(data);
		}
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.appendDecodedText(this.decoder.decode());
		if (this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const tailTruncation = truncateTail(this.getRetainedText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};

		if (options.persistIfTruncated && truncation.truncated) {
			this.ensureTempFile();
		}

		return { content: truncation.content, truncation, fullOutputFile: this.tempFile?.result };
	}

	/** Flush and close the temp file. Never rejects: a failed file shows up as `failed` in later snapshots. */
	async closeTempFile(): Promise<void> {
		await this.tempFile?.close();
	}

	/**
	 * The complete output, for callers that can take more than the display snapshot. Call after
	 * `finish()` and `closeTempFile()`. Output longer than `maxBytes` raw bytes keeps its first and
	 * last `maxBytes / 2` bytes around an omission marker. When the temp file could not be saved, only
	 * the retained tail is left: up to its last `maxBytes` bytes, behind the same marker when output is
	 * missing.
	 */
	async readFullOutput(maxBytes: number): Promise<FullOutput> {
		const fullOutputFile = this.tempFile?.result;
		if (!fullOutputFile) {
			return { content: new TextDecoder().decode(Buffer.concat(this.rawChunks)), truncated: false };
		}
		if (fullOutputFile.kind === "failed") {
			return this.readRetainedOutput(maxBytes);
		}
		const file = await open(fullOutputFile.path, "r");
		try {
			const size = (await file.stat()).size;
			if (size <= maxBytes) {
				return { content: new TextDecoder().decode(await file.readFile()), truncated: false };
			}
			const headBytes = Math.floor(maxBytes / 2);
			const tailBytes = maxBytes - headBytes;
			const head = Buffer.alloc(headBytes);
			const tail = Buffer.alloc(tailBytes);
			await file.read(head, 0, headBytes, 0);
			await file.read(tail, 0, tailBytes, size - tailBytes);
			// Cut at character boundaries: streaming decode holds back an incomplete trailing sequence,
			// and the tail skips leading continuation bytes.
			const headText = new TextDecoder().decode(head, { stream: true });
			let tailStart = 0;
			while (tailStart < tail.length && (tail[tailStart] & 0xc0) === 0x80) tailStart++;
			const tailText = new TextDecoder().decode(tail.subarray(tailStart));
			const omitted = size - headBytes - tailBytes;
			return { content: `${headText}\n\n[... ${omitted} bytes omitted ...]\n\n${tailText}`, truncated: true };
		} finally {
			await file.close();
		}
	}

	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) {
			this.trimTail();
		}

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += newlines;
			const tail = text.slice(lastNewline + 1);
			this.currentLineBytes = byteLength(tail);
			this.hasOpenLine = tail.length > 0;
		}
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	/**
	 * The retained tail, for display and as the fallback of `readFullOutput()`. Clipping drops the partial
	 * first line of the tail. When the tail is only the end of one over-long line (plus blank lines),
	 * nothing is left, so it keeps the end of that line instead.
	 */
	private getRetainedText(): string {
		const clippedText = this.getSnapshotText();
		return clippedText.trim().length === 0 ? this.tailText : clippedText;
	}

	/** The retained tail within `maxBytes`, marked as truncated only when output is missing. */
	private readRetainedOutput(maxBytes: number): FullOutput {
		let bytes = Buffer.from(this.getRetainedText(), "utf-8");
		if (bytes.length > maxBytes) {
			let start = bytes.length - maxBytes;
			while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
			bytes = bytes.subarray(start);
		}
		const tail = bytes.toString("utf-8");
		const omitted = this.totalDecodedBytes - bytes.length;
		if (omitted === 0) {
			return { content: tail, truncated: false };
		}
		return { content: `[... ${omitted} bytes omitted ...]\n\n${tail}`, truncated: true };
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	private ensureTempFile(): OutputFileStream {
		if (this.tempFile) {
			return this.tempFile;
		}
		const tempFile = createOutputFileStream(this.tempFilePrefix, ".log");
		this.tempFile = tempFile;
		for (const chunk of this.rawChunks) {
			tempFile.write(chunk);
		}
		this.rawChunks = [];
		return tempFile;
	}
}
