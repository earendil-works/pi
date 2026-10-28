// EXIF orientation of JPEG and WebP files, read from the bytes without decoding the image.

/** The EXIF orientation of a JPEG or WebP, 1 to 8; 1 when absent or unreadable. */
export function exifOrientation(bytes: Uint8Array): number {
	const tiff = tiffStart(bytes);
	if (tiff < 0 || tiff + 8 > bytes.length) return 1;
	const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
	const u16 = (at: number): number =>
		little ? bytes[at]! | (bytes[at + 1]! << 8) : (bytes[at]! << 8) | bytes[at + 1]!;
	const u32 = (at: number): number =>
		little
			? (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0
			: ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
	const directory = tiff + u32(tiff + 4);
	if (directory + 2 > bytes.length) return 1;
	const entries = u16(directory);
	for (let index = 0; index < entries; index++) {
		const entry = directory + 2 + index * 12;
		if (entry + 12 > bytes.length) return 1;
		// Tag 0x0112 is Orientation, a SHORT whose value sits in the entry.
		if (u16(entry) === 0x0112) {
			const value = u16(entry + 8);
			return value >= 1 && value <= 8 ? value : 1;
		}
	}
	return 1;
}

/** Where the TIFF header of a JPEG's APP1 or a WebP's EXIF chunk starts; -1 when there is none. */
function tiffStart(bytes: Uint8Array): number {
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		for (let offset = 2; offset + 4 <= bytes.length; ) {
			if (bytes[offset] !== 0xff) return -1;
			const marker = bytes[offset + 1]!;
			if (marker === 0xff) {
				offset++;
				continue;
			}
			if (marker === 0xe1 && isExifHeader(bytes, offset + 4)) return offset + 10;
			offset += 2 + ((bytes[offset + 2]! << 8) | bytes[offset + 3]!);
		}
		return -1;
	}
	if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) {
		for (let offset = 12; offset + 8 <= bytes.length; ) {
			const size =
				(bytes[offset + 4]! |
					(bytes[offset + 5]! << 8) |
					(bytes[offset + 6]! << 16) |
					(bytes[offset + 7]! << 24)) >>>
				0;
			// Some WebP files prefix the TIFF header with "Exif\0\0".
			if (ascii(bytes, offset, "EXIF")) return isExifHeader(bytes, offset + 8) ? offset + 14 : offset + 8;
			// RIFF chunks are padded to an even size.
			offset += 8 + size + (size % 2);
		}
	}
	return -1;
}

function isExifHeader(bytes: Uint8Array, offset: number): boolean {
	return ascii(bytes, offset, "Exif") && bytes[offset + 4] === 0 && bytes[offset + 5] === 0;
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
	for (let index = 0; index < text.length; index++) {
		if (bytes[offset + index] !== text.charCodeAt(index)) return false;
	}
	return true;
}
