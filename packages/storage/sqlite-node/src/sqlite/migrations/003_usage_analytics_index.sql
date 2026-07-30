CREATE INDEX IF NOT EXISTS idx_session_entries_message_timestamp
ON session_entries(timestamp)
WHERE type = 'message';
