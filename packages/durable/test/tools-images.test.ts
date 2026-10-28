import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Model } from "@earendil-works/pi-ai";
import type { ToolDiagnostic, ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { initSync, PhotonImage } from "@silvia-odwyer/photon/photon_rs.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getOrThrow } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { exifOrientation } from "../src/images/exif.ts";
import { imageDimensions } from "../src/tools/image.ts";
import { DEFAULT_IMAGE_LIMITS, type ImageProcessor, toBase64 } from "../src/tools/image-processor.ts";
import { createReadTool } from "../src/tools/read.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-durable-images-"));
let processor: ImageProcessor;

beforeAll(async () => {
	// Fixtures are built with Photon here; the processor prepares them in its worker thread.
	initSync({
		module: readFileSync(createRequire(import.meta.url).resolve("@silvia-odwyer/photon/photon_rs_bg.wasm")),
	});
	processor = await createNodePhotonImages();
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

type Rgb = readonly [number, number, number];

/** A `width` by `height` image of `block`-pixel squares coloured row by row from `colors`. */
function blocks(
	colors: readonly (readonly Rgb[])[],
	block: number,
): { rgba: Uint8Array; width: number; height: number } {
	const width = colors[0]!.length * block;
	const height = colors.length * block;
	const rgba = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			rgba.set([...colors[Math.floor(y / block)]![Math.floor(x / block)]!, 255], (y * width + x) * 4);
		}
	}
	return { rgba, width, height };
}

/** RGBA pixels of a `width` by `height` image: red, with a green top-left pixel. */
function pixels(width: number, height: number): Uint8Array {
	const rgba = new Uint8Array(width * height * 4);
	for (let index = 0; index < width * height; index++) rgba.set([255, 0, 0, 255], index * 4);
	rgba.set([0, 255, 0, 255], 0);
	return rgba;
}

function encodeRgba(rgba: Uint8Array, width: number, height: number, format: "png" | "jpeg"): Uint8Array {
	const image = new PhotonImage(rgba, width, height);
	try {
		return format === "png" ? image.get_bytes() : image.get_bytes_jpeg(95);
	} finally {
		image.free();
	}
}

function encode(width: number, height: number, format: "png" | "jpeg"): Uint8Array {
	return encodeRgba(pixels(width, height), width, height, format);
}

/** Noise, which neither PNG nor JPEG compresses well, so the byte limit decides. */
function noisyPng(width: number, height: number): Uint8Array {
	const rgba = new Uint8Array(width * height * 4);
	let seed = 1;
	for (let index = 0; index < rgba.length; index++) {
		seed = (seed * 1103515245 + 12345) >>> 0;
		rgba[index] = index % 4 === 3 ? 255 : seed >>> 24;
	}
	return encodeRgba(rgba, width, height, "png");
}

/** A 24-bit BMP, which providers do not take inline. */
function bmp(width: number, height: number): Uint8Array {
	const row = Math.ceil((width * 3) / 4) * 4;
	const bytes = new Uint8Array(54 + row * height);
	const view = new DataView(bytes.buffer);
	bytes.set([0x42, 0x4d]);
	view.setUint32(2, bytes.length, true);
	view.setUint32(10, 54, true);
	view.setUint32(14, 40, true);
	view.setInt32(18, width, true);
	view.setInt32(22, height, true);
	view.setUint16(26, 1, true);
	view.setUint16(28, 24, true);
	view.setUint32(34, row * height, true);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) bytes.set([0, 0, 255], 54 + y * row + x * 3);
	return bytes;
}

/** A 1x1 GIF with its logical screen size set to `width` by `height`. */
function gif(width = 1, height = 1): Uint8Array {
	const bytes = Uint8Array.from(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
	new DataView(bytes.buffer).setUint16(6, width, true);
	new DataView(bytes.buffer).setUint16(8, height, true);
	return bytes;
}

/** A TIFF header whose first directory holds only Orientation = `orientation`. */
function tiff(orientation: number, littleEndian: boolean): number[] {
	const bytes = new Uint8Array(26);
	const view = new DataView(bytes.buffer);
	bytes.set(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d]);
	view.setUint16(2, 42, littleEndian);
	view.setUint32(4, 8, littleEndian);
	view.setUint16(8, 1, littleEndian);
	view.setUint16(10, 0x0112, littleEndian);
	view.setUint16(12, 3, littleEndian);
	view.setUint32(14, 1, littleEndian);
	view.setUint16(18, orientation, littleEndian);
	return [...bytes];
}

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0, 0];

