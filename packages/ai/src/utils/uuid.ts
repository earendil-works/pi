const MAX_UUID_V7_TIMESTAMP = 0xffffffffffff;
const MAX_SEQUENCE = (1n << 41n) - 1n;

let lastOrdinaryTimestamp = -1;
let sequence: bigint | undefined;

/** Generate a time-ordered UUIDv7. A supplied timestamp is preserved for follower ids. */
export function uuidv7(timestampMs?: number): string {
	const requestedTimestamp = timestampMs ?? Date.now();
	if (!Number.isInteger(requestedTimestamp) || requestedTimestamp < 0 || requestedTimestamp > MAX_UUID_V7_TIMESTAMP) {
		throw new RangeError(`UUIDv7 timestamp must be an integer between 0 and ${MAX_UUID_V7_TIMESTAMP}`);
	}

	const effectiveTimestamp =
		timestampMs === undefined ? Math.max(requestedTimestamp, lastOrdinaryTimestamp) : timestampMs;
	if (timestampMs === undefined) lastOrdinaryTimestamp = effectiveTimestamp;

	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	if (sequence === undefined) {
		sequence =
			(BigInt(bytes[1]) << 32n) |
			(BigInt(bytes[2]) << 24n) |
			(BigInt(bytes[3]) << 16n) |
			(BigInt(bytes[4]) << 8n) |
			BigInt(bytes[5]);
	} else {
		if (sequence === MAX_SEQUENCE) throw new RangeError("UUIDv7 generator sequence exhausted");
		sequence++;
	}

	const timestamp = BigInt(effectiveTimestamp);
	for (let index = 5; index >= 0; index--) {
		bytes[index] = Number(timestamp >> BigInt((5 - index) * 8)) & 0xff;
	}
	bytes[6] = 0x70 | Number((sequence >> 37n) & 0x0fn);
	bytes[7] = Number((sequence >> 29n) & 0xffn);
	bytes[8] = 0x80 | Number((sequence >> 23n) & 0x3fn);
	bytes[9] = Number((sequence >> 15n) & 0xffn);
	bytes[10] = Number((sequence >> 7n) & 0xffn);
	bytes[11] = Number((sequence & 0x7fn) << 1n) | (bytes[11] & 0x01);

	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
