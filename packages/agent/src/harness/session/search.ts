import type { FileError, Result } from "../types.ts";
import type { Session } from "./session.ts";
import { type SessionCreateOptions, SessionError, type SessionMetadata, type SessionRepo } from "./types.ts";

export interface SessionSearchOptions {
	text: string;
	cwd?: string;
}

export interface SessionSearchHit<TMetadata extends SessionMetadata = SessionMetadata> {
	metadata: TMetadata;
	entryId: string;
	timestamp: string;
	snippet?: string;
	score?: number;
}

export interface SessionSearch<TMetadata extends SessionMetadata = SessionMetadata> {
	search(options: SessionSearchOptions): Promise<SessionSearchHit<TMetadata>[]>;
}

export function getFileSystemResultOrThrow<TValue>(result: Result<TValue, FileError>, message: string): TValue {
	if (!result.ok) {
		const code = result.error.code === "not_found" ? "not_found" : "storage";
		throw new SessionError(code, `${message}: ${result.error.message}`, result.error);
	}
	return result.value;
}

type ScanningSessionSearchSource<TMetadata extends SessionMetadata> = {
	list(): Promise<TMetadata[]>;
	open(metadata: TMetadata): Promise<Session<TMetadata>>;
};

class ScanningSessionSearch<TMetadata extends SessionMetadata = SessionMetadata> implements SessionSearch<TMetadata> {
	private readonly source: ScanningSessionSearchSource<TMetadata>;

	constructor(source: ScanningSessionSearchSource<TMetadata>) {
		this.source = source;
	}

	async search(options: SessionSearchOptions): Promise<SessionSearchHit<TMetadata>[]> {
		const normalizedText = options.text.trim().toLowerCase();
		if (!normalizedText) return [];
		const hits: SessionSearchHit<TMetadata>[] = [];
		for (const metadata of await this.source.list()) {
			const cwd = (metadata as { cwd?: unknown }).cwd;
			if (options.cwd !== undefined && cwd !== options.cwd) continue;
			const session = await this.source.open(metadata);
			for (const entry of await session.findEntries({ order: "oldestFirst" })) {
				const payload = JSON.stringify(entry);
				if (!payload.toLowerCase().includes(normalizedText)) continue;
				hits.push({
					metadata,
					entryId: entry.id,
					timestamp: new Date(entry.timestamp).toISOString(),
					snippet: payload,
				});
			}
		}
		return hits;
	}
}

export function createScanningSessionSearch<
	TMetadata extends SessionMetadata,
	TCreateOptions extends SessionCreateOptions,
	TListOptions,
>(source: Pick<SessionRepo<TMetadata, TCreateOptions, TListOptions>, "list" | "open">): SessionSearch<TMetadata> {
	return new ScanningSessionSearch(source);
}