/** `jpeg` with an APP1 segment whose EXIF says `orientation`, after an APP0 segment when `app0`. */
function withOrientation(jpeg: Uint8Array, orientation: number, options: { little?: boolean; app0?: boolean } = {}) {
	const exif = [...EXIF_HEADER, ...tiff(orientation, options.little ?? false)];
	const app1 = [0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff, ...exif];
	const app0 = options.app0 ? [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0] : [];
	return new Uint8Array([...jpeg.subarray(0, 2), ...app0, ...app1, ...jpeg.subarray(2)]);
}

/** A RIFF WebP with a dummy `VP8 ` chunk and an `EXIF` chunk saying `orientation`, its TIFF data bare or prefixed. */
function webpWithOrientation(orientation: number, prefixed: boolean): Uint8Array {
	const chunk = (type: string, data: number[]): number[] => {
		const size = data.length;
		const padding = size % 2 === 1 ? [0] : [];
		return [...Buffer.from(type), size & 0xff, (size >> 8) & 0xff, 0, 0, ...data, ...padding];
	};
	const exif = [...(prefixed ? EXIF_HEADER : []), ...tiff(orientation, true)];
	const body = [...Buffer.from("WEBP"), ...chunk("VP8 ", [1, 2, 3]), ...chunk("EXIF", exif)];
	return new Uint8Array([...Buffer.from("RIFF"), body.length & 0xff, (body.length >> 8) & 0xff, 0, 0, ...body]);
}

function decodedImage(data: string): { width: number; height: number; rgba: Uint8Array } {
	const image = PhotonImage.new_from_byteslice(Uint8Array.from(Buffer.from(data, "base64")));
	try {
		return { width: image.get_width(), height: image.get_height(), rgba: image.get_raw_pixels() };
	} finally {
		image.free();
	}
}

/**
 * The environment of a `read` call, with `onRead` seeing each positional read of an opened file, and the largest
 * read so far in `reads.largest`.
 */
function readEnv(onRead?: (offset: number, length: number) => void) {
	const env = new NodeExecutionEnv({ cwd: directory });
	const reads = { largest: 0 };
	const open = env.openBinaryReader.bind(env);
	env.openBinaryReader = async (path, options, ctx) => {
		const reader = getOrThrow(await open(path, options, ctx));
		return {
			ok: true,
			value: {
				info: (c) => reader.info(c),
				scanLines: (o, c) => reader.scanLines(o, c),
				close: (c) => reader.close(c),
				read: async (offset, length, c) => {
					reads.largest = Math.max(reads.largest, length);
					const result = await reader.read(offset, length, c);
					onRead?.(offset, length);
					return result;
				},
			},
		};
	};
	return { env, reads };
}

/** Run `read` on `bytes` written to `name`, for a conversation whose model takes `input`. */
async function read(
	name: string,
	bytes: Uint8Array,
	options: {
		readonly images?: ImageProcessor;
		readonly input?: readonly string[];
		readonly resize?: { readonly maxWidth?: number; readonly maxHeight?: number; readonly maxBytes?: number };
		readonly env?: NodeExecutionEnv;
		readonly tool?: ReturnType<typeof createReadTool>;
	} = {},
): Promise<ToolExecutionResult> {
	writeFileSync(join(directory, name), bytes);
	const model = {
		input: options.input ?? ["text", "image"],
		...(options.resize === undefined ? {} : { inputLimits: { images: { resize: options.resize } } }),
	} as unknown as Model<never>;
	const api = {
		env: options.env ?? new NodeExecutionEnv({ cwd: directory }),
		output: () => {},
		diagnostic: () => {},
		details: async () => {},
		agent: async () => ({ model: { provider: "test", modelId: "test" } }),
		models: { getModel: () => model },
	} as unknown as ToolExecutionApi;
	const tool = options.tool ?? createReadTool(options);
	return tool.execute({ path: name }, api, context);
}

function messages(result: ToolExecutionResult): string[] {
	return (result.diagnostics ?? []).map((diagnostic: ToolDiagnostic) => diagnostic.message);
}

