// Atom file storage (id-based paths).
//
// Writes one .md file per atom at <baseDir>/<type>/<atom.id>.md. The id-based
// path is intentional — title slugs collide on titles like "PDF 图片提取".
// readAtomFromFile is the inverse: split frontmatter from body, recompute the
// content hash, optionally validate against an expected hash.
//
// Architecture constraints (design.md Decisions 3, 4):
//   - File path uses atom.id, NEVER a title slug (collision-free).
//   - readAtomFromFile returns null on missing / malformed / hash-mismatched
//     files — it never throws, so callers can degrade gracefully to L0.
//   - Frontmatter format is intentionally trivial: simple `key: value` lines,
//     arrays JSON-encoded as `["a", "b"]`, numbers bare, `null` for nullables.
//     No nested structures beyond the tags array.
//
// Frontmatter does NOT include `content` — content lives in the body and the
// hash is computed from the body alone. This keeps the on-disk file diff-friendly
// (content changes don't touch the frontmatter).

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { MemoryAtom } from "./types.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Options bag for file-store calls. Mirrors the file path layout. */
export interface FileStoreOptions {
	baseDir: string; // e.g. ~/.pi/agent/memory/atoms
	type: MemoryAtom["type"]; // rule | fact | process
}

/**
 * Write an atom to <baseDir>/<atom.type>/<atom.id>.md.
 *
 * The directory is created recursively. Returns the absolute file path so
 * callers can persist it (e.g. into memory_index.file_path).
 */
export async function writeAtomToFile(atom: MemoryAtom, baseDir: string): Promise<string> {
	if (!isSafeFilename(atom.id)) {
		throw new Error(`unsafe atom id for filename: ${atom.id}`);
	}
	const dir = path.join(baseDir, atom.type);
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, `${atom.id}.md`);
	const frontmatter = serializeFrontmatter(atom);
	const body = `---\n${frontmatter}\n---\n\n${atom.content}\n`;
	await fs.writeFile(filePath, body, "utf8");
	return filePath;
}

/**
 * Read and parse an atom file. Recomputes the body hash and compares against
 * `expectedHash` if provided.
 *
 * Returns null (not throws) on:
 *   - file missing
 *   - frontmatter missing / malformed
 *   - hash mismatch (caller can fall back to L0 / DB row)
 */
export async function readAtomFromFile(
	filePath: string,
	expectedHash?: string,
): Promise<{ atom: MemoryAtom; contentHash: string } | null> {
	let raw: string;
	try {
		raw = await fs.readFile(filePath, "utf8");
	} catch {
		return null;
	}
	const parsed = parseFrontmatter(raw);
	if (!parsed) return null;
	const { frontmatter, body } = parsed;
	// Trim only the structural newlines around the body — internal newlines
	// in multi-paragraph content are preserved verbatim.
	const content = body.replace(/^\n+|\n+$/g, "");
	const contentHash = computeContentHash(content);
	if (expectedHash !== undefined && contentHash !== expectedHash) {
		return null;
	}
	const atom: MemoryAtom = { ...frontmatter, content };
	return { atom, contentHash };
}

/**
 * Split a raw .md file into frontmatter text and body. Returns null if the
 * file does not start with `---\n` or has no closing `---\n`/`---\n\n` marker.
 */
export function normalizeMarkdown(raw: string): { frontmatter: string; body: string } | null {
	const match = raw.match(/^---\n([\s\S]*?)\n---(\n?)([\s\S]*)$/);
	if (!match) return null;
	const frontmatter = match[1] ?? "";
	const body = match[3] ?? "";
	return { frontmatter, body };
}

/**
 * SHA-256 of the body, truncated to 16 hex chars. Matches the format used
 * for memory_index.content_fingerprint and lets readAtomFromFile detect
 * stale files cheaply.
 */
