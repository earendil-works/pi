// A minimal ustar (POSIX tar) writer and reader for the kit's address archives (slice 13 §4): regular files and
// directories, paths of at most 255 bytes, nothing else. The reader is a trust boundary: an archive may come from
// anywhere, so it refuses every entry that is no regular file or directory, a path that is absolute, holds `..`, a
// backslash or NUL, or names an empty segment, and a header whose checksum does not hold.

/** One entry to write: its path (`/`-separated, relative) and its bytes, as a size and the chunks that make it up. */
export type TarEntry = { readonly path: string; readonly size: number; readonly data: AsyncIterable<Uint8Array> };

/** One entry read: a regular file (its data, to be consumed before the next entry) or a directory. */
export type TarRead =
	| { readonly kind: "file"; readonly path: string; readonly size: number; readonly data: AsyncIterable<Uint8Array> }
	| { readonly kind: "directory"; readonly path: string };

/** A tar block. */
const BLOCK = 512;

/** The archive of `entries`, as the chunks of its bytes (two zero blocks end it). */
export async function* writeTar(entries: AsyncIterable<TarEntry> | Iterable<TarEntry>): AsyncGenerator<Uint8Array> {
	for await (const entry of entries) {
		yield header(entry.path, entry.size);
		let written = 0;
		for await (const chunk of entry.data) {
			written += chunk.length;
			if (written > entry.size) throw new Error(`tar: ${entry.path} is larger than its size ${entry.size}`);
			yield chunk;
		}
		if (written !== entry.size) throw new Error(`tar: ${entry.path} is ${written} bytes, not ${entry.size}`);
		const pad = (BLOCK - (entry.size % BLOCK)) % BLOCK;
		if (pad > 0) yield new Uint8Array(pad);
	}
	yield new Uint8Array(BLOCK * 2);
}

