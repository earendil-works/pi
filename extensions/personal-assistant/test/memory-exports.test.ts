import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryIndex, getAllAtoms, type MemoryAtom } from "../memory.ts";

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
