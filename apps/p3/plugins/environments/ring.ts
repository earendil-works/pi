// A terminal's kept output: a ring of its last bytes, at most a capacity, counted from its first byte (an offset), so a
// viewer that comes later reads the tail and one that falls behind skips to the oldest byte kept. The buffer is made
// at the first byte, small, and doubles as output comes until it holds the capacity (a short program's output costs
// little); then it never grows. Reads copy, so no caller holds a view of it.

/** The size a ring's buffer starts at. */
const FIRST_SIZE = 4 * 1024;

/** The last `capacity` bytes written, and the offset of the end. */
export class Ring {
	readonly #capacity: number;
	// Until it holds the capacity nothing wrapped: the bytes are at their offsets.
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

	/** How many bytes its buffer holds (what it costs). */
	get size(): number {
		return this.#buffer?.length ?? 0;
	}

	/** Appends `bytes`; of more than the capacity only the last `capacity` are kept. */
	write(bytes: Uint8Array): void {
		const buffer = this.#grown(Math.min(this.#capacity, this.#end + bytes.length));
		const size = buffer.length;
		const kept = bytes.length > size ? bytes.subarray(bytes.length - size) : bytes;
		const at = (this.#end + bytes.length - kept.length) % size;
		const first = Math.min(kept.length, size - at);
		buffer.set(kept.subarray(0, first), at);
		if (first < kept.length) buffer.set(kept.subarray(first), 0);
		this.#end += bytes.length;
	}

	/** A copy of the bytes from offset `from` (at least `start`) up to `max` of them, or to the end. */
	read(from: number, max: number): Uint8Array {
		const begin = Math.max(from, this.start);
		const length = Math.max(0, Math.min(max, this.#end - begin));
		const out = new Uint8Array(length);
		if (length === 0 || this.#buffer === undefined) return out;
		const size = this.#buffer.length;
		const at = begin % size;
		const first = Math.min(length, size - at);
		out.set(this.#buffer.subarray(at, at + first), 0);
		if (first < length) out.set(this.#buffer.subarray(0, length - first), first);
		return out;
	}

	/** The buffer, doubled (its bytes kept at their offsets) until it holds `needed` bytes or the capacity. */
	#grown(needed: number): Uint8Array {
		const old = this.#buffer;
		if (old !== undefined && old.length >= needed) return old;
		let size = old?.length ?? FIRST_SIZE;
		while (size < needed) size *= 2;
		const buffer = new Uint8Array(Math.min(size, this.#capacity));
		if (old !== undefined) buffer.set(old.subarray(0, this.#end), 0);
		this.#buffer = buffer;
		return buffer;
	}
}
