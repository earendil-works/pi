// UUIDv7 (§3, code copied from pi-ai's `uuidv7`): time-ordered ids, minted for host incarnations.

const MAX_SEQUENCE = (1n << 41n) - 1n;

/** The last timestamp used: a clock going backwards keeps the ids ordered. */
let lastTimestamp = -1;

/** A random start, then incremented per id, so ids within one millisecond stay ordered and unique. */
let sequence: bigint | undefined;

/** A time-ordered UUIDv7. */
export function uuidv7(): string {
	const timestamp = Math.max(Date.now(), lastTimestamp);
	lastTimestamp = timestamp;
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	if (sequence === undefined) {
		sequence =
			(BigInt(bytes[1]!) << 32n) |
			(BigInt(bytes[2]!) << 24n) |
			(BigInt(bytes[3]!) << 16n) |
			(BigInt(bytes[4]!) << 8n) |
			BigInt(bytes[5]!);
	} else {
		if (sequence === MAX_SEQUENCE) throw new RangeError("UUIDv7 generator sequence exhausted");
		sequence++;
	}
	const time = BigInt(timestamp);
	for (let index = 5; index >= 0; index--) bytes[index] = Number(time >> BigInt((5 - index) * 8)) & 0xff;
	bytes[6] = 0x70 | Number((sequence >> 37n) & 0x0fn);
	bytes[7] = Number((sequence >> 29n) & 0xffn);
	bytes[8] = 0x80 | Number((sequence >> 23n) & 0x3fn);
	bytes[9] = Number((sequence >> 15n) & 0xffn);
	bytes[10] = Number((sequence >> 7n) & 0xffn);
	bytes[11] = Number((sequence & 0x7fn) << 1n) | (bytes[11]! & 0x01);
	return uuidText(bytes);
}

const HEX = "0123456789abcdef";

/** The char code of `-`. */
const DASH = 45;

/**
 * The 16 `bytes` as a UUID's text, built from its char codes as one flat string: joined parts in a template are kept
 * as a tree of strings (about 300 B for as long as the id lives; an object keeps its instance id for its life).
 */
function uuidText(bytes: Uint8Array): string {
	const codes: number[] = [];
	for (let index = 0; index < 16; index++) {
		if (index === 4 || index === 6 || index === 8 || index === 10) codes.push(DASH);
		const byte = bytes[index]!;
		codes.push(HEX.charCodeAt(byte >> 4), HEX.charCodeAt(byte & 0x0f));
	}
	return String.fromCharCode(...codes);
}
