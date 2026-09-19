/**
 * Bounded byte collector. It retains a prefix or suffix constrained by both a byte
 * budget and a newline budget, and accounts for every discarded byte/newline.
 */
export class Bounded {
	private bytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
	private readonly maxBytes: number;
	private readonly maxLines: number;
	private readonly retain: "head" | "tail";
	droppedBytes = 0;
	droppedLines = 0;
	total = 0;

	constructor(maxBytes: number, maxLines: number, retain: "head" | "tail") {
		this.maxBytes = Math.max(0, maxBytes);
		this.maxLines = Math.max(0, maxLines);
		this.retain = retain;
	}

	push(chunk: Uint8Array): void {
		this.total += chunk.length;
		if (chunk.length === 0) return;
		if (this.maxBytes === 0 || this.maxLines === 0) {
			this.drop(chunk);
			return;
		}
		if (this.retain === "head") {
			this.pushHead(chunk);
			return;
		}
		this.pushTail(chunk);
	}

	private pushHead(chunk: Uint8Array): void {
		const remainingBytes = this.maxBytes - this.bytes.length;
		const remainingLines = this.maxLines - countNewlines(this.bytes);
		if (remainingBytes <= 0 || remainingLines <= 0) {
			this.drop(chunk);
			return;
		}
		let take = Math.min(chunk.length, remainingBytes);
		let lines = 0;
		for (let i = 0; i < take; i++) {
			if (chunk[i] !== 0x0a) continue;
			lines++;
			if (lines === remainingLines) {
				take = i + 1;
				break;
			}
		}
		this.bytes = concat(this.bytes, chunk.subarray(0, take));
		this.drop(chunk.subarray(take));
	}

	private pushTail(chunk: Uint8Array): void {
		const incomingStart = tailStart(chunk, this.maxBytes, this.maxLines);
		this.drop(chunk.subarray(0, incomingStart));
		const combined = concat(this.bytes, chunk.subarray(incomingStart));
		const start = tailStart(combined, this.maxBytes, this.maxLines);
		this.drop(combined.subarray(0, start));
		this.bytes = combined.slice(start);
	}

	private drop(bytes: Uint8Array): void {
		this.droppedBytes += bytes.length;
		this.droppedLines += countNewlines(bytes);
	}

	get dropped(): number {
		return this.droppedBytes;
	}

	text(): string {
		return new TextDecoder().decode(this.bytes);
	}
}

function tailStart(bytes: Uint8Array, maxBytes: number, maxLines: number): number {
	let start = Math.max(0, bytes.length - maxBytes);
	let excessLines = countNewlines(bytes.subarray(start)) - maxLines;
	for (; start < bytes.length && excessLines > 0; start++) {
		if (bytes[start] === 0x0a) excessLines--;
	}
	return start;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	if (a.length === 0) return b.slice();
	if (b.length === 0) return a;
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}

function countNewlines(bytes: Uint8Array): number {
	let count = 0;
	for (const byte of bytes) if (byte === 0x0a) count++;
	return count;
}
