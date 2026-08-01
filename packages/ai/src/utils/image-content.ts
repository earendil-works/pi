import type { ImageContent } from "../types.ts";

/**
 * Resolve an image block to a single URL string for providers that accept a URL
 * (OpenAI-compatible `image_url`, Mistral `imageUrl`, etc.). A direct `url` is
 * passed through untouched; otherwise the base64 `data` is wrapped in a data
 * URI. See earendil-works/pi#6151.
 */
export function imageToUrl(image: ImageContent): string {
	if (image.url) return image.url;
	return `data:${image.mimeType};base64,${image.data}`;
}

/**
 * Extract required base64 data for providers that can only send image bytes in a
 * structured field (Anthropic base64 source, Bedrock, Google inline data). These
 * providers cannot forward a bare URL, so a url-only {@link ImageContent} is a
 * clear caller error rather than something to silently mangle into a data URI.
 */
export function requireImageData(image: ImageContent): { data: string; mimeType: string } {
	if (image.data === undefined || image.mimeType === undefined) {
		throw new Error(
			"This provider requires base64 image data; url-only image content is supported by OpenAI-compatible providers only",
		);
	}
	return { data: image.data, mimeType: image.mimeType };
}
