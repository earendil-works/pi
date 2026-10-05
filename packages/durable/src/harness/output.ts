import type { ShellOutputSkip } from "../env/index.ts";
import { utf8ByteLength } from "../truncate.ts";

/** Retention limits of one tool's output. */
export type OutputLimits = { readonly maxBytes: number; readonly maxLines: number; readonly retain: "head" | "tail" };

/** Retained output and what the limits dropped. */
export type BoundedOutput = { readonly text: string; readonly droppedBytes: number; readonly droppedLines: number };

/** An exact slice of the input within the limits, and what it left out. */
export type OutputSlice = {
	readonly text: string;
	readonly bytes: number;
	readonly droppedBytes: number;
	readonly droppedLines: number;
};

const NEWLINE = 0x0a;
const INVALID_OUTPUT = /[\x00-\x08\x0b-\x1f\ufff9-\ufffb]/g;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Remove control characters that break display and transcripts; tabs and newlines stay. */
export function sanitizeOutput(text: string): string {
	return text.replace(INVALID_OUTPUT, "");
}

/**
 * Bound `text` to whole lines within the limits: the first lines for `head`, the last lines for `tail`. The result is an
 * exact slice, trailing newline included. A single line longer than `maxBytes` is cut at the byte limit on a character
 * boundary.
 */
export function boundOutput(text: string, limits: OutputLimits): OutputSlice {
	const bytes = encoder.encode(text);
	const [from, to] = limits.retain === "head" ? headRange(bytes, limits) : tailRange(bytes, limits);
	const kept = bytes.subarray(from, to);
	return {
		text: kept.length === bytes.length ? text : decoder.decode(kept),
		bytes: kept.length,
		droppedBytes: bytes.length - kept.length,
		droppedLines: lineCount(bytes) - lineCount(kept),
	};
}

function headRange(bytes: Uint8Array, limits: OutputLimits): [number, number] {
	if (limits.maxLines === 0 || limits.maxBytes === 0) return [0, 0];
	let end = bytes.length;
	let lines = 0;
	for (let index = bytes.indexOf(NEWLINE); index !== -1; index = bytes.indexOf(NEWLINE, index + 1)) {
		if (++lines === limits.maxLines) {
			end = index + 1;
			break;
		}
	}
	if (end > limits.maxBytes) {
		const newline = bytes.lastIndexOf(NEWLINE, limits.maxBytes - 1);
		end = newline === -1 ? characterEnd(bytes, limits.maxBytes) : newline + 1;
	}
	return [0, end];
}

function tailRange(bytes: Uint8Array, limits: OutputLimits): [number, number] {
	if (limits.maxLines === 0 || limits.maxBytes === 0) return [bytes.length, bytes.length];
	// A trailing newline ends the last line rather than starting another.
	const last = bytes[bytes.length - 1] === NEWLINE ? bytes.length - 2 : bytes.length - 1;
	let start = 0;
	let lines = 1;
	for (let index = last < 0 ? -1 : bytes.lastIndexOf(NEWLINE, last); index !== -1; ) {
		if (lines === limits.maxLines) {
			start = index + 1;
			break;
		}
		lines++;
		index = index === 0 ? -1 : bytes.lastIndexOf(NEWLINE, index - 1);
	}
	if (bytes.length - start > limits.maxBytes) {
		const from = bytes.length - limits.maxBytes;
		const newline = bytes.indexOf(NEWLINE, from - 1);
		// The first line starting inside the byte window, or a cut of the last line when it alone is too long.
		start = newline !== -1 && newline + 1 < bytes.length ? newline + 1 : characterStart(bytes, from);
	}
	return [start, bytes.length];
}

/** The last character boundary at or before `index`. */
export function characterEnd(bytes: Uint8Array, index: number): number {
	let end = index;
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return end;
}

/** The first character boundary at or after `index`. */
function characterStart(bytes: Uint8Array, index: number): number {
	let start = index;
	while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
	return start;
}

function lineCount(bytes: Uint8Array): number {
	if (bytes.length === 0) return 0;
	let newlines = 0;
	for (let index = bytes.indexOf(NEWLINE); index !== -1; index = bytes.indexOf(NEWLINE, index + 1)) newlines++;
	return newlines + (bytes[bytes.length - 1] === NEWLINE ? 0 : 1);
}

