import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { decodePng, encodeSixelFromRgba, quantize, type RgbaImage, resizeImage } from "../src/sixel.ts";
import { sixelRowsForHeight } from "../src/terminal-image.ts";

/**
 * Minimal sixel parser used to verify the encoder's output independently of the
 * encoder's own bookkeeping. Supports the subset we emit: raster attributes,
 * palette definitions, RLE runs, `$` (carriage return) and `-` (newline).
 */
function decodeSixel(sequence: string): RgbaImage {
	const match = /^\x1bP[0-9;]*q(?:"(\d+);(\d+);(\d+);(\d+))?/.exec(sequence);
	assert.ok(match, "sequence must start with a sixel DCS introducer");
	const width = Number(match[3]);
	const height = Number(match[4]);

	const data = new Uint8Array(width * height * 4);
	const palette = new Map<number, [number, number, number]>();
	let color = 0;
	let x = 0;
	let bandTop = 0;

	let i = match[0].length;
	const end = sequence.indexOf("\x1b\\");
	while (i < (end === -1 ? sequence.length : end)) {
		const char = sequence[i];

		if (char === "#") {
			const rest = /^#(\d+)(?:;2;(\d+);(\d+);(\d+))?/.exec(sequence.slice(i));
			assert.ok(rest, `bad colour introducer at ${i}`);
			color = Number(rest[1]);
			if (rest[2] !== undefined) {
				palette.set(color, [
					Math.round((Number(rest[2]) * 255) / 100),
					Math.round((Number(rest[3]) * 255) / 100),
					Math.round((Number(rest[4]) * 255) / 100),
				]);
			}
			i += rest[0].length;
			continue;
		}

		if (char === "$") {
			x = 0;
			i++;
			continue;
		}

		if (char === "-") {
			x = 0;
			bandTop += 6;
			i++;
			continue;
		}

		let repeat = 1;
		if (char === "!") {
			const rest = /^!(\d+)/.exec(sequence.slice(i));
			assert.ok(rest, `bad repeat at ${i}`);
			repeat = Number(rest[1]);
			i += rest[0].length;
		}

		const bits = sequence.charCodeAt(i) - 63;
		assert.ok(bits >= 0 && bits < 64, `bad sixel data byte at ${i}`);
		i++;

		for (let r = 0; r < repeat; r++, x++) {
			if (x >= width) continue;
			for (let row = 0; row < 6; row++) {
				if ((bits & (1 << row)) === 0) continue;
				const y = bandTop + row;
				if (y >= height) continue;
				const rgb = palette.get(color) ?? [0, 0, 0];
				const dst = (y * width + x) * 4;
				data[dst] = rgb[0];
				data[dst + 1] = rgb[1];
				data[dst + 2] = rgb[2];
				data[dst + 3] = 255;
			}
		}
	}

	return { width, height, data };
}

function solidImage(width: number, height: number, rgba: [number, number, number, number]): RgbaImage {
	const data = new Uint8Array(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		data.set(rgba, i * 4);
	}
	return { width, height, data };
}

test("encodes a solid image that round-trips to the same colour", () => {
	const image = solidImage(10, 8, [200, 40, 90, 255]);
	const decoded = decodeSixel(encodeSixelFromRgba(image));

	assert.equal(decoded.width, 10);
	assert.equal(decoded.height, 8);
	for (let i = 0; i < decoded.width * decoded.height; i++) {
		// Palette components are stored as percentages, so allow rounding slop.
		assert.ok(Math.abs(decoded.data[i * 4] - 200) <= 3, `red channel at ${i}`);
		assert.ok(Math.abs(decoded.data[i * 4 + 1] - 40) <= 3, `green channel at ${i}`);
		assert.ok(Math.abs(decoded.data[i * 4 + 2] - 90) <= 3, `blue channel at ${i}`);
	}
});

test("emits a DCS sequence with transparent background and raster attributes", () => {
	const sequence = encodeSixelFromRgba(solidImage(4, 4, [1, 2, 3, 255]));
	assert.ok(sequence.startsWith('\x1bP0;1;0q"1;1;4;4'), `unexpected header: ${JSON.stringify(sequence.slice(0, 24))}`);
	assert.ok(sequence.endsWith("\x1b\\"));
});

test("leaves transparent pixels unpainted", () => {
	const image = solidImage(8, 6, [255, 255, 255, 0]);
	// One opaque pixel in the middle of a fully transparent image.
	image.data.set([10, 220, 30, 255], (2 * 8 + 3) * 4);

	const decoded = decodeSixel(encodeSixelFromRgba(image));
	for (let y = 0; y < 6; y++) {
		for (let x = 0; x < 8; x++) {
			const alpha = decoded.data[(y * 8 + x) * 4 + 3];
			assert.equal(alpha, y === 2 && x === 3 ? 255 : 0, `pixel ${x},${y}`);
		}
	}
});

test("round-trips a multi-band image with several colours", () => {
	const width = 17;
	const height = 15; // not a multiple of 6, exercises the partial last band
	const image = solidImage(width, height, [0, 0, 0, 255]);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const dst = (y * width + x) * 4;
			image.data[dst] = (x * 15) % 256;
			image.data[dst + 1] = (y * 17) % 256;
			image.data[dst + 2] = 128;
		}
	}

	const decoded = decodeSixel(encodeSixelFromRgba(image));
	assert.equal(decoded.width, width);
	assert.equal(decoded.height, height);
	for (let i = 0; i < width * height; i++) {
		assert.equal(decoded.data[i * 4 + 3], 255, `pixel ${i} should be painted`);
		assert.ok(Math.abs(decoded.data[i * 4] - image.data[i * 4]) <= 24, `red channel at ${i}`);
		assert.ok(Math.abs(decoded.data[i * 4 + 1] - image.data[i * 4 + 1]) <= 24, `green channel at ${i}`);
	}
});

