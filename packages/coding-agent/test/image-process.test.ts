import { describe, expect, it } from "vitest";
import { processImage } from "../src/utils/image-process.ts";
import { detectSupportedImageMimeType } from "../src/utils/mime.ts";

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

describe("image processing pipeline", () => {
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
});
