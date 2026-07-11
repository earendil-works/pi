import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { processFileArguments } from "../src/cli/file-processor.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createReadTool } from "../src/core/tools/read.ts";

// 1x1 red PNG image as base64 (smallest valid PNG)
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

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

describe("blockImages setting", () => {
	describe("SettingsManager", () => {
		it("should default blockImages to false", () => {
			const manager = SettingsManager.inMemory({});
			expect(manager.getBlockImages()).toBe(false);
		});

		it("should return true when blockImages is set to true", () => {
			const manager = SettingsManager.inMemory({ images: { blockImages: true } });
			expect(manager.getBlockImages()).toBe(true);
		});

		it("should persist blockImages setting via setBlockImages", () => {
			const manager = SettingsManager.inMemory({});
			expect(manager.getBlockImages()).toBe(false);

			manager.setBlockImages(true);
			expect(manager.getBlockImages()).toBe(true);

			manager.setBlockImages(false);
			expect(manager.getBlockImages()).toBe(false);
		});

		it("should handle blockImages alongside autoResize", () => {
			const manager = SettingsManager.inMemory({
				images: { autoResize: true, blockImages: true },
			});
			expect(manager.getImageAutoResize()).toBe(true);
			expect(manager.getBlockImages()).toBe(true);
		});
	});

	describe("Read tool", () => {
		let testDir: string;

		beforeEach(() => {
			testDir = join(tmpdir(), `block-images-test-${Date.now()}`);
			mkdirSync(testDir, { recursive: true });
		});

		afterEach(() => {
			rmSync(testDir, { recursive: true, force: true });
		});

		it("should always read images (filtering happens at convertToLlm layer)", async () => {
			// Create test image
			const imagePath = join(testDir, "test.png");
			writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

			const tool = createReadTool(testDir);
			const result = await tool.execute("test-1", { path: imagePath });

			// Should have text note + image content
			expect(result.content.length).toBeGreaterThanOrEqual(1);
			const hasImage = result.content.some((c) => c.type === "image");
			expect(hasImage).toBe(true);
		});

		it("should read text files normally", async () => {
			// Create test text file
			const textPath = join(testDir, "test.txt");
			writeFileSync(textPath, "Hello, world!");

			const tool = createReadTool(testDir);
			const result = await tool.execute("test-2", { path: textPath });

			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe("text");
			const textContent = result.content[0] as { type: "text"; text: string };
			expect(textContent.text).toContain("Hello, world!");
		});
	});

	describe("processFileArguments", () => {
		let testDir: string;

		beforeEach(() => {
			testDir = join(tmpdir(), `block-images-process-test-${Date.now()}`);
			mkdirSync(testDir, { recursive: true });
		});

		afterEach(() => {
			rmSync(testDir, { recursive: true, force: true });
		});

		it("should always process images (filtering happens at convertToLlm layer)", async () => {
			// Create test image
			const imagePath = join(testDir, "test.png");
			writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

			const result = await processFileArguments([imagePath]);

			expect(result.images).toHaveLength(1);
			expect(result.images[0].type).toBe("image");
		});

		it("should process BMP images from disk as PNG attachments", async () => {
			const imagePath = join(testDir, "test.bmp");
			writeFileSync(imagePath, createTinyBmp1x1Red24bpp());

			const result = await processFileArguments([imagePath]);

			expect(result.images).toHaveLength(1);
			expect(result.images[0].type).toBe("image");
			expect(result.images[0].mimeType).toBe("image/png");
			expect(result.text).toContain("[Image converted from image/bmp to image/png.]");
		});

		it("should process text files normally", async () => {
			// Create test text file
			const textPath = join(testDir, "test.txt");
			writeFileSync(textPath, "Hello, world!");

			const result = await processFileArguments([textPath]);

			expect(result.images).toHaveLength(0);
			expect(result.text).toContain("Hello, world!");
		});
	});
});
