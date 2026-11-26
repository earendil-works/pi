// A terminal's kept output: a fixed-capacity ring of its last bytes, counted from its first byte (an offset), so a
// viewer that comes later reads the tail and one that falls behind skips to the oldest byte kept. The buffer is made
// at the first byte and never grows; reads copy, so no caller holds a view of it.

/** The last `capacity` bytes written, and the offset of the end. */
export class Ring {
	readonly #capacity: number;
	#buffer: Uint8Array | undefined;
	/** How many bytes were ever written: the offset of the end. */
	#end = 0;

	constructor(capacity: number) {
		this.#capacity = capacity;
	}

	/** The offset after the last byte written. */
	get end(): number {
		return this.#end;
	}

	/** The offset of the oldest byte kept. */
	get start(): number {
		return Math.max(0, this.#end - this.#capacity);
	}

	/** Appends `bytes`; of more than the capacity only the last `capacity` are kept. */
	write(bytes: Uint8Array): void {
		this.#buffer ??= new Uint8Array(this.#capacity);
		const kept = bytes.length > this.#capacity ? bytes.subarray(bytes.length - this.#capacity) : bytes;
		const at = (this.#end + bytes.length - kept.length) % this.#capacity;
		const first = Math.min(kept.length, this.#capacity - at);
		this.#buffer.set(kept.subarray(0, first), at);
		if (first < kept.length) this.#buffer.set(kept.subarray(first), 0);
		this.#end += bytes.length;
	}

	/** A copy of the bytes from offset `from` (at least `start`) up to `max` of them, or to the end. */
	read(from: number, max: number): Uint8Array {
		const begin = Math.max(from, this.start);
		const length = Math.max(0, Math.min(max, this.#end - begin));
		const out = new Uint8Array(length);
		if (length === 0 || this.#buffer === undefined) return out;
		const at = begin % this.#capacity;
		const first = Math.min(length, this.#capacity - at);
		out.set(this.#buffer.subarray(at, at + first), 0);
		if (first < length) out.set(this.#buffer.subarray(0, length - first), first);
		return out;
	}
}
