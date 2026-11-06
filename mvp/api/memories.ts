/**
 * Owner-only memories (list, save, delete). Off unless the owner sets NLT_MEMORY_ENABLED=1.
 *
 * Wires src/memory/route.ts to Mem0. The owner is the signed-in Vercel user from the session cookie.
 * The Mem0 client and credentials are server side only — never passed to the browser or the sandbox.
 * This file is not exercised by the offline tests.
 */
import { sessionFromCookie } from "../src/auth/owner.ts";
import { type MemoryRequest, handleMemoryRequest, memoryEnabled, writeChecks } from "../src/memory/route.ts";
import { type MemoryStore, createMem0Store } from "../src/memory/store.ts";
import { createMemoryClient, type MemoryClientEnv } from "../src/memory/client.ts";
import type { AgentResponse } from "../src/agent/route.ts";
import { neon } from "@neondatabase/serverless";
import { verifyToi, parseToi, type ToiDocument } from "@neurolift-technologies/toi";

let cachedClient: { env: MemoryClientEnv; client: ReturnType<typeof createMemoryClient> } | undefined;

function memoryClient(env: MemoryClientEnv) {
  if (!cachedClient || cachedClient.env !== env) {
    cachedClient = { env, client: createMemoryClient(env) };
  }
  return cachedClient.client;
}

let cachedSql: { url: string; sql: ReturnType<typeof neon> } | undefined;

function sqlFor(url: string) {
  if (!cachedSql || cachedSql.url !== url) {
    cachedSql = { url, sql: neon(url) };
  }
  return cachedSql.sql;
}

/**
 * Checks a source message in Neon: returns { kind } when the message exists, belongs to the owner,
 * and is not blocked/unavailable. Returns undefined otherwise.
 */
async function checkSourceMessage(databaseUrl: string, messageId: string, owner: string): Promise<{ kind: string } | undefined> {
  const sql = sqlFor(databaseUrl);
  const rows = await sql.query(
    `SELECT m.kind
     FROM chat_messages m
     JOIN chat_conversations c ON c.id = m.conversation_id
     WHERE m.id = $1 AND c.owner_sub = $2`,
    [messageId, owner],
  ) as Array<{ kind: string }>;
  if (rows.length === 0) return undefined;
  return { kind: rows[0].kind };
}

/**
 * Phase 2: Upload the owner's signed .toi to Mem0.
 * Validates $signature present, $signature.public_key == NLT_TOI_PUBKEY, verifyToi true.
 * Stores to Mem0 with user_id = owner, agent_id = nlt-pi-mvp, metadata { kind: "toi", source: "owner-upload" }.
 */
async function handleToiUpload(
  request: MemoryRequest,
  response: AgentResponse,
  owner: string,
  env: MemoryClientEnv & { NLT_TOI_PUBKEY?: string; NLT_MEMORY_ENABLED?: string },
): Promise<boolean> {
  if (request.method !== "POST") return false;
  const url = (request as MemoryRequest & { url?: string }).url ?? "";
  if (!url.endsWith("/toi")) return false;

  response.setHeader("Cache-Control", "no-store");

  if (!memoryEnabled(env)) {
    response.status(404).json({ error: "Not found" });
    return true;
  }

  const pubkey = env.NLT_TOI_PUBKEY;
  if (!pubkey) {
    response.status(503).json({ error: "TOI verification unavailable" });
    return true;
  }

  let body: unknown;
  try {
    body = request.body;
  } catch {
    response.status(400).json({ error: "Body must be JSON" });
    return true;
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    response.status(400).json({ error: "Body must be a JSON object" });
    return true;
  }

  const { signedToi } = body as { signedToi?: unknown };
  if (!signedToi || typeof signedToi !== "object" || Array.isArray(signedToi)) {
    response.status(400).json({ error: 'Body must include a "signedToi" object' });
    return true;
  }

  const doc = signedToi as ToiDocument;
  const signature = doc.$signature;
  if (!signature || typeof signature.public_key !== "string") {
    response.status(400).json({ error: "signedToi must include a $signature with public_key" });
    return true;
  }
  if (signature.public_key !== pubkey) {
    response.status(400).json({ error: "signedToi public key does not match the pinned NLT_TOI_PUBKEY" });
    return true;
  }
  if (!verifyToi(doc)) {
    response.status(400).json({ error: "signedToi signature verification failed" });
    return true;
  }

  const toiText = JSON.stringify(doc);
  const checkError = writeChecks(toiText);
  if (checkError) {
    response.status(400).json({ error: checkError });
    return true;
  }

  const client = memoryClient(env);
  const id = await client.create(owner, {
    text: toiText,
    bucket: "owner",
    sourceMessageId: undefined,
    metadata: { kind: "toi", source: "owner-upload" },
  });
  if (!id) {
    response.status(503).json({ error: "Memory unavailable" });
    return true;
  }

  response.status(200).json({ uploaded: true, id });
  return true;
}

export default async function handler(request: MemoryRequest, response: AgentResponse) {
  const env = process.env as unknown as {
    NLT_MEMORY_ENABLED?: string;
    NLT_HISTORY_ENABLED?: string;
    DATABASE_URL?: string;
    MEM0_API_KEY?: string;
    MEM0_ORG_ID?: string;
    MEM0_PROJECT_ID?: string;
    MEM0_BASE_URL?: string;
    NLT_TOI_PUBKEY?: string;
  };

  const databaseUrl = env.DATABASE_URL;
  const store: MemoryStore = createMem0Store(memoryClient(env));

  // Phase 2: TOI upload route takes precedence for POST /api/memories/toi.
  const isToiUpload = (request as MemoryRequest & { url?: string }).url?.endsWith("/toi");
  if (isToiUpload) {
    const owner = sessionFromCookie(process.env, request.headers?.cookie)?.sub;
    if (!owner) {
      response.status(401).json({ error: "Sign in required" });
      return;
    }
    await handleToiUpload(request, response, owner, env);
    return;
  }

  await handleMemoryRequest(request, response, {
    env,
    owner: (req) => sessionFromCookie(process.env, req.headers?.cookie)?.sub,
    createStore: () => store,
    sourceMessage: databaseUrl
      ? async (messageId: string, ownerId: string) => checkSourceMessage(databaseUrl, messageId, ownerId)
      : undefined,
    log: (line) => console.warn(line),
  });
}