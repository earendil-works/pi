import { describe, expect, it, vi } from "vitest";
import { handleAccessRequest, type AccessRequestMsg, type AccessRouteDeps } from "../src/access/route.ts";
import type { AccessStore } from "../src/access/store.ts";
import type { AgentResponse } from "../src/agent/route.ts";

const OWNER = "owner-a";
const DB = "postgres://x";
const REQ = "22222222-2222-4222-8222-222222222222";

function res() {
  const out = { status: 0, body: undefined as unknown, headers: {} as Record<string,string> };
  const response: AgentResponse = {
    setHeader: (k, v) => { out.headers[k]=v; },
    status: (c) => ({ json: (b) => { out.status=c; out.body=b; } }),
    write: () => {}, end: () => {},
  };
  return { out, response };
}
function store(over: Partial<AccessStore> = {}): AccessStore {
  return { listGrants: async () => [{host:"example.com",createdAt:"t"}], createRequest: async()=>({id:REQ}), decide: async()=>({status:"denied"}), removeGrant: async()=>true, consumeResumeGrants: async()=>({hosts:[],ignored:[]}), ...over };
}
function deps(over: Partial<AccessRouteDeps> = {}, s = store()): AccessRouteDeps {
  return { env: { NLT_ACCESS_REQUESTS: "1", DATABASE_URL: DB }, owner: () => OWNER, createStore: () => s, log: vi.fn(), now: () => Date.now(), ...over };
}
async function call(req: AccessRequestMsg, d: AccessRouteDeps) { const r = res(); await handleAccessRequest(req, r.response, d); return r.out; }

describe("access route", () => {
  it("404 when off, 401 without owner, 405 bad method, 503 without DB", async () => {
    expect((await call({method:"GET"}, deps({env:{NLT_ACCESS_REQUESTS:"0",DATABASE_URL:DB}}))).status).toBe(404);
    expect((await call({method:"GET"}, deps({owner:()=>undefined}))).status).toBe(401);
    const m = await call({method:"PUT"}, deps());
    expect(m.status).toBe(405);
    expect(m.headers.Allow).toBe("GET, POST, DELETE");
    expect((await call({method:"GET"}, deps({env:{NLT_ACCESS_REQUESTS:"1"}}))).status).toBe(503);
  });
  it("GET lists grants; DELETE removes validated host; rejects body host on POST", async () => {
    expect((await call({method:"GET"}, deps())).status).toBe(200);
    expect((await call({method:"DELETE", query:{host:"example.com"}}, deps())).status).toBe(200);
    expect((await call({method:"DELETE", query:{host:"*.bad"}}, deps())).status).toBe(400);
    const bad = await call({method:"POST", body:{id:REQ, decision:"allow_always", host:"evil.com"}}, deps());
    expect(bad.status).toBe(400);
  });
  it("allow_turn returns nonce once; allow_always/deny return status; unknown id 404", async () => {
    const a = await call({method:"POST", body:{id:REQ, decision:"allow_turn"}}, deps({}, store({decide: async()=>({status:"allowed_turn", nonce:"abc123"})})));
    expect(a.status).toBe(200);
    expect((a.body as any).nonce).toBe("abc123");
    expect((await call({method:"POST", body:{id:REQ, decision:"deny"}}, deps())).body).toEqual({status:"denied"});
    expect((await call({method:"POST", body:{id:REQ, decision:"deny"}}, deps({}, store({decide: async()=>({error:"not_found"})})))).status).toBe(404);
  });
  it("rejects bad ids/decisions; sets no-store", async () => {
    expect((await call({method:"POST", body:{id:"x", decision:"deny"}}, deps())).status).toBe(400);
    expect((await call({method:"POST", body:{id:REQ, decision:"nope"}}, deps())).status).toBe(400);
    expect((await call({method:"GET"}, deps())).headers["Cache-Control"]).toBe("no-store");
  });
  it("logs decision without nonce/reason", async () => {
    const log = vi.fn();
    await call({method:"POST", body:{id:REQ, decision:"allow_turn"}}, deps({log}, store({decide: async()=>({status:"allowed_turn", nonce:"secretnonce"})})));
    const line = JSON.stringify(log.mock.calls);
    expect(line).toContain("access_decision");
    expect(line).not.toContain("secretnonce");
  });
});
