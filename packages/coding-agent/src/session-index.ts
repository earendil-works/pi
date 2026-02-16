/**
 * SessionIndex - Fast session listing and search with metadata caching.
 *
 * Optimizations over SessionManager.loadAllSessionsGlobal():
 * 1. Directory-level workspace filtering (skip entire dirs)
 * 2. Metadata cache validated by mtime+size (avoid re-parsing)
 * 3. Early termination when limit reached
 * 4. Lazy full-text loading (only for search)
 * 5. Async I/O with event loop yields (keeps spinner responsive)
 */

import { existsSync } from "fs";
import { mkdir, open, readdir, readFile, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { join, resolve } from "path";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Persisted cache entry for a single session file */
export interface CacheEntry {
	id: string;
	cwd: string;
	mtime: number; // ms since epoch
	size: number; // bytes
	messageCount: number;
	firstMessage: string; // truncated to 500 chars
	title?: string; // latest persisted title (if any)
	preview?: string; // latest persisted listing preview (if any)
}

/** Persisted cache structure */
export interface MetadataCache {
	version: 2;
	entries: Record<string, CacheEntry>; // keyed by absolute path
}

/** File path with stat info for sorting/validation */
export interface FileWithStats {
	path: string;
	mtime: number;
	size: number;
}

/** Output session metadata */
export interface SessionMeta {
	id: string;
	path: string;
	cwd: string;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	title?: string;
	preview?: string;
}

/** Search group from parsed query (reuse from list-threads.ts) */
export type SearchGroup =
	| { type: "term"; text: string }
	| { type: "phrase"; text: string }
	| { type: "or"; alternatives: string[] };

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const CACHE_VERSION = 2;
const CACHE_DIR = ".cache";
const CACHE_FILE = "index.json";
const HEADER_READ_SIZE = 8192; // 8KB usually enough for header + first message
const FIRST_MESSAGE_MAX_LEN = 500;
const SEARCH_BATCH_SIZE = 50;

// -----------------------------------------------------------------------------
// SessionIndex Class
// -----------------------------------------------------------------------------

export class SessionIndex {
	private sessionsRoot: string;
	private cacheFilePath: string;
	private cache: MetadataCache | null = null;
	private dirty = false;

	constructor(sessionsRoot: string) {
		this.sessionsRoot = sessionsRoot;
		this.cacheFilePath = join(sessionsRoot, CACHE_DIR, CACHE_FILE);
	}

	// -------------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------------

	/**
	 * Fast path: list recent sessions with optional workspace filter.
	 * Does NOT load full message text - uses cached metadata.
	 */
	async listRecent(workspace: string | null, limit: number): Promise<SessionMeta[]> {
		await this.loadCache();

		const dirs = await this.findMatchingDirectories(workspace);
		const files = await this.collectFilesWithTimestamps(dirs);
		const sorted = this.sortByTimestampDescending(files);

		const results: SessionMeta[] = [];
		const wsLower = workspace?.toLowerCase();

		for (const file of sorted) {
			if (results.length >= limit) break;

			const entry = await this.getMetadata(file);
			// Double-check workspace filter (dir name matching is approximate)
			if (!wsLower || entry.cwd.toLowerCase().includes(wsLower)) {
				results.push(this.cacheEntryToSessionMeta(file.path, entry));
			}
		}

		await this.flushCache();
		return results;
	}

	/**
	 * Search sessions by text query. Loads full text lazily in batches.
	 * Yields to event loop between batches to keep UI responsive.
	 */
	async search(workspace: string | null, groups: SearchGroup[], limit: number): Promise<SessionMeta[]> {
		// Get all workspace-filtered candidates (metadata only)
		const candidates = await this.listRecent(workspace, Infinity);

		const results: SessionMeta[] = [];

		for (let i = 0; i < candidates.length && results.length < limit; i += SEARCH_BATCH_SIZE) {
			// Yield to event loop
			await new Promise((r) => setImmediate(r));

			const batch = candidates.slice(i, i + SEARCH_BATCH_SIZE);

			// Parallel load full text for batch
			const texts = await Promise.all(batch.map((s) => this.loadFullText(s.path)));

			// Apply search filter
			for (let j = 0; j < batch.length && results.length < limit; j++) {
				const haystack = (batch[j].firstMessage + " " + texts[j]).toLowerCase();
				if (this.matchAllGroups(groups, haystack)) {
					results.push(batch[j]);
				}
			}
		}

		return results;
	}

	/**
	 * Search with OR relaxation (matches any group instead of all).
	 */
	async searchAny(workspace: string | null, groups: SearchGroup[], limit: number): Promise<SessionMeta[]> {
		const candidates = await this.listRecent(workspace, Infinity);

		const results: SessionMeta[] = [];

		for (let i = 0; i < candidates.length && results.length < limit; i += SEARCH_BATCH_SIZE) {
			await new Promise((r) => setImmediate(r));

			const batch = candidates.slice(i, i + SEARCH_BATCH_SIZE);
			const texts = await Promise.all(batch.map((s) => this.loadFullText(s.path)));

			for (let j = 0; j < batch.length && results.length < limit; j++) {
				const haystack = (batch[j].firstMessage + " " + texts[j]).toLowerCase();
				if (this.matchAnyGroup(groups, haystack)) {
					results.push(batch[j]);
				}
			}
		}

		return results;
	}

	/**
	 * Remove stale cache entries for deleted files.
	 */
	async pruneCache(): Promise<void> {
		await this.loadCache();
		if (!this.cache) return;

		const toDelete: string[] = [];
		for (const path of Object.keys(this.cache.entries)) {
			if (!existsSync(path)) {
				toDelete.push(path);
			}
		}

		for (const path of toDelete) {
			delete this.cache.entries[path];
			this.dirty = true;
		}

		await this.flushCache();
	}

	// -------------------------------------------------------------------------
	// Directory Scanner
	// -------------------------------------------------------------------------

	/**
	 * Find workspace directories matching the filter.
	 * Directories are named --workspace-path-- so we can filter by substring.
	 */
	async findMatchingDirectories(workspace: string | null): Promise<string[]> {
		if (!existsSync(this.sessionsRoot)) return [];

		const entries = await readdir(this.sessionsRoot, { withFileTypes: true });

		// Convert workspace path to directory name pattern
		// e.g., "/Users/foo/project" → "users-foo-project"
		const wsTerm = workspace?.toLowerCase().replace(/^\//, "").replace(/[/\\]/g, "-");

		return entries
			.filter((e) => e.isDirectory() && e.name.startsWith("--"))
			.filter((e) => !wsTerm || e.name.toLowerCase().includes(wsTerm))
			.map((e) => join(this.sessionsRoot, e.name));
	}

	/**
	 * Collect all .jsonl files with their stats from given directories.
	 */
	async collectFilesWithTimestamps(dirs: string[]): Promise<FileWithStats[]> {
		const files: FileWithStats[] = [];

		await Promise.all(
			dirs.map(async (dir) => {
				try {
					const entries = await readdir(dir);
					const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));

					const withStats = await Promise.all(
						jsonlFiles.map(async (f) => {
							const path = join(dir, f);
							const stats = await stat(path);
							return { path, mtime: stats.mtimeMs, size: stats.size };
						}),
					);

					files.push(...withStats);
				} catch {
					// Skip inaccessible directories
				}
			}),
		);

		return files;
	}

	/**
	 * Sort files by mtime descending (most recent first).
	 */
	sortByTimestampDescending(files: FileWithStats[]): FileWithStats[] {
		return [...files].sort((a, b) => b.mtime - a.mtime);
	}

	// -------------------------------------------------------------------------
	// Metadata Cache
	// -------------------------------------------------------------------------

	/**
	 * Load cache from disk. Initializes empty cache if missing or invalid.
	 */
	async loadCache(): Promise<void> {
		if (this.cache) return;

		try {
			const content = await readFile(this.cacheFilePath, "utf8");
			const parsed = JSON.parse(content) as MetadataCache;

			// Validate version
			if (parsed.version !== CACHE_VERSION) {
				this.cache = { version: CACHE_VERSION, entries: {} };
			} else {
				this.cache = parsed;
			}
		} catch {
			// File doesn't exist or is invalid
			this.cache = { version: CACHE_VERSION, entries: {} };
		}
	}

	/**
	 * Write cache to disk if dirty.
	 */
	async flushCache(): Promise<void> {
		if (!this.dirty || !this.cache) return;

		const dir = join(this.sessionsRoot, CACHE_DIR);
		if (!existsSync(dir)) {
			await mkdir(dir, { recursive: true });
		}

		await writeFile(this.cacheFilePath, JSON.stringify(this.cache));
		this.dirty = false;
	}

	/**
	 * Check if cached entry is still valid based on mtime + size.
	 */
	isCacheValid(cached: CacheEntry, file: FileWithStats): boolean {
		return cached.mtime === file.mtime && cached.size === file.size;
	}

	/**
	 * Get metadata for a file, using cache if valid.
	 */
	async getMetadata(file: FileWithStats): Promise<CacheEntry> {
		const cached = this.cache?.entries[file.path];

		if (cached && this.isCacheValid(cached, file)) {
			return cached;
		}

		// Cache miss - read from file
		const entry = await this.readMetadataFromFile(file);
		this.cache!.entries[file.path] = entry;
		this.dirty = true;

		return entry;
	}

	// -------------------------------------------------------------------------
	// Header Parser
	// -------------------------------------------------------------------------

	/**
	 * Read session header and first user message from file.
	 * Only reads first 8KB to avoid loading entire file.
	 */
	async readMetadataFromFile(file: FileWithStats): Promise<CacheEntry> {
		const fd = await open(file.path, "r");
		try {
			const buffer = Buffer.alloc(HEADER_READ_SIZE);
			const { bytesRead } = await fd.read(buffer, 0, HEADER_READ_SIZE, 0);
			const content = buffer.toString("utf8", 0, bytesRead);
			const lines = content.split("\n");

			// Parse header (first line)
			const header = JSON.parse(lines[0]) as { id: string; cwd?: string; title?: string };
			let title = typeof header.title === "string" && header.title.trim() ? header.title.trim() : undefined;
			let preview: string | undefined;

			let firstMessage = "";
			let messageCount = 0;

			// For small files, the header read likely contains the full file, so we can extract title/preview quickly.
			for (let i = 1; i < lines.length; i++) {
				const line = lines[i].trim();
				if (!line) continue;

				let parsed: unknown;
				try {
					parsed = JSON.parse(line) as unknown;
				} catch {
					// Partial line at end of buffer - ignore
					continue;
				}

				if (typeof parsed !== "object" || parsed === null) continue;
				const rec = parsed as Record<string, unknown>;
				const type = rec.type;

				if (type === "session") {
					const t = typeof rec.title === "string" ? rec.title.trim() : "";
					if (t) title = t;
					continue;
				}
				if (type === "title_change") {
					const t = typeof rec.title === "string" ? rec.title.trim() : "";
					if (t) title = t;
					continue;
				}
				if (type === "preview_change") {
					const p = typeof rec.preview === "string" ? rec.preview.trim() : "";
					if (p) preview = p;
					continue;
				}

				if (type === "message" || type === "custom_message") {
					messageCount++;
					if (!firstMessage) {
						const msg = rec.message;
						if (typeof msg === "object" && msg !== null) {
							const msgRec = msg as Record<string, unknown>;
							if (msgRec.role === "user") {
								firstMessage = this.extractText(msgRec.content);
							}
						}
					}
				}
			}

			// Large file: scan full file once to get robust title/preview and accurate message count.
			if (bytesRead === HEADER_READ_SIZE) {
				const scanned = await this.scanSessionFileForMetadata(file.path);
				messageCount = scanned.messageCount;
				if (scanned.firstMessage) firstMessage = scanned.firstMessage;
				title = scanned.title ?? title;
				preview = scanned.preview ?? preview;
			}

			return {
				id: header.id,
				cwd: header.cwd || "",
				mtime: file.mtime,
				size: file.size,
				messageCount,
				firstMessage: firstMessage.substring(0, FIRST_MESSAGE_MAX_LEN),
				title,
				preview,
			};
		} finally {
			await fd.close();
		}
	}

	private async scanSessionFileForMetadata(filePath: string): Promise<{
		messageCount: number;
		firstMessage: string;
		title?: string;
		preview?: string;
	}> {
		const content = await readFile(filePath, "utf8");
		let messageCount = 0;
		let firstMessage = "";
		let title: string | undefined;
		let preview: string | undefined;

		const normalize = (value: unknown): string | undefined =>
			typeof value === "string" && value.trim() ? value.trim() : undefined;

		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed) as unknown;
			} catch {
				continue;
			}
			if (typeof parsed !== "object" || parsed === null) continue;
			const rec = parsed as Record<string, unknown>;
			const type = rec.type;

			if (type === "session") {
				const t = normalize(rec.title);
				if (t) title = t;
				continue;
			}
			if (type === "title_change") {
				const t = normalize(rec.title);
				if (t) title = t;
				continue;
			}
			if (type === "preview_change") {
				const p = normalize(rec.preview);
				if (p) preview = p;
				continue;
			}

			if (type === "message" || type === "custom_message") {
				messageCount++;
				if (!firstMessage) {
					const msg = rec.message;
					if (typeof msg === "object" && msg !== null) {
						const msgRec = msg as Record<string, unknown>;
						if (msgRec.role === "user") {
							firstMessage = this.extractText(msgRec.content);
						}
					}
				}
			}
		}

		return { messageCount, firstMessage, title, preview };
	}

	/**
	 * Count message entries in a file (for accurate count when header read is partial).
	 */
	async countMessages(filePath: string): Promise<number> {
		const content = await readFile(filePath, "utf8");
		let count = 0;

		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as { type: string };
				if (entry.type === "message" || entry.type === "custom_message") {
					count++;
				}
			} catch {
				// Skip malformed lines
			}
		}

		return count;
	}

	/**
	 * Load all message text from a session file (for search).
	 */
	async loadFullText(filePath: string): Promise<string> {
		const content = await readFile(filePath, "utf8");
		const texts: string[] = [];

		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as {
					type: string;
					message?: { role: string; content: unknown };
				};

				if (entry.type === "message" || entry.type === "custom_message") {
					const role = entry.message?.role;
					if (role === "user" || role === "assistant") {
						texts.push(this.extractText(entry.message?.content));
					}
				}
			} catch {
				// Skip malformed lines
			}
		}

		return texts.join(" ");
	}

	/**
	 * Extract text from message content (handles string or array format).
	 */
	extractText(content: unknown): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: string; text?: string } => c && typeof c === "object" && c.type === "text")
				.map((c) => c.text || "")
				.join(" ");
		}
		return "";
	}

	// -------------------------------------------------------------------------
	// Query Matcher
	// -------------------------------------------------------------------------

	/**
	 * Check if a single search group matches the haystack.
	 */
	matchGroup(group: SearchGroup, haystack: string): boolean {
		switch (group.type) {
			case "term":
			case "phrase":
				return haystack.includes(group.text);
			case "or":
				return group.alternatives.some((alt) => haystack.includes(alt));
		}
	}

	/**
	 * Check if ALL groups match (AND semantics).
	 */
	matchAllGroups(groups: SearchGroup[], haystack: string): boolean {
		return groups.every((group) => this.matchGroup(group, haystack));
	}

	/**
	 * Check if ANY group matches (OR semantics for relaxation).
	 */
	matchAnyGroup(groups: SearchGroup[], haystack: string): boolean {
		return groups.some((group) => this.matchGroup(group, haystack));
	}

	// -------------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------------

	private cacheEntryToSessionMeta(path: string, entry: CacheEntry): SessionMeta {
		return {
			id: entry.id,
			path,
			cwd: entry.cwd,
			modified: new Date(entry.mtime),
			messageCount: entry.messageCount,
			firstMessage: entry.firstMessage,
			title: entry.title,
			preview: entry.preview,
		};
	}
}

// -----------------------------------------------------------------------------
// Factory function for easy instantiation
// -----------------------------------------------------------------------------

/**
 * Get the sessions root directory.
 */
export function getSessionsRoot(): string {
	const configDir = resolve(process.env.MU_CODING_AGENT_DIR || join(homedir(), ".mu/agent/"));
	return join(configDir, "sessions");
}
