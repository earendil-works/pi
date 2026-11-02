// Values in messages (§3 values, §22): JSON text, and for payloads marked as carrying bytes raw byte segments, a
// `Uint8Array` leaf written as `{"$bytes": i}` and read back as a view of the received message (no copy, never
// base64); a part as the text codec splices it. Shared by the codecs.

import { invalid } from "../data/internal.ts";
import { DeflatedPart, type Part } from "./part.ts";

/** Strict, and a leading U+FEFF is data, not a byte order mark to strip. */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A JSON part at its origin: the value's JSON text (state and params are JSON only). */
export function jsonPart(value: unknown): string {
	return JSON.stringify(value) ?? "null";
}

/**
 * A payload part at its origin (arguments, a result): its JSON and, when `bytes` (its method's schema has a `bytes()`
 * leaf), its byte segments: each `Uint8Array` leaf becomes a segment, and an own key `$bytes`, reserved there, fails
 * `invalid/args`; otherwise plain JSON, where `$bytes` is ordinary data. `undefined` (a handler returning nothing) is
 * `null`.
 */
export function payloadPart(
	value: unknown,
	bytes: boolean,
): { readonly json: string; readonly segments: Uint8Array[] | undefined } {
	if (!bytes) return { json: jsonPart(value), segments: undefined };
	const segments: Uint8Array[] = [];
	const json = JSON.stringify(value, (_key, leaf: unknown) => {
		if (leaf instanceof Uint8Array) {
			segments.push(leaf);
			return { $bytes: segments.length - 1 };
		}
		// The replacer does not see the markers it returns, only their fields.
		if (typeof leaf === "object" && leaf !== null && Object.hasOwn(leaf, "$bytes")) {
			throw invalid("args", '"$bytes" is reserved in values crossing a link');
		}
		return leaf;
	});
	return { json: json ?? "null", segments };
}

/**
 * Parses a part's JSON where it is owned, once opened (`openPart`). Throws on a part that is no strict UTF-8 JSON (a
 * protocol error).
 */
export function parsePart(json: string | Uint8Array): unknown {
	return typeof json === "string" ? JSON.parse(json) : parseJson(json);
}

/**
 * Parses a payload part's JSON where it is owned, once opened, its `{"$bytes": i}` references resolved to views of
 * `segments` when it has them. Throws on a malformed part (a protocol error).
 */
export function parsePayload(json: string | Uint8Array, segments: readonly Uint8Array[] | undefined): unknown {
	const value = parsePart(json);
	return segments === undefined ? value : resolveSegments(value, segments);
}

/**
 * A part as the text codec splices it into its tuple, tagged so that no JSON value is reserved: `[0, json]` for a plain
 * part, `[1, base64]` for a deflated one. Throws on invalid UTF-8.
 */
export function partText(part: Part): string {
	if (part instanceof DeflatedPart) return `[1,"${base64(part.bytes)}"]`;
	return `[0,${typeof part === "string" ? part : readUtf8(part)}]`;
}

/** A part from its place in a text tuple (`partText` reversed). Throws on anything else (a protocol error). */
export function textPart(value: unknown): Part {
	// Trust boundary: fresh JSON from the text decoder.
	if (!Array.isArray(value) || value.length !== 2) throw new Error("text: a part is no [codec, payload] pair");
	const [codec, payload] = value as [unknown, unknown];
	if (codec === 0) return JSON.stringify(payload);
	if (codec === 1 && typeof payload === "string") return new DeflatedPart(fromBase64(payload));
	throw new Error("text: a part of an unknown codec");
}

/** Strict UTF-8 JSON. Throws on anything else (a protocol error). */
export function parseJson(bytes: Uint8Array): unknown {
	return JSON.parse(STRICT_UTF8.decode(bytes));
}

/** Strict UTF-8 text. Throws on invalid UTF-8 (a protocol error). */
export function readUtf8(bytes: Uint8Array): string {
	return STRICT_UTF8.decode(bytes);
}

/**
 * Replaces every `{"$bytes": i}` in a freshly decoded payload with segment `i`, in place. Throws on a malformed
 * reference (a protocol error).
 */
export function resolveSegments(value: unknown, segments: readonly Uint8Array[]): unknown {
	if (typeof value !== "object" || value === null) return value;
	// Trust boundary: fresh JSON from the link, owned by this decode.
	const node = value as Record<string, unknown>;
	if (!Array.isArray(node) && Object.hasOwn(node, "$bytes")) {
		const index = node.$bytes;
		if (Object.keys(node).length !== 1 || typeof index !== "number" || segments[index] === undefined) {
			throw new Error("payload: a malformed byte segment reference");
		}
		return segments[index];
	}
	for (const key of Object.keys(node)) {
		const child = node[key];
		const resolved = resolveSegments(child, segments);
		// Defined, not assigned: a key `__proto__` is an own property of parsed JSON.
		if (resolved !== child)
			Object.defineProperty(node, key, { value: resolved, writable: true, enumerable: true, configurable: true });
	}
	return node;
}

/** Bytes as base64 (the text codec's deflated parts; portable: `btoa` over a binary string, in chunks). */
function base64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

/** Bytes from base64. Throws on text that is no base64 (a protocol error). */
function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
