/**
 * Tests for image processing utilities using Photon.
 */

import { describe, expect, it } from "vitest";
import { convertToPng } from "../src/utils/image-convert.ts";
import { formatDimensionNote, resizeImage } from "../src/utils/image-resize.ts";

// Small 2x2 red PNG image (base64) - generated with ImageMagick
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==";

// Small 2x2 blue JPEG image (base64) - generated with ImageMagick
const TINY_JPEG =
	"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAGCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AD3VTB3/2Q==";

// 100x100 gray PNG
const MEDIUM_PNG_100x100 =
	"iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAAAAABVicqIAAAAAmJLR0QA/4ePzL8AAAAHdElNRQfqAQ4AMzkN2iH/AAAAP0lEQVRo3u3NQQEAAAQEMASXXYrz2gqst/Lm4ZBIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiSTsAP1cAUZeKtreAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAw6crMeAAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMJiXdMQAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDDPglUbAAAAAElFTkSuQmCC";

// 200x200 colored PNG
const LARGE_PNG_200x200 =
	"iVBORw0KGgoAAAANSUhEUgAAAMgAAADIEAIAAAByquWKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRP///////wlY99wAAAAHdElNRQfqAQ4AMzqU03BFAAAEEElEQVR42u3dvWqUURSF4XXMRAyIhSAWQvwnWtjaWusFx9bW1kKD/wELESxEiBjDjJdwysOC57mCXW32+zGcGbtdACpsdi+T8Xz1GABzm91xMl6sHgNgblzcT/Y+rh4DYG6cv0/2H64eA2BOEgI1fHQHaoyzbXIwVo8BMCcJgRqSEKgxft9Lrn5aPQbA3Ph1klw7Wj0GwJwkBGpYWECN8fMiub63egyAORcWUMPCAmqMH3eTG59XjwEwN76/S24+Wj0GwJwkBGpYWECN8e1fcmuzegyAORcWUMPCAmqM09vJ4dfVYwDMjS9vkzuPV48BMCcJgRqeSAZqjA/nyYP91WMAzElCoIYkBGqMk8Pk6HT1GABzm+3L5JIkBApIQqCGj+5AjfHmb/Lk8uoxAOYkIVBDEgI1LCygxmZ7nFyShEABFxZQw8ICaozXf5KnV1aPATDnwgJqWFhADQsLqOFnDUANFxZQw8ICaoxXZ8mzg9VjAMy5sIAaFhZQw3tYQA1/QgHUkIRADUkI1JCEQA1JCNSQhEANFxZQwzcsoIYkBGpIQqCGJARqSEKghiQEalhYQA1/QgHUcGEBNSwsoIYkBGq4sIAaFhZQw8ICaviGBdRwYQE1LCyghiQEariwgBoWFlDDe1hADS+OAjUkIVBDEgI1JCFQQxICNSQhUMOFBdTwDQuoIQmBGpIQqCEJgRqSEKghCYEaFhZQw4ujQA0XFlDDwgJqSEKghgsLqGFhATUsLKCGb1hADRcWUMPCAmpIQqCGCwuoYWEBNbyHBdTw4ihQQxICNSQhUEMSAjUkIVBDEgI1XFhADd+wgBqSEKghCYEakhCoIQmBGpIQqGFhATW8OArUcGEBNSwsoIYkBGq4sIAaFhZQw8ICaviGBdRwYQE1LCyghiQEariwgBoWFlDDe1hADS+OAjUkIVBDEgI1JCFQQxICNSQhUMOFBdTwDQuoIQmBGpIQqCEJgRqSEKghCYEa49lB8ups9RgAc14cBWpIQqCGhQXUkIRADRcWUMPCAmqMp1eS139WjwEw5xsWUEMSAjUsLKCGJARquLCAGhYWUGM8uZy8+bt6DIA5L44CNSQhUMMTyUCNcXSanByuHgNgThICNSQhUGM82E8+nK8eA2DOzxqAGpIQqDHuPE6+vF09BsDcOPyanN5ePQbAnCQEavgdFlBj3Nok3/6tHgNgzoujQA1JCNQYNx8l39+tHgNgbtz4nPy4u3oMgDlJCNSwsIAa4/pe8vNi9RgAc37WANSQhECNce0o+XWyegyAuXH1U/L73uoxAOYkIVDDwgJqjIORnG1XjwEw508ogBqSEKgx9h8m5+9XjwEwN/Y+Jhf3V48BMCcJgRpjPE+2x6vHAJgbSbLbrR4DYO4/GqiSgXN+ksgAAAAldEVYdGRhdGU6Y3JlYXRlADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDDpysx4AAAAJXRFWHRkYXRlOm1vZGlmeQAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwmJd0xAAAACh0RVh0ZGF0ZTp0aW1lc3RhbXAAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMM+CVRsAAAAASUVORK5CYII=";

function imageBytes(base64Data: string): Uint8Array {
	return Buffer.from(base64Data, "base64");
}

