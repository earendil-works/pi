CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	created_at TEXT NOT NULL,
	cwd TEXT NOT NULL,
	parent_session_id TEXT NULL,
	metadata TEXT NULL,
	active_leaf_id TEXT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);

CREATE TABLE IF NOT EXISTS session_entries (
	session_id TEXT NOT NULL,
	id TEXT NOT NULL,
	entry_seq INTEGER NOT NULL,
	parent_id TEXT NULL,
	type TEXT NOT NULL,
	timestamp TEXT NOT NULL,
	payload TEXT NOT NULL,
	PRIMARY KEY (session_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_entries_session_seq ON session_entries(session_id, entry_seq);
CREATE INDEX IF NOT EXISTS idx_session_entries_session_parent ON session_entries(session_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_session_entries_session_type ON session_entries(session_id, type);

CREATE TABLE IF NOT EXISTS session_sequences (
	session_id TEXT PRIMARY KEY,
	next_seq INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS branch_entries (
	session_id TEXT NOT NULL,
	branch_id TEXT NOT NULL,
	entry_id TEXT NOT NULL,
	entry_seq INTEGER NOT NULL,
	PRIMARY KEY (session_id, branch_id, entry_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_branch_entries_session_branch ON branch_entries(session_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_branch_entries_session_branch_seq ON branch_entries(session_id, branch_id, entry_seq);
CREATE INDEX IF NOT EXISTS idx_branch_entries_session_entry ON branch_entries(session_id, entry_id);

CREATE TABLE IF NOT EXISTS session_materialized (
	session_id TEXT PRIMARY KEY,
	payload TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS entry_materialized (
	session_id TEXT NOT NULL,
	entry_seq INTEGER NOT NULL,
	type TEXT NOT NULL,
	payload TEXT NOT NULL,
	PRIMARY KEY (session_id, entry_seq, type)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_entry_materialized_session_type_seq ON entry_materialized(session_id, type, entry_seq);
