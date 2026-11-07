/**
 * The coding-agent route. Off unless the owner sets NLT_AGENT_ENABLED=1 for the environment.
 *
 * Wires the real pieces: the ASFDK crisis gate (checked before anything else), the Vercel Sandbox, the free
 * Vercel AI Gateway models, and the Vercel OIDC token as the gateway credential (read inside the request).
 * See src/agent/route.ts for the contract. This file is not exercised by the offline tests.
 */
import { randomUUID } from "node:crypto";
import { getVercelOidcToken } from "@vercel/oidc";
import { neon } from "@neondatabase/serverless";
import type { AgentRunnerDeps, AgentTurnInput, AgentTurnResult } from "../src/agent/runner.ts";
import { gateWorkDir } from "../src/agent/gate-workdir.ts";
import { AGENT_LOCK_STALE_MS, type AgentRequest, type AgentResponse, handleAgentRequest } from "../src/agent/route.ts";
import { sessionFromCookie } from "../src/auth/owner.ts";
import { evaluateGate } from "../src/gate.ts";
import { AsfdkHarness, Channel } from "../src/harness/harness.ts";
import { createVercelSandboxClient } from "../src/sandbox/vercel-client.ts";
import { parseAllowedModels, parseDefaultModel } from "../src/gateway/free-models.ts";
import { accessRequestsEnabled } from "../src/access/config.ts";
import { createSqlAccessStore, neonSqlAccessRunner, type AccessStore } from "../src/access/store.ts";
import { createNeonMemoryStore } from "../src/memory/neon-store.ts";
import { createEmbedRunner } from "../src/memory/sandbox-embed.ts";
import { recallChecks, memoryEnabled } from "../src/memory/route.ts";
import type { Memory } from "../src/memory/store.ts";
import type { SandboxLike } from "../src/sandbox/operations.ts";

const embedRunner = createEmbedRunner();

let cachedNeonSql: { url: string; sql: ReturnType<typeof neon> } | undefined;
function neonSqlFor(url: string) {
  if (!cachedNeonSql || cachedNeonSql.url !== url) cachedNeonSql = { url, sql: neon(url) };
  return cachedNeonSql.sql;
}

/**
 * Returns a recall function that uses the locked sandbox for in-process embedding + pgvector search.
 * Called only when NLT_MEMORY_ENABLED=1 and DATABASE_URL is set.
 */
function makeRecallFactory(
  databaseUrl: string,
  owner: string,
  limit: number,
): (sandbox: SandboxLike) => (prompt: string) => Promise<Memory[]> {
  return (sandbox) => async (prompt) => {
    const sql = {
      query: (text: string, params: unknown[]) =>
        neonSqlFor(databaseUrl).query(text, params) as Promise<Record<string, unknown>[]>,
    };
    const store = createNeonMemoryStore(sql, { embedRunner, sandbox });
    try {
      const hits = await store.search(owner, prompt, limit);
      return hits.filter((m) => recallChecks(m.text));
    } catch {
      return [];
    }
  };
}

/** Runs the ASFDK crisis gate for one prompt; fails closed when the assessment cannot run. */
async function gate(prompt: string) {
  const workDir = gateWorkDir();
  const harness = new AsfdkHarness({ userId: `agent-gate-${randomUUID()}`, cwd: workDir });
  try {
    await harness.start();
    const { interaction, emotionalState } = await harness.assessText(prompt, {}, Channel.UNKNOWN);
    const decision = evaluateGate(interaction, emotionalState);
    return { allowed: decision.allowed, blockedReason: decision.blockedReason, crisisLevel: decision.crisisLevel };
  } catch {
    return { allowed: false, blockedReason: "Governance assessment unavailable", crisisLevel: null };
  } finally {
    await harness.shutdown().catch(() => undefined);
  }
}

/** Vercel serverless handler wiring the gate, sandbox and gateway for an enabled agent turn. */
export default async function handler(request: AgentRequest, response: AgentResponse) {
  await handleAgentRequest(request, response, {
    env: process.env,
    authorize: (req) => sessionFromCookie(process.env, req.headers?.cookie) !== undefined,
    ownerSub: (req) => sessionFromCookie(process.env, req.headers?.cookie)?.sub,
    createAccessStore: (databaseUrl: string) => createSqlAccessStore(neonSqlAccessRunner(databaseUrl)),
    createDeps: ({ egressAll, accessStore, owner }) => {
      const env = process.env as {
        NLT_MEMORY_ENABLED?: string;
        NLT_MEMORY_RECALL_LIMIT?: string;
        NLT_ACCESS_REQUESTS?: string;
        DATABASE_URL?: string;
        NLT_AGENT_EGRESS_ALL?: string;
      };
      const databaseUrl = env.DATABASE_URL ?? "";
      const recallLimit = env.NLT_MEMORY_RECALL_LIMIT
        ? Number.parseInt(env.NLT_MEMORY_RECALL_LIMIT, 10)
        : 5;
      const limit = Number.isFinite(recallLimit) && recallLimit >= 1 ? recallLimit : 5;

      const deps: AgentRunnerDeps = {
        gate,
        sandboxClient: createVercelSandboxClient(),
        gatewayToken: () => getVercelOidcToken(),
        allowedModels: parseAllowedModels(process.env.NLT_AGENT_MODELS),
        preferredModels: parseDefaultModel(process.env.NLT_AGENT_DEFAULT_MODEL),
        sandbox: { egressAll, lockStaleMs: AGENT_LOCK_STALE_MS },
        access: {
          enabled: accessRequestsEnabled(process.env),
          env: process.env,
          owner,
          store: accessStore,
          log: (line) => console.info(line),
        },
      };

      // Wire Neon+pgvector recall when memory is enabled and the DB is configured.
      if (memoryEnabled(env) && databaseUrl && owner) {
        deps.recallFactory = makeRecallFactory(databaseUrl, owner, limit);
      }

      return deps;
    },
    run: async (deps: AgentRunnerDeps, input: AgentTurnInput): Promise<AgentTurnResult> => {
      const { runAgentTurn } = await import("../src/agent/runner.ts");
      return runAgentTurn(deps, input);
    },
    log: (line) => console.info(line),
  });
}
