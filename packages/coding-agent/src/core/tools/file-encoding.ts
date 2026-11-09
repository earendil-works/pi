/**
 * UTF-16 text files for the read, edit and write tools.
 *
 * A file that starts with a UTF-16 byte order mark (FF FE for UTF-16LE, FE FF for UTF-16BE) is UTF-16.
 * Every other file is UTF-8. UTF-16 without a byte order mark is not detected.
 */

import { TextDecoder } from "util";

/** Byte order of a UTF-16 file. */
export type Utf16Encoding = "utf-16le" | "utf-16be";

/** The UTF-16 byte order announced by a leading byte order mark, if any. */
export function getUtf16Encoding(bytes: Uint8Array): Utf16Encoding | undefined {
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
	return undefined;
}

/**
 * Decode UTF-16 bytes of even length, keeping the byte order mark as U+FEFF like a UTF-8 one.
 * Lone surrogates are kept, so encodeUtf16 gives back the same bytes.
 */
export function decodeUtf16(bytes: Buffer, encoding: Utf16Encoding): string {
	return (encoding === "utf-16le" ? bytes : Buffer.from(bytes).swap16()).toString("utf16le");
}

/** Encode text as UTF-16 with a byte order mark. A leading U+FEFF in the text is that mark, not a second one. */
export function encodeUtf16(text: string, encoding: Utf16Encoding): Buffer {
	const bytes = Buffer.from(text.startsWith("\uFEFF") ? text : `\uFEFF${text}`, "utf16le");
	return encoding === "utf-16le" ? bytes : bytes.swap16();
}

/** Decode a whole file for showing it, like TextFileDecoder. */
export function decodeTextFile(bytes: Uint8Array): string {
	const decoder = new TextFileDecoder();
	return decoder.write(bytes) + decoder.end();
}

/**
 * Incremental decoder for showing text files.
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
