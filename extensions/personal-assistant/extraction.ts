import { createHash } from "node:crypto";

// normalizeContent: strip extra whitespace, trim, lowercase
export function normalizeContent(content: string): string {
	return content
		.replace(/\s+/g, " ") // collapse all whitespace (newlines, tabs, spaces) to single space
		.trim()
		.toLowerCase();
}

// computeFingerprint: sha256 of normalized content, first 16 chars
export function computeFingerprint(content: string): string {
	return createHash("sha256").update(normalizeContent(content)).digest("hex").slice(0, 16);
}