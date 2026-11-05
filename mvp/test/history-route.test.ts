import { describe, expect, it, vi } from "vitest";
import { type HistoryRequest, type HistoryRouteDeps, handleHistoryRequest, historyEnabled } from "../src/history/route.ts";
import type { HistoryStore, SaveInput, StoredConversation, StoredMessage } from "../src/history/store.ts";
import type { AgentResponse } from "../src/agent/route.ts";

// Synthetic values only.
const OWNER = "owner-a";
const OTHER = "owner-b";
const URL = "postgres://synthetic-user:synthetic-pass@db.example/synthetic";
const CONV = "11111111-1111-4111-8111-111111111111";
const MSG1 = "22222222-2222-4222-8222-222222222222";
const MSG2 = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-11-05T12:00:00.000Z");

/** In-memory store keyed by owner, with the same contract as the SQL store. */
function fakeStore() {
  const conversations = new Map<string, { owner: string; c: StoredConversation; messages: StoredMessage[] }>();
  let tick = 0;
  const store: HistoryStore = {
    async list(owner) {
      return [...conversations.values()]
        .filter((e) => e.owner === owner)
        .map((e) => e.c)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },
    async get(owner, id) {
      const e = conversations.get(id);
      return e && e.owner === owner ? { conversation: e.c, messages: e.messages } : undefined;
    },
    async save(owner, input: SaveInput) {
      const existing = conversations.get(input.conversation.id);
      if (existing && existing.owner !== owner) return { owned: false, saved: 0 };
      const at = new Date(NOW + ++tick * 1000).toISOString();
      const entry = existing ?? { owner, c: { id: input.conversation.id, title: input.conversation.title, createdAt: at, updatedAt: at }, messages: [] };
      entry.c = { ...entry.c, title: input.conversation.title, updatedAt: at };
      let saved = 0;
      for (const m of input.messages) {
        if (!entry.messages.some((x) => x.id === m.id)) {
          entry.messages.push(m);
          saved += 1;
        }
      }
      conversations.set(input.conversation.id, entry);
      return { owned: true, saved };
    },
    async remove(owner, id) {
      const e = conversations.get(id);
      if (!e || e.owner !== owner) return false;
      conversations.delete(id);
      return true;
    },
  };
  return { store, conversations };
}

function makeResponse() {
  const out = { status: 0, json: undefined as unknown, headers: {} as Record<string, string> };
  const response: AgentResponse = {
    setHeader(name, value) {
      out.headers[name] = value;
    },
    status(code) {
      out.status = code;
      return {
        json(body) {
          out.json = body;
        },
      };
    },
    write() {},
    end() {},
  };
  return { out, response };
}

function makeDeps(overrides: Partial<HistoryRouteDeps> = {}, store = fakeStore().store) {
  const createStore = vi.fn((_url: string) => store);
  const log = vi.fn();
  const deps: HistoryRouteDeps = {
    env: { NLT_HISTORY_ENABLED: "1", DATABASE_URL: URL },
    owner: () => OWNER,
    createStore,
    log,
    now: () => NOW,
    ...overrides,
  };
  return { deps, createStore, log };
}

const message = (overrides: Partial<StoredMessage> = {}) => ({
  id: MSG1,
  role: "user",
  kind: "normal",
  text: "hello",
  createdAt: "2026-11-05T11:59:00.000Z",
  ...overrides,
});
const saveBody = (overrides: Record<string, unknown> = {}) => ({
  conversation: { id: CONV, title: "Synthetic title" },
  messages: [message()],
  ...overrides,
});

async function call(req: HistoryRequest, deps: HistoryRouteDeps) {
  const r = makeResponse();
  await handleHistoryRequest(req, r.response, deps);
  return r.out;
}

