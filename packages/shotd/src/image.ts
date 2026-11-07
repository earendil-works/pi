// Image pipeline: 1920x1080 @ DSF2 → 3840x2160 archive (WebP) + model view resize.
// Depends on sharp (already in fork lockfile for durable image processing).
// If sharp is unavailable, falls back to PNG archive (callers still get valid dimensions).
import sharp from "sharp";

export const VIEWPORT_WIDTH = 1920;
export const VIEWPORT_HEIGHT = 1080;
export const DSF = 2; // device scale factor → cover 3840x2160
export const ARCHIVE_WIDTH = VIEWPORT_WIDTH * DSF;
export const ARCHIVE_HEIGHT = VIEWPORT_HEIGHT * DSF;

export interface EncodeOptions {
	quality?: number; // WebP 0-100
	lossless?: boolean;
	maxLongEdge?: number; // model-view limit (default 1568)
}

export async function encodeArchive(
	png: Buffer,
	opts: EncodeOptions = {},
): Promise<{ buf: Buffer; format: string; width: number; height: number }> {
	const quality = opts.quality ?? 85;
	const lossless = opts.lossless ?? false;
	const width = ARCHIVE_WIDTH;
	const height = ARCHIVE_HEIGHT;
	try {
		const buf = lossless
			? Buffer.from(await sharp(png).webp({ lossless: true }).toBuffer())
			: Buffer.from(await sharp(png).webp({ quality }).toBuffer());
		return { buf, format: "webp", width, height };
	} catch {
		// Fallback: keep PNG (valid, dimensions preserved). Caller records format.
		return { buf: png, format: "png", width, height };
	}
}

export async function resizeForModel(
	buf: Buffer,
	format: string,
	opts: EncodeOptions = {},
	width = ARCHIVE_WIDTH,
	height = ARCHIVE_HEIGHT,
): Promise<Buffer> {
	const maxLongEdge = opts.maxLongEdge ?? 1568;
	const longEdge = Math.max(width, height);
	if (longEdge <= maxLongEdge) return buf;
	const scale = maxLongEdge / longEdge;
	const w = Math.round(width * scale);
	const h = Math.round(height * scale);
	try {
		return Buffer.from(await sharp(buf).resize(w, h).webp({ quality: 80 }).toBuffer());
	} catch {
		return Buffer.from(await sharp(buf).resize(w, h).png().toBuffer());
	}
}

export function isValidWebP(buf: Buffer): boolean {
	return (
		buf.length >= 12 &&
		buf.subarray(0, 4).toString("ascii") === "RIFF" &&
		buf.subarray(8, 12).toString("ascii") === "WEBP"
	);
}

export function dimensions(buf: Buffer): { width: number; height: number } | null {
	// PNG IHDR fast path.
	if (buf.length >= 24 && buf.subarray(1, 4).toString("ascii") === "PNG") {
		return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
	}
	return null;
}
