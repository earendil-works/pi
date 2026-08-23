import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Default cap for one line, in UTF-16 code units - the unit `String.length`
 * counts and the unit V8's maximum string length is expressed in.
 *
 * An `rg --json` event is NOT the size of the matched line. It is that line
 * JSON-escaped, plus one `submatches` entry per occurrence at roughly 53 code
 * units each, so the pattern - not the file - sets the size. Measured with
 * ripgrep 15.2.0 on one real 5,089,613-char single-line tracked source file:
 * `function` gives 5.8M, `"` gives 25,174,363 (363,263 submatches), and `.`
 * gives 274,009,937. So no cap can be above every legal query, and a cap
 * justified against a low-submatch pattern alone understates real traffic by
 * more than an order of magnitude.
 *
 * The default therefore has two jobs, and only the second is absolute:
 *
 * - Sit above ORDINARY output, so a normal grep never loses a match. Worst
 *   measured over a whole real tracked repository was 25.2M code units, so this
 *   default is ~2.7x above it.
 * - Sit below V8's maximum string length, 536,870,888 on this runtime, which is
 *   where the append throws and kills the process. This is 8x below it.
 *
 * A held line costs two bytes per code unit, so the cap bounds one line's
 * retention at ~128MB. That is a bound the uncapped append never had: it held
 * whatever arrived, up to the throw.
 */
export const DEFAULT_LINE_CAP_CHARS = 64 * 1024 * 1024;

/** Retained leading slice of a discarded line, for attribution and diagnostics. */
export const DEFAULT_OVERSIZE_PREFIX_CHARS = 64 * 1024;

export interface OversizedLine {
	/** Length of the discarded line in code units, terminator excluded, prefix included. */
	chars: number;
	/** Leading slice of the discarded line, capped at `prefixChars`. */
	prefix: string;
}

export interface CappedLineReaderOptions {
	/** Max code units held for one line. Default `DEFAULT_LINE_CAP_CHARS`. */
	capChars?: number;
	/** Code units retained from a discarded line. Default `DEFAULT_OVERSIZE_PREFIX_CHARS`. */
	prefixChars?: number;
	/** Called once per complete line that stayed under the cap. */
	onLine: (line: string) => void;
	/** Called once per discarded line, when its terminator arrives or the stream ends. */
	onOversize: (line: OversizedLine) => void;
}

export interface CappedLineReader {
	/** Stop reading. Safe to call more than once. */
	detach: () => void;
	/** Code units currently held. Never exceeds `capChars`, mid-oversized-line included. */
	readonly retainedChars: number;
}

/**
 * Read LF-delimited lines from a child process stream, discarding a line that
 * would grow past a cap.
 *
 * Not `node:readline`, for two reasons:
 *
 * - Readline grows its line buffer with an unbounded append and offers no line
 *   cap, so one oversized line throws `RangeError: Invalid string length` inside
 *   the stream's `data` handler. That throw is in the parent, not the child, and
 *   no caller-level `try` surrounds it, so it takes the whole process down.
 * - Readline also splits on U+2028 and U+2029, which are legal inside a JSON
 *   string. A `rg --json` event containing either is delivered as two fragments
 *   that both fail to parse, silently losing the match.
 *
 * A discarded line is a bad line, not a poisoned stream: framing resynchronises
 * at the next terminator, so reading continues.
 */
export function attachCappedLineReader(stream: Readable, options: CappedLineReaderOptions): CappedLineReader {
	const capChars = options.capChars ?? DEFAULT_LINE_CAP_CHARS;
	const prefixChars = Math.min(options.prefixChars ?? DEFAULT_OVERSIZE_PREFIX_CHARS, capChars);
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	// Non-null while a line is being discarded: its retained head, plus how many
	// code units have passed by since. The rest is never held.
	let discardPrefix: string | null = null;
	let discarded = 0;

	const emit = (line: string) => {
		options.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};

	// Take the head of a line that will not fit, without ever concatenating its tail.
	const startDiscard = (tail: string) => {
		const head =
			buffer.length >= prefixChars
				? buffer.slice(0, prefixChars)
				: buffer + tail.slice(0, prefixChars - buffer.length);
		discarded = buffer.length + tail.length - head.length;
		buffer = "";
		discardPrefix = head;
	};

	const finishDiscard = () => {
		const prefix = discardPrefix ?? "";
		discardPrefix = null;
		const chars = prefix.length + discarded;
		discarded = 0;
		options.onOversize({ chars, prefix });
	};

	const consume = (text: string) => {
		let rest = text;
		while (rest.length > 0) {
			const newlineIndex = rest.indexOf("\n");
			if (discardPrefix !== null) {
				if (newlineIndex === -1) {
					discarded += rest.length;
					return;
				}
				discarded += newlineIndex;
				finishDiscard();
				rest = rest.slice(newlineIndex + 1);
				continue;
			}
			if (newlineIndex === -1) {
				// Held across chunks. The cap is checked before the append, so the
				// append that would throw never runs.
				if (buffer.length + rest.length > capChars) {
					startDiscard(rest);
					return;
				}
				buffer += rest;
				return;
			}
			const lineTail = rest.slice(0, newlineIndex);
			// Also checked here: one chunk can carry a whole oversized line plus its
			// terminator, which the buffered path above never sees.
			if (buffer.length + lineTail.length > capChars) {
				startDiscard(lineTail);
				finishDiscard();
			} else {
				emit(buffer + lineTail);
				buffer = "";
			}
			rest = rest.slice(newlineIndex + 1);
		}
	};

	const onData = (chunk: string | Buffer) => {
		consume(typeof chunk === "string" ? chunk : decoder.write(chunk));
	};

	const onEnd = () => {
		consume(decoder.end());
		if (discardPrefix !== null) {
			finishDiscard();
			return;
		}
		if (buffer.length > 0) {
			emit(buffer);
			buffer = "";
		}
	};

	stream.on("data", onData);
	stream.on("end", onEnd);

	return {
		detach: () => {
			stream.off("data", onData);
			stream.off("end", onEnd);
		},
		get retainedChars() {
			return buffer.length + (discardPrefix?.length ?? 0);
		},
	};
}
