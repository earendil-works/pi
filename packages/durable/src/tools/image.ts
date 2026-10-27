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

/**
 * The width and height an image of `mimeType` declares in its header, without decoding it: PNG's IHDR, GIF's screen,
 * WebP's VP8, VP8L, or VP8X chunk, JPEG's first SOF segment. `undefined` when the header cannot be read.
 */
export function imageDimensions(
	bytes: Uint8Array,
	mimeType: string,
): { readonly width: number; readonly height: number } | undefined {
	switch (mimeType) {
		case "image/png":
			return bytes.length < 24 ? undefined : { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20) };
		case "image/gif":
			return bytes.length < 10 ? undefined : { width: readUint16LE(bytes, 6), height: readUint16LE(bytes, 8) };
		case "image/webp":
			if (bytes.length < 30) return undefined;
			if (startsWithAscii(bytes, 12, "VP8 "))
				return { width: readUint16LE(bytes, 26) & 0x3fff, height: readUint16LE(bytes, 28) & 0x3fff };
			if (startsWithAscii(bytes, 12, "VP8L")) {
				const bits = readUint32LE(bytes, 21);
				return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
			}
			if (startsWithAscii(bytes, 12, "VP8X")) {
				const uint24 = (offset: number): number => readUint16LE(bytes, offset) + ((bytes[offset + 2] ?? 0) << 16);
				return { width: uint24(24) + 1, height: uint24(27) + 1 };
			}
			return undefined;
		case "image/jpeg":
			for (let offset = 2; offset + 9 <= bytes.length; ) {
				if (bytes[offset] !== 0xff) return undefined;
				const marker = bytes[offset + 1]!;
				if (marker === 0xff) {
					offset++;
					continue;
				}
				// SOF0 to SOF15, except DHT (C4), JPG (C8), and DAC (CC), which share the range.
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
					return { width: readUint16BE(bytes, offset + 7), height: readUint16BE(bytes, offset + 5) };
				}
				offset += 2 + readUint16BE(bytes, offset + 2);
			}
			return undefined;
		default:
			return undefined;
	}
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

function readUint16BE(buffer: Uint8Array, offset: number): number {
	return ((buffer[offset] ?? 0) << 8) + (buffer[offset + 1] ?? 0);
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
