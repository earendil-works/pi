CREATE TABLE IF NOT EXISTS branch_tips (
	session_id TEXT NOT NULL,
	tip_id TEXT NOT NULL,
	branch_id TEXT NOT NULL,
	PRIMARY KEY (session_id, tip_id),
	UNIQUE (session_id, branch_id)
) WITHOUT ROWID;

DELETE FROM branch_tips;
DELETE FROM branch_entries;

DROP INDEX IF EXISTS idx_branch_entries_session_branch;
