/**
 * Pi Personal Assistant Memory System
 *
 * Provides persistent memory for the Pi coding agent with:
 * - SQLite FTS5-based memory index for fast keyword search
 * - Optional Ollama embedding-based hybrid search
 * - Automatic memory extraction from conversation compaction
 * - Memory decay with importance-weighted strength reduction
 * - Query rewriting via LLM for better retrieval
 * - Memory injection into system prompt before agent start
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
}

interface PersonalAssistantConfig {
  agent?: {
    provider?: string;
    model?: string;
    thinking?: string;
    max_tokens?: number;
    temperature?: number;
  };
  subagent?: {
    provider?: string;
    model?: string;
    max_iterations?: number;
    max_parallel?: number;
  };
  memory?: {
    enabled?: boolean;
    query_rewrite?: { provider?: string; model?: string };
    extraction?: { provider?: string; model?: string };
    embedding?: { model?: string; api_base?: string };
    decay?: { base_decay?: number; archive_threshold?: number };
    injection?: { max_count?: number };
  };
  persona?: {
    soul_path?: string;
    user_path?: string;
  };
}

interface SearchResult {
  atom: MemoryAtom;
  score: number;
}

interface QueryRewriteResult {
  keywords: string[];
  target_types: string[];
}

interface ExtractionPlanItem {
  action: "create" | "update" | "skip";
  type?: MemoryAtomType;
  title?: string;
  summary?: string;
  tags?: string[];
  importance?: number;
  id?: string;
  changes?: Partial<Pick<MemoryAtom, "title" | "summary" | "tags" | "importance" | "content">>;
}

interface ExtractionPlan {
  plan: ExtractionPlanItem[];
}

// ============================================================================
// Constants
// ============================================================================

const PI_DIR = join(homedir(), ".pi");
const AGENT_DIR = join(PI_DIR, "agent");
const SETTINGS_PATH = join(AGENT_DIR, "settings.json");
const DATA_DIR = join(AGENT_DIR, "data");
const MEMORY_DB_PATH = join(DATA_DIR, "memory.db");
const ATOMS_DIR = join(DATA_DIR, "memory", "atoms");
const REPORTS_DIR = join(DATA_DIR, "memory", "reports");

const DEFAULT_BASE_DECAY = 0.05;
const DEFAULT_ARCHIVE_THRESHOLD = 0.15;
const DEFAULT_MAX_INJECTION = 10;
const DECAY_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "must",
  "ought",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "him",
  "his",
  "she",
  "her",
  "it",
  "its",
  "they",
  "them",
  "their",
  "this",
  "that",
  "these",
  "those",
  "what",
  "which",
  "who",
  "whom",
  "when",
  "where",
  "why",
  "how",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "because",
  "as",
  "until",
  "while",
  "of",
  "at",
  "by",
  "for",
  "with",
  "about",
  "against",
  "between",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "to",
  "from",
  "up",
  "down",
  "in",
  "out",
  "on",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "and",
  "but",
  "or",
  "nor",
  "if",
  "else",
  "also",
  "just",
  "like",
  "get",
  "got",
  "make",
  "made",
  "use",
  "used",
  "using",
  "want",
  "know",
  "think",
  "see",
  "look",
  "come",
  "go",
  "take",
  "give",
  "say",
  "said",
  "tell",
  "told",
  "ask",
  "asked",
  "try",
  "tried",
  "put",
  "set",
  "let",
  "keep",
  "kept",
  "seem",
  "run",
  "show",
  "help",
  // Chinese stop words
  "的", "了", "是", "在", "我", "你", "他", "她", "它",
  "们", "这", "那", "和", "与", "或", "就", "也", "还",
  "有", "没", "对", "到", "从", "被", "把", "让", "给",
  "为", "做", "能", "会", "要", "可", "以", "但", "而",
  "所", "如", "之", "上", "下", "中", "前", "后", "里",
  "什么", "怎么", "如何", "哪些", "这些", "那些", "这个", "那个",
  "没有", "可以", "应该", "能够", "需要", "因为", "所以", "如果",
  "但是", "而且", "虽然", "然后", "已经", "正在", "还是", "就是",
]);

const ATOM_TYPE_ORDER: MemoryAtomType[] = [
  "constraint",
  "preference",
  "workflow",
  "knowledge",
  "event",
  "solution",
  "insight",
];

// ============================================================================
// Config Loading
// ============================================================================

function loadConfig(): PersonalAssistantConfig {
  try {
    if (!existsSync(SETTINGS_PATH)) return {};
    const raw = readFileSync(SETTINGS_PATH, "utf-8");
    const settings = JSON.parse(raw);
    return (settings?.personalAssistant ?? {}) as PersonalAssistantConfig;
  } catch {
    return {};
  }
}

function getMemoryConfig(config: PersonalAssistantConfig) {
  return {
    enabled: config.memory?.enabled !== false,
    queryRewriteProvider: config.memory?.query_rewrite?.provider,
    queryRewriteModel: config.memory?.query_rewrite?.model,
    extractionProvider: config.memory?.extraction?.provider,
    extractionModel: config.memory?.extraction?.model,
    embeddingModel: config.memory?.embedding?.model,
    embeddingApiBase: config.memory?.embedding?.api_base,
    baseDecay: config.memory?.decay?.base_decay ?? DEFAULT_BASE_DECAY,
    archiveThreshold: config.memory?.decay?.archive_threshold ?? DEFAULT_ARCHIVE_THRESHOLD,
    maxInjection: config.memory?.injection?.max_count ?? DEFAULT_MAX_INJECTION,
  };
}

// ============================================================================
// Utility
// ============================================================================

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function nowISO(): string {
  return new Date().toISOString();
}

function daysBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / (1000 * 60 * 60 * 24);
}

function slugify(title: string): string {
  // Check for non-ASCII characters
  if (/[^\x00-\x7F]/.test(title)) {
    // Use first 8 hex chars of MD5 hash
    return createHash("md5").update(title).digest("hex").slice(0, 8);
  }
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatMessagesForLLM(messages: Array<{ role: string; content: unknown }>): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      parts.push(`[${msg.role}]: ${msg.content}`);
    } else if (Array.isArray(msg.content)) {
      const textParts = msg.content
        .filter((c: unknown): c is { type: string; text: string } => {
          return typeof c === "object" && c !== null && "type" in c && "text" in c && (c as { type: string }).type === "text";
        })
        .map((c) => c.text);
      if (textParts.length > 0) {
        parts.push(`[${msg.role}]: ${textParts.join("\n")}`);
      }
    }
  }
  return parts.join("\n\n");
}

// ============================================================================
// MemoryIndex — SQLite FTS5
// ============================================================================

class MemoryIndex {
  private db: InstanceType<typeof DatabaseSync> | null = null;

  constructor(private dbPath: string) {}

  init(): void {
    ensureDir(join(this.dbPath, ".."));
    this.db = new DatabaseSync(this.dbPath);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_index (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        importance REAL NOT NULL DEFAULT 0.5,
        strength REAL NOT NULL DEFAULT 1.0,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_access TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        archived INTEGER NOT NULL DEFAULT 0
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
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private ensureDb(): InstanceType<typeof DatabaseSync> {
    if (!this.db) throw new Error("MemoryIndex not initialized");
    return this.db;
  }

  upsertAtom(atom: MemoryAtom): void {
    const db = this.ensureDb();
    const tagsJson = JSON.stringify(atom.tags);
    const archivedInt = atom.archived ? 1 : 0;
    const ts = nowISO();

    // Upsert main table
    db.prepare(`
      INSERT INTO memory_index (id, type, title, summary, tags, importance, strength, access_count, last_access, created_at, updated_at, version, archived)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type=excluded.type,
        title=excluded.title,
        summary=excluded.summary,
        tags=excluded.tags,
        importance=excluded.importance,
        strength=excluded.strength,
        access_count=excluded.access_count,
        last_access=excluded.last_access,
        updated_at=excluded.updated_at,
        version=excluded.version,
        archived=excluded.archived
    `).run(
      atom.id, atom.type, atom.title, atom.summary, tagsJson,
      atom.importance, atom.strength, atom.access_count,
      atom.last_access, atom.created_at, atom.updated_at,
      atom.version, archivedInt,
    );

    // Upsert FTS
    db.prepare("DELETE FROM memory_fts WHERE id = ?").run(atom.id);
    db.prepare("INSERT INTO memory_fts (id, title, tags) VALUES (?, ?, ?)").run(
      atom.id, atom.title, tagsJson,
    );
  }

  getAtom(id: string): MemoryAtom | null {
    const db = this.ensureDb();
    const row = db.prepare("SELECT * FROM memory_index WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToAtom(row);
  }

  getActiveAtoms(): MemoryAtom[] {
    const db = this.ensureDb();
    const rows = db.prepare("SELECT * FROM memory_index WHERE archived = 0").all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToAtom(r));
  }

  getAtomsByType(type: MemoryAtomType): MemoryAtom[] {
    const db = this.ensureDb();
    const rows = db.prepare("SELECT * FROM memory_index WHERE type = ? AND archived = 0").all(type) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToAtom(r));
  }

  updateAccess(id: string): void {
    const db = this.ensureDb();
    db.prepare("UPDATE memory_index SET access_count = access_count + 1, last_access = ? WHERE id = ?").run(nowISO(), id);
  }

  updateStrength(id: string, strength: number): void {
    const db = this.ensureDb();
    db.prepare("UPDATE memory_index SET strength = ?, updated_at = ? WHERE id = ?").run(strength, nowISO(), id);
  }

  markArchived(id: string): void {
    const db = this.ensureDb();
    db.prepare("UPDATE memory_index SET archived = 1, updated_at = ? WHERE id = ?").run(nowISO(), id);
  }

  searchByFts(
    keywords: string[],
    typeFilter?: string,
    limit: number = 20,
  ): Array<{ id: string; score: number }> {
    const db = this.ensureDb();

    // Build FTS5 MATCH query — quote each keyword for safety
    const matchQuery = keywords.map((k) => `"${k.replace(/"/g, '""')}"`).join(" OR ");

    let sql: string;
    let params: unknown[];
    if (typeFilter) {
      sql = `
        SELECT f.id, bm25(memory_fts) as score
        FROM memory_fts f
        JOIN memory_index m ON m.id = f.id
        WHERE memory_fts MATCH ?
          AND m.type = ?
          AND m.archived = 0
        ORDER BY bm25(memory_fts)
        LIMIT ?
      `;
      params = [matchQuery, typeFilter, limit];
    } else {
      sql = `
        SELECT f.id, bm25(memory_fts) as score
        FROM memory_fts f
        JOIN memory_index m ON m.id = f.id
        WHERE memory_fts MATCH ?
          AND m.archived = 0
        ORDER BY bm25(memory_fts)
        LIMIT ?
      `;
      params = [matchQuery, limit];
    }

    try {
      const rows = db.prepare(sql).all(...params) as Array<{ id: string; score: number }>;
      return rows.map((r) => ({ id: r.id, score: Math.abs(r.score) }));
    } catch {
      return [];
    }
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
      content: "",
    };
  }
}

// ============================================================================
// Atom File Storage
// ============================================================================

function readAtomFromFile(type: MemoryAtomType, slug: string): MemoryAtom | null {
  const filePath = join(ATOMS_DIR, type, `${slug}.md`);
  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, "utf-8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1];
  const content = match[2];

  const fields: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    fields[key] = val;
  }

  let tags: string[] = [];
  if (fields.tags) {
    const tagsStr = fields.tags;
    if (tagsStr.startsWith("[") && tagsStr.endsWith("]")) {
      tags = tagsStr
        .slice(1, -1)
        .split(",")
        .map((t) => t.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
  }

  return {
    id: fields.id ?? "",
    type: (fields.type as MemoryAtomType) ?? type,
    title: fields.title ?? "",
    summary: fields.summary ?? "",
    tags,
    importance: parseFloat(fields.importance ?? "0.5"),
    strength: parseFloat(fields.strength ?? "1.0"),
    access_count: parseInt(fields.access_count ?? "0", 10),
    last_access: fields.last_access ?? nowISO(),
    created_at: fields.created_at ?? nowISO(),
    updated_at: fields.updated_at ?? nowISO(),
    version: parseInt(fields.version ?? "1", 10),
    archived: fields.archived === "true",
    content: content.trim(),
  };
}

function writeAtomToFile(atom: MemoryAtom): void {
  const dir = join(ATOMS_DIR, atom.type);
  ensureDir(dir);

  const slug = slugify(atom.title);
  const filePath = join(dir, `${slug}.md`);

  const tagsStr = `[${atom.tags.map((t) => `"${t}"`).join(", ")}]`;

  const frontmatter = [
    "---",
    `id: ${atom.id}`,
    `type: ${atom.type}`,
    `title: ${atom.title}`,
    `summary: ${atom.summary}`,
    `tags: ${tagsStr}`,
    `importance: ${atom.importance}`,
    `strength: ${atom.strength}`,
    `access_count: ${atom.access_count}`,
    `last_access: ${atom.last_access}`,
    `created_at: ${atom.created_at}`,
    `updated_at: ${atom.updated_at}`,
    `version: ${atom.version}`,
    `archived: ${atom.archived}`,
    "---",
  ].join("\n");

  const body = atom.content || atom.summary;
  writeFileSync(filePath, `${frontmatter}\n\n${body}\n`, "utf-8");
}

// ============================================================================
// Query Rewriter
// ============================================================================

function simpleKeywordExtraction(query: string): QueryRewriteResult {
  // Extract Chinese words (2+ characters) and English words (>2 chars)
  const chineseWords = query.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const englishWords = query
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const all = [...chineseWords, ...englishWords];
  const unique = [...new Set(all)];
  return {
    keywords: unique.slice(0, 10),
    target_types: [],
  };
}

async function rewriteQuery(
  query: string,
  ctx: ExtensionContext,
  config: PersonalAssistantConfig,
): Promise<QueryRewriteResult> {
  const memConfig = getMemoryConfig(config);

  // Try LLM-based rewriting if model is available
  const model = ctx.model;
  if (!model) return simpleKeywordExtraction(query);

  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) return simpleKeywordExtraction(query);

    const prompt = `You are a query rewriting assistant. Given a user query, extract keywords and suggest which memory atom types would be most relevant.

Memory atom types:
- constraint: Hard requirements or rules
- preference: User preferences and style choices
- workflow: Process and workflow patterns
- knowledge: Facts, knowledge, and information
- event: Past events and interactions
- solution: Solutions to problems
- insight: Insights and observations

Respond with ONLY valid JSON in this exact format:
{"keywords": ["keyword1", "keyword2"], "target_types": ["type1", "type2"]}

If no specific types seem relevant, use an empty array for target_types.
Extract 3-8 meaningful keywords. Remove stop words and focus on content words.

User query: ${query}`;

    const result = await completeSimple(model, { messages: [{ role: "user", content: prompt }] }, {
      maxTokens: 256,
      apiKey: auth.apiKey,
      headers: auth.headers,
    });

    const text = extractAssistantText(result);
    if (!text) return simpleKeywordExtraction(query);

    // Try to parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return simpleKeywordExtraction(query);

    const parsed = JSON.parse(jsonMatch[0]);
    if (Array.isArray(parsed.keywords) && parsed.keywords.length > 0) {
      return {
        keywords: parsed.keywords.filter((k: unknown) => typeof k === "string").slice(0, 10),
        target_types: Array.isArray(parsed.target_types)
          ? parsed.target_types.filter((t: unknown) => ATOM_TYPE_ORDER.includes(t as MemoryAtomType))
          : [],
      };
    }
  } catch {
    // Fall through to simple extraction
  }

  return simpleKeywordExtraction(query);
}

// ============================================================================
// LLM Helpers
// ============================================================================

function extractAssistantText(result: { content?: Array<{ type: string; text?: string; thinking?: string }> }): string | null {
  if (!result.content) return null;
  const textParts = result.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string);
  return textParts.length > 0 ? textParts.join("") : null;
}

// ============================================================================
// Memory Search
// ============================================================================

async function searchMemory(
  index: MemoryIndex,
  query: string,
  ctx: ExtensionContext,
  config: PersonalAssistantConfig,
  topK: number,
): Promise<MemoryAtom[]> {
  // Fast keyword extraction — no LLM call needed
  const rewritten = simpleKeywordExtraction(query);
  return searchAtoms(index, rewritten, topK);
}

async function searchAtoms(index: MemoryIndex, query: QueryRewriteResult, topK: number): Promise<MemoryAtom[]> {
  const candidates: Array<{ atom: MemoryAtom; score: number }> = [];

  if (query.keywords.length > 0) {
    // FTS5 search
    const ftsResults = index.searchByFts(query.keywords, query.target_types);
    if (ftsResults.length === 0) return [];

    // Try embedding search if available
    const embeddingResults = await searchEmbeddings(index, query.raw_query || query.keywords.join(" "), ftsResults.map(r => r.id));

    if (embeddingResults.size > 0) {
      const maxFts = Math.max(...ftsResults.map(r => Math.abs(r.score)));
      const maxEmb = Math.max(...Array.from(embeddingResults.values()));
      const ftsRange = maxFts > 0 ? maxFts : 1;
      const embRange = maxEmb > 0 ? maxEmb : 1;

      for (const fts of ftsResults) {
        const ftsNorm = Math.abs(fts.score) / ftsRange;
        const cosScore = embeddingResults.get(fts.id) ?? 0;
        const cosNorm = cosScore / embRange;
        const atomData = index.getAtom(fts.id);
        if (!atomData) continue;
        const hybrid = (0.5 * ftsNorm + 0.5 * cosNorm) * (0.5 + 0.3 * atomData.strength + 0.2 * atomData.importance);
        candidates.push({ atom: atomData, score: hybrid });
      }
    } else {
      // FTS-only scoring
      for (const fts of ftsResults) {
        const atomData = index.getAtom(fts.id);
        if (!atomData) continue;
        const score = Math.abs(fts.score) * (0.5 + 0.3 * atomData.strength + 0.2 * atomData.importance);
        candidates.push({ atom: atomData, score });
      }
    }
  } else {
    // No keywords — rank by type filter + strength + importance
    let atoms = index.getActiveAtoms();
    if (query.target_types.length > 0) {
      const typeSet = new Set(query.target_types);
      atoms = atoms.filter((a) => typeSet.has(a.type));
    }
    for (const atom of atoms) {
      candidates.push({ atom, score: 0.5 + 0.3 * atom.strength + 0.2 * atom.importance });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const results = candidates.slice(0, topK);

  // Update access stats
  for (const r of results) {
    index.updateAccess(r.atom.id);
  }

  return results.map(r => r.atom);
}

async function getEmbedding(text: string, apiBase: string, model: string): Promise<number[] | null> {
  try {
    const resp = await fetch(`${apiBase}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { data?: Array<{ embedding?: number[] }> };
    return data?.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ============================================================================
// Decay Logic
// ============================================================================

function runDecay(
  index: MemoryIndex,
  baseDecay: number,
  archiveThreshold: number,
): void {
  const atoms = index.getActiveAtoms();
  const now = nowISO();

  for (const atom of atoms) {
    const deltaDays = daysBetween(atom.last_access, now);
    if (deltaDays <= 0) continue;

    const lambda = baseDecay * (1 - atom.importance);
    const denom = 1 + 0.3 * Math.log(1 + atom.access_count + 2);
    const newStrength = atom.strength * Math.exp((-lambda * deltaDays) / denom);

    index.updateStrength(atom.id, newStrength);

    // Archive weak non-constraint atoms
    if (atom.type !== "constraint" && newStrength < archiveThreshold) {
      index.markArchived(atom.id);
    }
  }
}

// ============================================================================
// Memory Extraction
// ============================================================================

function extractKeywordsFromMessages(messages: Array<{ role: string; content: unknown }>): string[] {
  const allText = messages
    .map((m) => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter((c: unknown): c is { type: string; text: string } => {
            return typeof c === "object" && c !== null && "type" in c && "text" in c && (c as { type: string }).type === "text";
          })
          .map((c) => c.text)
          .join(" ");
      }
      return "";
    })
    .join(" ");

  return allText
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

async function extractMemories(
  messages: Array<{ role: string; content: unknown }>,
  index: MemoryIndex,
  ctx: ExtensionContext,
  config: PersonalAssistantConfig,
): Promise<void> {
  const memConfig = getMemoryConfig(config);
  const model = ctx.model;
  if (!model) return;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return;

  // Search for existing atoms that might be relevant
  const keywords = extractKeywordsFromMessages(messages);
  const existingAtoms = keywords.length > 0
    ? index.searchByFts(keywords.slice(0, 5), undefined, 5).map((r) => index.getAtom(r.id)).filter(Boolean)
    : [];

  const formattedMessages = formatMessagesForLLM(messages);
  const formattedAtoms = existingAtoms
    .map((a) => `- [${a!.id}] (${a!.type}) ${a!.title}: ${a!.summary}`)
    .join("\n");

  const extractPrompt = `You are a memory extraction assistant. Analyze the following conversation and identify important information that should be saved as memory atoms.

Memory atom types:
- constraint: Hard requirements or rules the user has set
- preference: User preferences and style choices
- workflow: Process and workflow patterns
- knowledge: Facts, knowledge, and information learned
- event: Important events or interactions
- solution: Solutions to problems that were found
- insight: Insights and observations

For each memory to create or update, provide:
- action: "create" (new atom), "update" (modify existing), or "skip" (not worth saving)
- type: the atom type (required for create)
- title: short descriptive title (required for create)
- summary: one-sentence summary
- tags: array of relevant tags
- importance: 0.0 to 1.0 (how critical is this to remember)
- id: existing atom ID (required for update)
- changes: object with fields to update (required for update)

Existing atoms for reference:
${formattedAtoms || "(none)"}

Conversation:
${formattedMessages.slice(0, 8000)}

Respond with ONLY valid JSON:
{"plan": [{"action": "create"|"update"|"skip", ...}]}

Only create atoms for genuinely important information. Skip routine conversation.`;

  try {
    const result = await completeSimple(model, { messages: [{ role: "user", content: extractPrompt }] }, {
      maxTokens: 2048,
      apiKey: auth.apiKey,
      headers: auth.headers,
    });

    const text = extractAssistantText(result);
    if (!text) return;

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const plan: ExtractionPlan = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(plan.plan)) return;

    // Write extraction report
    writeExtractionReport(plan.plan);

    // Execute the plan
    for (const item of plan.plan) {
      if (item.action === "skip") continue;

      if (item.action === "create" && item.type && item.title) {
        const atom: MemoryAtom = {
          id: randomUUID(),
          type: item.type,
          title: item.title,
          summary: item.summary ?? item.title,
          tags: Array.isArray(item.tags) ? item.tags : [],
          importance: item.importance ?? 0.5,
          strength: 1.0,
          access_count: 0,
          last_access: nowISO(),
          created_at: nowISO(),
          updated_at: nowISO(),
          version: 1,
          archived: false,
          content: item.summary ?? item.title,
        };
        index.upsertAtom(atom);
        writeAtomToFile(atom);
      }

      if (item.action === "update" && item.id && item.changes) {
        const existing = index.getAtom(item.id);
        if (!existing) continue;

        const updated: MemoryAtom = {
          ...existing,
          ...item.changes,
          updated_at: nowISO(),
          version: existing.version + 1,
        };
        index.upsertAtom(updated);
        writeAtomToFile(updated);
      }
    }
  } catch {
    // Extraction failed silently — don't disrupt compaction
  }
}

function writeExtractionReport(plan: ExtractionPlanItem[]): void {
  ensureDir(REPORTS_DIR);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = join(REPORTS_DIR, `extract-${ts}.md`);

  const lines = [
    `# Memory Extraction Report`,
    ``,
    `**Date:** ${nowISO()}`,
    ``,
    `## Plan`,
    ``,
  ];

  for (const item of plan) {
    if (item.action === "skip") {
      lines.push(`- **skip**`);
    } else if (item.action === "create") {
      lines.push(`- **create** (${item.type}) "${item.title}" — ${item.summary ?? ""}`);
      lines.push(`  - importance: ${item.importance ?? 0.5}`);
      lines.push(`  - tags: ${(item.tags ?? []).join(", ")}`);
    } else if (item.action === "update") {
      lines.push(`- **update** [${item.id}] — ${JSON.stringify(item.changes)}`);
    }
  }

  writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

// ============================================================================
// Persona Injection
// ============================================================================

function loadPersonaPrompt(config: PersonalAssistantConfig): string {
  const parts: string[] = [];

  const soulPath = config.persona?.soul_path ?? join(AGENT_DIR, "SOUL.md");
  const userPath = config.persona?.user_path ?? join(AGENT_DIR, "USER.md");

  if (existsSync(soulPath)) {
    try {
      const soul = readFileSync(soulPath, "utf-8").trim();
      if (soul) parts.push(`<soul>\n${soul}\n</soul>`);
    } catch {
      // ignore read errors
    }
  }

  if (existsSync(userPath)) {
    try {
      const user = readFileSync(userPath, "utf-8").trim();
      if (user) parts.push(`<user-context>\n${user}\n</user-context>`);
    } catch {
      // ignore read errors
    }
  }

  if (parts.length === 0) return "";

  return `\n\n## Persona\n\n${parts.join("\n\n")}`;
}

// ============================================================================
// Memory Context Formatting
// ============================================================================

function formatMemoryContext(results: SearchResult[]): string {
  if (results.length === 0) return "";

  const sections: string[] = [];

  for (const result of results) {
    const { atom } = result;
    const tagsStr = atom.tags.length > 0 ? ` [${atom.tags.join(", ")}]` : "";
    sections.push(
      `<memory type="${atom.type}" importance="${atom.importance.toFixed(2)}" strength="${atom.strength.toFixed(2)}">` +
        `\n  <title>${escapeXml(atom.title)}</title>` +
        `\n  <summary>${escapeXml(atom.summary)}</summary>` +
        (tagsStr ? `\n  <tags>${escapeXml(atom.tags.join(", "))}</tags>` : "") +
        `\n</memory>`,
    );
  }

  return `<memory-context>\n${sections.join("\n")}\n</memory-context>`;
}

// ============================================================================
// Main Registration
// ============================================================================

export function registerMemory(pi: ExtensionAPI): void {
  let memoryIndex: MemoryIndex | null = null;
  let lastDecayCheck = 0;

  function getIndex(): MemoryIndex | null {
    if (!memoryIndex) {
      try {
        memoryIndex = new MemoryIndex(MEMORY_DB_PATH);
        memoryIndex.init();
      } catch {
        return null;
      }
    }
    return memoryIndex;
  }

  // --- session_start: decay + persona ---
  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig();
    const memConfig = getMemoryConfig(config);

    if (!memConfig.enabled) return;

    const index = getIndex();
    if (!index) return;

    // Run decay if enough time has passed
    const now = Date.now();
    if (now - lastDecayCheck > DECAY_CHECK_INTERVAL_MS) {
      try {
        runDecay(index, memConfig.baseDecay, memConfig.archiveThreshold);
        lastDecayCheck = now;
      } catch {
        // Don't let decay errors break session start
      }
    }
  });

  // --- before_agent_start: inject persona fast, kick off async memory search ---

  // Shared promise for memory search started in before_agent_start,
  // awaited in context handler so it doesn't block TUI rendering.
  let pendingMemorySearch:
    | { promise: Promise<MemoryAtom[]>; timestamp: number }
    | undefined;

  pi.on("before_agent_start", async (event, ctx) => {
    const config = loadConfig();
    const memConfig = getMemoryConfig(config);
    if (!memConfig.enabled) return;

    let systemPrompt = event.systemPrompt;

    // Inject persona (fast file read, no LLM call)
    const persona = loadPersonaPrompt(config);
    if (persona) {
      systemPrompt += persona;
    }

    // Kick off async memory search — don't await, store promise for context handler
    const prompt = event.prompt.trim();
    if (prompt) {
      const index = getIndex();
      if (index) {
        const searchPromise = searchMemory(index, prompt, ctx, config, memConfig.maxInjection);
        pendingMemorySearch = { promise: searchPromise, timestamp: Date.now() };
        searchPromise.catch(() => { /* don't crash */ });
      }
    }

    return { systemPrompt };
  });

  // --- context: inject memory context before first LLM call ---
  pi.on("context" as any, async (event: { messages: unknown[] }, ctx: ExtensionContext) => {
    if (!pendingMemorySearch) return;
    const ps = pendingMemorySearch;
    pendingMemorySearch = undefined;

    try {
      const results = await Promise.race([
        ps.promise,
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error("memory search timeout")), 8000),
        ),
      ]);

      if (!results || results.length === 0) {
        if (ctx.hasUI) {
          ctx.ui.setStatus("memory", undefined);
        }
        return;
      }

      const memoryBlock = formatMemoryContext(results);
      if (!memoryBlock) {
        if (ctx.hasUI) {
          ctx.ui.setStatus("memory", undefined);
        }
        return;
      }

      // Show memory retrieval details in TUI
      if (ctx.hasUI) {
        const typeCounts = new Map<string, number>();
        for (const r of results) {
          typeCounts.set(r.type, (typeCounts.get(r.type) ?? 0) + 1);
        }
        const detail = Array.from(typeCounts.entries())
          .map(([t, n]) => `${t}(${n})`)
          .join(" ");
        ctx.ui.setStatus("memory", `mem: ${results.length} [${detail}]`);
      }

      // Inject memory context into the last user message
      for (let i = event.messages.length - 1; i >= 0; i--) {
        const msg = event.messages[i] as Record<string, unknown>;
        if (msg.role === "user" && typeof msg.content === "string") {
          msg.content = `${memoryBlock}\n\n${msg.content}`;
          break;
        }
      }
    } catch {
      // Memory search timed out or failed — proceed without context
      if (ctx.hasUI) {
        ctx.ui.setStatus("memory", undefined);
      }
    }
  });

  // --- session_before_compact: extract memories ---
  pi.on("session_before_compact", async (event, ctx) => {
    const config = loadConfig();
    const memConfig = getMemoryConfig(config);

    if (!memConfig.enabled) return;

    const index = getIndex();
    if (!index) return;

    // Extract memories from messages being compacted
    const messages = event.preparation.messagesToSummarize;
    if (messages.length === 0) return;

    try {
      await extractMemories(
        messages as Array<{ role: string; content: unknown }>,
        index,
        ctx,
        config,
      );
    } catch {
      // Don't let extraction errors block compaction
    }
  });
}