function onlyImage(result: ToolExecutionResult): { data: string; mimeType: string } {
	expect(result.output).toHaveLength(1);
	return (result.output as { data: string; mimeType: string }[])[0]!;
}

describe("read of images, without an image processor", () => {
	it("returns a supported image within the limits as it is", async () => {
		const png = encode(8, 6, "png");
		const result = await read("a.png", png);
		expect(result.output).toEqual([{ type: "image", data: toBase64(png), mimeType: "image/png" }]);
		expect(messages(result)).toEqual(["Read image file [image/png]."]);
		const tiny = await read("a.gif", gif());
		expect(onlyImage(tiny)).toEqual({ type: "image", data: toBase64(gif()), mimeType: "image/gif" });
	});

	it("refuses an image too large to send without reading it", async () => {
		const { env, reads } = readEnv();
		const result = await read("big.png", noisyPng(1100, 1100), { env });
		expect(result).toMatchObject({ output: [], isError: true });
		expect(messages(result)[0]).toMatch(/^big\.png is an image \(image\/png\) of .*, too large to send/);
		// Only the header and the chunk walk, in blocks of at most 64 KiB.
		expect(reads.largest).toBeLessThanOrEqual(64 * 1024);
	});

	it("refuses an image wider or taller than the limits, by its header", async () => {
		const wide = await read("wide.png", encode(2001, 2, "png"));
		expect(wide).toMatchObject({ output: [], isError: true });
		expect(messages(wide)).toEqual([
			"wide.png is an image (image/png) of 2001x2, larger than 2000x2000, and no image processor is configured to shrink it",
		]);
		const tall = await read("tall.gif", gif(1, 3000));
		expect(messages(tall)[0]).toMatch(/^tall\.gif is an image \(image\/gif\) of 1x3000, larger than 2000x2000/);
	});

	it("refuses a format that needs converting", async () => {
		const result = await read("a.bmp", bmp(4, 4));
		expect(result).toMatchObject({ output: [], isError: true });
		expect(messages(result)).toEqual([
			"a.bmp is an image (image/bmp) that needs converting, and no image processor is configured",
		]);
	});

	it("says when the model sees a placeholder instead of the image", async () => {
		const result = await read("a.png", encode(4, 4, "png"), { input: ["text"] });
		expect(result.output).toHaveLength(1);
		expect(messages(result)).toEqual([
			"Read image file [image/png]. The current model does not support images; it sees a placeholder instead.",
		]);
	});

	it("applies the model's image limits instead of the defaults", async () => {
		const png = encode(8, 6, "png");
		const refused = await read("a.png", png, { resize: { maxWidth: 4 } });
		expect(messages(refused)[0]).toMatch(/of 8x6, larger than 4x2000,/);
		const resized = await read("a.png", png, { resize: { maxWidth: 4 }, images: processor });
		expect(decodedImage(onlyImage(resized).data)).toMatchObject({ width: 4, height: 3 });
	});

	it("lists bmp in the description only with a processor", () => {
		expect(createReadTool().description).toContain("(jpg, png, gif, webp)");
		expect(createReadTool({ images: processor }).description).toContain("(jpg, png, gif, webp, bmp)");
	});
});

describe("read of an image that changes while it is read", () => {
	it("reads it again rather than return a cut-off image, even when it grew", async () => {
		const png = encode(8, 6, "png");
		const wholeReads: number[] = [];
		const { env } = readEnv((offset, length) => {
			// A writer appends during the first read of the whole file; the second read sees it all.
			if (offset !== 0 || length < png.length) return;
			wholeReads.push(length);
			if (wholeReads.length === 1) appendFileSync(join(directory, "growing.png"), new Uint8Array(16));
		});
		const result = await read("growing.png", png, { env });
		expect(wholeReads).toEqual([png.length, png.length + 16]);
		const after = [...png, ...new Uint8Array(16)];
		expect(onlyImage(result).data).toBe(toBase64(new Uint8Array(after)));
	});

	it("fails when it changes during the second read too", async () => {
		const png = encode(8, 6, "png");
		const { env } = readEnv((offset, length) => {
			if (offset === 0 && length >= png.length) appendFileSync(join(directory, "busy.png"), new Uint8Array(1));
		});
		await expect(read("busy.png", png, { env })).rejects.toThrow("busy.png changed while it was read");
	});
});

