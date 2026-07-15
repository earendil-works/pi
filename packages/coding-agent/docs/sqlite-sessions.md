# Experimental SQLite sessions

SQLite session storage is experimental and opt-in. JSONL remains the default.

```sh
PERSISTENT_STORE=sqlite pi
```

`PERSISTENT_STORE` accepts `jsonl` or `sqlite` (case-insensitive). Unsupported
values fail at startup. `--no-session` always selects ephemeral memory storage.
SDK callers can pass `persistentStore: "sqlite"` instead of changing process
environment state.

By default SQLite sessions share `~/.pi/agent/sessions.sqlite`, which allows
session discovery across working directories. With `--session-dir` or the
`sessionDir` setting, the database is `sessions.sqlite` in that directory.

## Interoperability and rollback

JSONL remains the import/export format. `/export file.jsonl` exports the active
branch, and `/import file.jsonl` imports it into the selected persistent store.
Enabling SQLite does not migrate or modify existing JSONL sessions.

To roll back, exit pi and start it with `PERSISTENT_STORE=jsonl`. SQLite and
JSONL data are kept independently.

## Backup

The database uses WAL mode. For a filesystem-level backup, stop all pi
processes first and copy `sessions.sqlite` together with any
`sessions.sqlite-wal` and `sessions.sqlite-shm` files. Prefer SQLite's online
backup API when backing up a live database. Do not copy only the main database
while writers are active.

## Validation and rollout

The experimental rollout is covered by storage conformance, migration-upgrade,
repository lifecycle, JSONL round-trip, selector metadata, deterministic RPC
persistence, and teardown-ordering tests. The validation matrix exercises
create, append, close, reopen, continue, list, fork, delete, import, and export.

Intentional differences from JSONL are limited to storage identity and layout:
SQLite sessions use a database path plus session ID, while JSONL sessions use a
unique file path. User-visible context, names, labels, branches, search text,
and exported JSONL remain equivalent. Switching `PERSISTENT_STORE` never
deletes or rewrites the other store.
