CREATE INDEX IF NOT EXISTS idx_entries_message_timestamp
ON entries(timestamp)
WHERE type = 'message';
