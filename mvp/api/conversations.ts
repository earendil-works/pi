/**
 * Owner-only chat history (list, open, save, delete). Off unless the owner sets NLT_HISTORY_ENABLED=1.
 *
 * Wires src/history/route.ts to the Neon database the owner added (`DATABASE_URL`). The owner is the signed-in Vercel
 * user from the session cookie. One store is kept per process and per URL, created lazily inside the first request,
 * so the schema check runs once per process. This file is not exercised by the offline tests.
 */
import { sessionFromCookie } from "../src/auth/owner.ts";
import { type HistoryRequest, handleHistoryRequest } from "../src/history/route.ts";
import { type HistoryStore, createSqlStore, neonSqlRunner } from "../src/history/store.ts";
import type { AgentResponse } from "../src/agent/route.ts";

let cached: { url: string; store: HistoryStore } | undefined;

function storeFor(url: string): HistoryStore {
  if (cached?.url !== url) cached = { url, store: createSqlStore(neonSqlRunner(url)) };
  return cached.store;
}

export default async function handler(request: HistoryRequest, response: AgentResponse) {
  await handleHistoryRequest(request, response, {
    env: process.env,
    owner: (req) => sessionFromCookie(process.env, req.headers?.cookie)?.sub,
    createStore: storeFor,
    log: (line) => console.warn(line),
  });
}
