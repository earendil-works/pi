/**
 * Pure-TypeScript sixel encoding, used for inline images inside terminal
 * multiplexers.
 *
 * Unlike the kitty and iTerm2 protocols, sixel data is *parsed by tmux itself*
 * (when built with `--enable-sixel`) and stored in tmux's own grid, so tmux
 * owns the cells the image occupies and repaints/erases them correctly. That
 * makes it the only image protocol that survives a differentially-rendered TUI
 * running inside a multiplexer.
 *
 * Deliberately dependency-free: `@earendil-works/pi-tui` ships with two runtime
 * deps and we do not want to add a WASM image codec to that list. We therefore
 * decode PNG ourselves (via `node:zlib`) and fall back to the textual image
 * placeholder for formats we cannot decode.
 */

import { inflateSync } from "node:zlib";

export interface RgbaImage {
	width: number;
	height: number;
	/** RGBA, 8 bits per channel, row-major. */
	data: Uint8Array;
}

// ---------------------------------------------------------------------------
// PNG decoding
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CHANNELS_PER_COLOR_TYPE: Record<number, number> = {
	0: 1, // grayscale
	2: 3, // truecolor
	3: 1, // palette index
	4: 2, // grayscale + alpha
	6: 4, // truecolor + alpha
};

function paethPredictor(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	if (pb <= pc) return b;
	return c;
}

/**
 * Decode a PNG into RGBA. Returns null for anything we do not handle
 * (interlaced images, bit depths below 8), so callers can fall back.
 */
