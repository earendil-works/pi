import { listJsonlSessionMetadata, loadJsonlSessionStorage } from "../harness/session/jsonl/repo.ts";
import type { JsonlSessionStorage } from "../harness/session/jsonl/storage.ts";
import type {
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	JsonlSessionRepoOptions,
} from "../harness/session/jsonl/types.ts";
import type { SessionSearch } from "./index.ts";
import {
	createScanningSessionSearch,
	type ScanningReadableOptions,
	type ScanningSessionSearchHit,
} from "./scanning.ts";

async function* jsonlSessionReadables(
	options: JsonlSessionRepoOptions,
	query: JsonlSessionListOptions = {},
): AsyncIterable<JsonlSessionStorage> {
	for (const metadata of await listJsonlSessionMetadata(options, query)) {
		yield loadJsonlSessionStorage(options, metadata);
	}
}

export function createJsonlScanningSessionSearch(
	options: JsonlSessionRepoOptions,
	sourceOptions?: ScanningReadableOptions<JsonlSessionMetadata>,
): SessionSearch<ScanningSessionSearchHit> {
	return createScanningSessionSearch<JsonlSessionMetadata, JsonlSessionListOptions>(
		(query) => jsonlSessionReadables(options, query),
		sourceOptions,
	);
}
