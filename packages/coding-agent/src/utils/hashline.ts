/**
 * Hashline formatting utilities
 *
 * Format: LINENUM:HASH|CONTENT
 * Hash: xxHash32 of whitespace-normalized line, base36, 2 chars
 */

// Simple hash function for now (xxHash32 replacement)
// Using FNV-1a 32-bit hash, convert to base36
function fnv1a32(str: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		hash = (hash * 0x01000193) >>> 0;
	}
	return hash;
}

function toBase36(n: number, length: number): string {
	return n.toString(36).padStart(length, "0").slice(-length);
}

const HASH_LEN = 2;

/**
 * Compute line hash (whitespace-normalized content, base36)
 */
export function computeLineHash(_idx: number, line: string): string {
	// Remove carriage return if present
	if (line.endsWith("\r")) {
		line = line.slice(0, -1);
	}
	// Whitespace-normalize
	const normalized = line.replace(/\s+/g, "");
	const hashNum = fnv1a32(normalized);
	return toBase36(hashNum, HASH_LEN);
}

/**
 * Format file content with hashline prefixes
 */
export function formatHashLines(content: string, startLine = 1): string {
	const lines = content.split("\n");
	return lines
		.map((line, i) => {
			const num = startLine + i;
			const hash = computeLineHash(num, line);
			return `${num}:${hash}|${line}`;
		})
		.join("\n");
}
