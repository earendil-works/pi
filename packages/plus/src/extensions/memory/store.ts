/**
 * File-backed long-term memory store for the memory_save / memory_recall tools
 * (adapted from openclaude's memdir system).
 *
 * Memories are markdown files with YAML frontmatter (name, description, type)
 * living under <agentDir>/memory/<project-key>/, one file per memory plus a
 * MEMORY.md index file in the same directory. <project-key> is the cwd
 * encoding the session manager uses for its per-cwd session dirs, so memories
 * are scoped per project and profiles (per-profile agent dirs) stay isolated.
 *
 * Writes are atomic (tmp file + rename) and serialized through an in-process
 * promise queue. Cross-process writers of the same project are not expected
 * (the auto-extract sub-agent runs in its own process but writes between
 * turns, never concurrently with the main agent), so no file locking is used.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { stringify } from "yaml";
import { getAgentDir } from "../../../../coding-agent/src/config.ts";
import { parseFrontmatter } from "../../../../coding-agent/src/utils/frontmatter.ts";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const INDEX_FILE = "MEMORY.md";
/** Index caps, ported from openclaude's memdir (MAX_ENTRYPOINT_LINES / MAX_ENTRYPOINT_BYTES). */
export const MAX_INDEX_LINES = 200;
export const MAX_INDEX_BYTES = 25_000;

const MAX_SLUG_LENGTH = 60;

export interface Memory {
	name: string;
	description: string;
	type: MemoryType;
	body: string;
	/** Base file name within the store dir, e.g. "prefers-pnpm.md". */
	fileName: string;
	mtimeMs: number;
}

export interface MemorySaveInput {
	name: string;
	description: string;
	type: MemoryType;
	body: string;
}

/**
 * Per-project key for `cwd`: the same encoding getDefaultSessionDirPath uses
 * for the per-cwd session dirs (session-manager.ts). Kept as a local replica
 * so the store does not pull the whole session manager into the module graph;
 * if the upstream encoding ever changes, update both.
 */
export function projectKeyFor(cwd: string): string {
	const resolved = path.resolve(cwd);
	return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Slug used as the file base name. Derived from `name` only; raw names with path separators are rejected. */
function slugFor(name: string): string {
	if (/[/\\\0]/.test(name)) {
		throw new Error(`memory name must not contain path separators: ${JSON.stringify(name)}`);
	}
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG_LENGTH);
	if (!slug) {
		throw new Error(`memory name does not produce a usable file name: ${JSON.stringify(name)}`);
	}
	return slug;
}

function hashSuffix(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

function serializeMemory(input: MemorySaveInput): string {
	const frontmatter = stringify({ name: input.name, description: input.description, type: input.type });
	return `---\n${frontmatter}---\n\n${input.body.trim()}\n`;
}

function normalizeType(value: unknown): MemoryType {
	return (MEMORY_TYPES as readonly string[]).includes(value as string) ? (value as MemoryType) : "reference";
}

function parseMemoryFile(fileName: string, raw: string, mtimeMs: number): Memory | null {
	try {
		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(raw);
		const name = typeof frontmatter.name === "string" && frontmatter.name.trim() !== "" ? frontmatter.name : null;
		if (!name) return null;
		return {
			name,
			description: typeof frontmatter.description === "string" ? frontmatter.description : "",
			type: normalizeType(frontmatter.type),
			body,
			fileName,
			mtimeMs,
		};
	} catch {
		return null;
	}
}

function truncate(text: string, max: number): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	return singleLine.length <= max ? singleLine : `${singleLine.slice(0, max - 1)}…`;
}

export class MemoryStore {
	private memoryDir: string;
	private queue: Promise<unknown> = Promise.resolve();

	private constructor(memoryDir: string) {
		this.memoryDir = memoryDir;
	}

	/** Store for the project containing `cwd`. */
	static forCwd(cwd: string): MemoryStore {
		return new MemoryStore(path.join(getAgentDir(), "memory", projectKeyFor(cwd)));
	}

	/** Direct constructor for tests with an injected directory. */
	static forDir(memoryDir: string): MemoryStore {
		return new MemoryStore(memoryDir);
	}

