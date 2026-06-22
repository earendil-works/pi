// Real end-to-end test: parse session, run extraction, recall, verify
// Uses ollama bge-m3 for embeddings + qwen2.5:3b for LLM (via /api/chat
// since the 3B model needs the system role for reliable JSON output).

import { promises as fs } from "node:fs";
import path from "node:path";
import { MemoryIndex } from "./../storage.ts";
import { runMemoryExtraction } from "./../extraction.ts";
import { recallAtoms } from "./../search.ts";
import { formatMemoryContext } from "./../format.ts";

// Default to committed fixture (200 messages, ~400KB). Set
// SESSION_PATH_OVERRIDE env var to use the full 31MB session file.
const SESSION_PATH = process.env.SESSION_PATH_OVERRIDE
  ?? new URL("./fixtures/session-sample.jsonl", import.meta.url).pathname;
const DB_PATH = "/tmp/memory-v2-real/memory.db";
const ATOMS_DIR = "/tmp/memory-v2-real/atoms";
const LLM_PROVIDER = "minimax-cn";
const LLM_MODEL = "MiniMax-M3";
const LLM_BASE_URL = "https://api.minimaxi.com/anthropic";

interface SessionMsg { role: "user" | "assistant"; content: string; ts: string; }

async function loadSession(filePath: string): Promise<SessionMsg[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const out: SessionMsg[] = [];
  for (const line of lines) {
    const d = JSON.parse(line);
    if (d.type !== "message") continue;
    const msg = d.message;
    if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;
    let content = "";
    if (typeof msg.content === "string") content = msg.content;
    else if (Array.isArray(msg.content)) content = msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    if (content.trim().length > 0) {
      out.push({ role: msg.role, content, ts: msg.timestamp });
    }
  }
  return out;
}

