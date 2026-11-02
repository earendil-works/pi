// Parts on links (R1, R2, Q2, §22): a value as it crosses a link (JSON text at its origin, its bytes once received, or
// deflated by its origin), the size limits per part, compression at the origin, and opening a part where it is owned:
// its size checked before anything is parsed or inflated, a deflated part inflated within the decoded limit.

import type { Context } from "../../context/index.ts";
import { ChordError } from "../data/index.ts";

/**
 * A part (R1): a value as JSON text at its origin (and after a text decode), its UTF-8 bytes once a binary codec
 * received it (or at an origin that encoded it already), or those bytes deflated by an origin that compresses. Opaque
 * on the way: only the end that owns it opens and parses it, while handling its message (a malformed part is a protocol
 * error then), so a relay forwards it unparsed and still deflated.
 */
export type Part = string | Uint8Array | DeflatedPart;

/** What inflating a deflated part gave: its JSON bytes, more than the decoded limit, or data that is no raw deflate. */
export type Inflated =
	| { readonly kind: "bytes"; readonly bytes: Uint8Array }
	| { readonly kind: "too_large" }
	| { readonly kind: "corrupt"; readonly error: unknown };

/**
 * A JSON part deflated (raw deflate) by its origin. A host without a synchronous compressor inflates it before its
 * owner handles the message (`inflateAsync`) and keeps the outcome here for the owner to open.
 */
export class DeflatedPart {
	readonly bytes: Uint8Array;
	/** The asynchronous inflate's outcome; `undefined` until one ran. */
	inflated: Inflated | undefined;

	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
	}
}

/**
 * A synchronous compressor (`createHost({ compression })`; `nodeCompression` for Node). `deflate` is raw deflate at
 * level 1. `inflate` gives at most `limit` bytes (`Infinity`: no limit; 0 allowed), `too_large` when the output would
 * be larger, `corrupt` for data that is no raw deflate stream.
 */
export interface Compression {
	deflate(bytes: Uint8Array): Uint8Array;
	inflate(bytes: Uint8Array, limit: number): Inflated;
}

/** A link's limits per part as `accept`, `connect` and `resolve` take them, in bytes. */
export type PartLimits = {
	/** A part's size on the wire. */
	readonly part?: number;
	/** A part's size after inflating it. */
	readonly decoded?: number;
};

/** A link's limits in force; `Infinity` for none. */
export type Limits = { readonly part: number; readonly decoded: number };

const MiB = 1024 * 1024;

/** The limits of untrusted links unless set (Q2); trusted links (IPC) have none. */
const UNTRUSTED: Limits = { part: 16 * MiB, decoded: 64 * MiB };

const NONE: Limits = { part: Number.POSITIVE_INFINITY, decoded: Number.POSITIVE_INFINITY };

/** The limits of a link: the ones set, the defaults of its trust for the others. */
export function linkLimits(trusted: boolean, limits: PartLimits = {}): Limits {
	const defaults = trusted ? NONE : UNTRUSTED;
	return { part: limits.part ?? defaults.part, decoded: limits.decoded ?? defaults.decoded };
}

/** JSON parts above this many UTF-8 bytes are compressed at their origin (a protocol constant). */
export const COMPRESS_ABOVE = 16 * 1024;

const UTF8 = new TextEncoder();

/**
 * A JSON part at its origin: deflated when the host compresses, its UTF-8 bytes are above `COMPRESS_ABOVE` and
 * deflating made it smaller; otherwise the text, or its bytes once they were encoded (never encoded twice). Counts one
 * deflate (`chord.link.deflates`).
 */
export function originPart(json: string, compression: Compression | undefined, context: Context): Part {
	// A UTF-16 unit is at most three UTF-8 bytes: a text this short is within the threshold without encoding it.
	if (compression === undefined || json.length * 3 <= COMPRESS_ABOVE) return json;
	const bytes = UTF8.encode(json);
	if (bytes.byteLength <= COMPRESS_ABOVE) return bytes;
	context.telemetry.metrics?.counter("chord.link.deflates").add(1);
	const deflated = compression.deflate(bytes);
	return deflated.byteLength < bytes.byteLength ? new DeflatedPart(deflated) : bytes;
}

/**
 * The `too_large/part` error of a part whose size on the wire (its UTF-8 bytes; a deflated part's deflated bytes) is
 * above `limit`; `undefined` within it. Nothing is parsed or inflated.
 */
