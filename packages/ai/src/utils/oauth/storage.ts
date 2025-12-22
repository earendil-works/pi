/**
 * OAuth credential storage with configurable backend.
 *
 * Default: ~/.pi/agent/oauth.json
 * Override with setOAuthStorage() for custom storage locations or backends.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export interface OAuthCredentials {
	type: "oauth";
	refresh: string;
	access: string;
	expires: number;
	enterpriseUrl?: string;
	projectId?: string;
	email?: string;
}

export interface OAuthStorage {
	[provider: string]: OAuthCredentials;
}

export type OAuthProvider = "anthropic" | "github-copilot" | "google-gemini-cli" | "google-antigravity";

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

// ============================================================================
// Default filesystem backend
// ============================================================================

const DEFAULT_PATH = join(homedir(), ".pi", "agent", "oauth.json");

function defaultLoad(): OAuthStorage {
	if (!existsSync(DEFAULT_PATH)) {
		return {};
	}
	try {
		const content = readFileSync(DEFAULT_PATH, "utf-8");
		return JSON.parse(content);
	} catch {
		return {};
	}
}

function defaultSave(storage: OAuthStorage): void {
	const configDir = dirname(DEFAULT_PATH);
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
	}
	writeFileSync(DEFAULT_PATH, JSON.stringify(storage, null, 2), "utf-8");
	chmodSync(DEFAULT_PATH, 0o600);
}

// ============================================================================
// Configurable backend
// ============================================================================

let currentBackend: OAuthStorageBackend = {
	load: defaultLoad,
	save: defaultSave,
};

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
export function setOAuthStorage(backend: OAuthStorageBackend): void {
	currentBackend = backend;
}

/**
 * Reset to default filesystem storage (~/.pi/agent/oauth.json)
 */
export function resetOAuthStorage(): void {
	currentBackend = { load: defaultLoad, save: defaultSave };
}

/**
 * Get the default OAuth path (for reference, may not be used if custom backend is set)
 */
export function getOAuthPath(): string {
	return DEFAULT_PATH;
}

// ============================================================================
// Public API (uses current backend)
// ============================================================================

/**
 * Load all OAuth credentials
 */
export function loadOAuthStorage(): OAuthStorage {
	return currentBackend.load();
}

/**
 * Load OAuth credentials for a specific provider
 */
export function loadOAuthCredentials(provider: string): OAuthCredentials | null {
	const storage = currentBackend.load();
	return storage[provider] || null;
}

/**
 * Save OAuth credentials for a specific provider
 */
export function saveOAuthCredentials(provider: string, creds: OAuthCredentials): void {
	const storage = currentBackend.load();
	storage[provider] = creds;
	currentBackend.save(storage);
}

/**
 * Remove OAuth credentials for a specific provider
 */
export function removeOAuthCredentials(provider: string): void {
	const storage = currentBackend.load();
	delete storage[provider];
	currentBackend.save(storage);
}

/**
 * Check if OAuth credentials exist for a provider
 */
export function hasOAuthCredentials(provider: string): boolean {
	return loadOAuthCredentials(provider) !== null;
}

/**
 * List all providers with OAuth credentials
 */
export function listOAuthProviders(): string[] {
	const storage = currentBackend.load();
	return Object.keys(storage);
}
