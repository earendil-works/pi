/**
 * OAuth credential storage with configurable backend.
 *
 * Default: ~/.mu/agent/oauth.json
 * Override with setOAuthStorage() for custom storage locations or backends.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
// ============================================================================
// Default filesystem backend
// ============================================================================
const DEFAULT_PATH = join(homedir(), ".mu", "agent", "oauth.json");
function defaultLoad() {
    if (!existsSync(DEFAULT_PATH)) {
        return {};
    }
    try {
        const content = readFileSync(DEFAULT_PATH, "utf-8");
        return JSON.parse(content);
    }
    catch {
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
 * Reset to default filesystem storage (~/.mu/agent/oauth.json)
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
// Internal helpers
// ============================================================================
function isMultiAccountEntry(entry) {
    return (typeof entry === "object" &&
        entry !== null &&
        "accounts" in entry &&
        Array.isArray(entry.accounts));
}
function deriveAccountId(provider, credentials) {
    return credentials.accountId ?? credentials.email ?? `${provider}-default`;
}
function buildAccountEntry(provider, credentials, label, lastUsed) {
    return {
        id: deriveAccountId(provider, credentials),
        credentials,
        label: label ?? credentials.email ?? credentials.accountId,
        lastUsed,
    };
}
function getActiveAccount(entry) {
    if (entry.accounts.length === 0)
        return null;
    if (entry.activeAccountId) {
        const active = entry.accounts.find((account) => account.id === entry.activeAccountId);
        if (active)
            return active;
    }
    return entry.accounts[0] ?? null;
}
function ensureProviderEntry(storage, provider) {
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
    const migrated = {
        accounts: [accountEntry],
        activeAccountId: accountEntry.id,
    };
    storage[provider] = migrated;
    return { entry: migrated, migrated: true };
}
function cloneAccountEntry(account) {
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
export function loadOAuthStorage() {
    return currentBackend.load();
}
/**
 * Load OAuth credentials for a specific provider
 */
export function loadOAuthCredentials(provider) {
    const storage = currentBackend.load();
    const { entry } = ensureProviderEntry(storage, provider);
    const active = entry ? getActiveAccount(entry) : null;
    return active?.credentials ?? null;
}
/**
 * Save OAuth credentials for a specific provider
 */
export function saveOAuthCredentials(provider, creds) {
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
export function removeOAuthCredentials(provider) {
    const storage = currentBackend.load();
    delete storage[provider];
    currentBackend.save(storage);
}
/**
 * Check if OAuth credentials exist for a provider
 */
export function hasOAuthCredentials(provider) {
    const storage = currentBackend.load();
    const { entry } = ensureProviderEntry(storage, provider);
    return !!(entry && entry.accounts.length > 0);
}
/**
 * List all providers with OAuth credentials
 */
export function listOAuthProviders() {
    const storage = currentBackend.load();
    const providers = [];
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
export function listOAuthAccounts(provider) {
    const storage = currentBackend.load();
    const { entry } = ensureProviderEntry(storage, provider);
    if (!entry)
        return [];
    return entry.accounts.map(cloneAccountEntry);
}
/**
 * Get the active OAuth account for a provider
 */
export function getActiveOAuthAccount(provider) {
    const storage = currentBackend.load();
    const { entry } = ensureProviderEntry(storage, provider);
    const active = entry ? getActiveAccount(entry) : null;
    return active ? cloneAccountEntry(active) : null;
}
/**
 * Set the active OAuth account for a provider
 */
export function setActiveOAuthAccount(provider, accountId) {
    const storage = currentBackend.load();
    const { entry } = ensureProviderEntry(storage, provider);
    if (!entry)
        return;
    const exists = entry.accounts.some((account) => account.id === accountId);
    if (!exists)
        return;
    entry.activeAccountId = accountId;
    storage[provider] = entry;
    currentBackend.save(storage);
}
/**
 * Add or update an OAuth account for a provider
 */
export function addOAuthAccount(provider, creds, label) {
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
    }
    else {
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
export function removeOAuthAccount(provider, accountId) {
    const storage = currentBackend.load();
    const { entry } = ensureProviderEntry(storage, provider);
    if (!entry)
        return;
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
export function updateOAuthAccountCredentials(provider, accountId, creds) {
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
    }
    else {
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
export function markOAuthAccountCooldown(provider, accountId, durationMs) {
    const storage = currentBackend.load();
    const { entry } = ensureProviderEntry(storage, provider);
    if (!entry)
        return;
    const account = entry.accounts.find((item) => item.id === accountId);
    if (!account)
        return;
    account.cooldownUntil = Date.now() + durationMs;
    storage[provider] = entry;
    currentBackend.save(storage);
}
/**
 * Clear OAuth account cooldown
 */
export function clearOAuthAccountCooldown(provider, accountId) {
    const storage = currentBackend.load();
    const { entry } = ensureProviderEntry(storage, provider);
    if (!entry)
        return;
    const account = entry.accounts.find((item) => item.id === accountId);
    if (!account)
        return;
    account.cooldownUntil = undefined;
    storage[provider] = entry;
    currentBackend.save(storage);
}
/**
 * Select the next available OAuth account for a provider
 */
export function getNextAvailableOAuthAccount(provider) {
    const storage = currentBackend.load();
    const { entry } = ensureProviderEntry(storage, provider);
    if (!entry)
        return null;
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
    let selected;
    if (availableAccounts.length > 0) {
        selected = [...availableAccounts].sort((a, b) => (a.lastUsed ?? 0) - (b.lastUsed ?? 0))[0];
    }
    else {
        selected = [...entry.accounts].sort((a, b) => (a.cooldownUntil ?? Number.POSITIVE_INFINITY) - (b.cooldownUntil ?? Number.POSITIVE_INFINITY))[0];
    }
    if (!selected)
        return null;
    selected.lastUsed = now;
    entry.activeAccountId = selected.id;
    storage[provider] = entry;
    currentBackend.save(storage);
    return cloneAccountEntry(selected);
}
//# sourceMappingURL=storage.js.map