import { describe, expect, it } from "vitest";
import { createSqlAccessStore, type SqlRunner } from "../src/access/store.ts";

const OWNER = "owner-sub-1";
const OTHER = "owner-sub-2";
const CONV = "11111111-1111-4111-8111-111111111111";
const REQ = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-11-06T12:00:00.000Z");

function stub(rowsFor: (text: string, params: unknown[]) => Record<string, unknown>[]) {
  const calls: { text: string; params: unknown[]; via: string }[] = [];
  const runner: SqlRunner = {
    async query(text, params) { calls.push({ text, params, via: "q" }); return rowsFor(text, params); },
    async transaction(statements) {
      return statements.map((s) => { calls.push({ text: s.text, params: s.params, via: "tx" }); return rowsFor(s.text, s.params); });
    },
  };
  return { runner, calls };
}
const isSchema = (t: string) => /CREATE (TABLE|INDEX) IF NOT EXISTS/.test(t);

describe("createSqlAccessStore", () => {
  it("creates schema once and scopes by owner", async () => {
    const { runner, calls } = stub(() => []);
    const store = createSqlAccessStore(runner);
    await store.listGrants(OWNER);
    await store.listGrants(OWNER);
    const schema = calls.filter((c) => isSchema(c.text));
    expect(schema.some((c) => c.text.includes("access_requests"))).toBe(true);
    expect(schema.some((c) => c.text.includes("network_grants"))).toBe(true);
    const work = calls.filter((c) => !isSchema(c.text));
    for (const c of work) {
      expect(c.params, c.text).toContain(OWNER);
      expect(c.text).not.toContain(OWNER);
      expect(c.text).toMatch(/owner_sub/);
    }
  });

  it("createRequest cleans expired, checks cap, binds conversation and task hash", async () => {
    const { runner, calls } = stub((t) => (t.includes("INSERT INTO access_requests") ? [{ id: REQ }] : [{ n: 0 }]));
    const store = createSqlAccessStore(runner);
    const r = await store.createRequest(OWNER, { id: REQ, conversationId: CONV, prompt: "do it", host: "example.com", reason: "docs", now: NOW });
    expect(r).toEqual({ id: REQ });
    const tx = calls.filter((c) => c.via === "tx" && !isSchema(c.text));
    expect(tx.some((c) => c.text.includes("DELETE FROM access_requests") && c.params[1] === new Date(NOW - 24 * 60 * 60 * 1000).toISOString())).toBe(true);
    const ins = tx.find((c) => c.text.includes("INSERT INTO access_requests"));
    expect(ins?.params).toEqual(expect.arrayContaining([REQ, OWNER, CONV, expect.any(String), "example.com", "docs"]));
  });

  it("allow_turn stores nonce hash and returns nonce once; consume matches owner+conversation+task+nonce", async () => {
    const { runner, calls } = stub((t) => (t.includes("UPDATE access_requests SET status = 'allowed_turn'") ? [{ id: REQ }] : t.includes("RETURNING host") && t.includes("used") ? [{ host: "example.com" }] : []));
    const store = createSqlAccessStore(runner);
    const d = await store.decide(OWNER, REQ, "allow_turn", NOW);
    expect("nonce" in d).toBe(true);
    const nonce = (d as { nonce: string }).nonce;
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    const upd = calls.find((c) => c.text.includes("SET status = 'allowed_turn'") && typeof c.params[2] === 'string');
    expect(upd?.params[2]).toMatch(/^[0-9a-f]{64}$/); // nonce hash stored
    expect(upd?.params).not.toContain(nonce);

    const c = await store.consumeResumeGrants(OWNER, { conversationId: CONV, resumeTask: "do it", grants: [{ id: REQ, nonce }] });
    expect(c.hosts).toEqual(["example.com"]);
    expect(c.ignored).toEqual([]);
    const cons = calls.find((c) => c.text.includes("status = 'used'"));
    expect(cons?.params).toEqual([REQ, OWNER, CONV, expect.any(String), expect.any(String)]);
  });

  it("consume ignores wrong/missing/expired/malformed grants and never grants on mismatch", async () => {
    const { runner } = stub((t) => (t.includes("RETURNING host") && t.includes("used") ? [] : []));
    const store = createSqlAccessStore(runner);
    const c = await store.consumeResumeGrants(OWNER, {
      conversationId: CONV, resumeTask: "do it",
      grants: [{ id: REQ, nonce: "wrong" }, { id: "bad" as never, nonce: 5 as never }],
    });
    expect(c.hosts).toEqual([]);
    expect(c.ignored.map((i) => i.id)).toEqual([REQ, "bad"]);
  });

  it("decide on missing/expired request returns not_found; deny updates only pending unexpired", async () => {
    const { runner } = stub(() => []);
    const store = createSqlAccessStore(runner);
    expect(await store.decide(OWNER, REQ, "deny")).toEqual({ error: "not_found" });
  });
});