// Real MiniMax-M3 LLM via /api/chat (uses system role for reliable JSON)
async function callOllamaChat(systemPrompt: string, userPrompt: string): Promise<string> {
  const res = await fetch(`${LLM_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.MINIMAX_CN_API_KEY || "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`MiniMax API failed: ${res.status} ${errBody.slice(0, 300)}`);
  }
  const data = (await res.json()) as { content?: Array<{ text?: string }> };
  return data.content?.[0]?.text ?? "";
}

const SYSTEM_PROMPT = `You are a memory extraction agent. From the conversation, extract knowledge worth keeping as JSON.

ATOM TYPES (only these 3):
- "rule": user preference / constraint / always-do rule
- "fact": objective fact / state / recent event
- "process": multi-step workflow / experience / solution

SCHEMA for each item:
{
  "type": "rule|fact|process",
  "title": "<= 50 chars, descriptive",
  "content": "2-4 short paragraphs, total 50-500 chars, specific details",
  "summary": "1-2 sentence summary, 5-500 chars",
  "tags": ["3-8 short tags"],
  "importance": 0.0-1.0
}

DEDUP: code handles fingerprint + cosine dedup automatically. Just emit what you see.

OUTPUT: pure JSON only. NO markdown code blocks. NO explanatory text.
- If nothing to extract: {"items": []}
- Otherwise: {"items": [{...}, {...}]}`;

async function extractChunk(messages: SessionMsg[]): Promise<{ text: string; items: number; dt: number }> {
  const t0 = Date.now();
  const messagesText = messages.map((m) => `[${m.role}] ${m.content}`).join("\n\n");
  const userPrompt = `Extract memories from these messages:\n\n${messagesText}\n\nJSON output:`;
  const response = await callOllamaChat(SYSTEM_PROMPT, userPrompt);
  return { text: response, items: 0, dt: Date.now() - t0 };
}

async function main() {
  const tStart = Date.now();
  console.log("=== Loading session ===");
  const allMessages = await loadSession(SESSION_PATH);
  console.log(`  Total user/assistant messages: ${allMessages.length}`);
  console.log(`  Date range: ${allMessages[0]?.ts} → ${allMessages[allMessages.length - 1]?.ts}`);

  // Clean previous run
  await fs.rm("/tmp/memory-v2-real", { recursive: true, force: true });
  await fs.mkdir(ATOMS_DIR, { recursive: true });

  // Take a representative window from the END of the session (most recent).
  // 60 messages = 3 chunks of 20 (simulating 3 compaction events).
  const WINDOW = 60;
  const recentMessages = allMessages.slice(-WINDOW);
  const CHUNK_SIZE = 20;
  const chunks: SessionMsg[][] = [];
  for (let i = 0; i < recentMessages.length; i += CHUNK_SIZE) {
    chunks.push(recentMessages.slice(i, i + CHUNK_SIZE));
  }
  console.log(`\n=== Plan: extract ${chunks.length} chunks of last ${WINDOW} messages (${CHUNK_SIZE}/chunk) ===`);

  let totalCreated = 0;
  let totalSkipped = 0;
  const allCreated: any[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const t0 = Date.now();
    console.log(`\n--- Chunk ${i + 1}/${chunks.length} (${chunk.length} messages) ---`);

    try {
      const result = await runMemoryExtraction({
        callLlm: (prompt) => callOllamaChat(SYSTEM_PROMPT, prompt),
        config: { model: LLM_MODEL },
        messages: chunk,
        dbPath: DB_PATH,
        atomsDir: ATOMS_DIR,
      });
      const dt = Date.now() - t0;
      console.log(`  ${dt}ms: created=${result.created.length} superseded=${result.superseded.length} skipped=${result.skipped.length}`);
      console.log(`  Plan items: ${result.plan.items.length}`);

      for (const a of result.created) {
        allCreated.push(a);
        console.log(`    + [${a.type}] ${a.title}`);
      }
      for (const a of result.skipped) {
        console.log(`    = skip ${a.title.slice(0, 60)}`);
      }
      totalCreated += result.created.length;
      totalSkipped += result.skipped.length;
    } catch (e) {
      console.log(`  ERROR: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Total created: ${totalCreated}`);
  console.log(`  Total skipped: ${totalSkipped}`);

  // Show created atoms (unique by type)
  console.log(`\n=== Unique atoms (${allCreated.length}) ===`);
  for (const a of allCreated.slice(0, 15)) {
    console.log(`\n  [${a.type}] ${a.title}`);
    console.log(`    ${a.summary}`);
    console.log(`    tags: ${a.tags.join(", ")} | importance: ${a.importance}`);
  }

  // Verify recall
  console.log(`\n=== Recall test (vector KNN) ===`);
  const queries = [
    "Skera adapter primer 截断",
    "CCA RDA DBRDA 轴标签",
    "BLAST 验证引物",
    "amplicon ITS1-5F",
  ];
  const index = new MemoryIndex(DB_PATH);
  await index.init();
  try {
    for (const q of queries) {
      const t0 = Date.now();
      const results = await recallAtoms(index, q, ATOMS_DIR, { topK: 3, threshold: 0.3 });
      const dt = Date.now() - t0;
      console.log(`\n  "${q}" (${dt}ms) → ${results.length} hits:`);
      for (const r of results) {
        console.log(`    [${r.atom.type}] ${r.atom.title} (cos=${r.cosine.toFixed(3)})`);
      }
      if (results.length > 0) {
        const formatted = formatMemoryContext(results, 300);
        console.log(`    formatted: ${formatted.text.slice(0, 200)}...`);
      }
    }
  } finally {
    index.close();
  }

  // Show .md file structure
  console.log(`\n=== .md files on disk ===`);
  const types = await fs.readdir(ATOMS_DIR);
  for (const type of types) {
    const files = await fs.readdir(path.join(ATOMS_DIR, type));
    console.log(`  ${type}/: ${files.length} files`);
  }

  // Sample one .md file
  if (types.length > 0 && (await fs.readdir(path.join(ATOMS_DIR, types[0]!))).length > 0) {
    const firstFile = (await fs.readdir(path.join(ATOMS_DIR, types[0]!)))[0]!;
    const content = await fs.readFile(path.join(ATOMS_DIR, types[0]!, firstFile), "utf8");
    console.log(`\n  Sample (${types[0]}/${firstFile.slice(0, 8)}):`);
    console.log("  " + content.split("\n").slice(0, 12).join("\n  "));
  }

  console.log(`\n=== Total: ${(Date.now() - tStart) / 1000}s ===`);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
