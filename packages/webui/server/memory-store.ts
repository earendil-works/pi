import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Types
// ============================================================================

type MemoryAtomType =
  | "constraint"
  | "preference"
  | "workflow"
  | "knowledge"
  | "event"
  | "solution"
  | "insight";

interface MemoryAtom {
  id: string;
  type: MemoryAtomType;
  title: string;
  summary: string;
  tags: string[];
  importance: number;
  strength: number;
  access_count: number;
  last_access: string;
  created_at: string;
  updated_at: string;
  version: number;
  archived: boolean;
  content: string;
  file_path: string;
  content_hash: string;
}

// ============================================================================
// MemoryStore
// ============================================================================

export class MemoryStore {
  private db: Database.Database;

  constructor(private dbPath: string = join(homedir(), ".pi", "agent", "data", "memory.db")) {
    this.db = new Database(this.dbPath);
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_index (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        importance REAL NOT NULL DEFAULT 0.5,
        strength REAL NOT NULL DEFAULT 1.0,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_access TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        archived INTEGER NOT NULL DEFAULT 0,
        file_path TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL DEFAULT ''
      )
    `);

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id,
        title,
        tags,
        tokenize='unicode61'
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        id TEXT PRIMARY KEY REFERENCES memory_index(id),
        embedding TEXT NOT NULL
      )
    `);
  }

  writeAtom(atom: MemoryAtom): void {
    // Validate and sanitize atom fields (defense-in-depth)
    const title = typeof atom.title === "string" ? atom.title.slice(0, 500) : "";
    const summary = typeof atom.summary === "string" ? atom.summary.slice(0, 500) : "";
    const content = typeof atom.content === "string" ? atom.content.slice(0, 32 * 1024) : "";
    const rawTags = Array.isArray(atom.tags) ? atom.tags : [];
    const tags = rawTags.filter((t): t is string => typeof t === "string").slice(0, 20).map((t) => t.slice(0, 50));
    let importance = typeof atom.importance === "number" ? atom.importance : 0.5;
    let strength = typeof atom.strength === "number" ? atom.strength : 1.0;
    importance = Math.max(0, Math.min(1, importance));
    strength = Math.max(0, Math.min(1, strength));

    const tagsJson = JSON.stringify(tags);
    const archivedInt = atom.archived ? 1 : 0;

    // Upsert main table
    this.db.prepare(`
      INSERT INTO memory_index (id, type, title, tags, importance, strength, access_count, last_access, created_at, updated_at, version, archived, file_path, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type=excluded.type,
        title=excluded.title,
        tags=excluded.tags,
        importance=excluded.importance,
        strength=excluded.strength,
        access_count=excluded.access_count,
        last_access=excluded.last_access,
        updated_at=excluded.updated_at,
        version=excluded.version,
        archived=excluded.archived,
        file_path=excluded.file_path,
        content_hash=excluded.content_hash
    `).run(
      atom.id, atom.type, title, tagsJson,
      importance, strength, atom.access_count,
      atom.last_access, atom.created_at, atom.updated_at,
      atom.version, archivedInt, atom.file_path, atom.content_hash,
    );

    // Upsert FTS
    this.db.prepare("DELETE FROM memory_fts WHERE id = ?").run(atom.id);
    this.db.prepare("INSERT INTO memory_fts (id, title, tags) VALUES (?, ?, ?)").run(
      atom.id, title, tagsJson,
    );
  }

  readAtom(id: string): MemoryAtom | null {
    const row = this.db.prepare("SELECT * FROM memory_index WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToAtom(row);
  }

  close(): void {
    this.db.close();
  }

  private rowToAtom(row: Record<string, unknown>): MemoryAtom {
    return {
      id: row.id as string,
      type: row.type as MemoryAtomType,
      title: row.title as string,
      summary: (row.summary as string) ?? "",
      tags: JSON.parse((row.tags as string) ?? "[]"),
      importance: row.importance as number,
      strength: row.strength as number,
      access_count: row.access_count as number,
      last_access: row.last_access as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      version: row.version as number,
      archived: (row.archived as number) === 1,
      content: (row.content as string) ?? "",
      file_path: (row.file_path as string) ?? "",
      content_hash: (row.content_hash as string) ?? "",
    };
  }
}
