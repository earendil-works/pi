/**
 * Owner-only access route (GET list grants, POST decide, DELETE remove grant). Testable function;
 * `api/access.ts` wires to Neon. Off unless `NLT_ACCESS_REQUESTS=1`. 404 when off, 401 without owner.
 * The browser never sends a host for decisions (looked up server-side). Never logs nonce/prompt/reason.
 */
import type { AgentRequest, AgentResponse } from "../agent/route.ts";
import type { AccessStore } from "./store.ts";
import { normalizeHost } from "./host.ts";
import { accessRequestsEnabled } from "./config.ts";
export { accessRequestsEnabled };

export interface AccessRequestMsg extends AgentRequest {
  query?: Record<string, string | string[] | undefined>;
}

export interface AccessRouteDeps {
  env: { NLT_ACCESS_REQUESTS?: string; DATABASE_URL?: string; NLT_AGENT_EGRESS_ALL?: string };
  owner: (request: AccessRequestMsg) => string | undefined;
  createStore: (databaseUrl: string) => AccessStore;
  log: (line: string) => void;
  now?: () => number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECISIONS = new Set(["allow_turn", "allow_always", "deny"]);
const UNAVAILABLE = { error: "Access requests unavailable" } as const;


const firstQuery = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export async function handleAccessRequest(request: AccessRequestMsg, response: AgentResponse, deps: AccessRouteDeps): Promise<void> {
  response.setHeader("Cache-Control", "no-store");
  if (!accessRequestsEnabled(deps.env)) {
    response.status(404).json({ error: "Not found" });
    return;
  }
  const owner = deps.owner(request);
  if (!owner) {
    response.status(401).json({ error: "Sign in required" });
    return;
  }
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "POST" && method !== "DELETE") {
    response.setHeader("Allow", "GET, POST, DELETE");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }
  const databaseUrl = deps.env.DATABASE_URL;
  if (!databaseUrl) {
    response.status(503).json(UNAVAILABLE);
    return;
  }

  let store: AccessStore;
  try {
    store = deps.createStore(databaseUrl);
  } catch {
    deps.log(JSON.stringify({ event: "access_lookup_error", op: "store" }));
    response.status(503).json(UNAVAILABLE);
    return;
  }

  try {
    if (method === "GET") {
      const hosts = await store.listGrants(owner);
      response.status(200).json({ hosts });
      return;
    }
    if (method === "DELETE") {
      const host = normalizeHost(firstQuery(request.query?.host));
      if (!host) {
        response.status(400).json({ error: "host must be a valid hostname" });
        return;
      }
      const removed = await store.removeGrant(owner, host);
      if (!removed) response.status(404).json({ error: "Not found" });
      else {
        deps.log(JSON.stringify({ event: "access_decision", decision: "revoke_always", host }));
        response.status(200).json({ deleted: true });
      }
      return;
    }
    // POST: decision. Browser must not send a host.
    if (!isRecord(request.body)) {
      response.status(400).json({ error: "Body must be a JSON object" });
      return;
    }
    if ("host" in request.body) {
      response.status(400).json({ error: "host must not be sent; decisions are looked up server-side" });
      return;
    }
    const id = request.body.id;
    const decision = request.body.decision;
    if (typeof id !== "string" || !UUID.test(id)) {
      response.status(400).json({ error: "id must be a UUID" });
      return;
    }
    if (typeof decision !== "string" || !DECISIONS.has(decision)) {
      response.status(400).json({ error: "decision must be allow_turn, allow_always, or deny" });
      return;
    }
    const result = await store.decide(owner, id, decision as "allow_turn" | "allow_always" | "deny", deps.now?.() ?? Date.now());
    if ("error" in result) {
      if (result.error === "grant_cap") response.status(409).json({ error: "Grant limit reached" });
      else response.status(404).json({ error: "Not found" });
      return;
    }
    deps.log(JSON.stringify({ event: "access_decision", decision: result.status, requestId: id }));
    if (result.status === "allowed_turn") response.status(200).json({ status: result.status, nonce: result.nonce });
    else response.status(200).json({ status: result.status });
  } catch {
    deps.log(JSON.stringify({ event: "access_lookup_error", op: method.toLowerCase() }));
    response.status(503).json(UNAVAILABLE);
  }
}
