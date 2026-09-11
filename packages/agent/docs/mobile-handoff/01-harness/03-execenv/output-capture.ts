import type { Context } from "../context.ts";
import type { CaptureOptions, CapturedOutput, ShellOutputUpdate, ShellStream } from "../types.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateHead,
	truncateTail,
	utf8ByteLength,
} from "./truncate.ts";

/**
 * Bounded capture for a Shell implementation.
 *
 * Owns the two-stage structure that `shell-output.ts` had inside `bash.ts`: a raw
 * buffer trimmed to `maxBytes * 2` as a memory guard, and a retained view
 * computed from it per snapshot. `truncateTail` is line-aware — it walks
 * backwards line by line and takes a partial only when one line alone exceeds the
 * cap — so eviction is not byte arithmetic and cannot be done incrementally.
 *
 * Emits the three update kinds from `executionenv.md` §4 and enforces the
 * ordering invariant: once the cap is crossed, a `chunk` never follows without an
 * intervening `snapshot`.
 */
export class OutputCapture {
	readonly #maxBytes: number;
	readonly #maxLines: number;
	readonly #retain: "head" | "tail";
	readonly #intervalMs: number;
	readonly #onUpdate?: (update: ShellOutputUpdate, context: Context) => void;

	/** Raw rolling buffer, held at twice the cap. */
	#buffer = "";
	/** Everything ever produced. */
	#totalBytes = 0;
	/** Newlines seen. A trailing partial line is counted separately — a command
	 * emitting one 60 KB line with no newline has produced one line, not zero. */
	#newlines = 0;
	#endsWithNewline = true;
	/** True once the retained view has begun evicting (tail) or filled (head). */
	#crossed = false;
	/** Pending chunks for the current coalescing window. */
	#pending: { stream: ShellStream; text: string }[] = [];
	#lastFlush = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#spillPath: string | undefined;

	constructor(
		options: CaptureOptions | undefined,
		onUpdate: ((update: ShellOutputUpdate, context: Context) => void) | undefined,
	) {
		this.#maxBytes = options?.limits.maxBytes ?? DEFAULT_MAX_BYTES;
		this.#maxLines = options?.limits.maxLines ?? DEFAULT_MAX_LINES;
		this.#retain = options?.limits.retain ?? "tail";
		this.#intervalMs = options?.intervalMs ?? 0;
		this.#onUpdate = onUpdate;
	}

	push(stream: ShellStream, text: string, context: Context): void {
		if (text === "") return;
		this.#totalBytes += utf8ByteLength(text);
		this.#newlines += countNewlines(text);
		this.#endsWithNewline = text.endsWith("\n");
		this.#buffer += text;

		// Memory guard. The retained view is computed from this, never equal to it.
		const guard = this.#maxBytes * 2;
		if (utf8ByteLength(this.#buffer) > guard) {
			this.#buffer = trimToLastBytes(this.#buffer, guard);
		}

		this.#pending.push({ stream, text });
		this.#schedule(context);
	}

	setSpillPath(path: string | undefined): void {
		this.#spillPath = path;
	}

	/** The bounded view, recomputed from the raw buffer. */
	snapshot(): CapturedOutput {
		const truncation =
			this.#retain === "head"
				? truncateHead(this.#buffer, { maxBytes: this.#maxBytes, maxLines: this.#maxLines })
				: truncateTail(this.#buffer, { maxBytes: this.#maxBytes, maxLines: this.#maxLines });
		// The buffer already lost its front, so totals come from counters rather
		// than from what survives.
		const totalLines = this.#totalLines();
		const truncated = this.#totalBytes > this.#maxBytes || totalLines > this.#maxLines;
		return {
			text: truncation.content,
			truncation: {
				...truncation,
				lastLinePartial: truncation.lastLinePartial,
				truncated,
				truncatedBy: truncated ? (totalLines > this.#maxLines ? "lines" : "bytes") : null,
				totalBytes: this.#totalBytes,
				totalLines,
			},
			...(this.#spillPath === undefined ? {} : { spillPath: this.#spillPath }),
			...(truncation.lastLinePartial ? { lastLineBytes: this.#lastLineBytes() } : {}),
		};
	}

	#totalLines(): number {
		return this.#newlines + (this.#endsWithNewline || this.#totalBytes === 0 ? 0 : 1);
	}

	/** Bytes in the final line of the raw buffer, for the single-oversized-line case. */
	#lastLineBytes(): number {
		const start = this.#buffer.lastIndexOf("\n");
		return utf8ByteLength(start === -1 ? this.#buffer : this.#buffer.slice(start + 1));
	}

	#schedule(context: Context): void {
		if (this.#onUpdate === undefined) return;
		if (this.#intervalMs === 0) {
			this.flush(context);
			return;
		}
		if (this.#timer !== undefined) return;
		const wait = Math.max(0, this.#lastFlush + this.#intervalMs - Date.now());
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.flush(context);
		}, wait);
	}

	/** Emit one update for everything buffered since the last flush. */
	flush(context: Context): void {
		if (this.#onUpdate === undefined) return;
		this.#lastFlush = Date.now();
		const pending = this.#pending;
		this.#pending = [];
		if (pending.length === 0) return;

		const nowCrossed = this.#totalBytes > this.#maxBytes || this.#totalLines() > this.#maxLines;

		if (this.#retain === "head") {
			// Head never evicts. Below the cap the appended text is complete; above
			// it, only totals move — resending maxBytes to change a number is the
			// thing `counters` exists to avoid.
			if (!nowCrossed) {
				this.#onUpdate({ kind: "chunk", stream: pending[0]!.stream, text: joined(pending) }, context);
			} else {
				this.#onUpdate({ kind: "counters", truncation: this.snapshot().truncation }, context);
			}
			this.#crossed = nowCrossed;
			return;
		}

		// Tail. Once the buffer is full every byte in evicts a byte out, so there is
		// no cheap-trickle regime past the cap: chunks until full, snapshots after.
		if (nowCrossed) {
			this.#crossed = true;
			this.#onUpdate({ kind: "snapshot", output: this.snapshot() }, context);
			return;
		}
		if (this.#crossed) {
			// Defensive: never let a chunk follow the crossing.
			this.#onUpdate({ kind: "snapshot", output: this.snapshot() }, context);
			return;
		}
		this.#onUpdate({ kind: "chunk", stream: pending[0]!.stream, text: joined(pending) }, context);
	}

	dispose(): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}

const joined = (pending: { text: string }[]): string => pending.map((p) => p.text).join("");

function countNewlines(text: string): number {
	let count = 0;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count++;
	return count;
}

/** Keep the last `bytes` UTF-8 bytes without splitting a codepoint. */
function trimToLastBytes(text: string, bytes: number): string {
	if (utf8ByteLength(text) <= bytes) return text;
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (utf8ByteLength(text.slice(mid)) > bytes) low = mid + 1;
		else high = mid;
	}
	return text.slice(low);
}

export type { TruncationResult };
