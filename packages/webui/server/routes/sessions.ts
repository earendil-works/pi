import express from "express";
import { createReadStream } from "node:fs";
import { readdir, unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionPool, SessionHeader } from "../session-pool";
import { runMemoryExtraction } from "@earendil-works/pi-personal-assistant";
import type { RunMemoryExtractionOptions, PersonalAssistantConfig } from "@earendil-works/pi-personal-assistant";
import { spawnPiNewSession } from "../lib/new-session";
import { extractUsage } from "../lib/usage-parser";

export interface SessionsDeps {
  callLlm: (prompt: string) => Promise<string>;
  settings: PersonalAssistantConfig;
  /** Optional override for memory.db path (for testing) */
  dbPath?: string;
  /** Optional override for atoms directory (for testing) */
  atomsDir?: string;
}

export function mountSessionsRoutes(app: express.Express, sessionPool: SessionPool, deps?: SessionsDeps): void {
  // GET /api/sessions - list all sessions from pool
  app.get("/api/sessions", async (_req, res) => {
    try {
      const sessionsDir = sessionPool.sessionsDir;
      const sessions: Array<SessionHeader & { sessionFile: string }> = [];

      try {
        const entries = await readdir(sessionsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
            continue;
          }
          const filePath = join(sessionsDir, entry.name);
          try {
            const header = await parseSessionHeader(filePath);
            if (header?.id) {
              sessions.push({
                ...header,
                sessionFile: filePath,
              });
            }
          } catch {
            // Skip files that can't be parsed
          }
        }
      } catch {
        // Directory doesn't exist yet — return empty list
      }

      // Enrich with client-friendly fields: title, lastActive, status, messageCount
      const enriched = await Promise.all(
        sessions.map(async (s) => {
          const isRunning = sessionPool.isRunning(s.id);
          const msgCount = await countMessages(s.sessionFile);
          return {
            ...s,
            title: deriveTitle(s, sessionPool),
            lastActive: s.timestamp,
            status: isRunning ? ("running" as const) : ("idle" as const),
            messageCount: msgCount,
          };
        }),
      );
      // Sort by lastActive descending
      enriched.sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime());

      res.json(enriched);
    } catch (err) {
      console.error("Error listing sessions:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/sessions - create new session
  app.post("/api/sessions", async (req, res) => {
    try {
      const cwd = process.cwd();
      const sessionsDir = sessionPool.sessionsDir;
      const result = await spawnPiNewSession(cwd, { sessionsDir });
      res.status(200).json({
        id: result.sessionId,
        sessionFile: result.sessionFile,
      });
    } catch (err) {
      console.error("Error creating session:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/sessions/:id/messages - get paginated messages
  app.get("/api/sessions/:id/messages", async (req, res) => {
    try {
      const { id } = req.params;
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 200, 1000);
      const offset = parseInt(req.query.offset as string, 10) || 0;

      const sessionsDir = sessionPool.sessionsDir;
      const filePath = await findSessionFile(sessionsDir, id);

      if (!filePath) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      const messages = await readMessages(filePath, id, limit, offset);
      res.json(messages);
    } catch (err) {
      console.error("Error reading messages:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /api/sessions/:id - delete session after extracting memory atoms
  app.delete("/api/sessions/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const sessionsDir = sessionPool.sessionsDir;
      const filePath = await findSessionFile(sessionsDir, id);

      if (!filePath) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      // Read session content for extraction (non-blocking)
      const jsonlContent = await readFile(filePath, "utf-8");
      void extractAtomsSafely(jsonlContent, deps).catch((err) => {
        console.error("Background atom extraction failed:", err);
      });

      // Delete the session file immediately
      await unlink(filePath);

      res.json({ ok: true });
    } catch (err) {
      console.error("Error deleting session:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });
}

/**
 * Attempt memory extraction using personal-assistant's runMemoryExtraction.
 * Returns the number of atoms extracted, or 0 if extraction failed or no
 * LLM client is available. Errors are logged but never thrown so deletion
 * can proceed.
 */
async function extractAtomsSafely(jsonlContent: string, deps?: SessionsDeps): Promise<number> {
  if (!deps?.callLlm || !deps?.settings) return 0;

  try {
    // Parse JSONL and extract messages
    const messages = parseMessagesFromJsonl(jsonlContent);
    if (messages.length === 0) return 0;

    const opts: RunMemoryExtractionOptions = {
      callLlm: deps.callLlm,
      config: deps.settings,
      messages,
      dbPath: deps.dbPath,
      atomsDir: deps.atomsDir,
    };

    const result = await runMemoryExtraction(opts);
    return result.atomsWritten;
  } catch (llmErr) {
    console.warn("Memory extraction failed, proceeding with deletion:", llmErr);
    return 0;
  }
}

/**
 * Parse messages from JSONL content for memory extraction.
 * Filters to only type === "message" entries and extracts role + content.
 */
function parseMessagesFromJsonl(jsonlContent: string): Array<{ role: string; content: unknown }> {
  const lines = jsonlContent.split("\n").filter((l) => l.trim());
  // Skip header (first line)
  const messageLines = lines.slice(1);

  const messages: Array<{ role: string; content: unknown }> = [];
  for (const line of messageLines) {
    try {
      const entry = JSON.parse(line);
      // Only process 'message' entries (skip model_change, thinking_level_change, etc.)
      if (entry.type !== "message" || !entry.message) continue;

      const inner = entry.message;
      const role = inner.role;
      if (role !== "user" && role !== "assistant" && role !== "system") continue;

      messages.push({
        role,
        content: inner.content,
      });
    } catch {
      // Skip invalid JSON lines
    }
  }
  return messages;
}

async function parseSessionHeader(filePath: string): Promise<SessionHeader | undefined> {
  return new Promise((resolve) => {
    const stream = createReadStream(filePath, { encoding: "utf8", highWaterMark: 1024 });
    let settled = false;

    stream.on("data", (chunk: string | Buffer) => {
      if (settled) return;
      const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const lineEnd = str.indexOf("\n");
      if (lineEnd === -1) return;

      settled = true;
      stream.destroy();
      try {
        const header = JSON.parse(str.slice(0, lineEnd)) as SessionHeader;
        resolve(header.type === "session" ? header : undefined);
      } catch {
        resolve(undefined);
      }
    });

    stream.on("error", () => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    });

    stream.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    });
  });
}

async function findSessionFile(sessionsDir: string, sessionId: string): Promise<string | undefined> {
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const filePath = join(sessionsDir, entry.name);
      const header = await parseSessionHeader(filePath);
      if (header?.id === sessionId) {
        return filePath;
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return undefined;
}

interface Message {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  usage?: { input: number; output: number };
}

async function readMessages(
  filePath: string,
  sessionId: string,
  limit: number,
  offset: number,
): Promise<Message[]> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  // Skip header (first line)
  const messageLines = lines.slice(1);

  // Apply pagination
  const paginatedLines = messageLines.slice(offset, offset + limit);

  const messages: Message[] = [];
  for (const line of paginatedLines) {
    try {
      const entry = JSON.parse(line);
      // Only process 'message' entries (skip model_change, thinking_level_change, etc.)
      if (entry.type !== "message" || !entry.message) continue;

      const inner = entry.message;
      const role = inner.role;
      if (role !== "user" && role !== "assistant" && role !== "system") continue;

      // Extract text from content array
      let text = "";
      if (Array.isArray(inner.content)) {
        text = inner.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text ?? "")
          .join("");
      } else if (typeof inner.content === "string") {
        text = inner.content;
      }

      const msg: Message = {
        id: entry.id ?? crypto.randomUUID(),
        sessionId,
        role,
        content: text,
        timestamp: entry.timestamp ?? new Date().toISOString(),
      };

      // For assistant messages, extract usage if available
      if (role === "assistant") {
        const usage = extractUsage(line);
        if (usage) {
          msg.usage = usage;
        }
      }

      messages.push(msg);
    } catch {
      // Skip invalid JSON lines
    }
  }

  return messages;
}

/**
 * Return the session title from the JSONL header, falling back to sessionPool.
 * Returns empty string when name is not yet set (title written via RPC after first prompt).
 */
function deriveTitle(s: SessionHeader & { sessionFile: string }, sessionPool: SessionPool): string {
  return s.name ?? sessionPool.getSessionName(s.id) ?? "";
}

/**
 * Count the number of message entries in a session JSONL file.
 * Returns 0 on error.
 */
async function countMessages(sessionFile: string): Promise<number> {
  try {
    const content = await readFile(sessionFile, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    // Subtract 1 for the header line; clamp to 0
    return Math.max(0, lines.length - 1);
  } catch {
    return 0;
  }
}
