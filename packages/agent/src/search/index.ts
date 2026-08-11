import type { Entry } from "../harness/session/types.ts";

export {
	createJsonlScanningSessionSearch,
	createJsonlScanningSessionSource,
	type JsonlScanningSessionSourceOptions,
	type JsonlSearchTextProjector,
	type JsonlSessionSearchHit,
	jsonlScanningSessions,
	jsonlSearchSessions,
} from "./jsonl.ts";
export type {
	ScanningReadable,
	ScanningReadableOptions,
	ScanningSearchTextProjector,
	ScanningSession,
	ScanningSessionSearchHit,
	ScanningSessionSearchOptions,
	ScanningSessionSource,
	SessionSearchCandidate,
} from "./scanning.ts";
export {
	createScanningSessionFromReadable,
	createScanningSessionSearch,
	createScanningSessionSearchFromReadables,
	createScanningSessionSourceFromReadables,
	scanningSessionsFromReadables,
} from "./scanning.ts";

export interface SessionSearchOptions {
	/** Restrict results to specific canonical entry types. */
	readonly entryTypes?: readonly Entry["type"][];
	/** Maximum number of hits to return. */
	readonly limit?: number;
	/** Abort signal for cancellation, e.g. search-as-you-type. */
	readonly signal?: AbortSignal;
}

export interface SessionSearchHit {
	/** Logical identifier of the session that owns the entry. */
	readonly sessionId: string;
	/** Logical identifier of the entry within that session. */
	readonly entryId: string;
}

export interface SessionSearch<T extends SessionSearchHit = SessionSearchHit> {
	search(text: string, options?: SessionSearchOptions): AsyncIterable<T>;
}
