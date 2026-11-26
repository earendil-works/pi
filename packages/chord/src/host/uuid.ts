// UUIDv7 (§3, after pi-ai's `uuidv7`): time-ordered ids, minted for host incarnations, object instances and job runs.

/** The largest sequence: 41 bits, exact as a number (below 2^53). */
const MAX_SEQUENCE = 2 ** 41 - 1;

/** The last timestamp used: a clock going backwards keeps the ids ordered. */
let lastTimestamp = -1;

/** A random start, then incremented per id, so ids within one millisecond stay ordered and unique. */
let sequence: number | undefined;

/**
 * A time-ordered UUIDv7. Its bits are pi-ai's: 48 of milliseconds, version 7, the 41-bit sequence (its first value
 * random), variant 10, one random bit and 32 random bits. Made with numbers, random bytes taken from a pool and the
 * text made from one list of char codes: with bigints, a fresh random buffer and a list of char codes an id cost 1.7 KiB and
 * 1.4 µs (one per object instance).
 */
export function uuidv7(): string {
	const timestamp = Math.max(Date.now(), lastTimestamp);
	lastTimestamp = timestamp;
	// The random bytes first, where pi-ai's generator took them: the random source may throw (nothing of this id has
	// changed then) or mint an id itself (it takes its own bytes and sequence; this id's come after). No code of
	// anyone's runs from here to the text.
	const at = takeRandom();
	const pool = POOL;
	if (sequence === undefined) {
		sequence = 0;
		for (let index = 0; index < 5; index++) sequence = sequence * 256 + pool[at + index]!;
	} else {
		if (sequence === MAX_SEQUENCE) throw new RangeError("UUIDv7 generator sequence exhausted");
		sequence++;
	}
	const bytes = ID;
	// Bitwise operators read the low 32 bits: exact for every byte below (divisions by powers of two are exact).
	for (let index = 5; index >= 0; index--) bytes[index] = Math.floor(timestamp / 2 ** ((5 - index) * 8)) & 0xff;
	bytes[6] = 0x70 | (Math.floor(sequence / 2 ** 37) & 0x0f);
	bytes[7] = Math.floor(sequence / 2 ** 29) & 0xff;
	bytes[8] = 0x80 | (Math.floor(sequence / 2 ** 23) & 0x3f);
	bytes[9] = Math.floor(sequence / 2 ** 15) & 0xff;
	bytes[10] = Math.floor(sequence / 2 ** 7) & 0xff;
	bytes[11] = ((sequence % 128) << 1) | (pool[at + 5]! & 0x01);
	for (let index = 12; index < 16; index++) bytes[index] = pool[at + index - 6]!;
	return uuidText(bytes);
}

/** The bytes of the id being made: one buffer, rewritten by each id (no code runs between its writes and its text). */
const ID = new Uint8Array(16);

/** Random bytes per id: five for a first sequence, one for byte 11's low bit, four for the last bytes. */
const PER_ID = 10;

/**
 * Where an id's `PER_ID` random bytes start in the pool, refilled by the platform's generator first when too few are
 * left: one call per 25 ids, not one per id. The pool holds random bytes not yet used, never an id or anything derived
 * from one. A refill that throws takes nothing.
 */
function takeRandom(): number {
	if (poolAt + PER_ID > POOL.length) {
		globalThis.crypto.getRandomValues(POOL);
		poolAt = 0;
	}
	const at = poolAt;
	poolAt += PER_ID;
	return at;
}

const POOL = new Uint8Array(250);

/** The next unused byte of the pool; past its end, the pool is refilled first. */
let poolAt = POOL.length;

const HEX = "0123456789abcdef";

/** The char code of `-`. */
const DASH = 45;

/**
 * The 16 `bytes` as a UUID's text, made from one list of its char codes as one flat string: joined parts in a template
 * are kept as a tree of strings (about 300 B for as long as the id lives; an object keeps its instance id).
 */
function uuidText(bytes: Uint8Array): string {
	const codes = TEXT;
	let at = 0;
	for (let index = 0; index < 16; index++) {
		if (index === 4 || index === 6 || index === 8 || index === 10) codes[at++] = DASH;
		const byte = bytes[index]!;
		codes[at++] = HEX.charCodeAt(byte >> 4);
		codes[at++] = HEX.charCodeAt(byte & 0x0f);
	}
	return String.fromCharCode.apply(null, codes);
}

/**
 * The char codes of the id being written: one list, rewritten by each id (a list of small integers: `apply` takes it
 * as it is, where a typed array or a decoder copied it, 0.2-0.3 KiB per id).
 */
const TEXT: number[] = new Array(36).fill(0);
