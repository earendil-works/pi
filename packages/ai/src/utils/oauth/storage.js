/**
 * OAuth credential storage with configurable backend.
 *
 * Default: ~/.pi/agent/oauth.json
 * Override with setOAuthStorage() for custom storage locations or backends.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

// ============================================================================
// Default filesystem backend
// ============================================================================
const DEFAULT_PATH = join(homedir(), ".pi", "agent", "oauth.json");
function defaultLoad() {
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
function defaultSave(storage) {
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
let currentBackend = {
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
export function setOAuthStorage(backend) {
	currentBackend = backend;
}
/**
 * Reset to default filesystem storage (~/.pi/agent/oauth.json)
 */
export function resetOAuthStorage() {
	currentBackend = { load: defaultLoad, save: defaultSave };
}
/**
 * Get the default OAuth path (for reference, may not be used if custom backend is set)
 */
export function getOAuthPath() {
	return DEFAULT_PATH;
}
// ============================================================================
// Public API (uses current backend)
// ============================================================================
/**
 * Load all OAuth credentials
 */
export function loadOAuthStorage() {
	return currentBackend.load();
}
/**
 * Load OAuth credentials for a specific provider
 */
export function loadOAuthCredentials(provider) {
	const storage = currentBackend.load();
	return storage[provider] || null;
}
/**
 * Save OAuth credentials for a specific provider
 */
export function saveOAuthCredentials(provider, creds) {
	const storage = currentBackend.load();
	storage[provider] = creds;
	currentBackend.save(storage);
}
/**
 * Remove OAuth credentials for a specific provider
 */
export function removeOAuthCredentials(provider) {
	const storage = currentBackend.load();
	delete storage[provider];
	currentBackend.save(storage);
}
/**
 * Check if OAuth credentials exist for a provider
 */
export function hasOAuthCredentials(provider) {
	return loadOAuthCredentials(provider) !== null;
}
/**
 * List all providers with OAuth credentials
 */
export function listOAuthProviders() {
	const storage = currentBackend.load();
	return Object.keys(storage);
}
//# sourceMappingURL=storage.js.map
