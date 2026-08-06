import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface MemoryEntry {
	id: string;
	text: string;
	tags: string[];
	createdAt: number;
	updatedAt: number;
}

interface MemoryFile {
	version: 1;
	entries: MemoryEntry[];
}

const MAX_QUERY_TERMS = 24;
const MIN_TERM_LENGTH = 2;

/** Tag used for the rolling conversation summary entry. */
export const SUMMARY_TAG = "conversation-summary";

export class MemoryStore {
	private entries: MemoryEntry[] = [];
	private readonly filePath: string;

	constructor(filePath: string) {
		this.filePath = filePath;
		this.load();
	}

	load(): void {
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as MemoryFile;
			this.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
		} catch {
			this.entries = [];
		}
	}

	save(): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		writeFileSync(this.filePath, JSON.stringify({ version: 1, entries: this.entries }, null, 2), "utf8");
	}

	add(text: string, tags: string[] = []): MemoryEntry {
		const now = Date.now();
		const entry: MemoryEntry = {
			id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			text,
			tags: [...tags],
			createdAt: now,
			updatedAt: now,
		};
		this.entries.push(entry);
		this.save();
		return entry;
	}

	remove(id: string): boolean {
		const index = this.entries.findIndex((entry) => entry.id === id);
		if (index < 0) {
			return false;
		}
		this.entries.splice(index, 1);
		this.save();
		return true;
	}

	list(): MemoryEntry[] {
		return [...this.entries].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	findByTag(tag: string): MemoryEntry | undefined {
		return this.entries.find((entry) => entry.tags.includes(tag));
	}

	upsertByTag(tag: string, text: string): MemoryEntry {
		const existing = this.findByTag(tag);
		if (existing) {
			existing.text = text;
			existing.updatedAt = Date.now();
			this.save();
			return existing;
		}
		return this.add(text, [tag]);
	}

	search(query: string, limit = 5, excludeTags: string[] = []): MemoryEntry[] {
		const terms = extractTerms(query);
		if (terms.length === 0) {
			return [];
		}
		return this.entries
			.filter((entry) => !excludeTags.some((tag) => entry.tags.includes(tag)))
			.map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
			.filter((candidate) => candidate.score > 0)
			.sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
			.slice(0, limit)
			.map((candidate) => candidate.entry);
	}
}

function extractTerms(query: string): string[] {
	const segments = query
		.split(/[\s,，。；;、!！?？:：/\\]+/)
		.map((term) => term.trim())
		.filter((term) => term.length >= MIN_TERM_LENGTH || (term.length === 1 && HAS_CJK.test(term)));
	const terms = new Set<string>();
	for (const segment of segments) {
		terms.add(segment);
		if (HAS_CJK.test(segment)) {
			for (let index = 0; index + 2 <= segment.length; index++) {
				terms.add(segment.slice(index, index + 2));
			}
		}
	}
	return [...terms].slice(0, MAX_QUERY_TERMS);
}

const HAS_CJK = /[\u4e00-\u9fff]/;

function scoreEntry(entry: MemoryEntry, terms: string[]): number {
	const textLower = entry.text.toLowerCase();
	let score = 0;
	for (const term of terms) {
		const termLower = term.toLowerCase();
		if (entry.tags.some((tag) => tag.toLowerCase() === termLower)) {
			score += 3;
		} else if (entry.tags.some((tag) => tag.toLowerCase().includes(termLower))) {
			score += 2;
		}
		if (textLower.includes(termLower)) {
			score += 1;
		}
	}
	return score;
}
