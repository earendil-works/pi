import { execFileSync } from "node:child_process";
import type * as Photon from "@silvia-odwyer/photon-node";
import { describe, expect, it, vi } from "vitest";
import { applyExifOrientation } from "../src/utils/exif-orientation.ts";
import type { PhotonImageType } from "../src/utils/photon.ts";

function webpChunk(id: string, data: Buffer, declaredSize = data.length): Buffer {
	const header = Buffer.alloc(8);
	header.write(id);
	header.writeUInt32LE(declaredSize, 4);
	return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
}

function webp(...chunks: Buffer[]): Buffer {
	const header = Buffer.from("RIFF\0\0\0\0WEBP", "binary");
	const bytes = Buffer.concat([header, ...chunks]);
	bytes.writeUInt32LE(bytes.length - 8, 4);
	return bytes;
}

function orientationExif(): Buffer {
	const tiff = Buffer.alloc(26);
	tiff.write("II");
	tiff.writeUInt16LE(42, 2);
	tiff.writeUInt32LE(8, 4);
	tiff.writeUInt16LE(1, 8);
	tiff.writeUInt16LE(0x0112, 10);
	tiff.writeUInt16LE(3, 12);
	tiff.writeUInt32LE(1, 14);
	tiff.writeUInt16LE(2, 18);
	return tiff;
}

describe("WebP EXIF orientation", () => {
	it.each([0xfffffff8, 0xffffffff, 0x80000000])("returns promptly for oversized chunk length %i", (size) => {
		const bytes = webp(webpChunk("JUNK", Buffer.alloc(0), size));
		const moduleUrl = new URL("../src/utils/exif-orientation.ts", import.meta.url).href;
		// Run in a child so a non-advancing parser loop fails without hanging the test runner.
		const script = `import { applyExifOrientation } from ${JSON.stringify(moduleUrl)};
applyExifOrientation(null, null, Buffer.from(process.argv[1], "hex"));`;
		expect(() =>
			execFileSync(process.execPath, ["--input-type=module", "-e", script, bytes.toString("hex")], {
				timeout: 3000,
				stdio: "pipe",
				windowsHide: true,
			}),
		).not.toThrow();
	});

	it.each(["EXIF", "JUNK"])("ignores a truncated %s chunk instead of reading the following bytes", (id) => {
		const fliph = vi.fn();
		const photon = { fliph } as unknown as typeof Photon;
		const image = {} as PhotonImageType;
		const bytes = webp(webpChunk(id, orientationExif(), 100));
		expect(applyExifOrientation(photon, image, bytes)).toBe(image);
		expect(fliph).not.toHaveBeenCalled();
	});

	it.each([false, true])("reads valid EXIF after an odd-sized chunk (Exif prefix: %s)", (prefix) => {
		const fliph = vi.fn();
		const photon = { fliph } as unknown as typeof Photon;
		const image = {} as PhotonImageType;
		const exif = prefix ? Buffer.concat([Buffer.from("Exif\0\0"), orientationExif()]) : orientationExif();
		const bytes = webp(webpChunk("JUNK", Buffer.from([1])), webpChunk("EXIF", exif));
		expect(applyExifOrientation(photon, image, bytes)).toBe(image);
		expect(fliph).toHaveBeenCalledExactlyOnceWith(image);
	});
});
