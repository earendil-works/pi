import type { Entry, SessionMetadata } from "../harness/session/types.ts";
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