test("run-length encodes long identical spans", () => {
	const sequence = encodeSixelFromRgba(solidImage(200, 6, [10, 20, 30, 255]));
	assert.match(sequence, /!\d{2,}/);
	// A 200px band must not be spelled out one character at a time.
	assert.ok(sequence.length < 200, `expected compact output, got ${sequence.length} bytes`);
});

test("quantizes down to the requested palette size", () => {
	const width = 64;
	const height = 64;
	const image = solidImage(width, height, [0, 0, 0, 255]);
	for (let i = 0; i < width * height; i++) {
		image.data[i * 4] = i % 256;
		image.data[i * 4 + 1] = (i * 7) % 256;
		image.data[i * 4 + 2] = (i * 13) % 256;
	}

	const result = quantize(image, 16);
	assert.ok(result.palette.length <= 16, `palette too large: ${result.palette.length}`);
	assert.ok(result.palette.length > 1, "expected more than one colour");
	for (let i = 0; i < result.indices.length; i++) {
		assert.ok(result.indices[i] >= 0 && result.indices[i] < result.palette.length, `index ${i} out of range`);
	}
});

test("resizes with a box filter and keeps colours stable", () => {
	const resized = resizeImage(solidImage(40, 40, [90, 180, 240, 255]), 10, 10);
	assert.equal(resized.width, 10);
	assert.equal(resized.height, 10);
	for (let i = 0; i < 100; i++) {
		assert.equal(resized.data[i * 4], 90);
		assert.equal(resized.data[i * 4 + 1], 180);
		assert.equal(resized.data[i * 4 + 2], 240);
		assert.equal(resized.data[i * 4 + 3], 255);
	}
});

test("rejects images it cannot decode instead of throwing", () => {
	assert.equal(decodePng(Buffer.from("not a png")), null);
	assert.equal(decodePng(Buffer.alloc(0)), null);
});

// PNG decoding is verified against ImageMagick when available, so the decoder is
// checked against a real encoder rather than only against our own fixtures.
function makePngWithImageMagick(args: string[]): Buffer | null {
	try {
		return execFileSync("magick", [...args, "png:-"], { maxBuffer: 32 * 1024 * 1024 });
	} catch {
		return null;
	}
}

test("decodes PNG variants produced by ImageMagick", () => {
	const variants: Array<{ name: string; args: string[] }> = [
		{ name: "truecolor", args: ["-size", "12x9", "gradient:red-blue", "-define", "png:color-type=2"] },
		{ name: "truecolor-alpha", args: ["-size", "12x9", "gradient:red-blue", "-define", "png:color-type=6"] },
		{ name: "grayscale", args: ["-size", "12x9", "gradient:black-white", "-colorspace", "gray"] },
		{ name: "palette", args: ["-size", "12x9", "gradient:red-blue", "-colors", "8", "-define", "png:color-type=3"] },
	];

	for (const variant of variants) {
		const png = makePngWithImageMagick(variant.args);
		if (!png) {
			continue; // ImageMagick unavailable; skip rather than fail the suite
		}
		const decoded = decodePng(png);
		assert.ok(decoded, `${variant.name} should decode`);
		assert.equal(decoded.width, 12, `${variant.name} width`);
		assert.equal(decoded.height, 9, `${variant.name} height`);
		// A gradient must not decode to a single flat colour.
		const first = decoded.data.slice(0, 3).join(",");
		const last = decoded.data.slice((12 * 9 - 1) * 4, (12 * 9 - 1) * 4 + 3).join(",");
		assert.notEqual(first, last, `${variant.name} should not be flat`);
	}
});

test("sixelRowsForHeight matches tmux's sixel_size_in_cells", () => {
	// Exact multiples divide evenly; anything else rounds up.
	assert.equal(sixelRowsForHeight(32, 32), 1);
	assert.equal(sixelRowsForHeight(64, 32), 2);
	assert.equal(sixelRowsForHeight(320, 32), 10);
	assert.equal(sixelRowsForHeight(1, 32), 1);
	assert.equal(sixelRowsForHeight(33, 32), 2);
	assert.equal(sixelRowsForHeight(300, 32), 10);
});
