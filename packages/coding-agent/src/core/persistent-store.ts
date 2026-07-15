export const ENV_PERSISTENT_STORE = "PERSISTENT_STORE";

export type PersistentStore = "jsonl" | "sqlite";
export type SessionStore = PersistentStore | "memory";

export function parsePersistentStore(value: string | undefined): PersistentStore {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return "jsonl";
	if (normalized === "jsonl" || normalized === "sqlite") return normalized;
	throw new Error(`Invalid ${ENV_PERSISTENT_STORE} value "${value}"; expected "jsonl" or "sqlite"`);
}

/** Resolve SDK configuration before environment configuration. */
export function resolvePersistentStore(
	explicit?: PersistentStore,
	env: { PERSISTENT_STORE?: string } = process.env,
): PersistentStore {
	return explicit ?? parsePersistentStore(env[ENV_PERSISTENT_STORE]);
}

/** Memory mode is an explicit non-persistent override. */
export function resolveSessionStore(options: {
	noSession: boolean;
	explicit?: PersistentStore;
	env?: { PERSISTENT_STORE?: string };
}): SessionStore {
	if (options.noSession) return "memory";
	return resolvePersistentStore(options.explicit, options.env);
}
