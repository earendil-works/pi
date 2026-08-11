import { listJsonlSessionMetadata, loadJsonlSessionStorage } from "../harness/session/jsonl/repo.ts";
import type { JsonlSessionStorage } from "../harness/session/jsonl/storage.ts";
import type {
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	JsonlSessionRepoOptions,
} from "../harness/session/jsonl/types.ts";
import type { SessionSearch } from "./index.ts";
import {
	createScanningSessionFromReadable,
	createScanningSessionSearch,
	type ScanningReadableOptions,
	type ScanningSession,
	type ScanningSessionSearchHit,
	type ScanningSessionSource,
} from "./scanning.ts";

export type JsonlScanningSessionSourceOptions = ScanningReadableOptions<JsonlSessionMetadata>;
export type JsonlSearchTextProjector = NonNullable<JsonlScanningSessionSourceOptions["projectText"]>;
export type JsonlSessionSearchHit = ScanningSessionSearchHit;

export async function* jsonlSearchSessions(
	options: JsonlSessionRepoOptions,
	query: JsonlSessionListOptions = {},
): AsyncIterable<JsonlSessionStorage> {
	for (const metadata of await listJsonlSessionMetadata(options, query)) {
		yield loadJsonlSessionStorage(options, metadata);
	}
}

export async function* jsonlScanningSessions(
	options: JsonlSessionRepoOptions,
	query: JsonlSessionListOptions = {},
	sourceOptions: JsonlScanningSessionSourceOptions = {},
): AsyncIterable<ScanningSession<JsonlSessionMetadata>> {
	for await (const storage of jsonlSearchSessions(options, query)) {
		yield createScanningSessionFromReadable(storage, sourceOptions);
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
