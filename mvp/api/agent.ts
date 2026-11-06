/**
 * The coding-agent route. Off unless the owner sets NLT_AGENT_ENABLED=1 for the environment.
 *
 * Wires the real pieces: the ASFDK crisis gate (checked before anything else), the Vercel Sandbox, the free
 * Vercel AI Gateway models, and the Vercel OIDC token as the gateway credential (read inside the request).
 * See src/agent/route.ts for the contract. This file is not exercised by the offline tests.
 */
import { randomUUID } from "node:crypto";
import { getVercelOidcToken } from "@vercel/oidc";
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
import { createMemoryClient, type MemoryClientEnv } from "../src/memory/client.ts";
import { recallChecks } from "../src/memory/route.ts";
import type { Memory } from "../src/memory/store.ts";

/** Recalls approved memories for a turn. Searches Mem0, applies deterministic recall checks,
 * limits results by NLT_MEMORY_RECALL_LIMIT (default 5). Never writes to Mem0. */
async function recall(
  prompt: string,
  env: MemoryClientEnv & { NLT_MEMORY_ENABLED?: string; NLT_MEMORY_RECALL_LIMIT?: string },
  owner: string,
): Promise<Memory[]> {
  if (env.NLT_MEMORY_ENABLED !== "1") return [];
  const client = createMemoryClient(env);
  const limit = env.NLT_MEMORY_RECALL_LIMIT
    ? Number.parseInt(env.NLT_MEMORY_RECALL_LIMIT, 10)
    : 5;
  if (!Number.isFinite(limit) || limit < 1) return [];
  try {
    const hits = await client.search(owner, prompt, limit);
    return hits.filter((m) => recallChecks(m.text));
  } catch {
    // Mem0 unavailable on recall: turn runs without memories.
    return [];
  }
}

/** Runs the ASFDK crisis gate for one prompt; fails closed when the assessment cannot run. */
async function gate(prompt: string) {
  // Sleepwalker writes relative to the working directory; function directories are read-only. The directory
  // is chosen once per process (see gate-workdir.ts), never changed per request.
  const workDir = gateWorkDir();
  const harness = new AsfdkHarness({ userId: `agent-gate-${randomUUID()}`, cwd: workDir });
  try {
    await harness.start();
    const { interaction, emotionalState } = await harness.assessText(prompt, {}, Channel.UNKNOWN);
    const decision = evaluateGate(interaction, emotionalState);
    return { allowed: decision.allowed, blockedReason: decision.blockedReason, crisisLevel: decision.crisisLevel };
  } catch {
    // Fail closed: an assessment that could not run is not a pass.
    return { allowed: false, blockedReason: "Governance assessment unavailable", crisisLevel: null };
  } finally {
    await harness.shutdown().catch(() => undefined);
  }
}

/** Vercel serverless handler wiring the gate, sandbox and gateway for an enabled agent turn. */
export default async function handler(request: AgentRequest, response: AgentResponse) {
  await handleAgentRequest(request, response, {
    env: process.env,
    // Only a signed-in owner (allow-listed Vercel user) may call the route; see src/auth/owner.ts.
    authorize: (req) => sessionFromCookie(process.env, req.headers?.cookie) !== undefined,
    ownerSub: (req) => sessionFromCookie(process.env, req.headers?.cookie)?.sub,
    createAccessStore: (databaseUrl: string) => createSqlAccessStore(neonSqlAccessRunner(databaseUrl)),
    createDeps: ({ egressAll, accessStore, owner }) => {
      const env = process.env as unknown as MemoryClientEnv & {
        NLT_MEMORY_ENABLED?: string;
        NLT_MEMORY_RECALL_LIMIT?: string;
        NLT_ACCESS_REQUESTS?: string;
        DATABASE_URL?: string;
        NLT_AGENT_EGRESS_ALL?: string;
      };
      return {
        gate,
        recall: (prompt) => recall(prompt, env, owner ?? ""),
        sandboxClient: createVercelSandboxClient(),
        gatewayToken: () => getVercelOidcToken(),
        // Owner-set allow-list of models this plan can call; unset means any free tool-capable model.
        allowedModels: parseAllowedModels(process.env.NLT_AGENT_MODELS),
        // Owner-set default for "Auto"; used only while it is free, tool-capable and allowed.
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
    },
    run: async (deps: AgentRunnerDeps, input: AgentTurnInput): Promise<AgentTurnResult> => {
      // The runner module is loaded only once the route is known to be enabled, so disabled requests never load it.
      const { runAgentTurn } = await import("../src/agent/runner.ts");
      return runAgentTurn(deps, input);
    },
    log: (line) => console.info(line),
  });
}
