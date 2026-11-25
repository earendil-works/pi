// The files the surfaces serve (slice 11 §1, §4): base bundles, plugin scripts, stylesheets and assets, each named by
// its content and so cached by clients forever; their types.

import { extname } from "node:path";
import type { HttpResponse } from "../http/index.ts";

/** A file the server serves: its type and bytes. */
export type ServedFile = { readonly mime: string; readonly bytes: Uint8Array };

/** A served file's response, cached by the browser forever (its path names its content); 404 for none. */
export function served(found: ServedFile | undefined): HttpResponse {
	if (found === undefined) return { kind: "error", status: 404 };
	const { mime, bytes } = found;
	return {
		kind: "bytes",
		mime,
		size: bytes.length,
		read: async (offset, length) => bytes.subarray(offset, offset + length),
		// Overrides the baseline's `no-store` for these files only.
		headers: { "Cache-Control": "private, max-age=31536000, immutable" },
	};
}

/** The type of a script. */
export const JAVASCRIPT = "text/javascript; charset=utf-8";

/** The type of a stylesheet. */
export const CSS = "text/css; charset=utf-8";

/** The type of a built asset, by extension. */
export function mimeOf(path: string): string {
	return ASSET_TYPES[extname(path).slice(1).toLowerCase()] ?? "application/octet-stream";
}

/** The extensions of files a build collects as assets (fonts, images, WebAssembly): served under the prefix's `assets/`. */
export const ASSET_EXTENSIONS = ["svg", "png", "jpg", "jpeg", "gif", "webp", "woff", "woff2", "ttf", "wasm"] as const;

/** The types of the assets builds collect, by extension. */
const ASSET_TYPES: Readonly<Record<string, string>> = {
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	wasm: "application/wasm",
	json: "application/json",
	css: CSS,
	js: JAVASCRIPT,
};
