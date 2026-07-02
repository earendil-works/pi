import { NodeExecutionEnv } from "../env/nodejs.ts";
import type {
	BuiltinSessionStorageOptions,
	FileSystem,
	JsonlSessionBackendOptions,
	JsonlSessionCreateOptions,
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	SessionRepo,
	SqliteEnv,
	SqliteSessionBackendOptions,
	SqliteSessionCreateOptions,
	SqliteSessionListOptions,
	SqliteSessionMetadata,
} from "../types.ts";
import { SessionError } from "../types.ts";
import { JsonlSessionRepo } from "./jsonl-repo.ts";
import { isExperimentalSqliteSessionStorageEnabled } from "./sqlite/experimental.ts";
import { SqliteSessionRepo } from "./sqlite/repo.ts";

type NodeBuiltinSessionRepoEnv = FileSystem & Partial<SqliteEnv>;

export type BuiltinSessionRepo =
	| SessionRepo<JsonlSessionMetadata, JsonlSessionCreateOptions, JsonlSessionListOptions>
	| SessionRepo<SqliteSessionMetadata, SqliteSessionCreateOptions, SqliteSessionListOptions>;

function requireSqliteEnv(env: NodeBuiltinSessionRepoEnv): FileSystem & SqliteEnv {
	if (typeof env.openSqlite !== "function") {
		throw new SessionError("storage", "SQLite session storage requires an environment with openSqlite(path)");
	}
	return env as FileSystem & SqliteEnv;
}

export function selectBuiltinSessionStorage(options: {
	jsonl: JsonlSessionBackendOptions;
	sqlite?: SqliteSessionBackendOptions;
}): BuiltinSessionStorageOptions {
	if (options.sqlite && isExperimentalSqliteSessionStorageEnabled()) {
		return options.sqlite;
	}
	return options.jsonl;
}

export function createBuiltinSessionRepo(options: {
	env: NodeBuiltinSessionRepoEnv;
	storage: BuiltinSessionStorageOptions;
}): BuiltinSessionRepo {
	if (options.storage.kind === "jsonl") {
		return new JsonlSessionRepo({ fs: options.env, sessionsRoot: options.storage.sessionsRoot });
	}
	return new SqliteSessionRepo({ env: requireSqliteEnv(options.env), databasePath: options.storage.databasePath });
}

export function createNodeBuiltinSessionRepo(options: {
	cwd?: string;
	storage: BuiltinSessionStorageOptions;
}): BuiltinSessionRepo {
	return createBuiltinSessionRepo({
		env: new NodeExecutionEnv({ cwd: options.cwd ?? process.cwd() }),
		storage: options.storage,
	});
}
