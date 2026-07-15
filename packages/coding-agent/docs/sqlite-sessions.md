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
