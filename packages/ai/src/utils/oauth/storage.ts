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
		return JSON.parse(content) as OAuthStorage;
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
// Internal helpers
// ============================================================================

function isMultiAccountEntry(entry: OAuthStorageEntry): entry is OAuthMultiAccountStorage {
	return (
		typeof entry === "object" &&
		entry !== null &&
		"accounts" in entry &&
		Array.isArray((entry as OAuthMultiAccountStorage).accounts)
	);
}

function deriveAccountId(provider: string, credentials: OAuthCredentials): string {
	return credentials.accountId ?? credentials.email ?? `${provider}-default`;
}

function buildAccountEntry(
	provider: string,
	credentials: OAuthCredentials,
	label?: string,
	lastUsed?: number,
): OAuthAccountEntry {
	return {
		id: deriveAccountId(provider, credentials),
		credentials,
		label: label ?? credentials.email ?? credentials.accountId,
		lastUsed,
	};
}

function getActiveAccount(entry: OAuthMultiAccountStorage): OAuthAccountEntry | null {
	if (entry.accounts.length === 0) return null;
	if (entry.activeAccountId) {
		const active = entry.accounts.find((account) => account.id === entry.activeAccountId);
		if (active) return active;
	}
	return entry.accounts[0] ?? null;
}

function ensureProviderEntry(
	storage: OAuthStorage,
	provider: string,
): { entry: OAuthMultiAccountStorage | null; migrated: boolean } {
	const rawEntry = storage[provider];
	if (!rawEntry) {
		return { entry: null, migrated: false };
	}

	if (isMultiAccountEntry(rawEntry)) {
		if (!rawEntry.activeAccountId && rawEntry.accounts[0]) {
			rawEntry.activeAccountId = rawEntry.accounts[0].id;
		}
		return { entry: rawEntry, migrated: false };
	}

	const legacyCredentials = rawEntry;
	const accountEntry = buildAccountEntry(provider, legacyCredentials, undefined, Date.now());
	const migrated: OAuthMultiAccountStorage = {
		accounts: [accountEntry],
		activeAccountId: accountEntry.id,
	};
	storage[provider] = migrated;
	return { entry: migrated, migrated: true };
}

function cloneAccountEntry(account: OAuthAccountEntry): OAuthAccountEntry {
	return {
		id: account.id,
		credentials: { ...account.credentials },
		label: account.label,
		lastUsed: account.lastUsed,
		cooldownUntil: account.cooldownUntil,
	};
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
	const { entry } = ensureProviderEntry(storage, provider);
	const active = entry ? getActiveAccount(entry) : null;
	return active?.credentials ?? null;
}

/**
 * Save OAuth credentials for a specific provider
 */
export function saveOAuthCredentials(provider: string, creds: OAuthCredentials): void {
	const storage = currentBackend.load();
	const accountEntry = buildAccountEntry(provider, creds, undefined, Date.now());
	storage[provider] = {
		accounts: [accountEntry],
		activeAccountId: accountEntry.id,
	};
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
	const storage = currentBackend.load();
	const { entry } = ensureProviderEntry(storage, provider);
	return !!(entry && entry.accounts.length > 0);
}

/**
 * List all providers with OAuth credentials
 */
export function listOAuthProviders(): string[] {
	const storage = currentBackend.load();
	const providers: string[] = [];
	for (const provider of Object.keys(storage)) {
		const { entry } = ensureProviderEntry(storage, provider);
		if (entry && entry.accounts.length > 0) {
			providers.push(provider);
		}
	}
	return providers;
}

/**
 * List all OAuth accounts for a provider
 */
export function listOAuthAccounts(provider: string): OAuthAccountEntry[] {
	const storage = currentBackend.load();
	const { entry } = ensureProviderEntry(storage, provider);
	if (!entry) return [];
	return entry.accounts.map(cloneAccountEntry);
}

/**
 * Get the active OAuth account for a provider
 */
export function getActiveOAuthAccount(provider: string): OAuthAccountEntry | null {
	const storage = currentBackend.load();
	const { entry } = ensureProviderEntry(storage, provider);
	const active = entry ? getActiveAccount(entry) : null;
	return active ? cloneAccountEntry(active) : null;
}

/**
 * Set the active OAuth account for a provider
 */
export function setActiveOAuthAccount(provider: string, accountId: string): void {
	const storage = currentBackend.load();
	const { entry } = ensureProviderEntry(storage, provider);
	if (!entry) return;
	const exists = entry.accounts.some((account) => account.id === accountId);
	if (!exists) return;
	entry.activeAccountId = accountId;
	storage[provider] = entry;
	currentBackend.save(storage);
}

/**
 * Add or update an OAuth account for a provider
 */