	dir(): string {
		return this.memoryDir;
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.queue.then(fn, fn);
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private ensureDir(): void {
		fs.mkdirSync(this.memoryDir, { recursive: true });
	}

	private memoryPath(fileName: string): string {
		return path.join(this.memoryDir, fileName);
	}

	private readFile(fileName: string): Memory | null {
		try {
			const stats = fs.statSync(this.memoryPath(fileName));
			const raw = fs.readFileSync(this.memoryPath(fileName), "utf-8");
			return parseMemoryFile(fileName, raw, stats.mtimeMs);
		} catch {
			return null;
		}
	}
	private writeFile(fileName: string, content: string): void {
		this.ensureDir();
		const target = this.memoryPath(fileName);
		const tmp = `${target}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o600 });
		fs.renameSync(tmp, target);
	}

	/**
	 * Resolve the file name for `name`: the plain slug, unless that file
	 * already exists under a different memory name, in which case a hash of
	 * the name disambiguates (two different names slugging to the same file).
	 */
	private resolveFileName(name: string): string {
		const slug = slugFor(name);
		const plain = `${slug}.md`;
		const existing = this.readFile(plain);
		if (!existing || existing.name === name) return plain;
		return `${slug}-${hashSuffix(name)}.md`;
	}

	private rebuildIndex(memories: Memory[]): void {
		const lines = memories
			.map((m) => `- [${m.name}](${m.fileName}) — ${truncate(m.description, 80)}`)
			.sort((a, b) => a.localeCompare(b));
		// Cap the index (openclaude parity); entries beyond the caps are dropped
		// from the end of the alphabetically-sorted list.
		while (lines.length > MAX_INDEX_LINES) lines.pop();
		let content = `# Memory index\n\n${lines.join("\n")}\n`;
		while (Buffer.byteLength(content, "utf-8") > MAX_INDEX_BYTES && lines.length > 0) {
			lines.pop();
			content = `# Memory index\n\n${lines.join("\n")}\n`;
		}
		this.writeFile(INDEX_FILE, content);
	}

	/** Synchronous core of list(); also callable from inside an enqueued write. */
	private listSync(): Memory[] {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(this.memoryDir, { withFileTypes: true });
		} catch {
			return [];
		}
		const memories: Memory[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === INDEX_FILE) continue;
			if (entry.name.includes(".tmp-")) continue;
			const memory = this.readFile(entry.name);
			if (memory) memories.push(memory);
		}
		memories.sort((a, b) => a.name.localeCompare(b.name));
		return memories;
	}

	/** All memories, sorted by name. Unreadable or frontmatter-less files are skipped. */
	list(): Promise<Memory[]> {
		return this.enqueue(async () => this.listSync());
	}

	/** One memory by file name, or null. Rejects file names outside the store dir. */
	get(fileName: string): Promise<Memory | null> {
		return this.enqueue(async () => {
			if (fileName !== path.basename(fileName)) return null;
			return this.readFile(fileName);
		});
	}

	/** Create or overwrite the memory called `input.name` and rebuild the index. */
	save(input: MemorySaveInput): Promise<Memory> {
		return this.enqueue(async () => {
			const fileName = this.resolveFileName(input.name);
			this.writeFile(fileName, serializeMemory(input));
			this.rebuildIndex([
				...this.listSync().filter((m) => m.fileName !== fileName),
				{
					name: input.name,
					description: input.description,
					type: input.type,
					body: input.body,
					fileName,
					mtimeMs: Date.now(),
				},
			]);
			const memory = this.readFile(fileName);
			if (!memory) throw new Error(`failed to persist memory ${JSON.stringify(input.name)}`);
			return memory;
		});
	}

	/** Delete the memory stored in `fileName` and rebuild the index. */
	remove(fileName: string): Promise<boolean> {
		return this.enqueue(async () => {
			if (fileName !== path.basename(fileName)) return false;
			let existed = true;
			try {
				fs.unlinkSync(this.memoryPath(fileName));
			} catch {
				existed = false;
			}
			this.rebuildIndex(this.listSync().filter((m) => m.fileName !== fileName));
			return existed;
		});
	}

	/** Raw MEMORY.md content ("" when no index exists yet). */
	readIndex(): Promise<string> {
		return this.enqueue(async () => this.readIndexSync());
	}

	private readIndexSync(): string {
		try {
			return fs.readFileSync(this.memoryPath(INDEX_FILE), "utf-8");
		} catch {
			return "";
		}
	}

	/**
	 * Keyword search over all memories. Every query term must match somewhere
	 * (name +3, description +2, body +1 per term); results are score-ordered.
	 * An empty query returns the first `limit` memories.
	 */
	async search(query: string, limit = 5): Promise<Memory[]> {
		const memories = await this.list();
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		if (terms.length === 0) return memories.slice(0, limit);
		const scored: { memory: Memory; score: number }[] = [];
		for (const memory of memories) {
			const name = memory.name.toLowerCase();
			const description = memory.description.toLowerCase();
			const body = memory.body.toLowerCase();
			let score = 0;
			for (const term of terms) {
				if (name.includes(term)) score += 3;
				else if (description.includes(term)) score += 2;
				else if (body.includes(term)) score += 1;
				else {
					score = 0;
					break;
				}
			}
			if (score > 0) scored.push({ memory, score });
		}
		scored.sort((a, b) => b.score - a.score || a.memory.name.localeCompare(b.memory.name));
		return scored.slice(0, limit).map((s) => s.memory);
	}
}
