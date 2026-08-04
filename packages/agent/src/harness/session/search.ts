import type {
	SessionCreateOptions,
	SessionMetadata,
	SessionSearch,
	SessionSearchHit,
	SessionSearchOptions,
} from "../types.ts";
import type { SessionRepository } from "./repository.ts";
import type { Session } from "./session.ts";

type ScanningSessionSearchSource<TMetadata extends SessionMetadata> = {
	list(): Promise<TMetadata[]>;
	open(metadata: TMetadata): Promise<Session<TMetadata>>;
};

/** Searches canonical sessions directly and therefore has no index to maintain. */
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
			for (const entry of await session.getEntries()) {
				const payload = JSON.stringify(entry);
				if (!payload.toLowerCase().includes(normalizedText)) continue;
				hits.push({ metadata, entryId: entry.id, timestamp: entry.timestamp, snippet: payload });
			}
		}
		return hits;
	}
}

export function createScanningSessionSearch<
	TMetadata extends SessionMetadata,
	TCreateOptions extends SessionCreateOptions,
	TListOptions,
>(source: Pick<SessionRepository<TMetadata, TCreateOptions, TListOptions>, "list" | "open">): SessionSearch<TMetadata> {
	return new ScanningSessionSearch(source);
}
