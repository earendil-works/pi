import type { Entry, SessionMetadata, SessionStorage } from "../harness/session/types.ts";
import type { SessionSearch } from "./index.ts";
import {
	createScanningSessionSearch,
	type ScanningSession,
	type ScanningSessionSearchHit,
	type ScanningSessionSource,
	type SessionSearchCandidate,
} from "./scanning.ts";

export type MemoryScanningReadable<TMetadata extends SessionMetadata = SessionMetadata> = Pick<
	SessionStorage<TMetadata>,
	"getMetadata" | "findEntries" | "getLabel"
>;

export type MemorySearchTextProjector<TMetadata extends SessionMetadata = SessionMetadata> = (
	metadata: TMetadata,
	entry: Entry,
	label: string | undefined,
) => string;

export interface MemoryScanningSessionSourceOptions<TMetadata extends SessionMetadata = SessionMetadata> {
	projectText?: MemorySearchTextProjector<TMetadata>;
	pageSize?: number;
}

function defaultMemorySearchText<TMetadata extends SessionMetadata>(
	_metadata: TMetadata,
	entry: Entry,
	label: string | undefined,
): string {
	return label === undefined ? JSON.stringify(entry) : `${JSON.stringify(entry)} ${label}`;
}

async function* memorySearchCandidates<TMetadata extends SessionMetadata>(
	readable: MemoryScanningReadable<TMetadata>,
	options: MemoryScanningSessionSourceOptions<TMetadata>,
	query: { afterSeq?: number; limit?: number; entryTypes?: readonly Entry["type"][] } = {},
): AsyncIterable<SessionSearchCandidate> {
	const metadata = await readable.getMetadata();
	const projectText = options.projectText ?? defaultMemorySearchText;
	const pageSize = query.limit ?? options.pageSize ?? 100;
	let afterSeq = query.afterSeq ?? 0;
	const entryTypes = query.entryTypes === undefined ? undefined : new Set(query.entryTypes);
	while (true) {
		const entries = await readable.findEntries({
			order: "oldestFirst",
			limit: pageSize,
			cursor: { afterSeq },
			type: query.entryTypes?.length === 1 ? query.entryTypes[0] : undefined,
		});
		if (entries.length === 0) break;
		for (const entry of entries) {
			if (entryTypes !== undefined && !entryTypes.has(entry.type)) continue;
			const label = await readable.getLabel(entry.id);
			yield {
				entryId: entry.id,
				seq: entry.seq,
				type: entry.type,
				timestamp: entry.timestamp,
				text: projectText(metadata, entry, label),
				fields: label === undefined ? undefined : { label },
			};
		}
		afterSeq = entries[entries.length - 1]?.seq ?? afterSeq;
		if (entries.length < pageSize) break;
	}
}

export async function* memoryScanningSessions<TMetadata extends SessionMetadata>(
	readables: readonly MemoryScanningReadable<TMetadata>[],
	options: MemoryScanningSessionSourceOptions<TMetadata> = {},
): AsyncIterable<ScanningSession<TMetadata>> {
	for (const readable of readables) {
		yield {
			metadata: () => readable.getMetadata(),
			entries: (entryQuery) => memorySearchCandidates(readable, options, entryQuery),
		};
	}
}

export function createMemoryScanningSessionSource<TMetadata extends SessionMetadata>(
	readables: readonly MemoryScanningReadable<TMetadata>[],
	options: MemoryScanningSessionSourceOptions<TMetadata> = {},
): ScanningSessionSource<TMetadata, void> {
	return {
		sessions: () => memoryScanningSessions(readables, options),
	};
}

export function createMemoryScanningSessionSearch<TMetadata extends SessionMetadata>(
	readables: readonly MemoryScanningReadable<TMetadata>[],
	options?: MemoryScanningSessionSourceOptions<TMetadata>,
): SessionSearch<ScanningSessionSearchHit> {
	return createScanningSessionSearch(createMemoryScanningSessionSource(readables, options));
}
