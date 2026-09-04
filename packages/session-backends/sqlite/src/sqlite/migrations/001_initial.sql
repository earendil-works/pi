-- AgentHarness storage format 4 / storageVersion 1.
-- A SQLite database file is a session container. The current default repo
-- placement still creates one file per session, but the schema supports any
-- number of sessions per file by scoping every durable row with session_id.
-- Authoritative durable state is entries + scalar_values + list_values +
-- usage_ledger; branch_* and stats columns on sessions are maintained
-- projections/caches.

CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL,
	parent_session_id TEXT,
	storage_version INTEGER NOT NULL,
	metadata TEXT,
	message_count INTEGER NOT NULL,
	usage_payload TEXT NOT NULL,
	next_seq INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS entries (
	session_id TEXT NOT NULL,
	id TEXT NOT NULL,
	parent_id TEXT,
	seq INTEGER NOT NULL,
	type TEXT NOT NULL,
	custom_type TEXT,
	timestamp INTEGER NOT NULL,
	payload TEXT NOT NULL,
	PRIMARY KEY (session_id, id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS ix_entry_parent ON entries(session_id, parent_id);
CREATE INDEX IF NOT EXISTS ix_entry_seq ON entries(session_id, seq, type);

CREATE TABLE IF NOT EXISTS scalar_values (
	session_id TEXT NOT NULL,
	namespace TEXT NOT NULL,
	key TEXT NOT NULL,
	seq INTEGER NOT NULL,
	value TEXT NOT NULL,
	PRIMARY KEY (session_id, namespace, key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS list_values (
	session_id TEXT NOT NULL,
	namespace TEXT NOT NULL,
	key TEXT NOT NULL,
	seq INTEGER NOT NULL,
	value TEXT NOT NULL,
	PRIMARY KEY (session_id, namespace, key, seq)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS usage_ledger (
	session_id TEXT NOT NULL,
	id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	entry_id TEXT,
	adjustment INTEGER NOT NULL,
	usage TEXT NOT NULL,
	details TEXT,
	PRIMARY KEY (session_id, id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS ix_usage_seq ON usage_ledger(session_id, seq);

-- Storage-level integrity that spans rows/tables. Primary keys enforce
-- same-table duplicate ids; these triggers enforce the shared entry/usage id
-- namespace and ordered parent insertion without a TypeScript preflight pass.
CREATE TRIGGER IF NOT EXISTS trg_entries_validate
BEFORE INSERT ON entries
BEGIN
	SELECT RAISE(ABORT, 'missing parent entry')
	WHERE NEW.parent_id IS NOT NULL
		AND NOT EXISTS (
			SELECT 1 FROM entries WHERE session_id = NEW.session_id AND id = NEW.parent_id
		);

	SELECT RAISE(ABORT, 'duplicate entry or usage id')
	WHERE EXISTS (
		SELECT 1 FROM usage_ledger WHERE session_id = NEW.session_id AND id = NEW.id
	);
END;

CREATE TRIGGER IF NOT EXISTS trg_usage_ledger_validate
BEFORE INSERT ON usage_ledger
BEGIN
	SELECT RAISE(ABORT, 'duplicate entry or usage id')
	WHERE EXISTS (
		SELECT 1 FROM entries WHERE session_id = NEW.session_id AND id = NEW.id
	);
END;

-- Private branch index. Not values/lists; no equivalent in the other backends.
CREATE TABLE IF NOT EXISTS branch_entries (
	session_id TEXT NOT NULL,
	branch_id TEXT NOT NULL,
	entry_id TEXT NOT NULL,
	entry_seq INTEGER NOT NULL,
	entry_type TEXT NOT NULL,
	PRIMARY KEY (session_id, branch_id, entry_id)
) WITHOUT ROWID;

-- Ordered scans. entry_seq must follow session_id, branch_id directly or ORDER
-- BY needs a temp b-tree; entry_id and entry_type trail so the index covers
-- id-only reads.
CREATE INDEX IF NOT EXISTS ix_be_seq ON branch_entries(session_id, branch_id, entry_seq, entry_id, entry_type);
-- Type-filtered scans.
CREATE INDEX IF NOT EXISTS ix_be_type ON branch_entries(session_id, branch_id, entry_type, entry_seq, entry_id);
CREATE INDEX IF NOT EXISTS ix_be_entry ON branch_entries(session_id, entry_id);

CREATE TABLE IF NOT EXISTS branch_meta (
	session_id TEXT NOT NULL,
	branch_id TEXT NOT NULL,
	tip_entry_id TEXT NOT NULL,
	tip_seq INTEGER NOT NULL,
	base_branch_id TEXT,
	base_seq INTEGER,
	PRIMARY KEY (session_id, branch_id)
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS ix_bm_tip ON branch_meta(session_id, tip_entry_id);
