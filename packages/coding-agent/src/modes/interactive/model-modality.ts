/**
 * Image-input detection for the model selector.
 *
 * pi attaches images by inserting a file path into the editor (clipboard paste
 * writes a temp file and inserts its path); the `read` tool picks it up on
 * submit. The selector therefore has to know *before* a model is chosen whether
 * the pending prompt needs image input, so it can narrow the model list to
 * models that declare the image modality.
 *
 * Detection is deliberately conservative: a token only counts when it resolves
 * to a file whose bytes are a supported image. A path that merely looks like an
 * image is not treated as one, so a mention in prose cannot wrongly narrow the
 * selector.
 */

import { extname, isAbsolute, resolve } from "node:path";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";

/** Extensions that can plausibly be images; the bytes still have to confirm it. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

/** Bound the filesystem probing a single prompt can trigger. */
const MAX_CANDIDATES = 32;

/** Split editor text into whitespace-delimited tokens. */
export function extractPathCandidates(text: string): string[] {
	return text.split(/\s+/).filter((token) => token.length > 0);
}

export interface ImageInputDetectionOptions {
	cwd: string;
	/** Injectable for tests. Defaults to the real filesystem probe. */
	detectImage?: (path: string) => Promise<string | null>;
}

/**
 * Whether the pending editor content requires a model that accepts image input.
 * Returns false for empty text, for tokens without an image extension, and for
 * paths that do not exist or are not valid images.
 */
export async function textRequiresImageInput(text: string, options: ImageInputDetectionOptions): Promise<boolean> {
	const detectImage = options.detectImage ?? detectSupportedImageMimeTypeFromFile;
	const candidates = extractPathCandidates(text)
		.filter((candidate) => IMAGE_EXTENSIONS.has(extname(candidate).toLowerCase()))
		.slice(0, MAX_CANDIDATES);

	for (const candidate of candidates) {
		const path = isAbsolute(candidate) ? candidate : resolve(options.cwd, candidate);
		try {
			if (await detectImage(path)) return true;
		} catch {
			// Missing or unreadable files are simply not images.
		}
	}
	return false;
}

/** Whether a model declares the image input modality. */
export function modelAcceptsImage(model: { input: readonly string[] }): boolean {
	return model.input.includes("image");
}
