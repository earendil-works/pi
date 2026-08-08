import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";

/**
 * A single cross-session memory entry. Memories persist across sessions so a
 * later session can recall durable facts (decisions, gotchas, conventions).
 */
export interface MemoryEntry {
	id: string;
	/** The durable fact / note text. */
	content: string;
	/** Session that created this memory, if any. */
	sourceSessionId?: string;
	/** Working directory this memory applies to (prefix-matched on recall). */
	cwd?: string;
	/** Optional tags for lightweight categorization. */
	tags?: string[];
	createdAt: number;
	updatedAt: number;
}

/** Query for listing or recalling memories. */
export interface MemoryQuery {
	/** Only memories created under this cwd (prefix match). */
	cwd?: string;
	/** Only memories whose content/tags match at least one keyword (substring match). */
	keywords?: string[];
	/** Maximum number of entries to return. */
	limit?: number;
}

/** New-memory input for {@link MemoryStore.save}. */
export type NewMemory = Omit<MemoryEntry, "id" | "createdAt" | "updatedAt"> & {
	id?: string;
	createdAt?: number;
	updatedAt?: number;
};

/** Persistent store for cross-session memories. */
export interface MemoryStore {
	save(memory: NewMemory): Promise<MemoryEntry>;
	list(query?: MemoryQuery): Promise<MemoryEntry[]>;
	delete(id: string): Promise<void>;
}

function matchesQuery(entry: MemoryEntry, query: MemoryQuery = {}): boolean {
	if (query.cwd && entry.cwd) {
		// The query cwd is the current working directory; a stored memory applies
		// when it was saved for that directory or any ancestor of it.
		const applies = entry.cwd === query.cwd || query.cwd.startsWith(`${entry.cwd}/`);
		if (!applies) {
			return false;
		}
	}
	if (query.keywords && query.keywords.length > 0) {
		const haystack = `${entry.content} ${(entry.tags ?? []).join(" ")}`.toLowerCase();
		if (!query.keywords.some((k) => haystack.includes(k.toLowerCase()))) {
			return false;
		}
	}
	return true;
}

/** In-memory {@link MemoryStore}, primarily for tests. */
export class InMemoryMemoryStore implements MemoryStore {
	private readonly entries = new Map<string, MemoryEntry>();

	async save(memory: NewMemory): Promise<MemoryEntry> {
		const entry: MemoryEntry = {
			...memory,
			id: memory.id ?? uuidv7(),
			createdAt: memory.createdAt ?? Date.now(),
			updatedAt: memory.updatedAt ?? Date.now(),
		};
		this.entries.set(entry.id, structuredClone(entry));
		return structuredClone(entry);
	}

	async list(query: MemoryQuery = {}): Promise<MemoryEntry[]> {
		const matches = [...this.entries.values()].filter((e) => matchesQuery(e, query));
		matches.sort((a, b) => b.updatedAt - a.updatedAt);
		return structuredClone(query.limit ? matches.slice(0, query.limit) : matches);
	}

	async delete(id: string): Promise<void> {
		this.entries.delete(id);
	}
}

/**
 * File-backed {@link MemoryStore} that persists one JSON file per memory under
 * `<agentDir>/memories/`.
 */
export class FileMemoryStore implements MemoryStore {
	private readonly agentDir: string;

	constructor(agentDir: string) {
		this.agentDir = agentDir;
	}

	private get memoriesDir(): string {
		return join(this.agentDir, "memories");
	}

	async save(memory: NewMemory): Promise<MemoryEntry> {
		const entry: MemoryEntry = {
			...memory,
			id: memory.id ?? uuidv7(),
			createdAt: memory.createdAt ?? Date.now(),
			updatedAt: memory.updatedAt ?? Date.now(),
		};
		await mkdir(this.memoriesDir, { recursive: true });
		await writeFile(join(this.memoriesDir, `${entry.id}.json`), JSON.stringify(entry, null, 2), "utf8");
		return structuredClone(entry);
	}

	async list(query: MemoryQuery = {}): Promise<MemoryEntry[]> {
		await mkdir(this.memoriesDir, { recursive: true });
		const names = await readdir(this.memoriesDir);
		const entries: MemoryEntry[] = [];
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			try {
				const raw = await readFile(join(this.memoriesDir, name), "utf8");
				entries.push(JSON.parse(raw) as MemoryEntry);
			} catch {
				// Skip corrupted/partial files.
			}
		}
		const matches = entries.filter((e) => matchesQuery(e, query));
		matches.sort((a, b) => b.updatedAt - a.updatedAt);
		return query.limit ? matches.slice(0, query.limit) : matches;
	}

	async delete(id: string): Promise<void> {
		await rm(join(this.memoriesDir, `${id}.json`), { force: true });
	}
}

/**
 * Formats recalled memories into a system-prompt appendix block, or undefined
 * when there is nothing to inject.
 */
export function formatMemoriesBlock(memories: MemoryEntry[]): string | undefined {
	if (memories.length === 0) {
		return undefined;
	}
	const lines = memories.map((m) => `- ${m.content}`).join("\n");
	return `## Project memories\n${lines}\n(These are facts from earlier sessions in this project. Use them when relevant; ignore when stale.)`;
}
