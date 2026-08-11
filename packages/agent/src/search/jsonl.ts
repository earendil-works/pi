import { listJsonlSessionMetadata, loadJsonlSessionStorage } from "../harness/session/jsonl/repo.ts";
import type { JsonlSessionStorage } from "../harness/session/jsonl/storage.ts";
import type {
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	JsonlSessionRepoOptions,
} from "../harness/session/jsonl/types.ts";
import type { Entry } from "../harness/session/types.ts";
import type { SessionSearch } from "./index.ts";
import {
	createScanningSessionSearch,
	type ScanningSession,
	type ScanningSessionSearchHit,
	type ScanningSessionSource,
	type SessionSearchCandidate,
} from "./scanning.ts";

type JsonlScanningReadable = Pick<JsonlSessionStorage, "getMetadata" | "findEntries" | "getLabel">;

export type JsonlSearchTextProjector = (
	metadata: JsonlSessionMetadata,
	entry: Entry,
	label: string | undefined,
) => string;

export type JsonlSessionSearchHit = ScanningSessionSearchHit;

export interface JsonlScanningSessionSourceOptions {
	projectText?: JsonlSearchTextProjector;
	pageSize?: number;
}

function defaultJsonlSearchText(_metadata: JsonlSessionMetadata, entry: Entry, label: string | undefined): string {
	return label === undefined ? JSON.stringify(entry) : `${JSON.stringify(entry)} ${label}`;
}

export async function* jsonlSearchSessions(
	options: JsonlSessionRepoOptions,
	query: JsonlSessionListOptions = {},
): AsyncIterable<JsonlSessionStorage> {
	for (const metadata of await listJsonlSessionMetadata(options, query)) {
		yield loadJsonlSessionStorage(options, metadata);
	}
}

async function* jsonlSearchCandidates(
	storage: JsonlScanningReadable,
	options: JsonlScanningSessionSourceOptions,
	query: { afterSeq?: number; limit?: number; entryTypes?: readonly Entry["type"][] } = {},
): AsyncIterable<SessionSearchCandidate> {
	const metadata = await storage.getMetadata();
	const projectText = options.projectText ?? defaultJsonlSearchText;
	const pageSize = query.limit ?? options.pageSize ?? 100;
	let afterSeq = query.afterSeq ?? 0;
	const entryTypes = query.entryTypes === undefined ? undefined : new Set(query.entryTypes);
	while (true) {
		const entries = await storage.findEntries({
			order: "oldestFirst",
			limit: pageSize,
			cursor: { afterSeq },
			type: query.entryTypes?.length === 1 ? query.entryTypes[0] : undefined,
		});
		if (entries.length === 0) break;
		for (const entry of entries) {
			if (entryTypes !== undefined && !entryTypes.has(entry.type)) continue;
			const label = await storage.getLabel(entry.id);
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

export async function* jsonlScanningSessions(
	options: JsonlSessionRepoOptions,
	query: JsonlSessionListOptions = {},
	sourceOptions: JsonlScanningSessionSourceOptions = {},
): AsyncIterable<ScanningSession<JsonlSessionMetadata>> {
	for await (const storage of jsonlSearchSessions(options, query)) {
		yield {
			metadata: () => storage.getMetadata(),
			entries: (entryQuery) => jsonlSearchCandidates(storage, sourceOptions, entryQuery),
		};
	}
}

export function createJsonlScanningSessionSource(
	options: JsonlSessionRepoOptions,
	sourceOptions: JsonlScanningSessionSourceOptions = {},
): ScanningSessionSource<JsonlSessionMetadata, JsonlSessionListOptions> {
	return {
		sessions: (query) => jsonlScanningSessions(options, query, sourceOptions),
	};
}

export function createJsonlScanningSessionSearch(
	options: JsonlSessionRepoOptions,
	sourceOptions?: JsonlScanningSessionSourceOptions,
): SessionSearch<JsonlSessionSearchHit> {
	return createScanningSessionSearch<JsonlSessionMetadata, JsonlSessionListOptions>(
		createJsonlScanningSessionSource(options, sourceOptions),
	);
}
