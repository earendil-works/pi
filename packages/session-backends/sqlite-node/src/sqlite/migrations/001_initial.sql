CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	created_at TEXT NOT NULL,
	cwd TEXT NOT NULL,
	parent_session_id TEXT NULL,
	metadata TEXT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);

CREATE TABLE IF NOT EXISTS entries (
	session_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	id TEXT NOT NULL,
	parent_id TEXT NULL,
	type TEXT NOT NULL,
	timestamp TEXT NOT NULL,
	payload TEXT NOT NULL,
	PRIMARY KEY (session_id, id),
	UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_entries_session_seq ON entries(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_entries_session_parent ON entries(session_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_entries_session_type_seq ON entries(session_id, type, seq);

CREATE TABLE IF NOT EXISTS session_sequences (
	session_id TEXT PRIMARY KEY,
	next_seq INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS session_stats (
	session_id TEXT PRIMARY KEY,
	message_count INTEGER NOT NULL,
	cached_tokens REAL NOT NULL,
	uncached_tokens REAL NOT NULL,
	total_tokens REAL NOT NULL,
	cost_total REAL NOT NULL
) WITHOUT ROWID;

-- Derived branch cache. Parent links in entries remain canonical; this cache
-- exists only to make branch scans cheap.
CREATE TABLE IF NOT EXISTS branch_entries (
	session_id TEXT NOT NULL,
	branch_id TEXT NOT NULL,
	entry_id TEXT NOT NULL,
	entry_seq INTEGER NOT NULL,
	entry_type TEXT NULL,
	custom_type TEXT NULL,
	PRIMARY KEY (session_id, branch_id, entry_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_branch_entries_session_branch_seq ON branch_entries(session_id, branch_id, entry_seq);
CREATE INDEX IF NOT EXISTS idx_branch_entries_session_entry ON branch_entries(session_id, entry_id);
CREATE INDEX IF NOT EXISTS idx_branch_entries_session_branch_type_seq ON branch_entries(session_id, branch_id, entry_type, entry_seq);
CREATE INDEX IF NOT EXISTS idx_branch_entries_session_branch_custom_seq ON branch_entries(session_id, branch_id, custom_type, entry_seq);

CREATE TABLE IF NOT EXISTS lanes (
	session_id TEXT NOT NULL,
	lane TEXT NOT NULL,
	leaf_id TEXT NULL,
	PRIMARY KEY (session_id, lane)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_lanes_session_leaf ON lanes(session_id, leaf_id);

CREATE TABLE IF NOT EXISTS records (
	session_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	id TEXT NOT NULL,
	lane TEXT NOT NULL,
	run_id TEXT NULL,
	type TEXT NOT NULL,
	op_kind TEXT NULL,
	timestamp TEXT NOT NULL,
	payload TEXT NOT NULL,
	PRIMARY KEY (session_id, id),
	UNIQUE (session_id, seq)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_records_session_seq ON records(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_records_session_lane_type_seq ON records(session_id, lane, type, seq);
CREATE INDEX IF NOT EXISTS idx_records_session_lane_type_op_kind_seq ON records(session_id, lane, type, op_kind, seq);
CREATE INDEX IF NOT EXISTS idx_records_session_run_id_seq ON records(session_id, run_id, seq);

CREATE TABLE IF NOT EXISTS lane_moves (
	session_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	lane TEXT NOT NULL,
	leaf_id TEXT NULL,
	PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_lane_moves_session_lane_seq ON lane_moves(session_id, lane, seq);

CREATE TABLE IF NOT EXISTS facts (
	session_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	kind TEXT NOT NULL,
	key TEXT NULL,
	value TEXT NULL,
	PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_facts_session_kind_key_seq ON facts(session_id, kind, key, seq);

CREATE TABLE IF NOT EXISTS branch_tips (
	session_id TEXT NOT NULL,
	tip_id TEXT NOT NULL,
	branch_id TEXT NOT NULL,
	PRIMARY KEY (session_id, tip_id),
	UNIQUE (session_id, branch_id)
) WITHOUT ROWID;

-- Per-session writer claim. The fence prevents an expired owner from writing
-- after a new owner takes over the session.
CREATE TABLE IF NOT EXISTS leases (
	session_id TEXT PRIMARY KEY,
	owner_id TEXT NOT NULL,
	fence INTEGER NOT NULL,
	expires_at_ms INTEGER NOT NULL
) WITHOUT ROWID;
