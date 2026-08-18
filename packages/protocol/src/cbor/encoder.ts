import {
	CborError,
	type CborOptions,
	MAX_UINT32,
	type ResolvedCborOptions,
	resolveOptions,
	textDecoder,
	textEncoder,
	UINT32_BASE,
} from "./options.ts";

class CborWriter {
	private buffer: Uint8Array;
	private offset = 0;
	private readonly maxByteLength: number;

	constructor(maxByteLength: number) {
		this.maxByteLength = maxByteLength;
		this.buffer = new Uint8Array(Math.min(256, maxByteLength));
	}

	writeByte(value: number): void {
		this.ensureCapacity(1);
		this.buffer[this.offset] = value;
		this.offset++;
	}

	writeBytes(bytes: Uint8Array): void {
		this.ensureCapacity(bytes.byteLength);
		this.buffer.set(bytes, this.offset);
		this.offset += bytes.byteLength;
	}

	writeUint16(value: number): void {
		this.ensureCapacity(2);
		this.buffer[this.offset] = value >>> 8;
		this.buffer[this.offset + 1] = value;
		this.offset += 2;
	}

	writeUint32(value: number): void {
		this.ensureCapacity(4);
		this.buffer[this.offset] = value >>> 24;
		this.buffer[this.offset + 1] = value >>> 16;
		this.buffer[this.offset + 2] = value >>> 8;
		this.buffer[this.offset + 3] = value;
		this.offset += 4;
	}

	writeUint64(value: number): void {
		const high = Math.floor(value / UINT32_BASE);
		const low = value - high * UINT32_BASE;
		this.writeUint32(high);
		this.writeUint32(low);
	}

	writeFloat64(value: number): void {
		this.ensureCapacity(9);
		this.buffer[this.offset] = 0xfb;
		new DataView(this.buffer.buffer).setFloat64(this.offset + 1, value, false);
		this.offset += 9;
	}

	finish(): Uint8Array {
		return this.buffer.slice(0, this.offset);
	}

	private ensureCapacity(additionalBytes: number): void {
		const required = this.offset + additionalBytes;
		if (required > this.maxByteLength) {
			throw new CborError(`CBOR byte length exceeds configured limit of ${this.maxByteLength}`);
		}
		if (required <= this.buffer.byteLength) return;

		let capacity = Math.max(1, this.buffer.byteLength);
		while (capacity < required) capacity = Math.min(this.maxByteLength, Math.max(required, capacity * 2));
		const expanded = new Uint8Array(capacity);
		expanded.set(this.buffer);
		this.buffer = expanded;
	}
}

function writeArgument(writer: CborWriter, majorType: number, value: number): void {
	const prefix = majorType << 5;
	if (value < 24) {
		writer.writeByte(prefix | value);
	} else if (value <= 0xff) {
		writer.writeByte(prefix | 24);
		writer.writeByte(value);
	} else if (value <= 0xffff) {
		writer.writeByte(prefix | 25);
		writer.writeUint16(value);
	} else if (value <= MAX_UINT32) {
		writer.writeByte(prefix | 26);
		writer.writeUint32(value);
	} else {
		writer.writeByte(prefix | 27);
		writer.writeUint64(value);
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function encodeText(writer: CborWriter, value: string, options: ResolvedCborOptions): void {
	const bytes = textEncoder.encode(value);
	if (bytes.byteLength > options.maxByteLength) {
		throw new CborError(`CBOR text string length exceeds configured limit of ${options.maxByteLength}`);
	}
	if (textDecoder.decode(bytes) !== value)
		throw new CborError("CBOR text strings must contain valid Unicode scalar values");
	writeArgument(writer, 3, bytes.byteLength);
	writer.writeBytes(bytes);
}

function encodeValue(
	writer: CborWriter,
	value: unknown,
	options: ResolvedCborOptions,
	depth: number,
	ancestors: Set<object>,
): void {
	if (depth > options.maxDepth)
		throw new CborError(`CBOR nesting depth exceeds configured limit of ${options.maxDepth}`);

	if (value === null) {
		writer.writeByte(0xf6);
		return;
	}
	if (typeof value === "boolean") {
		writer.writeByte(value ? 0xf5 : 0xf4);
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new CborError("CBOR numbers must be finite");
		if (Number.isInteger(value) && !Object.is(value, -0)) {
			if (!Number.isSafeInteger(value)) throw new CborError("CBOR integers must be safe JavaScript integers");
			if (value >= 0) writeArgument(writer, 0, value);
			else writeArgument(writer, 1, -1 - value);
		} else {
			writer.writeFloat64(value);
		}
		return;
	}
	if (typeof value === "string") {
		encodeText(writer, value, options);
		return;
	}
	if (value instanceof Uint8Array) {
		if (value.byteLength > options.maxByteLength) {
			throw new CborError(`CBOR byte string length exceeds configured limit of ${options.maxByteLength}`);
		}
		writeArgument(writer, 2, value.byteLength);
		writer.writeBytes(value);
		return;
	}
	if (Array.isArray(value)) {
		if (ancestors.has(value)) throw new CborError("CBOR values must not contain cycles");
		if (value.length > options.maxContainerLength) {
			throw new CborError(`CBOR array length exceeds configured limit of ${options.maxContainerLength}`);
		}
		ancestors.add(value);
		try {
			writeArgument(writer, 4, value.length);
			for (let index = 0; index < value.length; index++) {
				if (!Object.hasOwn(value, index) || value[index] === undefined) {
					throw new CborError("CBOR arrays must not contain holes or undefined values");
				}
				encodeValue(writer, value[index], options, depth + 1, ancestors);
			}
		} finally {
			ancestors.delete(value);
		}
		return;
	}
	if (isPlainObject(value)) {
		if (ancestors.has(value)) throw new CborError("CBOR values must not contain cycles");
		for (const symbol of Object.getOwnPropertySymbols(value)) {
			if (Object.prototype.propertyIsEnumerable.call(value, symbol)) {
				throw new CborError("CBOR map keys must be strings");
			}
		}
		const entries: Array<readonly [string, unknown]> = [];
		for (const key of Object.keys(value)) {
			const entryValue = value[key];
			if (entryValue !== undefined) entries.push([key, entryValue]);
		}
		if (entries.length > options.maxContainerLength) {
			throw new CborError(`CBOR map length exceeds configured limit of ${options.maxContainerLength}`);
		}
		ancestors.add(value);
		try {
			writeArgument(writer, 5, entries.length);
			for (const [key, entryValue] of entries) {
				encodeText(writer, key, options);
				encodeValue(writer, entryValue, options, depth + 1, ancestors);
			}
		} finally {
			ancestors.delete(value);
		}
		return;
	}

	throw new CborError(`Unsupported CBOR value type: ${typeof value}`);
}

/** Encodes the protocol's strict, definite-length RFC 8949 subset. */
export function encodeCbor(value: unknown, options?: CborOptions): Uint8Array {
	const resolved = resolveOptions(options);
	const writer = new CborWriter(resolved.maxByteLength);
	encodeValue(writer, value, resolved, 0, new Set<object>());
	return writer.finish();
}