/** The ustar header of a regular file at `path` of `size` bytes. */
function header(path: string, size: number): Uint8Array {
	checkPath(path);
	const block = new Uint8Array(BLOCK);
	const bytes = new TextEncoder().encode(path);
	let name = bytes;
	let prefix = new Uint8Array();
	if (bytes.length > 100) {
		// Split at a `/` so the name has at most 100 bytes and the prefix at most 155.
		const at = path.lastIndexOf("/", path.length - 1);
		const split = new TextEncoder().encode(path.slice(0, at)).length;
		if (at < 0 || split > 155 || bytes.length - split - 1 > 100) throw new Error(`tar: the path ${path} is too long`);
		prefix = bytes.subarray(0, split);
		name = bytes.subarray(split + 1);
	}
	block.set(name, 0);
	field(block, 100, 8, "0000644");
	field(block, 108, 8, "0000000");
	field(block, 116, 8, "0000000");
	field(block, 124, 12, size.toString(8).padStart(11, "0"));
	field(
		block,
		136,
		12,
		Math.floor(Date.now() / 1000)
			.toString(8)
			.padStart(11, "0"),
	);
	block.fill(0x20, 148, 156);
	block[156] = 0x30;
	block.set(new TextEncoder().encode("ustar\u000000"), 257);
	block.set(prefix, 345);
	const sum = block.reduce((total, byte) => total + byte, 0);
	field(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\u0000 `);
	return block;
}

/** Writes `text` (ASCII) at `offset` of `block`, NUL-terminated within `length`. */
function field(block: Uint8Array, offset: number, length: number, text: string): void {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length > length) throw new Error(`tar: ${text} does not fit ${length} bytes`);
	block.set(bytes, offset);
}

/** Refuses a path an archive may not hold: absolute, with `..`, `.`, an empty segment, a backslash or a NUL. */
function checkPath(path: string): void {
	const segments = path.split("/");
	const bad = path === "" || path.includes("\\") || path.includes("\u0000") || path.startsWith("/");
	if (bad || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new Error(`tar: the path ${JSON.stringify(path)} is refused`);
	}
}

/**
 * Reads the archive `source` entry by entry (each file's data read fully before the next entry is asked for), refusing
 * what it may not hold (see the file's header).
 */
export async function* readTar(source: AsyncIterable<Uint8Array>): AsyncGenerator<TarRead> {
	const reader = new ByteReader(source);
	for (;;) {
		const block = await reader.read(BLOCK);
		if (block.length < BLOCK) throw new Error("tar: the archive ends inside a header");
		if (block.every((byte) => byte === 0)) return;
		const { path, size, type } = parseHeader(block);
		const padded = Math.ceil(size / BLOCK) * BLOCK;
		if (type === "directory") {
			yield { kind: "directory", path };
			await reader.skip(padded);
			continue;
		}
		let left = size;
		const data = (async function* () {
			while (left > 0) {
				const chunk = await reader.read(Math.min(left, 64 * 1024));
				if (chunk.length === 0) throw new Error(`tar: the archive ends inside ${path}`);
				left -= chunk.length;
				yield chunk;
			}
		})();
		yield { kind: "file", path, size, data };
		// What the consumer left unread (also when it ended the data's iteration early), then the padding.
		await reader.skip(left + padded - size);
	}
}

/** A header's path, size and type, its checksum checked; anything but a regular file or a directory refused. */
function parseHeader(block: Uint8Array): {
	readonly path: string;
	readonly size: number;
	readonly type: "file" | "directory";
} {
	const stored = Number.parseInt(text(block, 148, 8).trim(), 8);
	let sum = 0;
	for (let index = 0; index < BLOCK; index++) sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
	if (stored !== sum) throw new Error("tar: a header's checksum does not hold");
	const flag = String.fromCharCode(block[156]!);
	const type = flag === "0" || flag === "\u0000" ? "file" : flag === "5" ? "directory" : undefined;
	if (type === undefined) throw new Error(`tar: an entry of type ${JSON.stringify(flag)} is refused (files only)`);
	const prefix = text(block, 345, 155);
	const name = text(block, 0, 100);
	const path = (prefix === "" ? name : `${prefix}/${name}`).replace(/\/$/, "");
	checkPath(path);
	const size = Number.parseInt(text(block, 124, 12).trim() || "0", 8);
	if (!Number.isSafeInteger(size) || size < 0) throw new Error(`tar: ${path} has no valid size`);
	return { path, size: type === "directory" ? 0 : size, type };
}

/** The NUL-terminated text of a header field. */
function text(block: Uint8Array, offset: number, length: number): string {
	const bytes = block.subarray(offset, offset + length);
	const end = bytes.indexOf(0);
	return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
}

/** Reads exactly as many bytes as asked from a stream of chunks (fewer only at its end). */
class ByteReader {
	readonly #source: AsyncIterator<Uint8Array>;
	#buffer = new Uint8Array();

	constructor(source: AsyncIterable<Uint8Array>) {
		this.#source = source[Symbol.asyncIterator]();
	}

	/** Up to `length` bytes: `length` unless the stream ends first. */
	async read(length: number): Promise<Uint8Array> {
		while (this.#buffer.length < length) {
			const next = await this.#source.next();
			if (next.done === true) break;
			const joined = new Uint8Array(this.#buffer.length + next.value.length);
			joined.set(this.#buffer);
			joined.set(next.value, this.#buffer.length);
			this.#buffer = joined;
		}
		const taken = this.#buffer.subarray(0, Math.min(length, this.#buffer.length));
		this.#buffer = this.#buffer.subarray(taken.length);
		return taken;
	}

	/** Skips `length` bytes. */
	async skip(length: number): Promise<void> {
		let left = length;
		while (left > 0) {
			const skipped = await this.read(Math.min(left, 64 * 1024));
			if (skipped.length === 0) throw new Error("tar: the archive ends early");
			left -= skipped.length;
		}
	}
}
