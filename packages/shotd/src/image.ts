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

export interface DiffResult {
	passed: boolean;
	percentChanged: number;
	changedPixels: number;
	totalPixels: number;
	diffPath?: string;
}

export async function diffImages(
	a: Buffer,
	b: Buffer,
	opts: { threshold?: number; diffPath?: string } = {},
): Promise<DiffResult> {
	const threshold = opts.threshold ?? 0.001;
	// Decode both to raw RGBA at same size (resize b to a if needed).
	const metaA = await sharp(a).metadata();
	const w = metaA.width ?? 0;
	const h = metaA.height ?? 0;
	const rawA = await sharp(a).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const rawB = await sharp(b).ensureAlpha().resize(w, h, { fit: "fill" }).raw().toBuffer();
	if (rawA.data.length !== rawB.length) throw new Error("shotd diff: size mismatch");
	const total = w * h;
	let changed = 0;
	for (let i = 0; i < rawA.data.length; i += 4) {
		const dr = Math.abs(rawA.data[i]! - rawB[i]!);
		const dg = Math.abs(rawA.data[i + 1]! - rawB[i + 1]!);
		const db = Math.abs(rawA.data[i + 2]! - rawB[i + 2]!);
		const da = Math.abs(rawA.data[i + 3]! - rawB[i + 3]!);
		if (dr > 8 || dg > 8 || db > 8 || da > 8) changed++;
	}
	const percent = total ? changed / total : 0;
	const passed = percent <= threshold;
	let diffPath: string | undefined;
	if (opts.diffPath) {
		// Build diff image: red where changed.
		const diffRaw = Buffer.alloc(rawA.data.length);
		for (let i = 0; i < rawA.data.length; i += 4) {
			const dr = Math.abs(rawA.data[i]! - rawB[i]!);
			const dg = Math.abs(rawA.data[i + 1]! - rawB[i + 1]!);
			const db = Math.abs(rawA.data[i + 2]! - rawB[i + 2]!);
			const ch = dr > 8 || dg > 8 || db > 8;
			diffRaw[i] = ch ? 255 : rawA.data[i]!;
			diffRaw[i + 1] = ch ? 0 : rawA.data[i + 1]!;
			diffRaw[i + 2] = ch ? 0 : rawA.data[i + 2]!;
			diffRaw[i + 3] = 255;
		}
		const { writeFileSync } = await import("node:fs");
		const png = await sharp(diffRaw, { raw: { width: w, height: h, channels: 4 } })
			.png()
			.toBuffer();
		writeFileSync(opts.diffPath, png);
		diffPath = opts.diffPath;
	}
	return { passed, percentChanged: percent, changedPixels: changed, totalPixels: total, diffPath };
}

export async function cropForZoom(
	buf: Buffer,
	region: { x: number; y: number; width: number; height: number },
	opts: { maxLongEdge?: number } = {},
): Promise<Buffer> {
	const maxLongEdge = opts.maxLongEdge ?? 1568;
	const cropped = await sharp(buf).extract({
		left: Math.round(region.x),
		top: Math.round(region.y),
		width: Math.round(region.width),
		height: Math.round(region.height),
	});
	const meta = await cropped.metadata();
	const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
	if (longEdge <= maxLongEdge) return Buffer.from(await cropped.toBuffer());
	return Buffer.from(await cropped.resize({ width: maxLongEdge, height: maxLongEdge, fit: "inside" }).toBuffer());
}
