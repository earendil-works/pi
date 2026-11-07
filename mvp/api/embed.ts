/**
 * Background embed route. Owner-only, off unless NLT_MEMORY_ENABLED=1.
 * Called fire-and-forget from api/memories.ts after a successful save.
 * Acquires the sandbox lock, runs embed.py, updates the memories.embedding column.
 * See src/memory/embed-route.ts for the contract.
 */
import { sessionFromCookie } from "../src/auth/owner.ts";
import { handleEmbedRequest } from "../src/memory/embed-route.ts";
import { createEmbedRunner } from "../src/memory/sandbox-embed.ts";
import { createVercelSandboxClient } from "../src/sandbox/vercel-client.ts";
import { neon } from "@neondatabase/serverless";
import type { AgentResponse } from "../src/agent/route.ts";
import type { AgentRequest } from "../src/agent/route.ts";

let cachedSql: { url: string; sql: ReturnType<typeof neon> } | undefined;
function sqlFor(url: string) {
  if (!cachedSql || cachedSql.url !== url) cachedSql = { url, sql: neon(url) };
  return cachedSql.sql;
}

const embedRunner = createEmbedRunner();
const sandboxClient = createVercelSandboxClient();

export default async function handler(request: AgentRequest, response: AgentResponse) {
  const env = process.env as { NLT_MEMORY_ENABLED?: string; DATABASE_URL?: string };
  const databaseUrl = env.DATABASE_URL ?? "";

  await handleEmbedRequest(request, response, {
    env,
    owner: (req) => sessionFromCookie(process.env, req.headers?.cookie)?.sub,
    sql: {
      query: (text, params) =>
        sqlFor(databaseUrl).query(text, params) as Promise<Record<string, unknown>[]>,
    },
    embedRunner,
    sandboxClient,
    log: (line) => console.info(line),
  });
}
