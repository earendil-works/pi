// The package declares only `module`, which bundlers use but Node does not: import the file itself.
import {
	fliph,
	flipv,
	initSync,
	PhotonImage,
	resize,
	SamplingFilter,
	type SyncInitInput,
} from "@silvia-odwyer/photon/photon_rs.js";
import type { ImageLimits, ImageProcessor, PreparedImage } from "../tools/image-processor.ts";
import { base64Length, INLINE_IMAGE_TYPES, toBase64 } from "../tools/image-processor.ts";
import { exifOrientation } from "./exif.ts";

/** JPEG qualities tried in order. */
const JPEG_QUALITIES = [80, 70, 55, 40];

/**
 * An `ImageProcessor` on Photon (Rust compiled to WebAssembly), for `createCodingTools({ images })`. `wasm` is
 * Photon's `photon_rs_bg.wasm` as bytes or as a compiled module: `@earendil-works/pi-durable/images/node` reads it from
 * the installed package, `@earendil-works/pi-durable/images/cloudflare` imports it as a Workers module. Elsewhere, such
 * as a browser, fetch the file and pass its bytes. Photon loads once per process; later calls reuse the first `wasm`.
 *
 * An image already upright, in a format providers take inline, and within the limits is returned as it is, once it
 * decodes. Otherwise it is turned upright by its EXIF orientation, scaled to the
 * maximum width and height, and encoded as PNG or JPEG at falling qualities (JPEG first for JPEG sources), then at
 * smaller dimensions, 3/4 at a time, until the base64 fits. Formats providers do not take inline (BMP) become PNG.
 *
 * The work runs on the calling thread: about a second and a half for a 12-megapixel photo. Decoding takes the image's
 * RGBA size in WebAssembly memory, which does not shrink again; leave the processor out on memory-constrained hosts.
 */
export function createPhotonImages(wasm: SyncInitInput): ImageProcessor {
	initSync({ module: wasm });
	return { prepare: async (bytes, mimeType, limits) => prepare(bytes, mimeType, limits) };
}

function prepare(bytes: Uint8Array, mimeType: string, limits: ImageLimits): PreparedImage | undefined {
	const orientation = exifOrientation(bytes);
	const inline = INLINE_IMAGE_TYPES.has(mimeType);
	let image: PhotonImage | undefined;
	try {
		// Decoded even when it is returned as it is: a damaged file is an error, not an image the provider rejects.
		image = PhotonImage.new_from_byteslice(bytes);
		if (
			inline &&
			orientation === 1 &&
			image.get_width() <= limits.maxWidth &&
			image.get_height() <= limits.maxHeight &&
			base64Length(bytes.byteLength) <= limits.maxBytes
		) {
			return { data: toBase64(bytes), mimeType };
		}
		if (orientation >= 5) {
			const upright = transposed(image, orientation);
			// Freed first, so the upright copy reuses its WebAssembly memory.
			image.free();
			image = undefined;
			image = new PhotonImage(upright.pixels, upright.width, upright.height);
		} else if (orientation !== 1) {
			if (orientation !== 4) fliph(image);
			if (orientation !== 2) flipv(image);
		}
		const width = image.get_width();
		const height = image.get_height();
		const scale = Math.min(1, limits.maxWidth / width, limits.maxHeight / height);
		let target = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
		for (;;) {
			const encoded = encodeWithin(image, target, limits.maxBytes, mimeType === "image/jpeg");
			if (encoded !== undefined) {
				const resized =
					target.width === width && target.height === height
						? {}
						: { resized: { from: { width, height }, to: target } };
				const converted = encoded.mimeType === mimeType ? {} : { convertedFrom: mimeType };
				return { ...encoded, ...converted, ...resized };
			}
			if (target.width === 1 && target.height === 1) return undefined;
			target = {
				width: Math.max(1, Math.floor(target.width * 0.75)),
				height: Math.max(1, Math.floor(target.height * 0.75)),
			};
		}
	} catch {
		// Photon throws for bytes it cannot decode.
		return undefined;
	} finally {
		image?.free();
	}
}

/**
 * `image` at `size` in the first encoding whose base64 fits `maxBytes`: PNG, then JPEG at falling qualities, or the
 * JPEG qualities first when `jpegFirst`; `undefined` if none fits.
 */
function encodeWithin(
	image: PhotonImage,
	size: { readonly width: number; readonly height: number },
	maxBytes: number,
	jpegFirst: boolean,
): { readonly data: string; readonly mimeType: string } | undefined {
	const same = size.width === image.get_width() && size.height === image.get_height();
	const scaled = same ? image : resize(image, size.width, size.height, SamplingFilter.Lanczos3);
	try {
		const png = { mimeType: "image/png", encode: () => scaled.get_bytes() };
		const jpegs = JPEG_QUALITIES.map((quality) => ({
			mimeType: "image/jpeg",
			encode: () => scaled.get_bytes_jpeg(quality),
		}));
		for (const candidate of jpegFirst ? [...jpegs, png] : [png, ...jpegs]) {
			const bytes = candidate.encode();
			if (base64Length(bytes.byteLength) <= maxBytes) return { data: toBase64(bytes), mimeType: candidate.mimeType };
		}
		return undefined;
	} finally {
		if (!same) scaled.free();
	}
}

/**
 * The RGBA pixels of `image` turned upright for EXIF `orientation` 5 to 8, the orientations that swap width and
 * height. Photon's own `rotate` drops pixels at right angles, so the pixels are moved here.
 */
function transposed(
	image: PhotonImage,
	orientation: number,
): { readonly pixels: Uint8Array; readonly width: number; readonly height: number } {
	const width = image.get_width();
	const height = image.get_height();
	const source = image.get_raw_pixels();
	const pixels = new Uint8Array(source.length);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			// Where (x, y) lands in the upright image, which is `height` wide.
			const outX = orientation === 5 || orientation === 8 ? y : height - 1 - y;
			const outY = orientation === 5 || orientation === 6 ? x : width - 1 - x;
			pixels.set(source.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), (outY * height + outX) * 4);
		}
	}
	return { pixels, width: height, height: width };
}
