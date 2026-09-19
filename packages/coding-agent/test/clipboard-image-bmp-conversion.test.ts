/**
 * Test for BMP to PNG conversion in clipboard image handling.
 * Separate from clipboard-image.test.ts due to different mocking requirements.
 *
 * This tests the fix for WSL2/WSLg where clipboard often provides image/bmp
 * instead of image/png.
 */
import { describe, expect, test, vi } from "vitest";
import { readClipboardImage } from "../src/utils/clipboard-image.ts";

function createTinyBmp1x1Red24bpp(): Uint8Array {
	// Minimal 1x1 24bpp BMP (BGR + row padding to 4 bytes)
	// File size = 14 (BMP header) + 40 (DIB header) + 4 (pixel row) = 58
	const buffer = Buffer.alloc(58);

	// BITMAPFILEHEADER
	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(buffer.length, 2); // file size
	buffer.writeUInt16LE(0, 6); // reserved1
	buffer.writeUInt16LE(0, 8); // reserved2
	buffer.writeUInt32LE(54, 10); // pixel data offset

	// BITMAPINFOHEADER
	buffer.writeUInt32LE(40, 14); // DIB header size
	buffer.writeInt32LE(1, 18); // width
	buffer.writeInt32LE(1, 22); // height (positive = bottom-up)
	buffer.writeUInt16LE(1, 26); // planes
	buffer.writeUInt16LE(24, 28); // bits per pixel
	buffer.writeUInt32LE(0, 30); // compression (BI_RGB)
	buffer.writeUInt32LE(4, 34); // image size (incl. padding)
	buffer.writeInt32LE(0, 38); // x pixels per meter
	buffer.writeInt32LE(0, 42); // y pixels per meter
	buffer.writeUInt32LE(0, 46); // colors used
	buffer.writeUInt32LE(0, 50); // important colors

	// Pixel data (B, G, R) + 1 byte padding
	buffer[54] = 0x00; // B
	buffer[55] = 0x00; // G
	buffer[56] = 0xff; // R
	buffer[57] = 0x00; // padding

	return new Uint8Array(buffer);
}

// Mock wl-paste to return BMP
vi.mock("../src/utils/clipboard-command.ts", () => ({
	runClipboardCommand: vi.fn(async (command: string, args: string[]) => {
		if (command === "wl-paste" && args.includes("--list-types")) return Buffer.from("image/bmp\n");
		if (command === "wl-paste" && args.includes("image/bmp")) return Buffer.from(createTinyBmp1x1Red24bpp());
		return undefined;
	}),
}));

vi.mock("@earendil-works/pi-tui", () => ({
	getNativeClipboard: () => ({ getImage: async () => createTinyBmp1x1Red24bpp() }),
}));

describe("readClipboardImage BMP conversion", () => {
	test.each(["linux", "win32"] as const)("%s: converts command/native BMP to PNG", async (platform) => {
		const image = await readClipboardImage({ env: { WAYLAND_DISPLAY: "wayland-0" }, platform });

		expect(image).not.toBeNull();
		expect(image!.mimeType).toBe("image/png");
		expect(Array.from(image!.bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
	});
});
