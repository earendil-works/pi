// Loads bounded local, data-URI and HTTP images for terminal question forms.
import { open } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { processImage } from "../../utils/image-process.ts";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Loads and validates a raster image without executing document content. */
export async function loadFormImage(
	source: string,
	cwd: string,
	signal: AbortSignal,
): Promise<{ data: string; mimeType: string }> {
	signal.throwIfAborted();
	let bytes: Buffer;
	let mimeType: string;
	if (source.startsWith("data:")) {
		const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z\d+/=\s]+)$/i.exec(source);
		if (!match) throw new Error("Use a base64 PNG, JPEG, GIF or WebP data URI");
		if (match[2].length > MAX_IMAGE_BYTES * 1.4) throw new Error("Image exceeds 8 MiB");
		bytes = Buffer.from(match[2], "base64");
		mimeType = match[1].toLowerCase();
	} else if (/^https?:/i.test(source)) {
		const result = await fetchImage(new URL(source), signal);
		bytes = result.bytes;
		mimeType = result.mimeType;
	} else {
		if (/^[a-z][a-z\d+.-]*:/i.test(source) && !source.startsWith("file:"))
			throw new Error("Unsupported image URL scheme");
		const path = source.startsWith("file:") ? fileURLToPath(source) : resolve(cwd, source);
		const handle = await open(path, "r");
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES)
				throw new Error("Image must be a regular file of at most 8 MiB");
			const chunks: Buffer[] = [];
			let total = 0;
			for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
				total += chunk.length;
				if (total > MAX_IMAGE_BYTES) throw new Error("Image exceeds 8 MiB");
				chunks.push(chunk);
			}
			bytes = Buffer.concat(chunks, total);
		} finally {
			await handle.close();
		}
		const extensions: Record<string, string> = {
			".png": "image/png",
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
			".gif": "image/gif",
			".webp": "image/webp",
		};
		mimeType = extensions[extname(path).toLowerCase()] ?? "application/octet-stream";
	}
	if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Image exceeds 8 MiB");
	const dimensions = getImageDimensions(bytes.toString("base64"), mimeType);
	if (!dimensions || dimensions.widthPx * dimensions.heightPx > 40_000_000)
		throw new Error("Use a valid PNG, JPEG, GIF or WebP of at most 40 megapixels");
	const processed = await processImage(bytes, mimeType);
	signal.throwIfAborted();
	if (!processed.ok) throw new Error(processed.message);
	return { data: processed.data, mimeType: processed.mimeType };
}

async function fetchImage(initial: URL, signal: AbortSignal): Promise<{ bytes: Buffer; mimeType: string }> {
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
	let url = initial;
	for (let redirects = 0; redirects <= 5; redirects++) {
		if (!/^https?:$/.test(url.protocol) || url.username || url.password)
			throw new Error("Use an HTTP(S) image URL without credentials");
		const response = await fetch(url, { redirect: "manual", signal: deadline });
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			await response.body?.cancel();
			const location = response.headers.get("location");
			if (!location) throw new Error("Image redirect has no location");
			url = new URL(location, url);
			continue;
		}
		if (!response.ok || !response.body) {
			await response.body?.cancel();
			throw new Error(`Image request failed: ${response.status}`);
		}
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > MAX_IMAGE_BYTES) throw new Error("Image exceeds 8 MiB");
				chunks.push(value);
			}
		} finally {
			await reader.cancel();
			reader.releaseLock();
		}
		return {
			bytes: Buffer.concat(chunks, total),
			mimeType: (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(),
		};
	}
	throw new Error("Too many image redirects");
}
