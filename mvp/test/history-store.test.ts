import { describe, expect, it } from "vitest";
import { type SaveInput, type SqlRunner, createSqlStore } from "../src/history/store.ts";

// Synthetic values only.
const OWNER = "owner-sub-1";
const CONV = "11111111-1111-4111-8111-111111111111";
const MSG = "22222222-2222-4222-8222-222222222222";
const SECRET_TEXT = "synthetic message text";

interface Recorded {
  text: string;
  params: unknown[];
  via: "query" | "transaction";
}

/** Records every statement. `rows` decides what each statement returns. */
function stubRunner(rows: (text: string) => Record<string, unknown>[] = () => []) {
  const calls: Recorded[] = [];
  const runner: SqlRunner = {
    async query(text, params) {
      calls.push({ text, params, via: "query" });
      return rows(text);
    },
    async transaction(statements) {
      for (const s of statements) calls.push({ text: s.text, params: s.params, via: "transaction" });
      return statements.map((s) => rows(s.text));
    },
  };
  return { runner, calls };
}

const isSchema = (text: string) => /CREATE (TABLE|INDEX) IF NOT EXISTS/.test(text);

const saveInput: SaveInput = {
  conversation: { id: CONV, title: "Synthetic title" },
  messages: [{ id: MSG, role: "user", kind: "normal", text: SECRET_TEXT, model: null, createdAt: "2026-11-05T12:00:00.000Z" }],
};

describe("createSqlStore", () => {
  it("creates the schema once, before the first query", async () => {
    const { runner, calls } = stubRunner();
    const store = createSqlStore(runner);
    await store.list(OWNER);
    await store.list(OWNER);
    const schemaCalls = calls.filter((c) => isSchema(c.text));
    expect(schemaCalls.some((c) => c.text.includes("CREATE TABLE IF NOT EXISTS chat_conversations"))).toBe(true);
    expect(schemaCalls.some((c) => c.text.includes("CREATE TABLE IF NOT EXISTS chat_messages"))).toBe(true);
    // Schema statements come first and are not repeated.
    const firstNonSchema = calls.findIndex((c) => !isSchema(c.text));
    expect(calls.slice(0, firstNonSchema).every((c) => isSchema(c.text))).toBe(true);
    expect(calls.slice(firstNonSchema).some((c) => isSchema(c.text))).toBe(false);
  });

  it("every statement is parameterised and filtered by owner", async () => {
    const { runner, calls } = stubRunner((text) => (text.includes("RETURNING id") ? [{ id: CONV }] : []));
    const store = createSqlStore(runner);
    await store.list(OWNER);
    await store.get(OWNER, CONV);
    await store.save(OWNER, saveInput);
    await store.remove(OWNER, CONV);
    const work = calls.filter((c) => !isSchema(c.text));
    expect(work.length).toBeGreaterThanOrEqual(5);
    for (const c of work) {
      expect(c.text, c.text).toMatch(/owner_sub = (\$\d+|EXCLUDED\.owner_sub)/);
      expect(c.params, c.text).toContain(OWNER);
      expect(c.text).not.toContain(OWNER);
      expect(c.text).not.toContain(SECRET_TEXT);
      expect(c.text).not.toContain(CONV);
    }
  });

  it("save upserts only the owner's conversation and inserts messages with ON CONFLICT (id) DO NOTHING", async () => {
    const { runner, calls } = stubRunner((text) => (text.includes("INSERT INTO chat_messages") ? [{ id: MSG }] : []));
    const store = createSqlStore(runner);
    const result = await store.save(OWNER, saveInput);
    const tx = calls.filter((c) => c.via === "transaction");
    expect(tx.length).toBe(2);
    expect(tx[0]?.text).toContain("ON CONFLICT (id) DO UPDATE");
    expect(tx[0]?.text).toContain("WHERE chat_conversations.owner_sub = EXCLUDED.owner_sub");
    expect(tx[0]?.text).toContain("RETURNING id");
    expect(tx[1]?.text).toContain("ON CONFLICT (id) DO NOTHING");
    expect(tx[1]?.text).toMatch(/EXISTS \(SELECT 1 FROM chat_conversations WHERE id = \$\d+ AND owner_sub = \$\d+\)/);
    // The upsert returned no row, so the conversation is not the owner's.
    expect(result).toEqual({ owned: false, saved: 1 });
  });

  it("save reports owned and the number of inserted messages", async () => {
    const { runner } = stubRunner((text) => (text.includes("RETURNING id") ? [{ id: "x" }] : []));
    const store = createSqlStore(runner);
    expect(await store.save(OWNER, saveInput)).toEqual({ owned: true, saved: 1 });
  });

  it("list orders by updated_at DESC and limits 100, and maps rows to ISO strings", async () => {
    const at = new Date("2026-11-05T12:00:00.000Z");
    const { runner, calls } = stubRunner((text) =>
      text.includes("FROM chat_conversations") && !isSchema(text) ? [{ id: CONV, title: "T", created_at: at, updated_at: at }] : [],
    );
    const store = createSqlStore(runner);
    expect(await store.list(OWNER)).toEqual([{ id: CONV, title: "T", createdAt: at.toISOString(), updatedAt: at.toISOString() }]);
    const list = calls.find((c) => !isSchema(c.text));
    expect(list?.text).toContain("ORDER BY updated_at DESC");
    expect(list?.text).toContain("LIMIT 100");
  });

  it("get returns undefined when the conversation is not the owner's", async () => {
    const { runner } = stubRunner();
    expect(await createSqlStore(runner).get(OWNER, CONV)).toBeUndefined();
  });

  it("remove returns false when no row was deleted", async () => {
    const { runner } = stubRunner();
    expect(await createSqlStore(runner).remove(OWNER, CONV)).toBe(false);
  });
});
