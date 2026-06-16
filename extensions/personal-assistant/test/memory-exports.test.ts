import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../sqlite.ts";
import {
  MemoryIndex,
  getAllAtoms,
  rewriteQueryWithCallLlm,
  searchAtomsWithScores,
  type MemoryAtom,
  type PersonalAssistantConfig,
} from "../memory.ts";

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

describe("searchAtomsWithScores", () => {
  let dir: string;
  let index: MemoryIndex;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "memory-scores-test-"));
    index = new MemoryIndex(join(dir, "test.db"));
    await index.init();
  });

  afterEach(() => {
    index.close();
    rmSync(dir, { recursive: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // Test-local config: explicit embedding.provider/model makes the test
  // independent of ~/.pi/agent/settings.json on the dev machine or CI runner.
  // searchAtomsWithScores forwards this to searchEmbeddings; before the
  // 4th-arg refactor the helpers hard-loaded ~/.pi/agent/settings.json, which
  // was the root cause of the level-1 review issues.
  const testConfig: PersonalAssistantConfig = {
    memory: { embedding: { provider: "local", model: "nomic-embed-text" } },
  };

  it("returns per-result fts/cosine/hybrid scores with embedding", async () => {
    // Mock the embedding HTTP endpoint so searchEmbeddings() returns a real score.
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: new Array(8).fill(0.5) }] }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    // Setup: 3 atoms, 1 with stored embedding
    const atom1 = makeAtom({ id: "a-1", title: "token alpha" });
    const atom2 = makeAtom({ id: "a-2", title: "unrelated content" });
    const atom3 = makeAtom({ id: "a-3", title: "another idea" });
    index.upsertAtom(atom1);
    index.upsertEmbedding("a-1", new Array(8).fill(0.5));
    index.upsertAtom(atom2);
    index.upsertAtom(atom3);

    const result = await searchAtomsWithScores(
      index,
      { keywords: ["token"], target_types: [], raw_query: "token" },
      5,
      testConfig,
    );

    expect(result.embedding_available).toBe(true);
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results[0].atom.id).toBe("a-1");
    expect(result.results[0].fts_score).toBeGreaterThan(0);
    expect(result.results[0].hybrid_score).toBeGreaterThan(0);
  });

  it("returns embedding_available=false and cosine_score=0 when no embeddings exist", async () => {
    // Mock fetch to throw — simulates embedding service unavailable.
    // searchEmbeddings() catches the error in getEmbedding() and returns null,
    // which makes it return an empty Map, so we go to the FTS-only branch.
    const fetchMock = vi.fn(async () => {
      throw new Error("embedding service unavailable");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    // Setup: 2 atoms, no stored embeddings
    const atom1 = makeAtom({ id: "a-1", title: "token alpha" });
    const atom2 = makeAtom({ id: "a-2", title: "token beta" });
    index.upsertAtom(atom1);
    index.upsertAtom(atom2);
    // No upsertEmbedding for either atom

    const result = await searchAtomsWithScores(
      index,
      { keywords: ["token"], target_types: [], raw_query: "token" },
      5,
      testConfig,
    );

    expect(result.embedding_available).toBe(false);
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results[0].cosine_score).toBe(0);
    expect(result.results[0].hybrid_score).toBeGreaterThan(0);
  });

  // Hermeticity guard for level-1 review fix #1:
  // On CI there is no ~/.pi/agent/settings.json with embedding.provider=local.
  // If searchEmbeddings (or its caller) still reaches into loadConfig() and
  // returns an empty config, embedding_available drops to false even though
  // the test passes a valid testConfig. This test stubs HOME to an empty
  // tmp dir, so any fallback to ~/.pi/agent/settings.json yields {} and
  // embedding_available must still be true thanks to the explicit config.
  it("drives embedding config from the passed config, not ~/.pi/agent/settings.json", async () => {
    // Force loadConfig() to see an empty HOME → ~/.pi/agent/settings.json
    // does not exist, so any fallback path yields {} (no embedding config).
    const emptyHome = mkdtempSync(join(tmpdir(), "memory-hermetic-home-"));
    vi.stubEnv("HOME", emptyHome);
    vi.stubEnv("USERPROFILE", emptyHome);

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: new Array(8).fill(0.5) }] }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const atom = makeAtom({ id: "a-1", title: "token alpha" });
    index.upsertAtom(atom);
    index.upsertEmbedding("a-1", new Array(8).fill(0.5));

    const result = await searchAtomsWithScores(
      index,
      { keywords: ["token"], target_types: [], raw_query: "token" },
      5,
      testConfig,
    );

    expect(result.embedding_available).toBe(true);
    expect(result.results[0].cosine_score).toBeGreaterThan(0);

    // Clean up the hermetic HOME dir we created.
    rmSync(emptyHome, { recursive: true });
  });
});
