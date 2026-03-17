# packages/web-ui/src/storage

## Purpose
Application storage layer for the web UI. Provides a reactive store abstraction over IndexedDB with typed stores for sessions, settings, provider keys, and custom providers.

## Technology
TypeScript, IndexedDB, reactive store pattern.

## Contents
- `app-storage.ts` - `AppStorage`: singleton storage coordinator, `getAppStorage()`, `setAppStorage()`
- `store.ts` - `Store<T>`: base reactive store class with get/set/subscribe pattern
- `types.ts` - Storage type definitions: `StorageBackend`, `StorageTransaction`, `StoreConfig`, `SessionData`, `SessionMetadata`, `IndexConfig`
- `backends/` - Storage backend implementations (IndexedDB)
- `stores/` - Typed store implementations (sessions, settings, provider keys, custom providers)

## Key Functions
- `AppStorage`: coordinates all stores, provides unified storage access
- `Store.get(key)`, `Store.set(key, value)`, `Store.subscribe(listener)`: reactive CRUD
- `getAppStorage()`: Get singleton storage instance

## Data Types
- `StorageBackend`: `{ get, set, delete, keys, transaction }` -- abstract storage interface
- `StorageTransaction`: `{ get, set, delete, commit, rollback }`
- `SessionData`: `{ id, metadata, messages, ... }`
- `SessionMetadata`: `{ title?, model?, messageCount, lastActivity }`
- `StoreConfig`: `{ name, backend, indexes? }`
- `IndexConfig`: `{ keyPath, unique? }`

## Logging
N/A

## CRUD Entry Points
- **Create**: `store.set(key, value)` creates new entries
- **Read**: `store.get(key)`, `store.keys()`, indexed queries
- **Update**: `store.set(key, newValue)` updates existing entries
- **Delete**: `store.delete(key)` removes entries

## Style Guide
- Reactive store pattern with subscription
- Abstract backend for testability (IndexedDB in production, in-memory for tests)
- Typed stores via generics
