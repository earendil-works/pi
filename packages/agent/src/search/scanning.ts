import type { Entry, SessionMetadata, SessionStorage } from "../harness/session/types.ts";
import type { SessionSearch, SessionSearchHit, SessionSearchOptions } from "./index.ts";

export interface SessionSearchCandidate {
	readonly entryId: string;
	readonly seq: number;
	readonly type: Entry["type"];
	readonly timestamp: number;
	readonly text: string;
	readonly fields?: Record<string, unknown>;
}

export type ScanningReadable<TMetadata extends SessionMetadata = SessionMetadata> = Pick<
	SessionStorage<TMetadata>,
	"getMetadata" | "findEntries" | "getLabel"
>;

export type ScanningReadableSource<TMetadata extends SessionMetadata = SessionMetadata, TOptions = unknown> = (
	options?: TOptions,
) => AsyncIterable<ScanningReadable<TMetadata>>;

export type ScanningSearchTextProjector<TMetadata extends SessionMetadata = SessionMetadata> = (
	metadata: TMetadata,
	entry: Entry,
	label: string | undefined,
) => string;

export interface ScanningReadableOptions<TMetadata extends SessionMetadata = SessionMetadata> {
	projectText?: ScanningSearchTextProjector<TMetadata>;
	pageSize?: number;
}

export interface ScanningSessionSearchHit extends SessionSearchHit {
	readonly timestamp: number;
	readonly snippet: string;
}

export interface ScanningSessionSearchOptions<
	TMetadata extends SessionMetadata = SessionMetadata,
	TSourceOptions = unknown,
	THit extends SessionSearchHit = ScanningSessionSearchHit,
> extends ScanningReadableOptions<TMetadata> {
	sourceOptions?: (text: string, options: SessionSearchOptions) => TSourceOptions | undefined;
	match?: (queryText: string, candidate: SessionSearchCandidate, metadata: TMetadata) => boolean;
	createHit?: (metadata: TMetadata, candidate: SessionSearchCandidate) => THit;
}

function defaultSearchText<TMetadata extends SessionMetadata>(
	_metadata: TMetadata,
	entry: Entry,
	label: string | undefined,
): string {
	return label === undefined ? JSON.stringify(entry) : `${JSON.stringify(entry)} ${label}`;
}

async function* scanReadableEntries<TMetadata extends SessionMetadata>(
	readable: ScanningReadable<TMetadata>,
	metadata: TMetadata,
	options: ScanningReadableOptions<TMetadata>,
	query: { afterSeq?: number; limit?: number; entryTypes?: readonly Entry["type"][] } = {},
): AsyncIterable<SessionSearchCandidate> {
	const projectText = options.projectText ?? defaultSearchText;
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

export async function* scanningEntries<TMetadata extends SessionMetadata>(
	readable: ScanningReadable<TMetadata>,
	options: ScanningReadableOptions<TMetadata> = {},
): AsyncIterable<SessionSearchCandidate> {
	yield* scanReadableEntries(readable, await readable.getMetadata(), options);
}

async function* arraySource<TMetadata extends SessionMetadata>(
	readables: readonly ScanningReadable<TMetadata>[],
): AsyncIterable<ScanningReadable<TMetadata>> {
	yield* readables;
}

function readablesFor<TMetadata extends SessionMetadata, TSourceOptions>(
	source: readonly ScanningReadable<TMetadata>[] | ScanningReadableSource<TMetadata, TSourceOptions>,
	options: TSourceOptions | undefined,
): AsyncIterable<ScanningReadable<TMetadata>> {
	return typeof source === "function" ? source(options) : arraySource(source);
}

function defaultMatch(queryText: string, candidate: SessionSearchCandidate): boolean {
	return candidate.text.toLowerCase().includes(queryText);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	throw error;
}

function createDefaultScanningHit<TMetadata extends SessionMetadata>(
	metadata: TMetadata,
	candidate: SessionSearchCandidate,
): ScanningSessionSearchHit {
	return {
		sessionId: metadata.id,
		entryId: candidate.entryId,
		timestamp: candidate.timestamp,
		snippet: candidate.text,
	};
}

export function createScanningSessionSearch<
	TMetadata extends SessionMetadata,
	TSourceOptions = unknown,
	THit extends SessionSearchHit = ScanningSessionSearchHit,
>(
	source: readonly ScanningReadable<TMetadata>[] | ScanningReadableSource<TMetadata, TSourceOptions>,
	options: ScanningSessionSearchOptions<TMetadata, TSourceOptions, THit> = {},
): SessionSearch<THit> {
	const createHit =
		options.createHit ??
		((metadata: TMetadata, candidate: SessionSearchCandidate) =>
			createDefaultScanningHit(metadata, candidate) as unknown as THit);
	return {
		async *search(text: string, searchOptions: SessionSearchOptions = {}): AsyncIterable<THit> {
			const normalizedText = text.trim().toLowerCase();
			if (!normalizedText || (searchOptions.limit !== undefined && searchOptions.limit <= 0)) return;
			if (searchOptions.entryTypes?.length === 0) return;
			let hitCount = 0;
			const seenSessionIds = new Set<string>();
			const entryTypes = searchOptions.entryTypes === undefined ? undefined : new Set(searchOptions.entryTypes);
			const sourceOptions = options.sourceOptions?.(normalizedText, searchOptions);
			for await (const readable of readablesFor(source, sourceOptions)) {
				throwIfAborted(searchOptions.signal);
				const metadata = await readable.getMetadata();
				if (seenSessionIds.has(metadata.id)) throw new Error(`Duplicate sessionId: ${metadata.id}`);
				seenSessionIds.add(metadata.id);
				for await (const candidate of scanReadableEntries(readable, metadata, options, {
					entryTypes: searchOptions.entryTypes,
				})) {
					throwIfAborted(searchOptions.signal);
					if (entryTypes !== undefined && !entryTypes.has(candidate.type)) continue;
					const matches =
						options.match?.(normalizedText, candidate, metadata) ?? defaultMatch(normalizedText, candidate);
					if (!matches) continue;
					yield createHit(metadata, candidate);
					hitCount += 1;
					if (searchOptions.limit !== undefined && hitCount >= searchOptions.limit) return;
				}
			}
		},
	};
}
