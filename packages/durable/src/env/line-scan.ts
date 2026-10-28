import { rangeDecoder, startsWithBom } from "./decode.ts";
import type { LineScan } from "./index.ts";

const NEWLINE = 0x0a;
const encoder = new TextEncoder();

/** UTF-8 byte length of decoded text. */
function decodedBytes(text: string): number {
	return text === "" ? 0 : encoder.encode(text).length;
}

/**
 * Computes a `LineScan` from a file's bytes fed in order, so an environment can scan any size in bounded memory. Decoded
 * sizes use the same streaming WHATWG decoder as decoding the whole file at once.
 */
export class LineScanner {
	readonly #startLine: number;
	readonly #endLine: number;
	#position = 0;
	#newlines = 0;
	#lineStart = 0;
	#start: number | undefined;
	#end: number | undefined;
	#firstLineEnd: number | undefined;
	#lastLineStart: number | undefined;
	#selectedBytes = 0;
	#firstLineBytes = 0;
	#selection: InstanceType<typeof TextDecoder> | undefined;
	#firstLine: InstanceType<typeof TextDecoder> | undefined;
	/** The first bytes, held until it is known whether they are a byte-order mark. */
	#head: number[] | undefined = [];
	#bom = false;

	/** `startLine` and `endLine` must be non-negative integers with `endLine > startLine`; `endLine` absent: to the end. */
	constructor(startLine: number, endLine = Number.POSITIVE_INFINITY) {
		if (!Number.isSafeInteger(startLine) || startLine < 0 || !(endLine > startLine)) {
			throw new RangeError("Invalid line range");
		}
		if (endLine !== Number.POSITIVE_INFINITY && !Number.isSafeInteger(endLine))
			throw new RangeError("Invalid line range");
		this.#startLine = startLine;
		this.#endLine = endLine;
		if (startLine === 0) this.#begin(0);
	}

	push(chunk: Uint8Array): void {
		if (this.#head !== undefined) {
			const take = Math.min(3 - this.#head.length, chunk.length);
			this.#head.push(...chunk.subarray(0, take));
			if (this.#head.length < 3) return;
			this.#releaseHead();
			chunk = chunk.subarray(take);
		}
		this.#process(chunk);
	}

	#releaseHead(): void {
		const head = Uint8Array.from(this.#head ?? []);
		this.#head = undefined;
		this.#bom = startsWithBom(head);
		this.#process(head);
	}

	#process(chunk: Uint8Array): void {
		const base = this.#position;
		let from = 0;
		for (let index = chunk.indexOf(NEWLINE); index !== -1; index = chunk.indexOf(NEWLINE, index + 1)) {
			// The newline ends line `this.#newlines`. It belongs to the selection between selected lines only.
			this.#feed(chunk, base, from, index);
			const line = this.#newlines;
			const position = base + index;
			if (line === this.#startLine) this.#endFirstLine(position);
			if (line === this.#endLine - 1) this.#endSelection(position);
			this.#feed(chunk, base, index, index + 1);
			from = index + 1;
			this.#newlines++;
			this.#lineStart = position + 1;
			if (this.#newlines === this.#startLine) this.#begin(this.#lineStart);
			if (this.#newlines === this.#endLine - 1) this.#lastLineStart = this.#lineStart;
		}
		this.#feed(chunk, base, from, chunk.length);
		this.#position += chunk.length;
	}

	finish(): LineScan {
		if (this.#head !== undefined) this.#releaseHead();
		const size = this.#position;
		if (this.#start === undefined) {
			return {
				newlines: this.#newlines,
				start: size,
				end: size,
				firstLineEnd: size,
				lastLineStart: size,
				selectedBytes: 0,
				firstLineBytes: 0,
			};
		}
		if (this.#firstLineEnd === undefined) this.#endFirstLine(size);
		if (this.#end === undefined) this.#endSelection(size);
		return {
			newlines: this.#newlines,
			start: this.#start,
			end: this.#end ?? size,
			firstLineEnd: this.#firstLineEnd ?? size,
			// A selection that reaches past the last line ends with the last line.
			lastLineStart: this.#lastLineStart ?? this.#lineStart,
			selectedBytes: this.#selectedBytes,
			firstLineBytes: this.#firstLineBytes,
		};
	}

	#begin(start: number): void {
		this.#start = start;
		if (this.#startLine === this.#endLine - 1) this.#lastLineStart = start;
		this.#selection = rangeDecoder();
		this.#firstLine = rangeDecoder();
	}

	#endFirstLine(position: number): void {
		this.#firstLineEnd = position;
		if (this.#firstLine !== undefined) this.#firstLineBytes += decodedBytes(this.#firstLine.decode());
		this.#firstLine = undefined;
	}

	#endSelection(position: number): void {
		this.#end = position;
		if (this.#selection !== undefined) this.#selectedBytes += decodedBytes(this.#selection.decode());
		this.#selection = undefined;
	}

	/** Feed `chunk[from, to)`, which starts at file offset `base`, to the decoders of the ranges still open. */
	#feed(chunk: Uint8Array, base: number, from: number, to: number): void {
		// Decoding the whole file drops a leading byte-order mark.
		if (this.#bom && base + from < 3) from = Math.min(to, 3 - base);
		if (to <= from) return;
		const bytes = chunk.subarray(from, to);
		if (this.#selection !== undefined) {
			this.#selectedBytes += decodedBytes(this.#selection.decode(bytes, { stream: true }));
		}
		if (this.#firstLine !== undefined) {
			this.#firstLineBytes += decodedBytes(this.#firstLine.decode(bytes, { stream: true }));
		}
	}
}
