import type { Context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "../../env/node.ts";
import { JsonlStorage, type JsonlStorageOptions } from "./storage.ts";

/** Open or create a JSONL storage directory using the local Node filesystem; `readOnly` opens one without writing. */
export async function openNodeJsonlStorage(
	directory: string,
	context: Context,
	options: JsonlStorageOptions = {},
): Promise<JsonlStorage> {
	return JsonlStorage.open(directory, new NodeExecutionEnv({ cwd: process.cwd() }), context, options);
}

export { JsonlStorage, type JsonlStorageOptions, JsonlStorageReadOnlyError } from "./storage.ts";
