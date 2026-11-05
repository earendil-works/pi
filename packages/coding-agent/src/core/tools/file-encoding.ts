/**
 * Encodings of text files for the read and edit tools.
 *
 * - UTF-16LE and UTF-16BE are detected by their byte order mark (FF FE, FE FF), which is kept out of the text.
 * - Everything else is UTF-8. `read` shows invalid UTF-8 bytes as U+FFFD, as Buffer.toString("utf-8") does.
 *   `edit` must write back what it read, so it decodes files that are not valid UTF-8 as Latin-1 instead:
 *   one character per byte, so ASCII text matches and splices byte-exactly and all other bytes stay as they were.
 */

import { isUtf8 } from "buffer";
import { TextDecoder } from "util";
import { splitBom } from "../../utils/text.ts";

/** How the edit tool maps a file's bytes to text. `bytes` is anything not valid UTF-8 or UTF-16 with BOM. */
export type FileEncoding = "utf-8" | "utf-16le" | "utf-16be" | "bytes";

/** File text without its BOM, decoded so that encoding it again gives back the same bytes. */
export type DecodedFile =
	| { encoding: "utf-8"; bom: boolean; text: string }
	| { encoding: "utf-16le" | "utf-16be" | "bytes"; text: string };

const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

/** The UTF-16 byte order announced by a leading byte order mark, if any. */
function getUtf16Encoding(bytes: Uint8Array): "utf-16le" | "utf-16be" | undefined {
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
	return undefined;
}

/** Decode file contents for editing, losslessly. Throws for a UTF-16 byte order mark with an odd length. */
export function decodeFile(buffer: Buffer, path: string): DecodedFile {
	// Buffer's utf16le keeps lone surrogates, so the text round-trips exactly.
	const utf16 = getUtf16Encoding(buffer);
	if (utf16 && buffer.length % 2 !== 0) {
		throw new Error(
			`Could not edit file: ${path}. It starts with a ${utf16.toUpperCase()} byte order mark but has an odd number of bytes, so it is not valid UTF-16. The file was left unchanged.`,
		);
	}
	if (utf16 === "utf-16le") return { encoding: utf16, text: buffer.toString("utf16le", 2) };
	if (utf16 === "utf-16be")
		return { encoding: utf16, text: Buffer.from(buffer.subarray(2)).swap16().toString("utf16le") };
	if (isUtf8(buffer)) {
		const { bom, text } = splitBom(buffer.toString("utf-8"));
		return { encoding: "utf-8", bom: bom !== "", text };
	}
	return { encoding: "bytes", text: buffer.toString("latin1") };
}

/** Encode edited text of a file that is not UTF-8 back to bytes, with the BOM it was read with. */
export function encodeNonUtf8File(encoding: "utf-16le" | "utf-16be" | "bytes", text: string): Buffer {
	switch (encoding) {
		case "utf-16le":
			return Buffer.concat([UTF16LE_BOM, Buffer.from(text, "utf16le")]);
		case "utf-16be":
			return Buffer.concat([UTF16BE_BOM, Buffer.from(text, "utf16le").swap16()]);
		case "bytes":
			return Buffer.from(text, "latin1");
	}
}

/**
 * Incremental decoder for the text the read tool shows.
 *
 * A file that starts with a UTF-16 byte order mark is decoded as UTF-16 without the mark. Every other file
 * is decoded as UTF-8 exactly like Buffer.toString("utf-8"), including a UTF-8 byte order mark, which stays
 * in the text as U+FEFF.
 */
export class TextFileDecoder {
	private decoder: TextDecoder | undefined;
	private bigEndian = false;
	// Bytes not decoded yet: the start of the file until the byte order mark can be checked, or the odd
	// byte of a big endian UTF-16 code unit split across chunks.
	private pending: Uint8Array = new Uint8Array(0);

	/** Decode the next chunk. Characters split across chunks come out with the chunk that completes them. */
	write(chunk: Uint8Array): string {
		return this.decode(chunk, true);
	}

	/** Decode the bytes still held back; an incomplete character at the end becomes U+FFFD. */
	end(): string {
		return this.decode(new Uint8Array(0), false);
	}

	private decode(chunk: Uint8Array, stream: boolean): string {
		let bytes = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
		this.pending = new Uint8Array(0);
		if (!this.decoder) {
			if (bytes.length < 2 && stream) {
				this.pending = bytes;
				return "";
			}
			const utf16 = getUtf16Encoding(bytes);
			this.bigEndian = utf16 === "utf-16be";
			// ignoreBOM keeps a UTF-8 byte order mark in the text, as Buffer.toString("utf-8") does.
			this.decoder = utf16 ? new TextDecoder("utf-16le") : new TextDecoder("utf-8", { ignoreBOM: true });
		}
		if (this.bigEndian) {
			// Swapping to little endian avoids depending on "utf-16be" support, which runtimes without ICU lack.
			const evenLength = bytes.length - (bytes.length % 2);
			if (stream) this.pending = bytes.slice(evenLength);
			const swapped = Buffer.from(bytes.subarray(0, evenLength)).swap16();
			bytes = stream ? swapped : Buffer.concat([swapped, bytes.subarray(evenLength)]);
		}
		return this.decoder.decode(bytes, { stream });
	}
}