describe("read of images, with the Photon image processor", () => {
	it("passes an image that needs no change through untouched", async () => {
		const png = encode(8, 6, "png");
		const result = await read("a.png", png, { images: processor });
		expect(result.output).toEqual([{ type: "image", data: toBase64(png), mimeType: "image/png" }]);
		expect(onlyImage(await read("a.gif", gif(), { images: processor })).mimeType).toBe("image/gif");
	});

	it("scales an image down to the maximum size, and says how to map coordinates back", async () => {
		const result = await read("wide.png", encode(4000, 1000, "png"), { images: processor });
		const block = onlyImage(result);
		expect(decodedImage(block.data)).toMatchObject({ width: 2000, height: 500 });
		expect(messages(result)).toEqual([
			`Read image file [${block.mimeType}]. Resized from 4000x1000 to 2000x500. Multiply coordinates by 2.00 to map them to the original.`,
		]);
	});

	// Multiple full-image encodes can exceed Vitest's 5s default on shared CI runners.
	it("re-encodes a PNG too large for the byte limit as JPEG at its size, and shrinks it when that is not enough", async () => {
		const result = await read("big.png", noisyPng(1100, 1100), { images: processor });
		const jpeg = onlyImage(result);
		expect(jpeg.mimeType).toBe("image/jpeg");
		expect(messages(result)).toEqual(["Read image file [image/jpeg]. Converted from image/png to image/jpeg."]);
		expect(jpeg.data.length).toBeLessThanOrEqual(DEFAULT_IMAGE_LIMITS.maxBytes);
		expect(decodedImage(jpeg.data)).toMatchObject({ width: 1100, height: 1100 });
		const tight = { ...DEFAULT_IMAGE_LIMITS, maxBytes: 200_000 };
		const shrunk = await processor.prepare(noisyPng(2000, 2000), "image/png", tight);
		expect(shrunk!.data.length).toBeLessThanOrEqual(tight.maxBytes);
		expect(shrunk!.resized?.from).toEqual({ width: 2000, height: 2000 });
		expect(shrunk!.resized!.to.width).toBeLessThan(2000);
	}, 60_000);

	it("keeps at least one pixel on each side of an extreme aspect ratio", async () => {
		const result = await processor.prepare(encode(6000, 2, "png"), "image/png", DEFAULT_IMAGE_LIMITS);
		expect(result?.resized).toEqual({ from: { width: 6000, height: 2 }, to: { width: 2000, height: 1 } });
	});

	it("gives up when not even one pixel fits the byte limit", async () => {
		const limits = { ...DEFAULT_IMAGE_LIMITS, maxBytes: 8 };
		expect(await processor.prepare(encode(4, 4, "png"), "image/png", limits)).toBeUndefined();
	});

	it("keeps a JPEG that must be re-encoded a JPEG", async () => {
		const result = await processor.prepare(
			withOrientation(encode(40, 30, "jpeg"), 3),
			"image/jpeg",
			DEFAULT_IMAGE_LIMITS,
		);
		expect(result?.mimeType).toBe("image/jpeg");
	});

	it("converts a format providers do not take inline to PNG", async () => {
		const result = await read("a.bmp", bmp(4, 4), { images: processor });
		expect(result.output).toMatchObject([{ type: "image", mimeType: "image/png" }]);
		expect(messages(result)).toEqual(["Read image file [image/png]. Converted from image/bmp to image/png."]);
	});

	it("reports bytes it cannot decode as an error", async () => {
		const broken = new Uint8Array([...encode(4, 4, "png").subarray(0, 40)]);
		const result = await read("broken.png", broken, { images: processor });
		expect(result).toMatchObject({ output: [], isError: true });
		expect(messages(result)).toEqual(["broken.png is an image (image/png) that cannot be prepared for the model"]);
	});

	it("is what createCodingTools({ images }) gives read", async () => {
		const tool = createCodingTools({ images: processor }).tools?.find((candidate) => candidate.name === "read");
		const result = await read("b.bmp", bmp(4, 4), { tool: tool as ReturnType<typeof createReadTool> });
		expect(result.output).toMatchObject([{ type: "image", mimeType: "image/png" }]);
	});
});

