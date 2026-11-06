/**
 * Sandbox access request store (Neon Postgres). See docs/superpowers/specs/2026-11-06-sandbox-access-requests-design.md.
 *
 * Every statement is parameterised and filtered by `owner_sub`. The owner always comes from the verified session.
 * Schema created once per store. Driver behind `SqlRunner` for offline tests.
 * Fail closed at callers: lookup failures mean presets only.
 */
import { neon } from "@neondatabase/serverless";
import { generateNonce, sha256Hex, taskHash } from "./hash.ts";

export type AccessRequestStatus = "pending" | "allowed_turn" | "allowed_always" | "denied" | "used";

export interface AccessRequest {
  id: string;
  ownerSub: string;
  conversationId: string;
  taskHash: string;
  host: string;
  reason: string;
  status: AccessRequestStatus;
  nonceHash: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface NetworkGrant {
  host: string;
  createdAt: string;
}

export interface SqlRunner {
  query(text: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  transaction(statements: { text: string; params: unknown[] }[]): Promise<Record<string, unknown>[][]>;
}

export interface AccessStore {
  /** Live always-allowed hosts for the owner. */
  listGrants(owner: string): Promise<NetworkGrant[]>;
  /** Inserts a pending request bound to conversation+task. Returns the new id, or undefined if cap/validation blocks. */
  createRequest(owner: string, input: { id: string; conversationId: string; prompt: string; host: string; reason: string; now?: number }): Promise<{ id: string } | { error: "pending_cap" }>;
  /** Owner decision on a pending, unexpired request. allow_turn returns the one-time nonce (once). */
  decide(owner: string, id: string, decision: "allow_turn" | "allow_always" | "deny", now?: number): Promise<
    | { status: "allowed_turn"; nonce: string }
    | { status: "allowed_always" }
    | { status: "denied" }
    | { error: "not_found" | "grant_cap" }
  >;
  /** Removes one always-allowed host. */
  removeGrant(owner: string, host: string): Promise<boolean>;
  /**
   * Validates and atomically consumes resume grants. Returns only hosts for grants that matched
   * owner+conversation+task hash+nonce hash, were allowed_turn and unexpired. Mismatches are ignored.
   * `resumeTask` is the original task sent by the client (hashed here); caller must also enforce prompt prefix.
   */
  consumeResumeGrants(owner: string, input: { conversationId: string; resumeTask: string; grants: { id: string; nonce: string }[]; now?: number }): Promise<{ hosts: string[]; ignored: { id: string; reason: string }[] }>;
}

const PENDING_LIVE = "status = 'pending' AND expires_at > now()";
const MAX_PENDING = 10;
const MAX_GRANTS = 50;
const PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour
const TURN_TTL_MS = 10 * 60 * 1000; // 10 minutes after decision
const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000; // 1 day

const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS access_requests (
  id              uuid PRIMARY KEY,
  owner_sub       text NOT NULL,
  conversation_id uuid NOT NULL,
  task_hash       text NOT NULL,
  host            text NOT NULL,
  reason          text NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending','allowed_turn','allowed_always','denied','used')),
  nonce_hash      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS access_requests_owner_pending
  ON access_requests (owner_sub, status, expires_at)`,
  `CREATE TABLE IF NOT EXISTS network_grants (
  owner_sub   text NOT NULL,
  host        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_sub, host)
)`,
  `CREATE INDEX IF NOT EXISTS network_grants_owner ON network_grants (owner_sub)`,
];

const iso = (ms: number) => new Date(ms).toISOString();

export function createSqlAccessStore(sql: SqlRunner): AccessStore {
  let ready: Promise<void> | undefined;
  const ensureSchema = (): Promise<void> => {
    ready ??= (async () => {
      for (const statement of SCHEMA) await sql.query(statement, []);
    })().catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };

  return {
    async listGrants(owner) {
      await ensureSchema();
      const rows = await sql.query(
        "SELECT host, created_at FROM network_grants WHERE owner_sub = $1 ORDER BY host",
        [owner],
      );
      return rows.map((r) => ({ host: String(r.host), createdAt: String(r.created_at) }));
    },

    async createRequest(owner, input) {
      await ensureSchema();
      const now = input.now ?? Date.now();
      const expiresAt = iso(now + PENDING_TTL_MS);
      const cleanupBefore = iso(now - CLEANUP_AGE_MS);
      const hash = taskHash(input.prompt);
      // Transaction: cleanup old expired rows for this owner, check live pending cap, insert if under cap.
      const results = await sql.transaction([
        { text: "DELETE FROM access_requests WHERE owner_sub = $1 AND expires_at < $2", params: [owner, cleanupBefore] },
        {
          text: `SELECT count(*)::int AS n FROM access_requests WHERE owner_sub = $1 AND ${PENDING_LIVE}`,
          params: [owner],
        },
        {
          text: `INSERT INTO access_requests (id, owner_sub, conversation_id, task_hash, host, reason, status, expires_at)
                 SELECT $1,$2,$3,$4,$5,$6,'pending',$7::timestamptz
                 WHERE (SELECT count(*) FROM access_requests WHERE owner_sub = $2 AND ${PENDING_LIVE}) < $8
                 RETURNING id`,
          params: [input.id, owner, input.conversationId, hash, input.host, input.reason, expiresAt, MAX_PENDING],
        },
      ]);
      const inserted = results[2] ?? [];
      if (inserted.length === 0) return { error: "pending_cap" };
      return { id: String(inserted[0]?.id ?? input.id) };
    },

    async decide(owner, id, decision, nowArg) {
      await ensureSchema();
      const now = nowArg ?? Date.now();
      if (decision === "deny") {
        const rows = await sql.query(
          "UPDATE access_requests SET status = 'denied' WHERE id = $1 AND owner_sub = $2 AND status = 'pending' AND expires_at > now() RETURNING id",
          [id, owner],
        );
        return rows.length ? { status: "denied" } : { error: "not_found" };
      }
      if (decision === "allow_always") {
        const results = await sql.transaction([
          {
            text: "SELECT host FROM access_requests WHERE id = $1 AND owner_sub = $2 AND status = 'pending' AND expires_at > now()",
            params: [id, owner],
          },
          {
            text: "SELECT count(*)::int AS n FROM network_grants WHERE owner_sub = $1",
            params: [owner],
          },
        ]);
        const req = results[0]?.[0];
        if (!req) return { error: "not_found" };
        const count = Number((results[1]?.[0] as Record<string, unknown> | undefined)?.n ?? 0);
        if (count >= MAX_GRANTS) return { error: "grant_cap" };
        const host = String(req.host);
        await sql.transaction([
          { text: "INSERT INTO network_grants (owner_sub, host) VALUES ($1,$2) ON CONFLICT DO NOTHING", params: [owner, host] },
          {
            text: "UPDATE access_requests SET status = 'allowed_always', expires_at = $3::timestamptz WHERE id = $1 AND owner_sub = $2 AND status = 'pending' AND expires_at > now()",
            params: [id, owner, iso(now + TURN_TTL_MS)],
          },
        ]);
        return { status: "allowed_always" };
      }
      // allow_turn
      const { nonce, nonceHash } = generateNonce();
      const rows = await sql.query(
        `UPDATE access_requests SET status = 'allowed_turn', nonce_hash = $3, expires_at = $4::timestamptz
         WHERE id = $1 AND owner_sub = $2 AND status = 'pending' AND expires_at > now()
         RETURNING id`,
        [id, owner, nonceHash, iso(now + TURN_TTL_MS)],
      );
      if (!rows.length) return { error: "not_found" };
      return { status: "allowed_turn", nonce };
    },

    async removeGrant(owner, host) {
      await ensureSchema();
      const rows = await sql.query("DELETE FROM network_grants WHERE owner_sub = $1 AND host = $2 RETURNING host", [owner, host]);
      return rows.length > 0;
    },

    async consumeResumeGrants(owner, input) {
      await ensureSchema();
      if (input.grants.length === 0) return { hosts: [], ignored: [] };
      const hash = taskHash(input.resumeTask);
      const hosts: string[] = [];
      const ignored: { id: string; reason: string }[] = [];
      // Each grant consumed atomically in its own statement (id is unique); avoids complex multi-grant SQL and keeps races correct.
      for (const grant of input.grants) {
        if (typeof grant.id !== "string" || typeof grant.nonce !== "string") {
          ignored.push({ id: String(grant?.id ?? ""), reason: "malformed" });
          continue;
        }
        const nonceHash = sha256Hex(grant.nonce);
        const rows = await sql.query(
          `UPDATE access_requests SET status = 'used'
           WHERE id = $1 AND owner_sub = $2 AND conversation_id = $3
             AND task_hash = $4 AND nonce_hash = $5
             AND status = 'allowed_turn' AND expires_at > now()
           RETURNING host`,
          [grant.id, owner, input.conversationId, hash, nonceHash],
        );
        if (rows.length && rows[0]?.host) hosts.push(String(rows[0].host));
        else ignored.push({ id: grant.id, reason: "no_match" });
      }
      return { hosts: Array.from(new Set(hosts)), ignored };
    },
  };
}

export function neonSqlAccessRunner(databaseUrl: string): SqlRunner {
  const sql = neon(databaseUrl);
  return {
    query: (text, params) => sql.query(text, params) as Promise<Record<string, unknown>[]>,
    transaction: (statements) =>
      sql.transaction(statements.map((s) => sql.query(s.text, s.params))) as Promise<Record<string, unknown>[][]>,
  };
}
