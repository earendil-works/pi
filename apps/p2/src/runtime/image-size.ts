/**
 * An image's pixel size from the start of its base64 data (PNG, GIF, WebP, JPEG), as the browser displays it (JPEG's
 * EXIF orientation applied). The transcript reserves an image's box with it: an image without a size lays out at 0px
 * and grows once decoded, and every such growth moves the transcript under the reader.
 */
export function imageSize(base64: string): { width: number; height: number } | undefined {
	// Most formats keep their size within the first bytes; JPEG's frame header follows its metadata (EXIF, ICC profile).
	for (let length = 4096; ; length *= 4) {
		const whole = length >= base64.length;
		let binary: string;
		try {
			binary = atob(whole ? base64 : base64.slice(0, length));
		} catch {
			return undefined;
		}
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
		const size = sizeOf(bytes);
		if (size !== "more") return size;
		if (whole) return undefined;
	}
}

/** The size, `undefined` for data that is no known image, or `"more"` when the header continues past `bytes`. */
function sizeOf(bytes: Uint8Array): { width: number; height: number } | undefined | "more" {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ascii = (offset: number, length: number) =>
		offset + length <= bytes.length ? String.fromCharCode(...bytes.subarray(offset, offset + length)) : "";
	const valid = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : undefined);
	if (bytes.length < 30) return "more";
	if (ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") return valid(view.getUint32(16), view.getUint32(20));
	if (ascii(0, 3) === "GIF") return valid(view.getUint16(6, true), view.getUint16(8, true));
	if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
		const chunk = ascii(12, 4);
		if (chunk === "VP8 ") return valid(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
		if (chunk === "VP8L") {
			const bits = view.getUint32(21, true);
			return valid((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
		}
		if (chunk === "VP8X")
			return valid((view.getUint32(24, true) & 0xffffff) + 1, (view.getUint32(27, true) & 0xffffff) + 1);
		return undefined;
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes, view);
	return undefined;
}

function jpegSize(bytes: Uint8Array, view: DataView): { width: number; height: number } | undefined | "more" {
	let rotated = false;
	let offset = 2;
	while (true) {
		if (offset + 9 > bytes.length) return "more";
		if (bytes[offset] !== 0xff) return undefined;
		const marker = bytes[offset + 1] ?? 0;
		// Fill bytes and markers without a length.
		if (marker === 0xff) {
			offset++;
			continue;
		}
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		const length = view.getUint16(offset + 2);
		// Start of frame (all but DHT, JPG and DAC, which share the range): precision, height, width.
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			const height = view.getUint16(offset + 5);
			const width = view.getUint16(offset + 7);
			if (width === 0 || height === 0) return undefined;
			return rotated ? { width: height, height: width } : { width, height };
		}
		if (marker === 0xda || marker === 0xd9) return undefined;
		if (marker === 0xe1) {
			if (offset + 2 + length > bytes.length) return "more";
			rotated = exifRotates(bytes, view, offset + 4, offset + 2 + length);
		}
		offset += 2 + length;
	}
}

/** Whether an APP1 segment's EXIF orientation turns the image by 90 degrees (orientations 5 to 8). */
function exifRotates(bytes: Uint8Array, view: DataView, start: number, end: number): boolean {
	if (String.fromCharCode(...bytes.subarray(start, start + 4)) !== "Exif") return false;
	const tiff = start + 6;
	if (tiff + 8 > end) return false;
	const little = bytes[tiff] === 0x49;
	const directory = tiff + view.getUint32(tiff + 4, little);
	if (directory + 2 > end) return false;
	const count = view.getUint16(directory, little);
	for (let index = 0; index < count; index++) {
		const tag = directory + 2 + index * 12;
		if (tag + 12 > end) return false;
		if (view.getUint16(tag, little) === 0x0112) return view.getUint16(tag + 8, little) >= 5;
	}
	return false;
}