export function decodePng(buffer: Buffer): RgbaImage | null {
	try {
		if (buffer.length < 8) return null;
		for (let i = 0; i < PNG_SIGNATURE.length; i++) {
			if (buffer[i] !== PNG_SIGNATURE[i]) return null;
		}

		let offset = 8;
		let width = 0;
		let height = 0;
		let bitDepth = 0;
		let colorType = 0;
		let interlace = 0;
		let palette: Uint8Array | null = null;
		let paletteAlpha: Uint8Array | null = null;
		const idatChunks: Buffer[] = [];

		while (offset + 8 <= buffer.length) {
			const length = buffer.readUInt32BE(offset);
			const type = buffer.toString("ascii", offset + 4, offset + 8);
			const dataStart = offset + 8;
			const dataEnd = dataStart + length;
			if (dataEnd > buffer.length) return null;

			if (type === "IHDR") {
				width = buffer.readUInt32BE(dataStart);
				height = buffer.readUInt32BE(dataStart + 4);
				bitDepth = buffer[dataStart + 8];
				colorType = buffer[dataStart + 9];
				interlace = buffer[dataStart + 12];
			} else if (type === "PLTE") {
				palette = new Uint8Array(buffer.subarray(dataStart, dataEnd));
			} else if (type === "tRNS") {
				paletteAlpha = new Uint8Array(buffer.subarray(dataStart, dataEnd));
			} else if (type === "IDAT") {
				idatChunks.push(buffer.subarray(dataStart, dataEnd));
			} else if (type === "IEND") {
				break;
			}

			offset = dataEnd + 4; // skip CRC
		}

		if (width <= 0 || height <= 0 || idatChunks.length === 0) return null;
		// Adam7 interlacing is rare for agent-produced images (plots, screenshots);
		// bail out instead of carrying the deinterlacing code.
		if (interlace !== 0) return null;
		if (![1, 2, 4, 8, 16].includes(bitDepth)) return null;

		const channels = CHANNELS_PER_COLOR_TYPE[colorType];
		if (channels === undefined) return null;
		if (colorType === 3 && !palette) return null;

		// Filtering operates on whole bytes; for sub-byte depths the "pixel"
		// distance used by the left/up-left predictors rounds up to one byte.
		const bytesPerPixel = Math.max(1, Math.ceil((channels * bitDepth) / 8));
		const stride = Math.ceil((width * channels * bitDepth) / 8);

		const raw = inflateSync(Buffer.concat(idatChunks));
		if (raw.length < (stride + 1) * height) return null;

		// Un-filter scanlines in place into a contiguous buffer.
		const pixels = new Uint8Array(stride * height);
		let rawOffset = 0;
		for (let y = 0; y < height; y++) {
			const filter = raw[rawOffset++];
			const rowStart = y * stride;
			const prevStart = rowStart - stride;

			for (let x = 0; x < stride; x++) {
				const value = raw[rawOffset + x];
				const left = x >= bytesPerPixel ? pixels[rowStart + x - bytesPerPixel] : 0;
				const up = y > 0 ? pixels[prevStart + x] : 0;
				const upLeft = y > 0 && x >= bytesPerPixel ? pixels[prevStart + x - bytesPerPixel] : 0;

				let out: number;
				switch (filter) {
					case 0:
						out = value;
						break;
					case 1:
						out = value + left;
						break;
					case 2:
						out = value + up;
						break;
					case 3:
						out = value + ((left + up) >> 1);
						break;
					case 4:
						out = value + paethPredictor(left, up, upLeft);
						break;
					default:
						return null;
				}
				pixels[rowStart + x] = out & 0xff;
			}
			rawOffset += stride;
		}

		// Read one sample, honouring bit depth. For depths below 8 the samples are
		// packed most-significant-bit first within each byte.
		const maxValue = (1 << Math.min(bitDepth, 8)) - 1;
		const readSample = (rowStart: number, sampleIndex: number): number => {
			if (bitDepth === 8) return pixels[rowStart + sampleIndex];
			if (bitDepth === 16) return pixels[rowStart + sampleIndex * 2]; // high byte
			const bitOffset = sampleIndex * bitDepth;
			const byte = pixels[rowStart + (bitOffset >> 3)];
			const shift = 8 - bitDepth - (bitOffset & 7);
			return (byte >> shift) & maxValue;
		};
		// Grayscale samples must be stretched to the full 0-255 range; palette
		// indices must not be.
		const scaleGray = (value: number): number => (bitDepth >= 8 ? value : Math.round((value * 255) / maxValue));

		// Expand to RGBA.
		const rgba = new Uint8Array(width * height * 4);
		for (let y = 0; y < height; y++) {
			const rowStart = y * stride;
			for (let x = 0; x < width; x++) {
				const sample = x * channels;
				const dst = (y * width + x) * 4;
				let r: number;
				let g: number;
				let b: number;
				let a = 255;

				switch (colorType) {
					case 0:
						r = g = b = scaleGray(readSample(rowStart, sample));
						break;
					case 2:
						r = readSample(rowStart, sample);
						g = readSample(rowStart, sample + 1);
						b = readSample(rowStart, sample + 2);
						break;
					case 3: {
						const index = readSample(rowStart, sample);
						const p = palette as Uint8Array;
						r = p[index * 3] ?? 0;
						g = p[index * 3 + 1] ?? 0;
						b = p[index * 3 + 2] ?? 0;
						if (paletteAlpha && index < paletteAlpha.length) a = paletteAlpha[index];
						break;
					}
					case 4:
						r = g = b = scaleGray(readSample(rowStart, sample));
						a = scaleGray(readSample(rowStart, sample + 1));
						break;
					default:
						r = readSample(rowStart, sample);
						g = readSample(rowStart, sample + 1);
						b = readSample(rowStart, sample + 2);
						a = readSample(rowStart, sample + 3);
						break;
				}

				rgba[dst] = r;
				rgba[dst + 1] = g;
				rgba[dst + 2] = b;
				rgba[dst + 3] = a;
			}
		}

		return { width, height, data: rgba };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------

/**
 * Box-filter resize. Averaging (rather than nearest neighbour) matters a lot
 * here: images are typically downscaled several-fold to fit a terminal cell
 * grid, and nearest neighbour turns thin plot lines and text into aliased mush.
 */
export function resizeImage(image: RgbaImage, targetWidth: number, targetHeight: number): RgbaImage {
	const width = Math.max(1, Math.round(targetWidth));
	const height = Math.max(1, Math.round(targetHeight));
	if (width === image.width && height === image.height) return image;

	const out = new Uint8Array(width * height * 4);
	const xRatio = image.width / width;
	const yRatio = image.height / height;

	for (let y = 0; y < height; y++) {
		const srcY0 = Math.floor(y * yRatio);
		const srcY1 = Math.max(srcY0 + 1, Math.min(image.height, Math.ceil((y + 1) * yRatio)));

		for (let x = 0; x < width; x++) {
			const srcX0 = Math.floor(x * xRatio);
			const srcX1 = Math.max(srcX0 + 1, Math.min(image.width, Math.ceil((x + 1) * xRatio)));

			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let count = 0;

			for (let sy = srcY0; sy < srcY1; sy++) {
				for (let sx = srcX0; sx < srcX1; sx++) {
					const src = (sy * image.width + sx) * 4;
					const alpha = image.data[src + 3];
					// Weight colour by alpha so transparent pixels do not bleed
					// their (often black) colour into the average.
					r += image.data[src] * alpha;
					g += image.data[src + 1] * alpha;
					b += image.data[src + 2] * alpha;
					a += alpha;
					count++;
				}
			}

			const dst = (y * width + x) * 4;
			if (a > 0) {
				out[dst] = Math.round(r / a);
				out[dst + 1] = Math.round(g / a);
				out[dst + 2] = Math.round(b / a);
			}
			out[dst + 3] = count > 0 ? Math.round(a / count) : 0;
		}
	}

	return { width, height, data: out };
}

// ---------------------------------------------------------------------------
// Colour quantization (median cut)
// ---------------------------------------------------------------------------

export interface QuantizedImage {
	/** Palette entries as packed 0xRRGGBB. */
	palette: number[];
	/** One palette index per pixel, or -1 for transparent pixels. */
	indices: Int16Array;
	width: number;
	height: number;
}

interface ColorBox {
	pixels: Uint32Array;
	rMin: number;
	rMax: number;
	gMin: number;
	gMax: number;
	bMin: number;
	bMax: number;
}

function makeBox(pixels: Uint32Array): ColorBox {
	let rMin = 255;
	let rMax = 0;
	let gMin = 255;
	let gMax = 0;
	let bMin = 255;
	let bMax = 0;

	for (let i = 0; i < pixels.length; i++) {
		const value = pixels[i];
		const r = (value >> 16) & 0xff;
		const g = (value >> 8) & 0xff;
		const b = value & 0xff;
		if (r < rMin) rMin = r;
		if (r > rMax) rMax = r;
		if (g < gMin) gMin = g;
		if (g > gMax) gMax = g;
		if (b < bMin) bMin = b;
		if (b > bMax) bMax = b;
	}

	return { pixels, rMin, rMax, gMin, gMax, bMin, bMax };
}

function splitBox(box: ColorBox): [ColorBox, ColorBox] | null {
	if (box.pixels.length < 2) return null;

	const rRange = box.rMax - box.rMin;
	const gRange = box.gMax - box.gMin;
	const bRange = box.bMax - box.bMin;
	const shift = rRange >= gRange && rRange >= bRange ? 16 : gRange >= bRange ? 8 : 0;

	const sorted = Uint32Array.from(box.pixels).sort((a, b) => ((a >> shift) & 0xff) - ((b >> shift) & 0xff));
	const mid = sorted.length >> 1;
	if (mid === 0 || mid === sorted.length) return null;

	return [makeBox(sorted.subarray(0, mid)), makeBox(sorted.subarray(mid))];
}

/**
 * Median-cut quantization down to `maxColors`, with a 15-bit lookup cache for
 * the nearest-colour mapping (the naive map is O(pixels * palette)).
 */
export function quantize(image: RgbaImage, maxColors: number, alphaThreshold = 128): QuantizedImage {
	const pixelCount = image.width * image.height;
	const opaque: number[] = [];
	const indices = new Int16Array(pixelCount).fill(-1);

	for (let i = 0; i < pixelCount; i++) {
		if (image.data[i * 4 + 3] < alphaThreshold) continue;
		opaque.push((image.data[i * 4] << 16) | (image.data[i * 4 + 1] << 8) | image.data[i * 4 + 2]);
	}

	if (opaque.length === 0) {
		return { palette: [0], indices, width: image.width, height: image.height };
	}

	let boxes: ColorBox[] = [makeBox(Uint32Array.from(opaque))];
	while (boxes.length < maxColors) {
		// Split the box with the largest volume-weighted range first.
		let bestIndex = -1;
		let bestScore = 0;
		for (let i = 0; i < boxes.length; i++) {
			const box = boxes[i];
			if (box.pixels.length < 2) continue;
			const score =
				Math.max(box.rMax - box.rMin, box.gMax - box.gMin, box.bMax - box.bMin) * Math.log2(box.pixels.length + 1);
			if (score > bestScore) {
				bestScore = score;
				bestIndex = i;
			}
		}
		if (bestIndex < 0) break;

		const halves = splitBox(boxes[bestIndex]);
		if (!halves) break;
		boxes = [...boxes.slice(0, bestIndex), ...halves, ...boxes.slice(bestIndex + 1)];
	}

	const palette = boxes.map((box) => {
		let r = 0;
		let g = 0;
		let b = 0;
		for (let i = 0; i < box.pixels.length; i++) {
			const value = box.pixels[i];
			r += (value >> 16) & 0xff;
			g += (value >> 8) & 0xff;
			b += value & 0xff;
		}
		const n = box.pixels.length || 1;
		return ((Math.round(r / n) & 0xff) << 16) | ((Math.round(g / n) & 0xff) << 8) | (Math.round(b / n) & 0xff);
	});

	// 5 bits per channel cache: 32768 entries covering the whole RGB cube.
	const cache = new Int16Array(32768).fill(-1);
	for (let i = 0; i < pixelCount; i++) {
		const alpha = image.data[i * 4 + 3];
		if (alpha < alphaThreshold) continue;

		const r = image.data[i * 4];
		const g = image.data[i * 4 + 1];
		const b = image.data[i * 4 + 2];
		const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

		let best = cache[key];
		if (best < 0) {
			let bestDistance = Number.POSITIVE_INFINITY;
			for (let p = 0; p < palette.length; p++) {
				const dr = ((palette[p] >> 16) & 0xff) - r;
				const dg = ((palette[p] >> 8) & 0xff) - g;
				const db = (palette[p] & 0xff) - b;
				const distance = dr * dr + dg * dg + db * db;
				if (distance < bestDistance) {
					bestDistance = distance;
					best = p;
				}
			}
			cache[key] = best;
		}
		indices[i] = best;
	}

	return { palette, indices, width: image.width, height: image.height };
}

// ---------------------------------------------------------------------------
// Sixel encoding
// ---------------------------------------------------------------------------

export interface SixelEncodeOptions {
	/** Maximum palette size. Most terminals expose 256 colour registers. */
	maxColors?: number;
}

/** Run-length encode a repeated sixel character, per the DEC sixel grammar. */
function emitRun(char: string, count: number): string {
	if (count <= 0) return "";
	if (count <= 3) return char.repeat(count);
	return `!${count}${char}`;
}

/**
 * Encode an RGBA image as a sixel DCS sequence.
 *
 * Uses P2=1 ("transparent background"), so pixels below the alpha threshold
 * leave the terminal background untouched instead of being painted black.
 */
export function encodeSixelFromRgba(image: RgbaImage, options: SixelEncodeOptions = {}): string {
	const maxColors = Math.max(2, Math.min(256, options.maxColors ?? 256));
	const { palette, indices, width, height } = quantize(image, maxColors);

	const parts: string[] = [`\x1bP0;1;0q"1;1;${width};${height}`];

	for (let i = 0; i < palette.length; i++) {
		// Sixel colour components are percentages (0-100), not 0-255.
		const r = Math.round((((palette[i] >> 16) & 0xff) * 100) / 255);
		const g = Math.round((((palette[i] >> 8) & 0xff) * 100) / 255);
		const b = Math.round(((palette[i] & 0xff) * 100) / 255);
		parts.push(`#${i};2;${r};${g};${b}`);
	}

	const bandCount = Math.ceil(height / 6);
	const bits = new Uint8Array(width);

	for (let band = 0; band < bandCount; band++) {
		const y0 = band * 6;
		const rowCount = Math.min(6, height - y0);

		// Which palette entries actually appear in this band?
		const used = new Set<number>();
		for (let row = 0; row < rowCount; row++) {
			const rowStart = (y0 + row) * width;
			for (let x = 0; x < width; x++) {
				const index = indices[rowStart + x];
				if (index >= 0) used.add(index);
			}
		}

		let first = true;
		for (const colorIndex of used) {
			bits.fill(0);
			for (let row = 0; row < rowCount; row++) {
				const rowStart = (y0 + row) * width;
				const bit = 1 << row;
				for (let x = 0; x < width; x++) {
					if (indices[rowStart + x] === colorIndex) bits[x] |= bit;
				}
			}

			// `$` is a carriage return within the band: it lets the next colour
			// overprint the same six-pixel-tall strip from column zero.
			if (!first) parts.push("$");
			first = false;
			parts.push(`#${colorIndex}`);

			let runChar = "";
			let runLength = 0;
			let pending = "";
			for (let x = 0; x < width; x++) {
				const char = String.fromCharCode(63 + bits[x]);
				if (char === runChar) {
					runLength++;
				} else {
					pending += emitRun(runChar, runLength);
					runChar = char;
					runLength = 1;
				}
			}
			// Trailing empty pixels need no output; the band is implicitly blank.
			if (runChar !== "?") pending += emitRun(runChar, runLength);
			parts.push(pending);
		}

		if (band < bandCount - 1) parts.push("-");
	}

	parts.push("\x1b\\");
	return parts.join("");
}
