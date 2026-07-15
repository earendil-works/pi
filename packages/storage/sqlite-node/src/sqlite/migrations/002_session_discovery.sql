ALTER TABLE sessions ADD COLUMN updated_at TEXT NULL;
ALTER TABLE sessions ADD COLUMN first_message TEXT NULL;
ALTER TABLE sessions ADD COLUMN all_messages_text TEXT NULL;

UPDATE sessions SET updated_at = created_at WHERE updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
