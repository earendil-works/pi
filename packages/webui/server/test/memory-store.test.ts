import { describe, it, expect, afterEach, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { MemoryStore } from "../memory-store";

describe("MemoryStore", () => {
  let store: MemoryStore;
  let dbPath: string;

  function makeAtom(overrides: Partial<{
    id: string;
    type: "constraint" | "preference" | "workflow" | "knowledge" | "event" | "solution" | "insight";
    title: string;
    summary: string;
    content: string;
    tags: string[];
    importance: number;
    strength: number;
    access_count: number;
    last_access: string;
    created_at: string;
    updated_at: string;
    version: number;
    archived: boolean;
    file_path: string;
    content_hash: string;
  }> = {}): Parameters<MemoryStore["writeAtom"]>[0] {
    return {
      id: "atom-1",
      type: "knowledge",
      title: "Test Atom",
      summary: "Test summary",
      tags: ["test", "unit"],
      importance: 0.8,
      strength: 1.0,
      access_count: 0,
      last_access: "2026-01-01T00:00:00.000Z",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      version: 1,
      archived: false,
      content: "Test content here",
      file_path: "/tmp/test.md",
      content_hash: "abc123",
      ...overrides,
    };
  }

  beforeEach(() => {
    dbPath = `/tmp/test-memory-${Date.now()}-${Math.random()}.db`;
    store = new MemoryStore(dbPath);
  });

  afterEach(() => {
    store.close();
  });

  // -------------------------------------------------------------------------
  // (a) init creates tables
  // -------------------------------------------------------------------------
  it("(a) init creates the three required tables", () => {
    store.init();

    // Open same db file separately to inspect schema (hermetic: same temp file)
    const inspector = new Database(dbPath, { readonly: true });
    const tables = inspector
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    inspector.close();

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("memory_index");
    expect(tableNames).toContain("memory_fts");
    expect(tableNames).toContain("memory_embeddings");
  });

  // -------------------------------------------------------------------------
  // (b) writeAtom then readAtom returns the atom
  // -------------------------------------------------------------------------
  it("(b) writeAtom then readAtom returns the atom with all fields", () => {
    store.init();

    const atom = makeAtom();
    store.writeAtom(atom);

    const read = store.readAtom(atom.id);
    expect(read).not.toBeNull();
    expect(read!.id).toBe(atom.id);
    expect(read!.type).toBe(atom.type);
    expect(read!.title).toBe(atom.title);
    expect(read!.tags).toEqual(atom.tags);
    expect(read!.importance).toBe(atom.importance);
    expect(read!.strength).toBe(atom.strength);
    expect(read!.access_count).toBe(atom.access_count);
    expect(read!.last_access).toBe(atom.last_access);
    expect(read!.created_at).toBe(atom.created_at);
    expect(read!.updated_at).toBe(atom.updated_at);
    expect(read!.version).toBe(atom.version);
    expect(read!.archived).toBe(atom.archived);
    expect(read!.file_path).toBe(atom.file_path);
    expect(read!.content_hash).toBe(atom.content_hash);
  });

  // -------------------------------------------------------------------------
  // (c) FTS row exists after write
  // -------------------------------------------------------------------------
  it("(c) fts row exists after writeAtom", () => {
    store.init();

    const atom = makeAtom({ id: "fts-atom-1", title: "FTS Test Title", tags: ["fts", "test"] });
    store.writeAtom(atom);

    const inspector = new Database(dbPath, { readonly: true });
    const rows = inspector
      .prepare("SELECT id, title, tags FROM memory_fts WHERE id = ?")
      .all(atom.id) as { id: string; title: string; tags: string }[];
    inspector.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(atom.id);
    expect(rows[0].title).toBe(atom.title);
    expect(JSON.parse(rows[0].tags)).toEqual(atom.tags);
  });

  // -------------------------------------------------------------------------
  // (d) UPSERT with same id overwrites
  // -------------------------------------------------------------------------
  it("(d) writeAtom with same id overwrites (UPSERT)", () => {
    store.init();

    const id = "upsert-atom-1";
    store.writeAtom(makeAtom({ id, title: "Version A", content: "Content A", tags: ["a"] }));
    store.writeAtom(makeAtom({ id, title: "Version B", content: "Content B", tags: ["b", "c"] }));

    const read = store.readAtom(id);
    expect(read).not.toBeNull();
    expect(read!.title).toBe("Version B");
    expect(read!.tags).toEqual(["b", "c"]);

    // Exactly one row in memory_index for this id
    const inspector = new Database(dbPath, { readonly: true });
    const count = inspector
      .prepare("SELECT COUNT(*) as cnt FROM memory_index WHERE id = ?")
      .get(id) as { cnt: number };
    expect(count.cnt).toBe(1);

    // Exactly one row in memory_fts
    const ftsCount = inspector
      .prepare("SELECT COUNT(*) as cnt FROM memory_fts WHERE id = ?")
      .get(id) as { cnt: number };
    expect(ftsCount.cnt).toBe(1);
    inspector.close();
  });
});
