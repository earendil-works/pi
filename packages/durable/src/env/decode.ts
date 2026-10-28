/**
 * Decoding that matches `new TextDecoder().decode(bytes)` of the whole input when the input arrives in pieces. Node's
 * streaming decoder with BOM handling can drop a U+FEFF that follows a chunk boundary, not only a leading byte-order
 * mark, so these decoders turn BOM handling off and drop a leading mark themselves.
 */

/** A streaming decoder for a byte range; callers that start at the beginning of a file skip a leading mark themselves. */
export function rangeDecoder(): InstanceType<typeof TextDecoder> {
	return new TextDecoder("utf-8", { ignoreBOM: true });
}

/** Whether decoding the whole input drops its first three bytes as a byte-order mark. */
export function startsWithBom(firstBytes: Uint8Array): boolean {
	return firstBytes[0] === 0xef && firstBytes[1] === 0xbb && firstBytes[2] === 0xbf;
}

/** Decodes one stream chunk by chunk exactly like decoding all of it at once. */
export class StreamDecoder {
	readonly #decoder = rangeDecoder();
	#started = false;

	/** Text for `bytes`, holding back an incomplete character; without `bytes`, the end of the stream. */
	decode(bytes?: Uint8Array): string {
		const text = bytes === undefined ? this.#decoder.decode() : this.#decoder.decode(bytes, { stream: true });
		if (this.#started || text === "") return text;
		this.#started = true;
		// U+FEFF encodes only as EF BB BF, so a leading U+FEFF is exactly a byte-order mark at the stream's start.
		return text.startsWith("\ufeff") ? text.slice(1) : text;
	}
}
