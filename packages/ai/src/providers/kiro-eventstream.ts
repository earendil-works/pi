const PRELUDE_LENGTH = 12;
const MESSAGE_CRC_LENGTH = 4;
const MIN_MESSAGE_LENGTH = PRELUDE_LENGTH + MESSAGE_CRC_LENGTH;

export interface KiroEventStreamMessage {
	headers: Record<string, string>;
	payload: Uint8Array;
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index++) {
	let value = index;
	for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	CRC_TABLE[index] = value >>> 0;
}

export function crc32(bytes: Uint8Array): number {
	let value = 0xffffffff;
	for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
	return (value ^ 0xffffffff) >>> 0;
}

export function decodeKiroEventStreamMessage(frame: Uint8Array): KiroEventStreamMessage {
	if (frame.length < MIN_MESSAGE_LENGTH) throw new Error("Kiro event stream frame is too short");
	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	const totalLength = view.getUint32(0, false);
	const headersLength = view.getUint32(4, false);
	if (totalLength !== frame.length) {
		throw new Error(`Kiro event stream framed length ${totalLength} does not match ${frame.length}`);
	}
	if (headersLength > totalLength - MIN_MESSAGE_LENGTH) {
		throw new Error("Kiro event stream header block exceeds frame");
	}
	if (crc32(frame.subarray(0, 8)) !== view.getUint32(8, false)) {
		throw new Error("Kiro event stream prelude CRC mismatch");
	}
	if (crc32(frame.subarray(0, totalLength - MESSAGE_CRC_LENGTH)) !== view.getUint32(totalLength - 4, false)) {
		throw new Error("Kiro event stream message CRC mismatch");
	}

	const headersStart = PRELUDE_LENGTH;
	const headersEnd = headersStart + headersLength;
	return {
		headers: parseKiroEventStreamHeaders(frame.subarray(headersStart, headersEnd)),
		payload: frame.subarray(headersEnd, totalLength - MESSAGE_CRC_LENGTH),
	};
}

function parseKiroEventStreamHeaders(bytes: Uint8Array): Record<string, string> {
	const result: Record<string, string> = {};
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const decoder = new TextDecoder();
	let offset = 0;
	const requireBytes = (count: number) => {
		if (offset + count > bytes.length) throw new Error("Truncated Kiro event stream headers");
	};
	while (offset < bytes.length) {
		requireBytes(1);
		const nameLength = view.getUint8(offset++);
		requireBytes(nameLength + 1);
		const name = decoder.decode(bytes.subarray(offset, offset + nameLength));
		offset += nameLength;
		const type = view.getUint8(offset++);
		switch (type) {
			case 0:
				result[name] = "true";
				break;
			case 1:
				result[name] = "false";
				break;
			case 2:
				requireBytes(1);
				result[name] = String(view.getInt8(offset++));
				break;
			case 3:
				requireBytes(2);
				result[name] = String(view.getInt16(offset, false));
				offset += 2;
				break;
			case 4:
				requireBytes(4);
				result[name] = String(view.getInt32(offset, false));
				offset += 4;
				break;
			case 5:
				requireBytes(8);
				result[name] = readSignedBigEndian(bytes.subarray(offset, offset + 8)).toString();
				offset += 8;
				break;
			case 6: {
				requireBytes(2);
				const length = view.getUint16(offset, false);
				offset += 2;
				requireBytes(length);
				const headerBytes = bytes.subarray(offset, offset + length);
				let binary = "";
				for (const byte of headerBytes) binary += String.fromCharCode(byte);
				result[name] = btoa(binary);
				offset += length;
				break;
			}
			case 7: {
				requireBytes(2);
				const length = view.getUint16(offset, false);
				offset += 2;
				requireBytes(length);
				result[name] = decoder.decode(bytes.subarray(offset, offset + length));
				offset += length;
				break;
			}
			case 8:
				requireBytes(8);
				result[name] = new Date(Number(readSignedBigEndian(bytes.subarray(offset, offset + 8)))).toISOString();
				offset += 8;
				break;
			case 9:
				requireBytes(16);
				result[name] = [...bytes.subarray(offset, offset + 16)]
					.map((byte) => byte.toString(16).padStart(2, "0"))
					.join("");
				offset += 16;
				break;
			default:
				throw new Error(`Unknown Kiro event stream header type ${type}`);
		}
	}
	return result;
}

function readSignedBigEndian(bytes: Uint8Array): bigint {
	let value = 0n;
	for (const byte of bytes) value = (value << 8n) | BigInt(byte);
	if (bytes.length === 8 && (bytes[0] & 0x80) !== 0) value -= 1n << 64n;
	return value;
}

export async function* decodeKiroEventStream(
	source: ReadableStream<Uint8Array>,
): AsyncGenerator<KiroEventStreamMessage> {
	const reader = source.getReader();
	let buffer = new Uint8Array(0);
	let completed = false;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (value && value.length > 0) {
				const next = new Uint8Array(buffer.length + value.length);
				next.set(buffer);
				next.set(value, buffer.length);
				buffer = next;
			}
			let offset = 0;
			while (buffer.length - offset >= 4) {
				const totalLength = new DataView(buffer.buffer, buffer.byteOffset + offset, 4).getUint32(0, false);
				if (totalLength < MIN_MESSAGE_LENGTH) throw new Error(`Invalid Kiro event stream length ${totalLength}`);
				if (buffer.length - offset < totalLength) break;
				yield decodeKiroEventStreamMessage(buffer.subarray(offset, offset + totalLength));
				offset += totalLength;
			}
			if (offset > 0) buffer = buffer.slice(offset);
			if (done) break;
		}
		if (buffer.length > 0) throw new Error("Truncated Kiro event stream message");
		completed = true;
	} finally {
		if (!completed) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
