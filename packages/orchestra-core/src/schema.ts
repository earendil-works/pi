// SQLite schema (WAL). Supervisor is the sole writer.
export const MIGRATIONS: { version: number; sql: string }[] = [
	{
		version: 1,
		sql: `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  parent_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  task_id TEXT,
  state TEXT NOT NULL DEFAULT 'spawning',
  worktree_path TEXT,
  branch TEXT,
  pid INTEGER,
  port INTEGER,
  model TEXT,
  session_file TEXT,
  last_event_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  spec TEXT NOT NULL DEFAULT '',
  owner_agent_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  parent_task_id TEXT,
  owns_globs TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_deps (
  task_id TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on)
);
CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  required INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS check_runs (
  id TEXT PRIMARY KEY,
  check_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  signature TEXT NOT NULL,
  output_path TEXT,
  ran_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS leases (
  path TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  expires_at INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'write'
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT,
  to_role TEXT,
  broadcast INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  in_reply_to TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  message_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  delivered_at INTEGER,
  PRIMARY KEY (message_id, recipient)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS budgets (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  max_turns INTEGER NOT NULL,
  max_tokens INTEGER NOT NULL,
  max_wall_clock_ms INTEGER NOT NULL,
  max_depth INTEGER NOT NULL,
  max_children INTEGER NOT NULL,
  used_turns INTEGER NOT NULL DEFAULT 0,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  used_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, scope_id)
);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  input_ref TEXT,
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS escalations (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  agent_id TEXT,
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  human_reply TEXT
);
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_deliveries_state ON deliveries(state);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id, ts);
`,
	},
];