/**
 * Bounded running output of one tool call. Accepting a chunk costs time proportional to the chunk: head retention stops
 * storing once the window is full, and tail retention drops stored text the window no longer needs when it snapshots.
 * Counts of the whole stream are kept so the dropped totals stay exact.
 */
export class OutputBuffer {
	readonly #limits: OutputLimits;
	readonly #decoder = new TextDecoder();
	/** Stored chunks: for head the start of the stream, for tail a suffix that still contains the next window. */
	#chunks: { readonly text: string; readonly bytes: number; readonly newlines: number }[] = [];
	#storedBytes = 0;
	#storedNewlines = 0;
	#full = false;
	#totalBytes = 0;
	#totalNewlines = 0;
	#endsWithNewline = true;

	constructor(limits: OutputLimits) {
		this.#limits = limits;
	}

	/** Bytes currently held; bounded by the limits plus one chunk. */
	get storedBytes(): number {
		return this.#storedBytes;
	}

	/**
	 * Accept a chunk; returns whether anything was accepted. `skipped` is output omitted right before the chunk, which
	 * must be more than the tail window by at least one byte or line (`ShellOutputInfo.skipped`); only tail retention
	 * accepts it.
	 */
	push(chunk: string | Uint8Array, skipped?: ShellOutputSkip): boolean {
		// Bytes of an incomplete character from an earlier byte chunk come first.
		const pending = typeof chunk === "string" || skipped !== undefined ? this.#decoder.decode() : "";
		const text = typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
		if (skipped === undefined) return this.#accept(pending + text);
		if (this.#limits.retain !== "tail") throw new Error("Skipped output requires tail retention");
		this.#accept(pending);
		this.#skip(skipped);
		this.#accept(text);
		return true;
	}

	/** Count omitted output; nothing stored before it can be in the window once the text after it arrives. */
	#skip(skipped: ShellOutputSkip): void {
		if (skipped.bytes === 0) return;
		this.#totalBytes += skipped.bytes;
		this.#totalNewlines += skipped.newlines;
		this.#endsWithNewline = skipped.endsWithNewline;
		this.#chunks = [];
		this.#storedBytes = 0;
		this.#storedNewlines = 0;
	}

	/** Flush an incomplete trailing character as a replacement character; call when the stream ends. */
	end(): void {
		this.#accept(this.#decoder.decode());
	}