export function addOAuthAccount(provider: string, creds: OAuthCredentials, label?: string): OAuthAccountEntry {
	const storage = currentBackend.load();
	const { entry } = ensureProviderEntry(storage, provider);
	const now = Date.now();
	const accountEntry = buildAccountEntry(provider, creds, label, now);

	if (!entry) {
		storage[provider] = {
			accounts: [accountEntry],
			activeAccountId: accountEntry.id,
		};
		currentBackend.save(storage);
		return cloneAccountEntry(accountEntry);
	}

	const existingIndex = entry.accounts.findIndex((account) => account.id === accountEntry.id);
	if (existingIndex >= 0) {
		const existing = entry.accounts[existingIndex];
		entry.accounts[existingIndex] = {
			...existing,
			credentials: creds,
			label: accountEntry.label ?? existing.label,
			lastUsed: now,
			cooldownUntil: undefined,
		};
	} else {
		entry.accounts.push(accountEntry);
	}

	entry.activeAccountId = accountEntry.id;
	storage[provider] = entry;
	currentBackend.save(storage);
	return cloneAccountEntry(accountEntry);
}

/**
 * Remove an OAuth account for a provider
 */
export function removeOAuthAccount(provider: string, accountId: string): void {
	const storage = currentBackend.load();
	const { entry } = ensureProviderEntry(storage, provider);
	if (!entry) return;

	entry.accounts = entry.accounts.filter((account) => account.id !== accountId);

	if (entry.accounts.length === 0) {
		delete storage[provider];
		currentBackend.save(storage);
		return;
	}

	if (entry.activeAccountId === accountId) {
		entry.activeAccountId = entry.accounts[0]?.id;
	}
	storage[provider] = entry;
	currentBackend.save(storage);
}

/**
 * Update OAuth account credentials
 */
export function updateOAuthAccountCredentials(provider: string, accountId: string, creds: OAuthCredentials): void {
	const storage = currentBackend.load();
	const { entry } = ensureProviderEntry(storage, provider);
	const now = Date.now();
	if (!entry) {
		addOAuthAccount(provider, creds, undefined);
		return;
	}

	const index = entry.accounts.findIndex((account) => account.id === accountId);
	if (index === -1) {
		entry.accounts.push({
			id: accountId,
			credentials: creds,
			label: creds.email ?? creds.accountId,
			lastUsed: now,
		});
	} else {
		const existing = entry.accounts[index];
		entry.accounts[index] = {
			...existing,
			credentials: creds,
			lastUsed: now,
		};
	}
	entry.activeAccountId = accountId;
	storage[provider] = entry;
	currentBackend.save(storage);
}

/**
 * Mark an OAuth account as cooling down
 */
export function markOAuthAccountCooldown(provider: string, accountId: string, durationMs: number): void {
	const storage = currentBackend.load();
	const { entry } = ensureProviderEntry(storage, provider);
	if (!entry) return;
	const account = entry.accounts.find((item) => item.id === accountId);
	if (!account) return;
	account.cooldownUntil = Date.now() + durationMs;
	storage[provider] = entry;
	currentBackend.save(storage);
}

/**
 * Clear OAuth account cooldown
 */
export function clearOAuthAccountCooldown(provider: string, accountId: string): void {
	const storage = currentBackend.load();
	const { entry } = ensureProviderEntry(storage, provider);
	if (!entry) return;
	const account = entry.accounts.find((item) => item.id === accountId);
	if (!account) return;
	account.cooldownUntil = undefined;
	storage[provider] = entry;
	currentBackend.save(storage);
}

/**
 * Select the next available OAuth account for a provider
 */
export function getNextAvailableOAuthAccount(provider: string): OAuthAccountEntry | null {
	const storage = currentBackend.load();
	const { entry } = ensureProviderEntry(storage, provider);
	if (!entry) return null;

	const now = Date.now();
	const active = getActiveAccount(entry);
	const isActiveAvailable = active ? !active.cooldownUntil || active.cooldownUntil <= now : false;
	if (active && isActiveAvailable) {
		active.lastUsed = now;
		entry.activeAccountId = active.id;
		storage[provider] = entry;
		currentBackend.save(storage);
		return cloneAccountEntry(active);
	}

	const availableAccounts = entry.accounts.filter((account) => !account.cooldownUntil || account.cooldownUntil <= now);

	let selected: OAuthAccountEntry | undefined;
	if (availableAccounts.length > 0) {
		selected = [...availableAccounts].sort((a, b) => (a.lastUsed ?? 0) - (b.lastUsed ?? 0))[0];
	} else {
		selected = [...entry.accounts].sort(
			(a, b) => (a.cooldownUntil ?? Number.POSITIVE_INFINITY) - (b.cooldownUntil ?? Number.POSITIVE_INFINITY),
		)[0];
	}

	if (!selected) return null;

	selected.lastUsed = now;
	entry.activeAccountId = selected.id;
	storage[provider] = entry;
	currentBackend.save(storage);
	return cloneAccountEntry(selected);
}
