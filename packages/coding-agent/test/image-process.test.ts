import { describe, expect, it } from "vitest";
import { processImage } from "../src/utils/image-process.ts";
import { detectSupportedImageMimeType } from "../src/utils/mime.ts";

// Small 2x2 red PNG image (base64) - generated with ImageMagick
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==";

// Small 2x2 blue JPEG image (base64) - generated with ImageMagick
const TINY_JPEG =
	"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAGCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AD3VTB3/2Q==";

function createTinyBmp1x1Red24bpp(): Buffer {
	const buffer = Buffer.alloc(58);
	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(buffer.length, 2);
	buffer.writeUInt32LE(54, 10);
	buffer.writeUInt32LE(40, 14);
	buffer.writeInt32LE(1, 18);
	buffer.writeInt32LE(1, 22);
	buffer.writeUInt16LE(1, 26);
	buffer.writeUInt16LE(24, 28);
	buffer.writeUInt32LE(0, 30);
	buffer.writeUInt32LE(4, 34);
	buffer[56] = 0xff;
	return buffer;
}

function expectPngMagic(base64Data: string): void {
	const buffer = Buffer.from(base64Data, "base64");
	expect(buffer[0]).toBe(0x89);
	expect(buffer[1]).toBe(0x50);
	expect(buffer[2]).toBe(0x4e);
	expect(buffer[3]).toBe(0x47);
}

function expectJpegMagic(base64Data: string): void {
	const buffer = Buffer.from(base64Data, "base64");
	expect(buffer[0]).toBe(0xff);
	expect(buffer[1]).toBe(0xd8);
	expect(buffer[2]).toBe(0xff);
}

function createWebpMagicBytes(): Buffer {
	const buffer = Buffer.alloc(12);
	buffer.write("RIFF", 0, "ascii");
	buffer.write("WEBP", 8, "ascii");
	return buffer;
}

describe("image processing pipeline", () => {
	it.each(["GIF87a", "GIF89a"])("detects the complete %s signature", (signature) => {
		expect(detectSupportedImageMimeType(Buffer.from(signature, "ascii"))).toBe("image/gif");
	});

	it("detects BMP files from magic bytes", () => {
		expect(detectSupportedImageMimeType(createTinyBmp1x1Red24bpp())).toBe("image/bmp");
	});

	it("converts BMP files to PNG attachments when auto-resize is disabled", async () => {
		const result = await processImage(createTinyBmp1x1Red24bpp(), "image/bmp", { autoResizeImages: false });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.mimeType).toBe("image/png");
		expect(result.hints).toContain("[Image converted from image/bmp to image/png.]");
		expectPngMagic(result.data);
	});

	it("converts BMP files before auto-resizing", async () => {
		const result = await processImage(createTinyBmp1x1Red24bpp(), "image/bmp");

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.mimeType).toBe("image/png");
		expect(result.hints).toContain("[Image converted from image/bmp to image/png.]");
		expectPngMagic(result.data);
	});

	it("uses PNG magic bytes instead of a JPEG label when auto-resize is disabled", async () => {
		const result = await processImage(Buffer.from(TINY_PNG, "base64"), "image/jpeg", {
			autoResizeImages: false,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.mimeType).toBe("image/png");
		expectPngMagic(result.data);
	});

	it("uses PNG magic bytes instead of a JPEG label when auto-resizing", async () => {
		const result = await processImage(Buffer.from(TINY_PNG, "base64"), "image/jpeg");

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.mimeType).toBe("image/png");
		expectPngMagic(result.data);
	});

	it("uses JPEG magic bytes instead of a PNG label when auto-resize is disabled", async () => {
		const result = await processImage(Buffer.from(TINY_JPEG, "base64"), "image/png", {
			autoResizeImages: false,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.mimeType).toBe("image/jpeg");
		expectJpegMagic(result.data);
	});

	it("uses JPEG magic bytes instead of a PNG label when auto-resizing", async () => {
		const result = await processImage(Buffer.from(TINY_JPEG, "base64"), "image/png");

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.mimeType).toBe("image/jpeg");
		expectJpegMagic(result.data);
	});

	it("uses GIF and WebP magic bytes instead of a mismatched label", async () => {
		const gif = await processImage(Buffer.from("GIF89a", "ascii"), "image/png", { autoResizeImages: false });
		const webp = await processImage(createWebpMagicBytes(), "image/png", { autoResizeImages: false });

		expect(gif.ok).toBe(true);
		expect(webp.ok).toBe(true);
		if (!gif.ok || !webp.ok) return;
		expect(gif.mimeType).toBe("image/gif");
		expect(webp.mimeType).toBe("image/webp");
	});
});
