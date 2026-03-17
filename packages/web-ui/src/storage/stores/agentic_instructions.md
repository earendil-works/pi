# packages/web-ui/src/storage/stores

## Purpose
Typed store implementations for specific data domains: sessions, settings, provider API keys, and custom providers.

## Technology
TypeScript, extends base `Store<T>` class.

## Contents
- `sessions-store.ts` - `SessionsStore`: manages chat session data and metadata
- `settings-store.ts` - `SettingsStore`: application settings (theme, language, display preferences)
- `provider-keys-store.ts` - `ProviderKeysStore`: API key storage per provider
- `custom-providers-store.ts` - `CustomProvidersStore`: user-configured custom LLM providers (OpenAI-compatible, Ollama, LMStudio)

## Key Functions
- `SessionsStore.createSession()`, `.getSession()`, `.listSessions()`, `.deleteSession()`
- `SettingsStore.get(key)`, `.set(key, value)`
- `ProviderKeysStore.getKey(provider)`, `.setKey(provider, key)`, `.deleteKey(provider)`
- `CustomProvidersStore.addProvider()`, `.removeProvider()`, `.getProviders()`

## Data Types
- `SessionData`: Full session with messages and metadata
- `CustomProvider`: `{ name, type, baseUrl, apiKey?, models? }`
- `CustomProviderType`: `"openai-compatible" | "ollama" | "lmstudio"`
- `AutoDiscoveryProviderType`: Provider types that support automatic model discovery

## Logging
N/A

## CRUD Entry Points
- **Create**: Store-specific create methods
- **Read**: Store-specific read/list methods
- **Update**: Store-specific update methods
- **Delete**: Store-specific delete methods

## Style Guide
- One store per file
- Extends base `Store<T>` with typed methods
- Domain-specific validation in store methods