export function computeContentHash(body: string): string {
	return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Render a MemoryAtom as a YAML-ish key:value block (no surrounding `---`). */
function serializeFrontmatter(atom: MemoryAtom): string {
	const lines: string[] = [];
	lines.push(`id: ${quoteString(atom.id)}`);
	lines.push(`type: ${quoteString(atom.type)}`);
	lines.push(`title: ${quoteString(atom.title)}`);
	lines.push(`summary: ${quoteString(atom.summary)}`);
	lines.push(`tags: ${JSON.stringify(atom.tags)}`);
	lines.push(`importance: ${atom.importance}`);
	lines.push(`strength: ${atom.strength}`);
	lines.push(`access_count: ${atom.access_count}`);
	lines.push(`version: ${atom.version}`);
	lines.push(`is_latest: ${atom.is_latest}`);
	lines.push(`parent_id: ${formatNullable(atom.parent_id)}`);
	lines.push(`superseded_at: ${formatNullable(atom.superseded_at)}`);
	lines.push(`archived: ${atom.archived}`);
	lines.push(`created_at: ${atom.created_at}`);
	lines.push(`updated_at: ${atom.updated_at}`);
	lines.push(`last_access: ${formatNullable(atom.last_access)}`);
	lines.push(`content_fingerprint: ${quoteString(atom.content_fingerprint)}`);
	lines.push(`source_session: ${formatNullable(atom.source_session)}`);
	return lines.join("\n");
}

/** Quote a string for safe frontmatter round-trip; escapes `\n`, `"`, `\`. */
function quoteString(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function formatNullable(value: string | number | null): string {
	return value === null || value === undefined ? "null" : String(value);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Inverse of serializeFrontmatter. `content` is left empty here — the caller
 *  (readAtomFromFile) fills it from the body. */
function parseFrontmatter(raw: string): { frontmatter: MemoryAtom; body: string } | null {
	const normalized = normalizeMarkdown(raw);
	if (!normalized) return null;
	const { frontmatter, body } = normalized;

	const fields: Record<string, unknown> = {};
	for (const line of frontmatter.split("\n")) {
		if (line.trim() === "") continue;
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		const value = line.slice(colonIdx + 1).trim();
		fields[key] = parseValue(value);
	}

	// Required fields — without these the file is unusable.
	if (typeof fields.id !== "string" || fields.id === "") return null;
	if (typeof fields.type !== "string") return null;
	if (typeof fields.title !== "string") return null;

	const type = fields.type as MemoryAtom["type"];
	if (type !== "rule" && type !== "fact" && type !== "process") return null;

	const tags = Array.isArray(fields.tags)
		? (fields.tags.filter((t): t is string => typeof t === "string"))
		: [];

	// Build the atom with all 18 fields; missing fields fall back to safe
	// defaults. The DB row is the source of truth — this is only for cases
	// where the .md is read while the DB row is stale or missing.
	const atom: MemoryAtom = {
		id: fields.id as string,
		type,
		title: fields.title as string,
		summary: typeof fields.summary === "string" ? (fields.summary as string) : "",
		content: body,
		tags,
		importance: numberField(fields.importance, 0.5),
		strength: numberField(fields.strength, 1.0),
		access_count: intField(fields.access_count, 0),
		version: intField(fields.version, 1),
		is_latest: intField(fields.is_latest, 1) === 1 ? 1 : 0,
		parent_id: nullableString(fields.parent_id),
		superseded_at: nullableNumber(fields.superseded_at),
		archived: intField(fields.archived, 0) === 1 ? 1 : 0,
		created_at: numberField(fields.created_at, 0),
		updated_at: numberField(fields.updated_at, 0),
		last_access: nullableNumber(fields.last_access),
		content_fingerprint:
			typeof fields.content_fingerprint === "string"
				? (fields.content_fingerprint as string)
				: "",
		source_session: nullableString(fields.source_session),
	};
	return { frontmatter: atom, body };
}

function parseValue(s: string): unknown {
	if (s === "" || s === "null") return null;
	if (s === "true") return true;
	if (s === "false") return false;
	// Quoted string — strip quotes, unescape basic escapes.
	if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
		return s
			.slice(1, -1)
			.replace(/\\n/g, "\n")
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\");
	}
	// JSON array (tags).
	if (s.startsWith("[") && s.endsWith("]")) {
		try {
			const parsed = JSON.parse(s);
			if (Array.isArray(parsed)) return parsed;
		} catch {
			// Fall through to plain string.
		}
		return s;
	}
	// Number (integer or float).
	if (/^-?\d+(\.\d+)?$/.test(s)) {
		return Number(s);
	}
	return s;
}

function numberField(v: unknown, fallback: number): number {
	if (typeof v === "number" && !Number.isNaN(v)) return v;
	if (typeof v === "string") {
		const n = Number(v);
		if (!Number.isNaN(n)) return n;
	}
	return fallback;
}

function intField(v: unknown, fallback: number): number {
	return Math.trunc(numberField(v, fallback));
}

function nullableNumber(v: unknown): number | null {
	if (v === null || v === undefined) return null;
	if (typeof v === "number" && !Number.isNaN(v)) return v;
	if (typeof v === "string") {
		if (v === "" || v === "null") return null;
		const n = Number(v);
		if (!Number.isNaN(n)) return n;
	}
	return null;
}

function nullableString(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	if (typeof v === "string") return v === "" || v === "null" ? null : v;
	return null;
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * Reject atom ids that could escape <baseDir>/<type>/. We allow UUIDs and
 * reasonable human-readable ids (e.g. "test-atom-1") but block:
 *   - path separators (`/`, `\`)
 *   - parent traversal (`..`)
 *   - NUL bytes
 *   - leading dots (hidden files, weird behaviour on some platforms)
 *   - empty strings
 */
function isSafeFilename(id: string): boolean {
	if (id === "" || id.length > 200) return false;
	if (id.includes("/") || id.includes("\\")) return false;
	if (id.includes("\0")) return false;
	if (id === "." || id === "..") return false;
	if (id.startsWith(".")) return false;
	return true;
}