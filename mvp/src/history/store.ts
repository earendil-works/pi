/**
 * Chat history store (Neon Postgres). See docs/superpowers/specs/2026-11-05-chat-history-neon-design.md.
 *
 * Every statement is parameterised and filtered by `owner_sub`, directly or through the conversation. The owner is
 * always an argument from the caller's verified session; nothing here reads it from request data. The schema is
 * created once per store, before its first query. The driver is behind `SqlRunner`, so the SQL can be tested
 * without a database.
 */
import { neon } from "@neondatabase/serverless";

export type MessageRole = "user" | "assistant";
export type MessageKind = "normal" | "blocked" | "unavailable";

export interface StoredConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage {
  id: string;
  role: MessageRole;
  kind: MessageKind;
  text: string;
  model: string | null;
  createdAt: string;
}

export interface SaveInput {
  conversation: { id: string; title: string };
  messages: StoredMessage[];
}

export interface HistoryStore {
  list(owner: string): Promise<StoredConversation[]>;
  get(owner: string, id: string): Promise<{ conversation: StoredConversation; messages: StoredMessage[] } | undefined>;
  /** `owned` is false when the conversation id belongs to another owner; nothing is changed then. */
  save(owner: string, input: SaveInput): Promise<{ owned: boolean; saved: number }>;
  remove(owner: string, id: string): Promise<boolean>;
}

export interface SqlRunner {
  query(text: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  /** Runs the statements in one transaction and returns each statement's rows. */
  transaction(statements: { text: string; params: unknown[] }[]): Promise<Record<string, unknown>[][]>;
}

const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS chat_conversations (
  id          uuid PRIMARY KEY,
  owner_sub   text NOT NULL,
  title       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
)`,
  `CREATE INDEX IF NOT EXISTS chat_conversations_owner_updated
  ON chat_conversations (owner_sub, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
  id               uuid PRIMARY KEY,
  conversation_id  uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('user', 'assistant')),
  kind             text NOT NULL CHECK (kind IN ('normal', 'blocked', 'unavailable')),
  text             text NOT NULL,
  model            text,
  created_at       timestamptz NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS chat_messages_conversation_created
  ON chat_messages (conversation_id, created_at)`,
];

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());

const toConversation = (row: Record<string, unknown>): StoredConversation => ({
  id: String(row.id),
  title: String(row.title),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const toMessage = (row: Record<string, unknown>): StoredMessage => ({
  id: String(row.id),
  role: row.role as MessageRole,
  kind: row.kind as MessageKind,
  text: String(row.text),
  model: typeof row.model === "string" ? row.model : null,
  createdAt: iso(row.created_at),
});

export function createSqlStore(sql: SqlRunner): HistoryStore {
  let ready: Promise<void> | undefined;
  const ensureSchema = (): Promise<void> => {
    ready ??= (async () => {
      for (const statement of SCHEMA) await sql.query(statement, []);
    })().catch((error: unknown) => {
      ready = undefined; // a failed attempt is retried by the next call
      throw error;
    });
    return ready;
  };

  return {
    async list(owner) {
      await ensureSchema();
      const rows = await sql.query(
        "SELECT id, title, created_at, updated_at FROM chat_conversations WHERE owner_sub = $1 ORDER BY updated_at DESC LIMIT 100",
        [owner],
      );
      return rows.map(toConversation);
    },

    async get(owner, id) {
      await ensureSchema();
      const conversations = await sql.query(
        "SELECT id, title, created_at, updated_at FROM chat_conversations WHERE id = $1 AND owner_sub = $2",
        [id, owner],
      );
      const conversation = conversations[0];
      if (!conversation) return undefined;
      const messages = await sql.query(
        "SELECT m.id, m.role, m.kind, m.text, m.model, m.created_at FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id WHERE c.id = $1 AND c.owner_sub = $2 ORDER BY m.created_at, m.id",
        [id, owner],
      );
      return { conversation: toConversation(conversation), messages: messages.map(toMessage) };
    },

    async save(owner, input) {
      await ensureSchema();
      const conversationId = input.conversation.id;
      const statements = [
        {
          text: "INSERT INTO chat_conversations (id, owner_sub, title) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, updated_at = now() WHERE chat_conversations.owner_sub = EXCLUDED.owner_sub RETURNING id",
          params: [conversationId, owner, input.conversation.title],
        },
        ...input.messages.map((message) => ({
          text: "INSERT INTO chat_messages (id, conversation_id, role, kind, text, model, created_at) SELECT $1, $2, $3, $4, $5, $6, $7 WHERE EXISTS (SELECT 1 FROM chat_conversations WHERE id = $2 AND owner_sub = $8) ON CONFLICT (id) DO NOTHING RETURNING id",
          params: [message.id, conversationId, message.role, message.kind, message.text, message.model, message.createdAt, owner],
        })),
      ];
      const results = await sql.transaction(statements);
      const owned = (results[0]?.length ?? 0) > 0;
      const saved = results.slice(1).reduce((count, rows) => count + rows.length, 0);
      return { owned, saved };
    },

    async remove(owner, id) {
      await ensureSchema();
      const rows = await sql.query("DELETE FROM chat_conversations WHERE id = $1 AND owner_sub = $2 RETURNING id", [id, owner]);
      return rows.length > 0;
    },
  };
}

/** The real runner, over Neon's HTTP driver. Created inside a request, never at module load. */
export function neonSqlRunner(databaseUrl: string): SqlRunner {
  const sql = neon(databaseUrl);
  return {
    query: (text, params) => sql.query(text, params) as Promise<Record<string, unknown>[]>,
    transaction: (statements) =>
      sql.transaction(statements.map((s) => sql.query(s.text, s.params))) as Promise<Record<string, unknown>[][]>,
  };
}
