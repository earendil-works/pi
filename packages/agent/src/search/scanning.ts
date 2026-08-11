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

export interface ScanningSession<TMetadata extends SessionMetadata = SessionMetadata> {
	metadata(): Promise<TMetadata>;
	entries(options?: {
		afterSeq?: number;
		limit?: number;
		entryTypes?: readonly Entry["type"][];
	}): AsyncIterable<SessionSearchCandidate>;
}

export interface ScanningSessionSource<TMetadata extends SessionMetadata = SessionMetadata, TOptions = unknown> {
	sessions(options?: TOptions): AsyncIterable<ScanningSession<TMetadata>>;
}

export type ScanningReadable<TMetadata extends SessionMetadata = SessionMetadata> = Pick<
	SessionStorage<TMetadata>,
	"getMetadata" | "findEntries" | "getLabel"
>;

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
	TListOptions = unknown,
	THit extends SessionSearchHit = ScanningSessionSearchHit,
> {
	sourceOptions?: (text: string, options: SessionSearchOptions) => TListOptions | undefined;
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

async function* searchCandidatesFromReadable<TMetadata extends SessionMetadata>(
	readable: ScanningReadable<TMetadata>,
	options: ScanningReadableOptions<TMetadata>,
	query: { afterSeq?: number; limit?: number; entryTypes?: readonly Entry["type"][] } = {},
): AsyncIterable<SessionSearchCandidate> {
	const metadata = await readable.getMetadata();
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

export function createScanningSessionFromReadable<TMetadata extends SessionMetadata>(
	readable: ScanningReadable<TMetadata>,
	options: ScanningReadableOptions<TMetadata> = {},
): ScanningSession<TMetadata> {
	return {
		metadata: () => readable.getMetadata(),
		entries: (entryQuery) => searchCandidatesFromReadable(readable, options, entryQuery),
	};
}

export async function* scanningSessionsFromReadables<TMetadata extends SessionMetadata>(
	readables: readonly ScanningReadable<TMetadata>[],
	options: ScanningReadableOptions<TMetadata> = {},
): AsyncIterable<ScanningSession<TMetadata>> {
	for (const readable of readables) yield createScanningSessionFromReadable(readable, options);
}

export function createScanningSessionSourceFromReadables<TMetadata extends SessionMetadata>(
	readables: readonly ScanningReadable<TMetadata>[],
	options: ScanningReadableOptions<TMetadata> = {},
): ScanningSessionSource<TMetadata, void> {
	return {
		sessions: () => scanningSessionsFromReadables(readables, options),
	};
}

export function createScanningSessionSearchFromReadables<TMetadata extends SessionMetadata>(
	readables: readonly ScanningReadable<TMetadata>[],
	options?: ScanningReadableOptions<TMetadata>,
): SessionSearch<ScanningSessionSearchHit> {
	return createScanningSessionSearch(createScanningSessionSourceFromReadables(readables, options));
}

function defaultMatch(queryText: string, candidate: SessionSearchCandidate): boolean {
	return candidate.text.toLowerCase().includes(queryText);
}

interface ScanningSessionSearchRuntimeOptions<TMetadata extends SessionMetadata, TListOptions> {
	sourceOptions?: (text: string, options: SessionSearchOptions) => TListOptions | undefined;
	match?: (queryText: string, candidate: SessionSearchCandidate, metadata: TMetadata) => boolean;
}

class ScanningSessionSearch<
	TMetadata extends SessionMetadata = SessionMetadata,
	TListOptions = unknown,
	THit extends SessionSearchHit = ScanningSessionSearchHit,
> implements SessionSearch<THit>
{
	private readonly source: ScanningSessionSource<TMetadata, TListOptions>;
	private readonly options: ScanningSessionSearchRuntimeOptions<TMetadata, TListOptions>;
	private readonly createHit: (metadata: TMetadata, candidate: SessionSearchCandidate) => THit;

	constructor(
		source: ScanningSessionSource<TMetadata, TListOptions>,
		options: ScanningSessionSearchRuntimeOptions<TMetadata, TListOptions>,
		createHit: (metadata: TMetadata, candidate: SessionSearchCandidate) => THit,
	) {
		this.source = source;
		this.options = options;
		this.createHit = createHit;
	}

	async *search(text: string, options: SessionSearchOptions = {}): AsyncIterable<THit> {
		const normalizedText = text.trim().toLowerCase();
		if (!normalizedText || (options.limit !== undefined && options.limit <= 0)) return;
		if (options.entryTypes?.length === 0) return;
		let hitCount = 0;
		const seenSessionIds = new Set<string>();
		const entryTypes = options.entryTypes === undefined ? undefined : new Set(options.entryTypes);
		for await (const session of this.source.sessions(this.options.sourceOptions?.(normalizedText, options))) {
			throwIfAborted(options.signal);
			const metadata = await session.metadata();
			if (seenSessionIds.has(metadata.id)) throw new Error(`Duplicate sessionId: ${metadata.id}`);
			seenSessionIds.add(metadata.id);
			for await (const candidate of session.entries({ entryTypes: options.entryTypes })) {
				throwIfAborted(options.signal);
				if (entryTypes !== undefined && !entryTypes.has(candidate.type)) continue;
				const matches =
					this.options.match?.(normalizedText, candidate, metadata) ?? defaultMatch(normalizedText, candidate);
				if (!matches) continue;
				yield this.createHit(metadata, candidate);
				hitCount += 1;
				if (options.limit !== undefined && hitCount >= options.limit) return;
			}
		}
	}
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

export function createScanningSessionSearch<TMetadata extends SessionMetadata, TListOptions = unknown>(
	source: ScanningSessionSource<TMetadata, TListOptions>,
	options?: Omit<ScanningSessionSearchOptions<TMetadata, TListOptions, ScanningSessionSearchHit>, "createHit">,
): SessionSearch<ScanningSessionSearchHit>;
export function createScanningSessionSearch<
	TMetadata extends SessionMetadata,
	TListOptions = unknown,
	THit extends SessionSearchHit = ScanningSessionSearchHit,
>(
	source: ScanningSessionSource<TMetadata, TListOptions>,
	options: ScanningSessionSearchOptions<TMetadata, TListOptions, THit> & {
		createHit: (metadata: TMetadata, candidate: SessionSearchCandidate) => THit;
	},
): SessionSearch<THit>;
export function createScanningSessionSearch<
	TMetadata extends SessionMetadata,
	TListOptions = unknown,
	THit extends SessionSearchHit = ScanningSessionSearchHit,
>(
	source: ScanningSessionSource<TMetadata, TListOptions>,
	options: ScanningSessionSearchOptions<TMetadata, TListOptions, THit> = {},
): SessionSearch<THit> | SessionSearch<ScanningSessionSearchHit> {
	if (options.createHit !== undefined) {
		return new ScanningSessionSearch<TMetadata, TListOptions, THit>(source, options, options.createHit);
	}
	return new ScanningSessionSearch<TMetadata, TListOptions, ScanningSessionSearchHit>(
		source,
		options,
		createDefaultScanningHit,
	);
}
