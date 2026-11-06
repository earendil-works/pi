/**
 * Owner-only sandbox access requests (list always-allowed hosts, decide on a pending request, remove a grant).
 * Off unless the owner sets NLT_ACCESS_REQUESTS=1. See src/access/route.ts for the contract.
 */
import { sessionFromCookie } from "../src/auth/owner.ts";
import { type AccessRequestMsg, handleAccessRequest } from "../src/access/route.ts";
import { type AccessStore, createSqlAccessStore, neonSqlAccessRunner } from "../src/access/store.ts";
import type { AgentResponse } from "../src/agent/route.ts";

let cached: { url: string; store: AccessStore } | undefined;

function storeFor(url: string): AccessStore {
  if (cached?.url !== url) cached = { url, store: createSqlAccessStore(neonSqlAccessRunner(url)) };
  return cached.store;
}

export default async function handler(request: AccessRequestMsg, response: AgentResponse) {
  await handleAccessRequest(request, response, {
    env: process.env,
    owner: (req) => sessionFromCookie(process.env, req.headers?.cookie)?.sub,
    createStore: storeFor,
    log: (line) => console.info(line),
  });
}
