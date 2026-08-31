/**
 * Minimal RFC 6455 WebSocket frame codec for the PiServer WS transport.
 *
 * Implements the server half of the protocol: incremental frame decoding
 * (including masking, which clients must use) and frame encoding (the server
 * never masks its own frames). Control frames are surfaced to the caller so
 * the listener can answer pings and react to close frames.
 *
 * Only binary payloads are supported; the transport layer ignores text frames.
 */

const MAX_UINT32 = 0xffff_ffff;

export const WS_OPCODE_CONTINUATION = 0x0;
export const WS_OPCODE_TEXT = 0x1;
export const WS_OPCODE_BINARY = 0x2;
export const WS_OPCODE_CLOSE = 0x8;
export const WS_OPCODE_PING = 0x9;
export const WS_OPCODE_PONG = 0xa;

export interface WsFrame {
	readonly fin: boolean;
	readonly opcode: number;
	readonly payload: Uint8Array;
}

export class WsProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WsProtocolError";
	}
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
	return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUint64BE(bytes: Uint8Array, offset: number): number {
	// 53-bit safe range is sufficient for frame length limits well below 2^53.
	let value = 0;
	for (let index = 0; index < 8; index++) {
		value = value * 256 + bytes[offset + index]!;
	}
	return value;
}

function isControlOpcode(opcode: number): boolean {
	return opcode >= 0x8;
}

/**
 * Incrementally splits arbitrary byte chunks into complete WebSocket frames.
 * Throws WsProtocolError on malformed input. A close frame with a non-empty
 * payload carries an optional status code in the first two bytes.
 */
export class WsFrameDecoder {
	private readonly maxFrameLength: number;
	private readonly chunks: Uint8Array[] = [];
	private length = 0;
	private failed = false;

	constructor(maxFrameLength = 16 * 1024 * 1024) {
		if (!Number.isSafeInteger(maxFrameLength) || maxFrameLength <= 0 || maxFrameLength > MAX_UINT32) {
			throw new TypeError("WsFrameDecoder maxFrameLength must be an integer between 1 and 0xffffffff");
		}
		this.maxFrameLength = maxFrameLength;
	}

	push(chunk: Uint8Array): WsFrame[] {
		if (this.failed) throw new WsProtocolError("WebSocket frame decoder has failed");
		this.chunks.push(chunk);
		this.length += chunk.byteLength;
		const frames: WsFrame[] = [];
		for (;;) {
			const frame = this.tryReadFrame();
			if (!frame) break;
			frames.push(frame);
		}
		return frames;
	}

	private tryReadFrame(): WsFrame | undefined {
		const header = this.peek(2);
		if (!header) return undefined;
		const first = header[0]!;
		const second = header[1]!;
		const fin = (first & 0x80) !== 0;
		const opcode = first & 0x0f;
		const masked = (second & 0x80) !== 0;
		let payloadLength = second & 0x7f;

		if (isControlOpcode(opcode) && !fin) {
			throw new WsProtocolError("WebSocket control frames must not be fragmented");
		}
		if (isControlOpcode(opcode) && payloadLength > 125) {
			throw new WsProtocolError("WebSocket control frame payload is too large");
		}

		let headerLength = 2;
		if (payloadLength === 126) {
			const extended = this.peek(4);
			if (!extended) return undefined;
			payloadLength = readUint16BE(extended, 2);
			headerLength = 4;
		} else if (payloadLength === 127) {
			const extended = this.peek(10);
			if (!extended) return undefined;
			payloadLength = readUint64BE(extended, 2);
			headerLength = 10;
		}

		if (payloadLength > this.maxFrameLength) {
			throw new WsProtocolError(
				`WebSocket frame payload ${payloadLength} exceeds configured limit of ${this.maxFrameLength}`,
			);
		}
		if (masked) headerLength += 4;

		const full = this.peek(headerLength + payloadLength);
		if (!full) return undefined;
		this.consume(headerLength + payloadLength);

		let payload = full.subarray(headerLength, headerLength + payloadLength);
		if (masked) {
			const maskKey = full.subarray(headerLength - 4, headerLength);
			payload = unmask(payload, maskKey);
		}
		return { fin, opcode, payload };
	}

	private peek(count: number): Uint8Array | undefined {
		if (this.length < count) return undefined;
		const buffer = new Uint8Array(count);
		let offset = 0;
		for (const chunk of this.chunks) {
			const take = Math.min(chunk.byteLength, count - offset);
			buffer.set(chunk.subarray(0, take), offset);
			offset += take;
			if (offset === count) break;
		}
		return buffer;
	}

	private consume(count: number): void {
		let remaining = count;
		while (remaining > 0 && this.chunks.length > 0) {
			const first = this.chunks[0]!;
			if (first.byteLength <= remaining) {
				remaining -= first.byteLength;
				this.length -= first.byteLength;
				this.chunks.shift();
			} else {
				this.chunks[0] = first.subarray(remaining);
				this.length -= remaining;
				remaining = 0;
			}
		}
	}
}

function unmask(payload: Uint8Array, maskKey: Uint8Array): Uint8Array {
	const result = new Uint8Array(payload.byteLength);
	for (let index = 0; index < payload.byteLength; index++) {
		result[index] = payload[index]! ^ maskKey[index % 4]!;
	}
	return result;
}

/** Encodes one unmasked binary frame (server-to-client). */
export function encodeWsFrame(payload: Uint8Array, opcode = WS_OPCODE_BINARY): Uint8Array {
	if (!(payload instanceof Uint8Array)) throw new TypeError("WebSocket frame payload must be a Uint8Array");
	if (payload.byteLength > MAX_UINT32) {
		throw new RangeError("WebSocket frame payload exceeds the unsigned 32-bit length limit");
	}
	let headerLength: number;
	if (payload.byteLength < 126) {
		headerLength = 2;
	} else if (payload.byteLength <= 0xffff) {
		headerLength = 4;
	} else {
		headerLength = 10;
	}
	const frame = new Uint8Array(headerLength + payload.byteLength);
	frame[0] = 0x80 | opcode; // FIN + opcode, no RSV bits
	const length = payload.byteLength;
	if (headerLength === 2) {
		frame[1] = length;
	} else if (headerLength === 4) {
		frame[1] = 126;
		frame[2] = length >>> 8;
		frame[3] = length;
	} else {
		frame[1] = 127;
		// 8-byte big-endian length; safe for the 32-bit range we allow.
		let value = length;
		for (let index = 9; index >= 2; index--) {
			frame[index] = value & 0xff;
			value = Math.floor(value / 256);
		}
	}
	frame.set(payload, headerLength);
	return frame;
}

/** Encodes a close frame with an optional status code. */
export function encodeWsCloseFrame(code = 1000, reason = ""): Uint8Array {
	const reasonBytes = new TextEncoder().encode(reason);
	const payload = new Uint8Array(2 + reasonBytes.byteLength);
	payload[0] = (code >>> 8) & 0xff;
	payload[1] = code & 0xff;
	payload.set(reasonBytes, 2);
	return encodeWsFrame(payload, WS_OPCODE_CLOSE);
}
