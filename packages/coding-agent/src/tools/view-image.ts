import * as os from "node:os";
import type { AgentTool } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { readFile } from "fs/promises";
import { extname, resolve as resolvePath } from "path";
import { getToolDescription } from "../prompts/index.js";

function expandPath(filePath: string): string {
	if (filePath === "~") {
		return os.homedir();
	}
	if (filePath.startsWith("~/")) {
		return os.homedir() + filePath.slice(1);
	}
	return filePath;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
};

function mimeTypeForPath(filePath: string): string | null {
	const ext = extname(filePath).toLowerCase();
	return IMAGE_MIME_TYPES[ext] ?? null;
}

function isUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

async function fetchImageFromUrl(
	url: string,
	signal?: AbortSignal,
): Promise<{ base64: string; mimeType: string; bytes: number } | { error: string }> {
	try {
		const response = await fetch(url, { signal });
		if (!response.ok) {
			return { error: `Failed to fetch image: HTTP ${response.status} ${response.statusText}` };
		}

		const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
		if (!contentType.startsWith("image/")) {
			return { error: `Unsupported content type: ${contentType || "unknown"} (expected image/*)` };
		}

		const allowed = new Set(Object.values(IMAGE_MIME_TYPES));
		if (!allowed.has(contentType)) {
			return { error: `Unsupported image format: ${contentType} (supported: jpeg, png, gif, webp)` };
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		return { base64: buffer.toString("base64"), mimeType: contentType, bytes: buffer.byteLength };
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			return { error: "Operation aborted" };
		}
		const msg = error instanceof Error ? error.message : String(error);
		return { error: `Failed to fetch image: ${msg}` };
	}
}

const viewImageSchema = Type.Object({
	path: Type.String({ description: "Local path or URL to an image file." }),
});

export interface ViewImageToolDetails {
	source: string;
	mimeType: string;
	bytes: number;
}

export const viewImageTool: AgentTool<typeof viewImageSchema, ViewImageToolDetails> = {
	name: "view_image",
	label: "view_image",
	description: getToolDescription("view_image"),
	parameters: viewImageSchema,
	execute: async (
		_toolCallId: string,
		{ path }: { path: string },
		signal?: AbortSignal,
		_onProgress?: (chunk: string) => void,
	) => {
		const source = path.trim();
		if (!source) {
			throw new Error("view_image: path is required");
		}

		let base64: string;
		let mimeType: string;
		let bytes: number;

		if (isUrl(source)) {
			const fetched = await fetchImageFromUrl(source, signal);
			if ("error" in fetched) {
				throw new Error(fetched.error);
			}
			base64 = fetched.base64;
			mimeType = fetched.mimeType;
			bytes = fetched.bytes;
		} else {
			const expanded = expandPath(source);
			const resolved = resolvePath(process.cwd(), expanded);
			const fileMime = mimeTypeForPath(resolved);
			if (!fileMime) {
				throw new Error(`Unsupported image format for ${path} (supported: jpg, jpeg, png, gif, webp)`);
			}
			const buf = await readFile(resolved);
			base64 = buf.toString("base64");
			mimeType = fileMime;
			bytes = buf.byteLength;
		}

		return {
			content: [
				{ type: "text", text: "Image loaded." },
				{ type: "image", data: base64, mimeType },
			],
			details: { source, mimeType, bytes },
		};
	},
};
