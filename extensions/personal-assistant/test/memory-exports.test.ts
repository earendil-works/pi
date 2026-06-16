import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../sqlite.ts";
import { MemoryIndex, getAllAtoms, rewriteQueryWithCallLlm, type MemoryAtom, type PersonalAssistantConfig } from "../memory.ts";

function makeAtom(overrides: Partial<MemoryAtom> = {}): MemoryAtom {
  const ts = "2025-01-01T00:00:00.000Z";
  return {
    id: cryptoRandomId(),
    type: "knowledge",
    title: "Sample",
    summary: "Sample atom",
    tags: ["sample"],
    importance: 0.5,
    strength: 1.0,
    access_count: 0,
    last_access: ts,
    created_at: ts,
    updated_at: ts,
    version: 1,
    archived: false,
    content: "Sample atom body",
    file_path: "",
    content_hash: "",
    ...overrides,
  };
}

function cryptoRandomId(): string {
  // RFC4122 v4 — enough entropy for tests
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

describe("getAllAtoms", () => {
  let dir: string;
  let index: MemoryIndex;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "memory-test-"));
    index = new MemoryIndex(join(dir, "test.db"));
    await index.init();
  });

  afterEach(() => {
    index.close();
    rmSync(dir, { recursive: true });
  });

  it("returns all atoms including archived", () => {
    const a = makeAtom({ id: "atom-a", title: "A" });
    const b = makeAtom({ id: "atom-b", title: "B" });
    const c = makeAtom({ id: "atom-c", title: "C" });

    index.upsertAtom(a);
    index.upsertAtom(b);
    index.upsertAtom(c);
    index.markArchived("atom-b");

    const all = getAllAtoms(index);
    expect(all).toHaveLength(3);

    const ids = all.map((x: MemoryAtom) => x.id).sort();
    expect(ids).toEqual(["atom-a", "atom-b", "atom-c"]);

    const archived = all.find((x: MemoryAtom) => x.id === "atom-b");
    expect(archived?.archived).toBe(true);

    const active = all.find((x: MemoryAtom) => x.id === "atom-a");
    expect(active?.archived).toBe(false);
  });

  it("returns empty array when no atoms", () => {
    expect(getAllAtoms(index)).toEqual([]);
  });
});

describe("MemoryIndex.invalidateEmbedding", () => {
  let dir: string;
  let index: MemoryIndex;
  let dbPath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "memory-invalidate-test-"));
    dbPath = join(dir, "test.db");
    index = new MemoryIndex(dbPath);
    await index.init();
  });

  afterEach(() => {
    index.close();
    rmSync(dir, { recursive: true });
  });

  it("removes the embedding row for the given atom id", async () => {
    // Setup: insert an atom and an embedding for it
    const atom = makeAtom({ id: "test-1", title: "Test 1" });
    index.upsertAtom(atom);
    index.upsertEmbedding("test-1", new Array(8).fill(0.1));

    // Verify the embedding exists via a fresh connection
    {
      const checkDb = await createDatabase(dbPath);
      const before = checkDb
        .prepare("SELECT 1 FROM memory_embeddings WHERE id = ?")
        .get("test-1");
      expect(before).toBeDefined();
      checkDb.close();
    }

    // Act: invalidate the embedding
    index.invalidateEmbedding("test-1");

    // Assert: no row for "test-1"
    const checkDb = await createDatabase(dbPath);
    try {
      const after = checkDb
        .prepare("SELECT 1 FROM memory_embeddings WHERE id = ?")
        .get("test-1");
      expect(after).toBeUndefined();
    } finally {
      checkDb.close();
    }
  });
});

describe("rewriteQueryWithCallLlm", () => {
  const emptyConfig: PersonalAssistantConfig = {};

  it("parses LLM response with keywords array", async () => {
    const callLlm = vi
      .fn()
      .mockResolvedValue('{"keywords":["foo","bar"],"target_types":["knowledge"]}');

    const result = await rewriteQueryWithCallLlm(
      callLlm,
      "anything",
      emptyConfig,
    );

    expect(callLlm).toHaveBeenCalledTimes(1);
    expect(result.keywords).toEqual(["foo", "bar"]);
    expect(result.target_types).toEqual(["knowledge"]);
  });

  it("falls back to simpleKeywordExtraction when LLM throws", async () => {
    const callLlm = vi.fn().mockRejectedValue(new Error("rate limit"));

    const result = await rewriteQueryWithCallLlm(
      callLlm,
      "what database schema should I use",
      emptyConfig,
    );

    // simpleKeywordExtraction drops stop words and words of length <= 2.
    // "what" (stop) "database" (kept) "schema" (kept) "should" (stop) "use" (stop)
    // "database" and "schema" are the only content tokens that survive.
    expect(result.keywords).toContain("database");
    expect(result.keywords).toContain("schema");
  });
});
