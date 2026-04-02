/**
 * OAuth credential storage with configurable backend.
 *
 * Default: ~/.mu/agent/oauth.json
 * Override with setOAuthStorage() for custom storage locations or backends.
 */
export interface OAuthCredentials {
	type: "oauth";
	refresh: string;
	access: string;
	expires: number;
	enterpriseUrl?: string;
	projectId?: string;
	email?: string;
	accountId?: string;
}
export interface OAuthAccountEntry {
	id: string;
	credentials: OAuthCredentials;
	label?: string;
	lastUsed?: number;
	cooldownUntil?: number;
}
export interface OAuthMultiAccountStorage {
	accounts: OAuthAccountEntry[];
	activeAccountId?: string;
}
export type OAuthStorageEntry = OAuthCredentials | OAuthMultiAccountStorage;
export interface OAuthStorage {
	[provider: string]: OAuthStorageEntry;
}
export type OAuthProvider =
	| "anthropic"
	| "github-copilot"
	| "google-gemini-cli"
	| "google-antigravity"
	| "openai-codex";
/**
 * Storage backend interface.
 * Implement this to use a custom storage location or backend.
 */
export interface OAuthStorageBackend {
	/** Load all OAuth credentials. Return empty object if none exist. */
	load(): OAuthStorage;
	/** Save all OAuth credentials. */
	save(storage: OAuthStorage): void;
}
/**
 * Configure the OAuth storage backend.
 *
 * @example
 * // Custom file path
 * setOAuthStorage({
 *   load: () => JSON.parse(readFileSync('/custom/path/oauth.json', 'utf-8')),
 *   save: (storage) => writeFileSync('/custom/path/oauth.json', JSON.stringify(storage))
 * });
 *
 * @example
 * // In-memory storage (for testing)
 * let memoryStorage = {};
 * setOAuthStorage({
 *   load: () => memoryStorage,
 *   save: (storage) => { memoryStorage = storage; }
 * });
 */
export declare function setOAuthStorage(backend: OAuthStorageBackend): void;
/**
 * Reset to default filesystem storage (~/.mu/agent/oauth.json)
 */
export declare function resetOAuthStorage(): void;
/**
 * Get the default OAuth path (for reference, may not be used if custom backend is set)
 */
export declare function getOAuthPath(): string;
/**
 * Load all OAuth credentials
 */
export declare function loadOAuthStorage(): OAuthStorage;
/**
 * Load OAuth credentials for a specific provider
 */
export declare function loadOAuthCredentials(provider: string): OAuthCredentials | null;
/**
 * Save OAuth credentials for a specific provider
 */
export declare function saveOAuthCredentials(provider: string, creds: OAuthCredentials): void;
/**
 * Remove OAuth credentials for a specific provider
 */
export declare function removeOAuthCredentials(provider: string): void;
/**
 * Check if OAuth credentials exist for a provider
 */
export declare function hasOAuthCredentials(provider: string): boolean;
/**
 * List all providers with OAuth credentials
 */
export declare function listOAuthProviders(): string[];
/**
 * List all OAuth accounts for a provider
 */
export declare function listOAuthAccounts(provider: string): OAuthAccountEntry[];
/**
 * Get the active OAuth account for a provider
 */
export declare function getActiveOAuthAccount(provider: string): OAuthAccountEntry | null;
/**
 * Set the active OAuth account for a provider
 */
export declare function setActiveOAuthAccount(provider: string, accountId: string): void;
/**
 * Add or update an OAuth account for a provider
 */
export declare function addOAuthAccount(provider: string, creds: OAuthCredentials, label?: string): OAuthAccountEntry;
/**
 * Remove an OAuth account for a provider
 */
export declare function removeOAuthAccount(provider: string, accountId: string): void;
/**
 * Update OAuth account credentials
 */
export declare function updateOAuthAccountCredentials(
	provider: string,
	accountId: string,
	creds: OAuthCredentials,
): void;
/**
 * Mark an OAuth account as cooling down
 */
export declare function markOAuthAccountCooldown(provider: string, accountId: string, durationMs: number): void;
/**
 * Clear OAuth account cooldown
 */
export declare function clearOAuthAccountCooldown(provider: string, accountId: string): void;
/**
 * Select the next available OAuth account for a provider
 */
export declare function getNextAvailableOAuthAccount(provider: string): OAuthAccountEntry | null;
//# sourceMappingURL=storage.d.ts.map