describe("history route", () => {
  it("404 when off, and the store is never created", async () => {
    for (const value of [undefined, "", "0", "true"]) {
      expect(historyEnabled({ NLT_HISTORY_ENABLED: value })).toBe(false);
      const { deps, createStore } = makeDeps({ env: { NLT_HISTORY_ENABLED: value, DATABASE_URL: URL } });
      expect((await call({ method: "GET" }, deps)).status).toBe(404);
      expect(createStore).not.toHaveBeenCalled();
    }
    expect(historyEnabled({ NLT_HISTORY_ENABLED: "1" })).toBe(true);
  });

  it("401 without an owner, 405 with Allow: GET, POST, DELETE for other methods", async () => {
    const anon = makeDeps({ owner: () => undefined });
    expect((await call({ method: "GET" }, anon.deps)).status).toBe(401);
    expect(anon.createStore).not.toHaveBeenCalled();
    const put = await call({ method: "PUT" }, makeDeps().deps);
    expect(put.status).toBe(405);
    expect(put.headers.Allow).toBe("GET, POST, DELETE");
  });

  it("503 when DATABASE_URL is missing while on", async () => {
    const { deps, createStore } = makeDeps({ env: { NLT_HISTORY_ENABLED: "1" } });
    const out = await call({ method: "GET" }, deps);
    expect(out.status).toBe(503);
    expect(out.json).toEqual({ error: "History unavailable" });
    expect(createStore).not.toHaveBeenCalled();
  });

  it("rejects each invalid input with 400 and writes nothing", async () => {
    const { store, conversations } = fakeStore();
    const { deps } = makeDeps({}, store);
    const bad: unknown[] = [
      saveBody({ conversation: { id: "not-a-uuid", title: "t" } }),
      saveBody({ conversation: { id: CONV, title: "   " } }),
      saveBody({ conversation: { id: CONV, title: "x".repeat(81) } }),
      saveBody({ messages: [] }),
      saveBody({ messages: Array.from({ length: 21 }, (_, i) => message({ id: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}` })) }),
      saveBody({ messages: [message({ role: "system" as never })] }),
      saveBody({ messages: [message({ kind: "info" as never })] }),
      saveBody({ messages: [message({ text: "x".repeat(20_001) })] }),
      saveBody({ messages: [message({ model: "m".repeat(201) })] }),
      saveBody({ messages: [message({ createdAt: new Date(NOW + 6 * 60_000).toISOString() })] }),
      saveBody({ messages: [message({ createdAt: "yesterday" })] }),
      saveBody({ messages: [message({ id: "nope" })] }),
      { conversation: { id: CONV, title: "t" }, messages: [message()], padding: "x".repeat(524_289) },
      "not an object",
    ];
    for (const body of bad) {
      const out = await call({ method: "POST", body }, deps);
      expect(out.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect(conversations.size).toBe(0);
  });

  it("stores a blocked message with empty text", async () => {
    const { store, conversations } = fakeStore();
    const { deps } = makeDeps({}, store);
    const out = await call({ method: "POST", body: saveBody({ messages: [message({ kind: "blocked", text: "possibly sensitive words" })] }) }, deps);
    expect(out.status).toBe(200);
    expect(conversations.get(CONV)?.messages[0]?.text).toBe("");
  });

  it("uses the session owner, never the body", async () => {
    const { store, conversations } = fakeStore();
    const { deps } = makeDeps({}, store);
    await call({ method: "POST", body: { ...saveBody(), owner_sub: OTHER, owner: OTHER } }, deps);
    expect(conversations.get(CONV)?.owner).toBe(OWNER);
  });

  it("another owner's conversation is 404 for GET ?id, POST and DELETE, and is unchanged", async () => {
    const { store, conversations } = fakeStore();
    await call({ method: "POST", body: saveBody() }, makeDeps({ owner: () => OTHER }, store).deps);
    const mine = makeDeps({}, store).deps;
    expect((await call({ method: "GET", query: { id: CONV } }, mine)).status).toBe(404);
    expect((await call({ method: "POST", body: saveBody({ conversation: { id: CONV, title: "hijack" }, messages: [message({ id: MSG2 })] }) }, mine)).status).toBe(404);
    expect((await call({ method: "DELETE", query: { id: CONV } }, mine)).status).toBe(404);
    expect(conversations.get(CONV)?.owner).toBe(OTHER);
    expect(conversations.get(CONV)?.c.title).toBe("Synthetic title");
    expect(conversations.get(CONV)?.messages.map((m) => m.id)).toEqual([MSG1]);
  });

  it("a retried save does not duplicate messages", async () => {
    const { deps } = makeDeps();
    const body = saveBody({ messages: [message(), message({ id: MSG2, role: "assistant", text: "reply" })] });
    expect((await call({ method: "POST", body }, deps)).json).toEqual({ saved: 2 });
    expect((await call({ method: "POST", body }, deps)).json).toEqual({ saved: 0 });
  });

  it("list returns newest first, and GET ?id returns the conversation with its messages", async () => {
    const { deps } = makeDeps();
    const second = "44444444-4444-4444-8444-444444444444";
    await call({ method: "POST", body: saveBody() }, deps);
    await call({ method: "POST", body: saveBody({ conversation: { id: second, title: "Second" }, messages: [message({ id: MSG2 })] }) }, deps);
    const list = (await call({ method: "GET" }, deps)).json as { conversations: { id: string }[] };
    expect(list.conversations.map((c) => c.id)).toEqual([second, CONV]);
    const one = (await call({ method: "GET", query: { id: CONV } }, deps)).json as { conversation: { id: string }; messages: { id: string }[] };
    expect(one.conversation.id).toBe(CONV);
    expect(one.messages.map((m) => m.id)).toEqual([MSG1]);
  });

  it("DELETE removes the owner's conversation; a bad id is 400", async () => {
    const { store, conversations } = fakeStore();
    const { deps } = makeDeps({}, store);
    await call({ method: "POST", body: saveBody() }, deps);
    expect((await call({ method: "DELETE", query: { id: "x" } }, deps)).status).toBe(400);
    const out = await call({ method: "DELETE", query: { id: CONV } }, deps);
    expect(out).toMatchObject({ status: 200, json: { deleted: true } });
    expect(conversations.size).toBe(0);
  });

  it("a store error is 503 and logs only the op", async () => {
    const failing: HistoryStore = {
      list: async () => {
        throw new Error(`connect failed ${URL}`);
      },
      get: async () => {
        throw new Error("boom");
      },
      save: async () => {
        throw new Error("hello in SQL");
      },
      remove: async () => {
        throw new Error("boom");
      },
    };
    const { deps, log } = makeDeps({}, failing);
    const out = await call({ method: "POST", body: saveBody() }, deps);
    expect(out).toMatchObject({ status: 503, json: { error: "History unavailable" } });
    expect(log.mock.calls).toEqual([['{"event":"history_error","op":"save"}']]);
    const listed = makeDeps({}, failing);
    await call({ method: "GET" }, listed.deps);
    expect(listed.log.mock.calls).toEqual([['{"event":"history_error","op":"list"}']]);
  });

  it("sets Cache-Control: no-store on every answer", async () => {
    const cases: [HistoryRequest, HistoryRouteDeps][] = [
      [{ method: "GET" }, makeDeps({ env: {} }).deps],
      [{ method: "GET" }, makeDeps({ owner: () => undefined }).deps],
      [{ method: "PUT" }, makeDeps().deps],
      [{ method: "POST", body: "x" }, makeDeps().deps],
      [{ method: "GET" }, makeDeps().deps],
    ];
    for (const [req, deps] of cases) expect((await call(req, deps)).headers["Cache-Control"]).toBe("no-store");
  });
});