describe("EXIF orientation", () => {
	const R: Rgb = [255, 0, 0];
	const G: Rgb = [0, 255, 0];
	const B: Rgb = [0, 0, 255];
	const W: Rgb = [255, 255, 255];
	const K: Rgb = [0, 0, 0];
	const Y: Rgb = [255, 255, 0];
	const stored = [
		[R, G, B],
		[W, K, Y],
	];
	const mirror = <T>(grid: readonly (readonly T[])[]): T[][] => grid.map((row) => [...row].reverse());
	// A quarter turn clockwise: the left column, read bottom to top, becomes the top row.
	const turn = <T>(grid: readonly (readonly T[])[]): T[][] =>
		grid[0]!.map((_, x) => grid.map((row) => row[x]!).reverse());
	// What each orientation shows, from its EXIF definition: mirror, then turn clockwise.
	const upright: Record<number, Rgb[][]> = {
		1: stored.map((row) => [...row]),
		2: mirror(stored),
		3: turn(turn(stored)),
		4: turn(turn(mirror(stored))),
		5: turn(turn(turn(mirror(stored)))),
		6: turn(stored),
		7: turn(mirror(stored)),
		8: turn(turn(turn(stored))),
	};

	for (let orientation = 1; orientation <= 8; orientation++) {
		it(`turns orientation ${orientation} upright`, async () => {
			const { rgba, width, height } = blocks(stored, 16);
			const jpeg = withOrientation(encodeRgba(rgba, width, height, "jpeg"), orientation);
			const prepared = await processor.prepare(jpeg, "image/jpeg", DEFAULT_IMAGE_LIMITS);
			const image = decodedImage(prepared!.data);
			const expected = upright[orientation]!;
			expect({ width: image.width, height: image.height }).toEqual({
				width: expected[0]!.length * 16,
				height: expected.length * 16,
			});
			// The colour at the centre of each block, rounded to full channels against JPEG noise.
			const seen = expected.map((row, by) =>
				row.map((_, bx) => {
					const at = ((by * 16 + 8) * image.width + bx * 16 + 8) * 4;
					return [...image.rgba.subarray(at, at + 3)].map((channel) => (channel > 127 ? 255 : 0));
				}),
			);
			expect(seen).toEqual(expected);
		});
	}

	it("reads big- and little-endian JPEG EXIF, after an APP0 segment, and 1 when absent or out of range", () => {
		const jpeg = encode(2, 2, "jpeg");
		expect(exifOrientation(withOrientation(jpeg, 6))).toBe(6);
		expect(exifOrientation(withOrientation(jpeg, 8, { little: true }))).toBe(8);
		expect(exifOrientation(withOrientation(jpeg, 5, { app0: true }))).toBe(5);
		expect(exifOrientation(withOrientation(jpeg, 9))).toBe(1);
		expect(exifOrientation(jpeg)).toBe(1);
		expect(exifOrientation(encode(2, 2, "png"))).toBe(1);
	});

	it("reads WebP EXIF chunks with and without the Exif prefix", () => {
		expect(exifOrientation(webpWithOrientation(6, false))).toBe(6);
		expect(exifOrientation(webpWithOrientation(3, true))).toBe(3);
	});
});

describe("imageDimensions", () => {
	it("reads the size each format declares in its header", () => {
		expect(imageDimensions(encode(7, 5, "png"), "image/png")).toEqual({ width: 7, height: 5 });
		expect(imageDimensions(encode(7, 5, "jpeg"), "image/jpeg")).toEqual({ width: 7, height: 5 });
		expect(imageDimensions(withOrientation(encode(7, 5, "jpeg"), 6, { app0: true }), "image/jpeg")).toEqual({
			width: 7,
			height: 5,
		});
		expect(imageDimensions(gif(300, 200), "image/gif")).toEqual({ width: 300, height: 200 });
		const webp = (type: string, data: number[]): Uint8Array =>
			new Uint8Array([
				...Buffer.from("RIFF"),
				0,
				0,
				0,
				0,
				...Buffer.from("WEBP"),
				...Buffer.from(type),
				0,
				0,
				0,
				0,
				...data,
				...new Array(16).fill(0),
			]);
		// VP8: frame tag, start code, then 14-bit width and height.
		expect(imageDimensions(webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x2c, 0x01, 0xc8, 0x00]), "image/webp")).toEqual({
			width: 300,
			height: 200,
		});
		// VP8L: signature, then width - 1 and height - 1 in 14 bits each.
		const bits = 299 | (199 << 14);
		expect(
			imageDimensions(
				webp("VP8L", [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, bits >>> 24]),
				"image/webp",
			),
		).toEqual({ width: 300, height: 200 });
		// VP8X: flags, then width - 1 and height - 1 in 24 bits each.
		expect(imageDimensions(webp("VP8X", [0, 0, 0, 0, 0x2b, 0x01, 0, 0xc7, 0, 0]), "image/webp")).toEqual({
			width: 300,
			height: 200,
		});
		expect(imageDimensions(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg")).toBeUndefined();
	});
});