describe("convertToPng", () => {
	it("should return original data for PNG input", async () => {
		const result = await convertToPng(TINY_PNG, "image/png");
		expect(result).not.toBeNull();
		expect(result!.data).toBe(TINY_PNG);
		expect(result!.mimeType).toBe("image/png");
	});

	it("should convert JPEG to PNG", async () => {
		const result = await convertToPng(TINY_JPEG, "image/jpeg");
		expect(result).not.toBeNull();
		expect(result!.mimeType).toBe("image/png");
		// Result should be valid base64
		expect(() => Buffer.from(result!.data, "base64")).not.toThrow();
		// PNG magic bytes
		const buffer = Buffer.from(result!.data, "base64");
		expect(buffer[0]).toBe(0x89);
		expect(buffer[1]).toBe(0x50); // 'P'
		expect(buffer[2]).toBe(0x4e); // 'N'
		expect(buffer[3]).toBe(0x47); // 'G'
	});
});

describe("resizeImage", () => {
	it("should keep caller input bytes intact", async () => {
		const input = new Uint8Array(imageBytes(TINY_PNG));
		const originalByteLength = input.byteLength;
		const originalFirstByte = input[0];

		const result = await resizeImage(input, "image/png", {
			maxWidth: 100,
			maxHeight: 100,
			maxBytes: 1024 * 1024,
		});

		expect(result).not.toBeNull();
		expect(input.byteLength).toBe(originalByteLength);
		expect(input[0]).toBe(originalFirstByte);
	});

	it("should return original image if within limits", async () => {
		const result = await resizeImage(imageBytes(TINY_PNG), "image/png", {
			maxWidth: 100,
			maxHeight: 100,
			maxBytes: 1024 * 1024,
		});

		expect(result).not.toBeNull();
		expect(result!.wasResized).toBe(false);
		expect(result!.data).toBe(TINY_PNG);
		expect(result!.originalWidth).toBe(2);
		expect(result!.originalHeight).toBe(2);
		expect(result!.width).toBe(2);
		expect(result!.height).toBe(2);
	});

	it("should resize image exceeding dimension limits", async () => {
		const result = await resizeImage(imageBytes(MEDIUM_PNG_100x100), "image/png", {
			maxWidth: 50,
			maxHeight: 50,
			maxBytes: 1024 * 1024,
		});

		expect(result).not.toBeNull();
		expect(result!.wasResized).toBe(true);
		expect(result!.originalWidth).toBe(100);
		expect(result!.originalHeight).toBe(100);
		expect(result!.width).toBeLessThanOrEqual(50);
		expect(result!.height).toBeLessThanOrEqual(50);
	});

	it("should resize image exceeding byte limit", async () => {
		const originalBuffer = Buffer.from(LARGE_PNG_200x200, "base64");
		const originalSize = originalBuffer.length;

		// Set maxBytes to less than the original encoded image size
		const result = await resizeImage(imageBytes(LARGE_PNG_200x200), "image/png", {
			maxWidth: 2000,
			maxHeight: 2000,
			maxBytes: Math.floor(LARGE_PNG_200x200.length * 0.9),
		});

		// Should have tried to reduce size
		expect(result).not.toBeNull();
		const resultBuffer = Buffer.from(result!.data, "base64");
		expect(resultBuffer.length).toBeLessThan(originalSize);
		expect(result!.data.length).toBeLessThan(LARGE_PNG_200x200.length);
	});

	it("should return null when image cannot be resized below maxBytes", async () => {
		const result = await resizeImage(imageBytes(LARGE_PNG_200x200), "image/png", {
			maxWidth: 2000,
			maxHeight: 2000,
			maxBytes: 1,
		});

		expect(result).toBeNull();
	});

	it("should handle JPEG input", async () => {
		const result = await resizeImage(imageBytes(TINY_JPEG), "image/jpeg", {
			maxWidth: 100,
			maxHeight: 100,
			maxBytes: 1024 * 1024,
		});

		expect(result).not.toBeNull();
		expect(result!.wasResized).toBe(false);
		expect(result!.originalWidth).toBe(2);
		expect(result!.originalHeight).toBe(2);
	});
});

describe("formatDimensionNote", () => {
	it("should return undefined for non-resized images", () => {
		const note = formatDimensionNote({
			data: "",
			mimeType: "image/png",
			originalWidth: 100,
			originalHeight: 100,
			width: 100,
			height: 100,
			wasResized: false,
		});
		expect(note).toBeUndefined();
	});

	it("should return formatted note for resized images", () => {
		const note = formatDimensionNote({
			data: "",
			mimeType: "image/png",
			originalWidth: 2000,
			originalHeight: 1000,
			width: 1000,
			height: 500,
			wasResized: true,
		});
		expect(note).toContain("original 2000x1000");
		expect(note).toContain("displayed at 1000x500");
		expect(note).toContain("2.00"); // scale factor
	});
});
