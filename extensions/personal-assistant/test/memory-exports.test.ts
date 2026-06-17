import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../sqlite.ts";
import {
  MemoryIndex,
  getAllAtoms,
  rewriteQueryWithCallLlm,
  searchAtomsWithScores,
  writeAtomToFile,
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

  // sdd-review CRITICAL #3: client needs to know when fallback happened.
  it("returns fallback=true when LLM throws", async () => {
    const callLlm = vi.fn().mockRejectedValue(new Error("rate limit"));
    const result = await rewriteQueryWithCallLlm(
      callLlm,
      "amplicon pipeline",
      emptyConfig,
    );
    expect(result.fallback).toBe(true);
    expect(result.keywords).toContain("amplicon");
    expect(result.raw_query).toBe("amplicon pipeline");
  });

  it("returns fallback=false when LLM parses successfully", async () => {
    const callLlm = vi.fn().mockResolvedValue(
      JSON.stringify({
        keywords: ["foo"],
        target_types: ["knowledge"],
        raw_query: "user typed this",
      }),
    );
    const result = await rewriteQueryWithCallLlm(callLlm, "user input", emptyConfig);
    expect(result.fallback).toBe(false);
    expect(result.keywords).toEqual(["foo"]);
  });

  it("returns fallback=true when LLM returns invalid JSON", async () => {
    const callLlm = vi.fn().mockResolvedValue("this is not JSON at all");
    const result = await rewriteQueryWithCallLlm(callLlm, "test", emptyConfig);
    expect(result.fallback).toBe(true);
  });

  // sdd-review HIGH #5: default raw_query to user input, not empty string.
  it("raw_query defaults to user input when LLM omits it", async () => {
    const callLlm = vi.fn().mockResolvedValue(
      JSON.stringify({ keywords: ["x"], target_types: [] }),
    );
    const result = await rewriteQueryWithCallLlm(callLlm, "my query", emptyConfig);
    expect(result.raw_query).toBe("my query");
  });

  // Regression: LLM often returns BOTH the broken-down keywords AND the
  // original phrase as a 4th keyword (e.g. ["PDF","图片","提取","图片提取"]
  // for query "pdf中图片提取"). The 4th is redundant and over-biases FTS5
  // matches. The dedupe helper drops any keyword that can be formed by
  // concatenating a subsequence of the other keywords.
  it("drops a keyword that is the concatenation of other keywords", async () => {
    const callLlm = vi.fn().mockResolvedValue(
      JSON.stringify({
        keywords: ["PDF", "图片", "提取", "图片提取"],
        target_types: ["solution", "workflow"],
      }),
    );
    const result = await rewriteQueryWithCallLlm(callLlm, "pdf中图片提取", emptyConfig);
    expect(result.keywords).toEqual(["PDF", "图片", "提取"]);
    expect(result.target_types).toEqual(["solution", "workflow"]);
    expect(result.fallback).toBe(false);
  });

  // Regression: when the LLM echoes the query verbatim as one of the
  // keywords, it's redundant with raw_query and contributes nothing to FTS5
  // beyond what the broken-down tokens already cover.
  it("drops a keyword that equals the query (case-insensitive, whitespace-normalized)", async () => {
    const callLlm = vi.fn().mockResolvedValue(
      JSON.stringify({ keywords: ["amplicon pipeline", "amplicon"], target_types: [] }),
    );
    const result = await rewriteQueryWithCallLlm(callLlm, "  Amplicon Pipeline ", emptyConfig);
    expect(result.keywords).toEqual(["amplicon"]);
  });

  // Sanity: keywords that are NOT redundant stay intact.
  it("keeps keywords that are not redundant", async () => {
    const callLlm = vi.fn().mockResolvedValue(
      JSON.stringify({ keywords: ["alpha", "beta", "gamma"], target_types: [] }),
    );
    const result = await rewriteQueryWithCallLlm(callLlm, "anything", emptyConfig);
    expect(result.keywords).toEqual(["alpha", "beta", "gamma"]);
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
      { keywords: ["token"], target_types: [], raw_query: "token", fallback: false },
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
      { keywords: ["token"], target_types: [], raw_query: "token", fallback: false },
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
      { keywords: ["token"], target_types: [], raw_query: "token", fallback: false },
      5,
      testConfig,
    );

    expect(result.embedding_available).toBe(true);
    expect(result.results[0].cosine_score).toBeGreaterThan(0);

    // Clean up the hermetic HOME dir we created.
    rmSync(emptyHome, { recursive: true });
  });
});

describe("writeAtomToFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memory-write-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("writes atom to <customBaseDir>/<type>/<slug>.md with valid frontmatter", () => {
    const customBase = join(dir, "custom-atoms");
    const atom = makeAtom({
      id: "w-1",
      type: "preference",
      title: "Use tabs not spaces",
    });
    const result = writeAtomToFile(atom, customBase);
    expect(result.filePath).toBe(join(customBase, "preference", "use-tabs-not-spaces.md"));
    expect(existsSync(result.filePath)).toBe(true);
    const content = readFileSync(result.filePath, "utf-8");
    expect(content).toContain("---");
    expect(content).toContain("title: Use tabs not spaces");
    expect(content).toContain("type: preference");
    // contentHash is sha256 hex (64 chars)
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("overwrites existing file via tmp+rename (no error on existing)", () => {
    const customBase = join(dir, "custom-atoms");
    // Title is kept the same so the slug — and therefore the file path —
    // stays identical between the two writes. writeAtomToFile derives the
    // path from slugify(title), so a PATCH that only changes summary /
    // content / updated_at / version writes to the same path and exercises
    // the tmp+rename overwrite branch.
    const atom1 = makeAtom({
      id: "w-2",
      type: "knowledge",
      title: "First version",
      summary: "v1",
      content: "body v1",
    });
    const result1 = writeAtomToFile(atom1, customBase);
    expect(existsSync(result1.filePath)).toBe(true);
    const beforeContent = readFileSync(result1.filePath, "utf-8");
    expect(beforeContent).toContain("title: First version");
    expect(beforeContent).toContain("summary: v1");

    const atom2: MemoryAtom = {
      ...atom1,
      summary: "v2 updated",
      content: "body v2",
      updated_at: new Date().toISOString(),
      version: atom1.version + 1,
    };
    expect(() => writeAtomToFile(atom2, customBase)).not.toThrow();
    // Same slug → same path; tmp+rename overwrites in place.
    expect(existsSync(result1.filePath)).toBe(true);
    const afterContent = readFileSync(result1.filePath, "utf-8");
    expect(afterContent).toContain("title: First version");
    expect(afterContent).toContain("summary: v2 updated");
    expect(afterContent).toContain("body v2");
    expect(afterContent).not.toContain("summary: v1");
  });
});
