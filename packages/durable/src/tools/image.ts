const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Bytes every check except the APNG chunk walk needs: BMP reads up to offset 29. */
const HEADER_BYTES = 32;
const BLOCK_BYTES = 64 * 1024;

/** Positional reads of a file of `size` bytes. */
export type ByteSource = {
	readonly size: number;
	read(offset: number, length: number): Promise<Uint8Array>;
};

/**
 * `detectSupportedImageMimeType` of a whole file, reading only its header and, for PNG, the chunk headers up to the
 * first `acTL` or `IDAT`.
 */
export async function detectSupportedImageMimeTypeOf(source: ByteSource): Promise<string | undefined> {
	const header = await source.read(0, HEADER_BYTES);
	if (!startsWith(header, PNG_SIGNATURE)) return detectSupportedImageMimeType(header);
	return isPng(header) && !(await isAnimatedPngOf(source)) ? "image/png" : undefined;
}

/** `isAnimatedPng` over a file read in blocks. */
async function isAnimatedPngOf(source: ByteSource): Promise<boolean> {
	let block: Uint8Array = new Uint8Array(0);
	let blockStart = 0;
	const bytesAt = async (offset: number, length: number): Promise<Uint8Array> => {
		if (offset < blockStart || offset + length > blockStart + block.length) {
			blockStart = offset;
			block = await source.read(offset, BLOCK_BYTES);
		}
		return block.subarray(offset - blockStart, offset - blockStart + length);
	};
	let offset = PNG_SIGNATURE.length;
	while (offset + 8 <= source.size) {
		const chunkHeader = await bytesAt(offset, 8);
		const chunkLength = readUint32BE(chunkHeader, 0);
		if (startsWithAscii(chunkHeader, 4, "acTL")) return true;
		if (startsWithAscii(chunkHeader, 4, "IDAT")) return false;
		const nextOffset = offset + 8 + chunkLength + 4;
		if (nextOffset <= offset || nextOffset > source.size) return false;
		offset = nextOffset;
	}
	return false;
}

export function detectSupportedImageMimeType(buffer: Uint8Array): string | undefined {
	if (startsWith(buffer, [0xff, 0xd8, 0xff])) return buffer[3] === 0xf7 ? undefined : "image/jpeg";
	if (startsWith(buffer, PNG_SIGNATURE)) return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : undefined;
	if (startsWithAscii(buffer, 0, "GIF87a") || startsWithAscii(buffer, 0, "GIF89a")) return "image/gif";
	if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) return "image/webp";
	if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer)) return "image/bmp";
	return undefined;
}

function isPng(buffer: Uint8Array): boolean {
	return (
		buffer.length >= 16 && readUint32BE(buffer, PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, "IHDR")
	);
}

function isAnimatedPng(buffer: Uint8Array): boolean {
	let offset = PNG_SIGNATURE.length;
	while (offset + 8 <= buffer.length) {
		const chunkLength = readUint32BE(buffer, offset);
		const chunkTypeOffset = offset + 4;
		if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
		if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;
		const nextOffset = offset + 8 + chunkLength + 4;
		if (nextOffset <= offset || nextOffset > buffer.length) return false;
		offset = nextOffset;
	}
	return false;
}

function isBmp(buffer: Uint8Array): boolean {
	if (buffer.length < 26) return false;
	const declaredFileSize = readUint32LE(buffer, 2);
	const pixelDataOffset = readUint32LE(buffer, 10);
	const dibHeaderSize = readUint32LE(buffer, 14);
	if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
	if (pixelDataOffset < 14 + dibHeaderSize) return false;
	if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;

	let colorPlanes: number;
	let bitsPerPixel: number;
	if (dibHeaderSize === 12) {
		colorPlanes = readUint16LE(buffer, 22);
		bitsPerPixel = readUint16LE(buffer, 24);
	} else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
		if (buffer.length < 30) return false;
		colorPlanes = readUint16LE(buffer, 26);
		bitsPerPixel = readUint16LE(buffer, 28);
	} else {
		return false;
	}
	return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

function readUint16LE(buffer: Uint8Array, offset: number): number {
	return (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8);
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) * 0x1000000 +
		((buffer[offset + 1] ?? 0) << 16) +
		((buffer[offset + 2] ?? 0) << 8) +
		(buffer[offset + 3] ?? 0)
	);
}

function readUint32LE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) +
		((buffer[offset + 1] ?? 0) << 8) +
		((buffer[offset + 2] ?? 0) << 16) +
		(buffer[offset + 3] ?? 0) * 0x1000000
	);
}

function startsWith(buffer: Uint8Array, bytes: number[]): boolean {
	if (buffer.length < bytes.length) return false;
	return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
	if (buffer.length < offset + text.length) return false;
	for (let index = 0; index < text.length; index++) {
		if (buffer[offset + index] !== text.charCodeAt(index)) return false;
	}
	return true;
}
