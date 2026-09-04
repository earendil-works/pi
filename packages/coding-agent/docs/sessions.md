# Sessions

Sessions are append-only version-3 JSONL trees. The first record is a session header. Every later record has an eight-character id, parentId, timestamp, and typed payload. Branching changes the active leaf without deleting alternate children. Compaction records summaries and retained tails.

Use `--continue`, `--session`, `--fork`, or the interactive session commands. Session files default to `~/.pi/agent/sessions`.