export function oversized(part: Part, limit: number): ChordError | undefined {
	if (limit === Number.POSITIVE_INFINITY) return undefined;
	const size = sizeOf(part);
	return size > limit ? tooLarge(size, limit, "wire") : undefined;
}

/**
 * The JSON of a part its owner is about to parse: its size checked against `limits.part` first, then its decoded size
 * against `limits.decoded`, a deflated part inflated within it (synchronously with `compression`, or by the
 * asynchronous inflate that ran ahead of its owner). Throws `too_large/part` past a limit; throws a plain error for a
 * deflated part nothing inflated or that is no raw deflate stream (a protocol error). Counts one synchronous inflate
 * (`chord.link.inflates`).
 */
export function openPart(
	part: Part,
	limits: Limits,
	compression: Compression | undefined,
	context: Context,
): string | Uint8Array {
	const wire = oversized(part, limits.part);
	if (wire !== undefined) throw wire;
	if (!(part instanceof DeflatedPart)) {
		// Not deflated: its decoded size is its size.
		const size = limits.decoded === Number.POSITIVE_INFINITY ? 0 : sizeOf(part);
		if (size > limits.decoded) throw tooLarge(size, limits.decoded, "decoded");
		return part;
	}
	let inflated = part.inflated;
	if (inflated === undefined) {
		if (compression === undefined) throw new Error("part: a deflated part this host did not inflate");
		context.telemetry.metrics?.counter("chord.link.inflates").add(1);
		inflated = compression.inflate(part.bytes, limits.decoded);
	}
	switch (inflated.kind) {
		case "bytes":
			return inflated.bytes;
		case "too_large":
			throw tooLarge(undefined, limits.decoded, "decoded");
		case "corrupt":
			throw new Error("part: no raw deflate stream", { cause: inflated.error });
	}
}

/**
 * Inflates `part` with the web `DecompressionStream` (a host without a synchronous compressor), counting output bytes
 * and stopping past `limit`; the outcome is kept on the part. `signal` (the link's close) cancels the stream at once,
 * leaving no outcome. Counts one inflate (`chord.link.inflates`).
 */
export async function inflateAsync(
	part: DeflatedPart,
	limit: number,
	signal: AbortSignal,
	context: Context,
): Promise<void> {
	context.telemetry.metrics?.counter("chord.link.inflates").add(1);
	const reader = new Blob([part.bytes as Uint8Array<ArrayBuffer>])
		.stream()
		.pipeThrough(new DecompressionStream("deflate-raw"))
		.getReader();
	// A pending read settles once cancelled: nothing of the stream outlives the link.
	const cancel = (): void => void reader.cancel().catch(() => {});
	signal.addEventListener("abort", cancel, { once: true });
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done || signal.aborted) break;
			length += value.byteLength;
			if (length > limit) {
				cancel();
				part.inflated = { kind: "too_large" };
				return;
			}
			chunks.push(value);
		}
	} catch (error) {
		if (!signal.aborted) part.inflated = { kind: "corrupt", error };
		return;
	} finally {
		signal.removeEventListener("abort", cancel);
	}
	if (signal.aborted) return;
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	part.inflated = { kind: "bytes", bytes };
}

/** A part's size on the wire: its UTF-8 bytes (counted for text, without encoding it). */
function sizeOf(part: Part): number {
	if (typeof part !== "string") return part instanceof DeflatedPart ? part.bytes.byteLength : part.byteLength;
	let size = part.length;
	for (let index = 0; index < part.length; index++) {
		const unit = part.charCodeAt(index);
		if (unit < 0x80) continue;
		if (unit < 0x800) size += 1;
		else if (unit >= 0xd800 && unit < 0xdc00 && (part.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
			// A surrogate pair: four bytes for two units.
			size += 2;
			index++;
		} else size += 2;
	}
	return size;
}

/** The error of a part past a limit (`size` unknown while inflating). */
function tooLarge(size: number | undefined, limit: number, measure: "wire" | "decoded"): ChordError {
	const what = size === undefined ? "a part" : `a part of ${size} bytes`;
	const message = `${what} is over the ${measure} limit of ${limit} bytes`;
	return new ChordError({ code: "too_large", reason: "part", message });
}