	#accept(text: string): boolean {
		if (text.length === 0) return false;
		const bytes = utf8ByteLength(text);
		const newlines = countNewlines(text);
		this.#totalBytes += bytes;
		this.#totalNewlines += newlines;
		this.#endsWithNewline = text.endsWith("\n");
		if (this.#full) return true;
		this.#chunks.push({ text, bytes, newlines });
		this.#storedBytes += bytes;
		this.#storedNewlines += newlines;
		if (this.#limits.retain === "head") {
			// Nothing past a full window is ever needed.
			this.#full = this.#storedBytes > this.#limits.maxBytes || this.#storedNewlines >= this.#limits.maxLines;
			return true;
		}
		// Drop leading chunks while the rest still holds more than a window: more than `maxBytes` bytes or `maxLines`
		// newlines, plus one, so the window's line start can still be found. Each chunk is dropped once.
		while (this.#chunks.length > 1) {
			const first = this.#chunks[0]!;
			const bytesAfter = this.#storedBytes - first.bytes;
			const newlinesAfter = this.#storedNewlines - first.newlines;
			if (bytesAfter <= this.#limits.maxBytes + 1 && newlinesAfter <= this.#limits.maxLines + 1) break;
			this.#chunks.shift();
			this.#storedBytes = bytesAfter;
			this.#storedNewlines = newlinesAfter;
		}
		return true;
	}

	/** Retained, sanitized output and what the limits dropped from the whole stream. */
	snapshot(): BoundedOutput {
		const stored =
			this.#chunks.length === 1 ? this.#chunks[0]!.text : this.#chunks.map((chunk) => chunk.text).join("");
		const kept = boundOutput(stored, this.#limits);
		const storedLines = lines(this.#storedNewlines, stored === "" || stored.endsWith("\n"));
		const keptLines = storedLines - kept.droppedLines;
		// Tail windows never reach back before this one, but finding a later window's first line needs what precedes it:
		// keep the shortest suffix longer than the window by a byte or a line, as `#accept` does.
		if (this.#limits.retain === "tail" || this.#chunks.length > 1) {
			const text = this.#limits.retain === "tail" ? tailMargin(stored, this.#limits) : stored;
			const bytes = this.#limits.retain === "tail" ? utf8ByteLength(text) : this.#storedBytes;
			this.#chunks = text === "" ? [] : [{ text, bytes, newlines: countNewlines(text) }];
			this.#storedBytes = bytes;
			this.#storedNewlines = this.#chunks[0]?.newlines ?? 0;
		}
		return {
			text: sanitizeOutput(kept.text),
			droppedBytes: this.#totalBytes - kept.bytes,
			droppedLines: lines(this.#totalNewlines, this.#endsWithNewline) - keptLines,
		};
	}
}

/**
 * The shortest suffix of `text` with more than `maxBytes` bytes or more than `maxLines` newlines, or all of it. The
 * tail window of any text that ends with this suffix, followed by anything, is the same as of `text` followed by it.
 */
function tailMargin(text: string, limits: OutputLimits): string {
	const bytes = encoder.encode(text);
	const byteStart = bytes.length > limits.maxBytes ? characterEnd(bytes, bytes.length - limits.maxBytes - 1) : 0;
	let lineStart = 0;
	let newlines = 0;
	for (let index = bytes.lastIndexOf(NEWLINE); index !== -1; index = bytes.lastIndexOf(NEWLINE, index - 1)) {
		if (++newlines > limits.maxLines) {
			lineStart = index;
			break;
		}
		if (index === 0) break;
	}
	const start = Math.max(byteStart, lineStart);
	return start === 0 ? text : decoder.decode(bytes.subarray(start));
}

/** Lines of text with `newlines` newlines; a final unterminated line counts. */
function lines(newlines: number, terminated: boolean): number {
	return newlines + (terminated ? 0 : 1);
}

function countNewlines(text: string): number {
	let count = 0;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count++;
	return count;
}

/** Each progress commit also buys a pause proportional to what it wrote. */
export const PROGRESS_BYTES_PER_SECOND = 100 * 1024;

/**
 * Adaptive progress commits: the first change after an idle period commits at once; each commit then delays the next
 * by at least `minIntervalMs` and by its written size at 100 KiB/s. At most one commit is in flight; changes made
 * meanwhile coalesce into the next one.
 */
export class Progress {
	readonly #write: () => Promise<number>;
	readonly #onError: (error: unknown) => void;
	readonly #minIntervalMs: number;
	#waiters: PromiseWithResolvers<void>[] = [];
	#timer: ReturnType<typeof setTimeout> | undefined;
	#inFlight: Promise<void> | undefined;
	#nextAt = 0;
	#dirty = false;
	#stopped = false;

	constructor(write: () => Promise<number>, onError: (error: unknown) => void, minIntervalMs: number) {
		this.#write = write;
		this.#onError = onError;
		this.#minIntervalMs = minIntervalMs;
	}

	/** Schedule a commit. */
	mark(): void {
		this.#dirty = true;
		this.#schedule();
	}

	/** Schedule a commit; the promise settles with the commit that includes this change. */
	markAndWait(): Promise<void> {
		const waiter = Promise.withResolvers<void>();
		this.#waiters.push(waiter);
		this.mark();
		return waiter.promise;
	}

	/** Stop committing and wait for the commit in flight; returns the waiters the final commit must settle. */
	async stop(): Promise<PromiseWithResolvers<void>[]> {
		this.#stopped = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		await this.#inFlight;
		return this.#waiters.splice(0);
	}

	#schedule(): void {
		if (this.#stopped || this.#timer !== undefined || this.#inFlight !== undefined) return;
		const wait = this.#nextAt - Date.now();
		if (wait <= 0) this.#flush();
		else
			this.#timer = setTimeout(() => {
				this.#timer = undefined;
				this.#flush();
			}, wait);
	}

	#flush(): void {
		if (this.#stopped || !this.#dirty) return;
		this.#dirty = false;
		const waiters = this.#waiters.splice(0);
		const started = Date.now();
		this.#inFlight = this.#write()
			.then(
				(bytes) => {
					this.#nextAt = started + Math.max(this.#minIntervalMs, (bytes * 1000) / PROGRESS_BYTES_PER_SECOND);
					for (const waiter of waiters) waiter.resolve();
				},
				(error: unknown) => {
					this.#nextAt = started + this.#minIntervalMs;
					for (const waiter of waiters) waiter.reject(error);
					this.#onError(error);
				},
			)
			.finally(() => {
				this.#inFlight = undefined;
				if (this.#dirty) this.#schedule();
			});
	}
}
