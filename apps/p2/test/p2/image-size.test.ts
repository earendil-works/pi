// The transcript reserves an image's box from its header (src/web/image-size.ts), so decoding never moves the reader.
import assert from "node:assert/strict";
import { it } from "node:test";
import { imageSize } from "../../src/web/image-size.ts";

const base64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const u16be = (value: number) => [value >> 8, value & 0xff];
const u16le = (value: number) => [value & 0xff, value >> 8];
const u32be = (value: number) => [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
const u32le = (value: number) => u32be(value).reverse();
const u24le = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
const padding = (count: number) => new Array<number>(count).fill(0);

const png = (width: number, height: number) => [
	0x89,
	...ascii("PNG\r\n\x1a\n"),
	...u32be(13),
	...ascii("IHDR"),
	...u32be(width),
	...u32be(height),
	...padding(20),
];
const webp = (chunk: string, body: number[]) => [
	...ascii("RIFF"),
	...u32le(100),
	...ascii("WEBP"),
	...ascii(chunk),
	...body,
	...padding(20),
];
/** A JPEG with an APP1 segment (EXIF orientation, padded to `metadata` bytes) before its frame header. */
const jpeg = (width: number, height: number, orientation: number, metadata = 0) => {
	const tiff = [...ascii("MM"), ...u16be(42), ...u32be(8), ...u16be(1), ...u16be(0x0112), ...u16be(3)];
	const exif = [...ascii("Exif"), 0, 0, ...tiff, ...u32be(1), ...u16be(orientation), 0, 0, ...padding(metadata)];
	return [
		0xff,
		0xd8,
		0xff,
		0xe1,
		...u16be(exif.length + 2),
		...exif,
		0xff,
		0xc0,
		...u16be(17),
		8,
		...u16be(height),
		...u16be(width),
		...padding(20),
	];
};

it("reads the size of PNG, GIF, WebP and JPEG images from their header", () => {
	assert.deepEqual(imageSize(base64(png(1280, 720))), { width: 1280, height: 720 });
	assert.deepEqual(imageSize(base64([...ascii("GIF89a"), ...u16le(64), ...u16le(48), ...padding(30)])), {
		width: 64,
		height: 48,
	});
	assert.deepEqual(imageSize(base64(webp("VP8X", [...u32le(10), 0, 0, 0, 0, ...u24le(1919), ...u24le(1079)]))), {
		width: 1920,
		height: 1080,
	});
	const lossless = (799 | (599 << 14)) >>> 0;
	assert.deepEqual(imageSize(base64(webp("VP8L", [...u32le(10), 0x2f, ...u32le(lossless)]))), {
		width: 800,
		height: 600,
	});
	assert.deepEqual(
		imageSize(base64(webp("VP8 ", [...u32le(10), 0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(640), ...u16le(480)]))),
		{ width: 640, height: 480 },
	);
	assert.deepEqual(imageSize(base64(jpeg(4032, 3024, 1))), { width: 4032, height: 3024 });
});

it("applies a JPEG's EXIF rotation and finds its frame header past large metadata", () => {
	// Orientation 6 (a phone photo held upright) is displayed turned by 90 degrees.
	assert.deepEqual(imageSize(base64(jpeg(4032, 3024, 6, 60_000))), { width: 3024, height: 4032 });
});

it("gives no size for data that is no known image", () => {
	assert.equal(imageSize(base64(ascii("not an image at all, just some text"))), undefined);
	assert.equal(imageSize("%%%"), undefined);
	assert.equal(imageSize(base64([0xff, 0xd8, 0xff, 0xe1, ...u16be(9000), ...padding(100)])), undefined);
});
