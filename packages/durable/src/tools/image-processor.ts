import type { Api, Model } from "@earendil-works/pi-ai";

/** Limits an image the model sees must keep; the defaults below are the coding agent's. */
export type ImageLimits = {
	/** Pixels. Default 2000. */
	readonly maxWidth: number;
	/** Pixels. Default 2000. */
	readonly maxHeight: number;
	/** Bytes of base64. Default 4.5 MiB, below Anthropic's 5 MB. */
	readonly maxBytes: number;
};

export const DEFAULT_IMAGE_LIMITS: ImageLimits = { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024 };

/** The limits of images sent to `model`: its `inputLimits.images.resize`, each absent one `DEFAULT_IMAGE_LIMITS`'s. */
export function imageLimits(model: Model<Api> | undefined): ImageLimits {
	const resize = model?.inputLimits?.images?.resize;
	return {
		maxWidth: resize?.maxWidth ?? DEFAULT_IMAGE_LIMITS.maxWidth,
		maxHeight: resize?.maxHeight ?? DEFAULT_IMAGE_LIMITS.maxHeight,
		maxBytes: resize?.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes,
	};
}

/** An image the model can take: a supported format, within the limits, as base64. */
export type PreparedImage = {
	readonly data: string;
	readonly mimeType: string;
	/** Set when the image was resized: its size before and after, for the model to map coordinates back. */
	readonly resized?: {
		readonly from: { readonly width: number; readonly height: number };
		readonly to: { readonly width: number; readonly height: number };
	};
	/** The original format, set when it differs from `mimeType`: BMP becomes PNG, a large PNG may become JPEG. */
	readonly convertedFrom?: string;
};

/**
 * Decodes, orients, resizes, and re-encodes images so the model can take them. `read` uses one when given; without
 * one, it passes supported images within the byte limit through as they are. `@earendil-works/pi-durable/images`
 * provides a Photon-based one.
 */
export type ImageProcessor = {
	/**
	 * The image, prepared to fit `limits`, or `undefined` when it cannot be decoded or made to fit. A promise, so a
	 * processor can do the work off the event loop.
	 */
	prepare(bytes: Uint8Array, mimeType: string, limits: ImageLimits): Promise<PreparedImage | undefined>;
};

/** What preparing changed, for the model: the format, and the size with the factor that maps coordinates back. */
export function preparedNotes(image: PreparedImage): string[] {
	const notes: string[] = [];
	if (image.convertedFrom !== undefined) notes.push(`Converted from ${image.convertedFrom} to ${image.mimeType}.`);
	if (image.resized !== undefined) {
		const { from, to } = image.resized;
		const scale = (from.width / to.width).toFixed(2);
		notes.push(
			`Resized from ${from.width}x${from.height} to ${to.width}x${to.height}. Multiply coordinates by ${scale} to map them to the original.`,
		);
	}
	return notes;
}

/** Formats every provider takes inline; others, such as BMP, need converting. */
export const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Standard base64 of `bytes`. `btoa` takes a binary string, built 8 KiB at a time: a single `String.fromCharCode`
 * call with megabytes of arguments overflows the stack.
 */
export function toBase64(bytes: Uint8Array): string {
	const parts: string[] = [];
	for (let i = 0; i < bytes.length; i += 8192) {
		// `apply` takes any array-like, though its type asks for an array.
		parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192) as unknown as number[]));
	}
	return btoa(parts.join(""));
}

/** The bytes of standard base64 `data`. */
export function fromBase64(data: string): Uint8Array {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/** The length of the base64 of `byteLength` bytes. */
export function base64Length(byteLength: number): number {
	return Math.ceil(byteLength / 3) * 4;
}