describe("toBase64", () => {
	it("matches Buffer for every remainder length", () => {
		for (const length of [0, 1, 2, 3, 4, 5, 8191, 8192, 8193, 10_000, 16_385]) {
			const bytes = Uint8Array.from({ length }, (_, index) => (index * 37) % 256);
			expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
		}
	});

	// #10923: building the output a character at a time took 138 MB of heap for a 3 MiB image.
	it("encodes a 3 MiB image within a 128 MB heap", () => {
		const source = new URL("../src/tools/image-processor.ts", import.meta.url).href;
		const script = `
			const { toBase64 } = await import(${JSON.stringify(source)});
			const bytes = Uint8Array.from({ length: 3147295 }, (_, index) => (index * 37) % 256);
			if (toBase64(bytes) !== Buffer.from(bytes).toString("base64")) throw new Error("mismatch");
		`;
		const args = ["--experimental-strip-types", "--max-heap-size=128", "--input-type=module", "-e", script];
		const result = spawnSync(process.execPath, args, { encoding: "utf8" });
		expect(result.stderr).not.toMatch(/heap out of memory|mismatch/);
		expect(result.status).toBe(0);
	});
});

describe("createNodePhotonImages", () => {
	it("prepares in a worker thread, leaving the event loop free", async () => {
		const photo = noisyPng(3000, 2000);
		const prepareOn = async (images: ImageProcessor): Promise<number> => {
			// The longest gap between timer ticks while the image is prepared: the time the event loop was blocked.
			let longest = 0;
			let last = performance.now();
			const ticks = setInterval(() => {
				const now = performance.now();
				longest = Math.max(longest, now - last);
				last = now;
			}, 5);
			try {
				const prepared = images.prepare(photo, "image/png", DEFAULT_IMAGE_LIMITS);
				expect(await prepared).toBeDefined();
				// Counted until the result arrived, including the gap the last tick did not see.
				longest = Math.max(longest, performance.now() - last);
			} finally {
				clearInterval(ticks);
			}
			return longest;
		};
		const inline = await prepareOn(await createNodePhotonImages({ worker: false }));
		const threaded = await prepareOn(processor);
		expect(inline).toBeGreaterThan(200);
		expect(threaded).toBeLessThan(100);
	}, 60_000);

	it("gives the same result as the calling thread, and keeps the caller's bytes", async () => {
		const png = noisyPng(1100, 1100);
		const copy = png.slice();
		const threaded = await processor.prepare(png, "image/png", DEFAULT_IMAGE_LIMITS);
		const inline = await (await createNodePhotonImages({ worker: false })).prepare(
			png,
			"image/png",
			DEFAULT_IMAGE_LIMITS,
		);
		expect(threaded).toEqual(inline);
		expect(png).toEqual(copy);
	}, 60_000);

	it("prepares concurrent images, and starts a new worker after the idle one exited", async () => {
		const images = await createNodePhotonImages({ idleMs: 10 });
		const results = await Promise.all([
			images.prepare(bmp(4, 4), "image/bmp", DEFAULT_IMAGE_LIMITS),
			images.prepare(encode(4000, 1000, "png"), "image/png", DEFAULT_IMAGE_LIMITS),
			images.prepare(new Uint8Array([1, 2, 3]), "image/png", DEFAULT_IMAGE_LIMITS),
		]);
		expect(results[0]?.mimeType).toBe("image/png");
		expect(results[1]?.resized?.to).toEqual({ width: 2000, height: 500 });
		expect(results[2]).toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect((await images.prepare(bmp(2, 2), "image/bmp", DEFAULT_IMAGE_LIMITS))?.mimeType).toBe("image/png");
	});
});
