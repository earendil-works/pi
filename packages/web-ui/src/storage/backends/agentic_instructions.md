# packages/web-ui/src/storage/backends

## Purpose
Storage backend implementations for the web UI store abstraction.

## Technology
TypeScript, IndexedDB API.

## Contents
- `indexeddb-storage-backend.ts` - `IndexedDBStorageBackend`: IndexedDB implementation of `StorageBackend` interface with transaction support and index management

## Key Functions
- `IndexedDBStorageBackend.get(key)`: Read from IndexedDB
- `IndexedDBStorageBackend.set(key, value)`: Write to IndexedDB
- `IndexedDBStorageBackend.delete(key)`: Delete from IndexedDB
- `IndexedDBStorageBackend.transaction()`: Create read-write transaction

## Data Types
- Implements `StorageBackend` interface from `../types.ts`

## Logging
N/A

## CRUD Entry Points
- **Create**: `new IndexedDBStorageBackend(config)` with database name and version
- **Read**: `.get(key)`, `.keys()`
- **Update**: `.set(key, value)`
- **Delete**: `.delete(key)`

## Style Guide
- Async/await for all IndexedDB operations
- Transaction wrapping for multi-operation consistency
