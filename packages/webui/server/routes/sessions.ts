import express from "express";
import { createReadStream } from "node:fs";
import { readdir, unlink, readFile, stat } from "node:fs/promises";
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
          // A session is webui-managed if (a) the persisted owned set says
          // so, or (b) it has 0 messages — a session with 0 messages can't
          // be actively in use by either TUI or webui yet, and the only way
          // to create a session in this directory is via webui (TUI uses
          // its own cwd). So 0-message sessions are safe to mark as
          // webui-owned.
          const isManaged =
            sessionPool.isSessionManaged(s.id) || msgCount === 0;
          // Read the file's mtime to know when the session was last touched.
          // The header's `timestamp` is the creation time, which is stale for
          // TUI sessions that the server never spawned. For TUI sessions the
          // file grows in real time; for webui sessions the server can update
          // the title via RPC, but mtime is also a reliable proxy.
          let lastActive = s.timestamp;
          try {
            const st = await stat(s.sessionFile);
            lastActive = st.mtime.toISOString();
          } catch {
            // File unreadable; fall back to header timestamp
          }
          // TUI sessions are detected by filename pattern:
          // TUI = "<ISO timestamp>_<uuid>.jsonl", webui = "<uuid>.jsonl".
          const source: "tui" | "webui" = isTuiSession(s.sessionFile)
            ? "tui"
            : "webui";
          return {
            ...s,
            title: await deriveTitle(s, sessionPool),
            lastActive,
            status: isRunning ? ("running" as const) : ("idle" as const),
            messageCount: msgCount,
            isManaged,
            source,
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
      // Mark as webui-owned so the UI input is enabled before the first prompt
      // arrives. The actual pi process is spawned lazily on the first prompt.
      sessionPool.markSessionOwned(result.sessionId);

      // Return SessionInfo shape (matches listSessions output) so the client
      // can append the new session to the sidebar without a refetch.
      res.status(200).json({
        id: result.sessionId,
        sessionFile: result.sessionFile,
        title: "",
        status: "idle",
        lastActive: new Date().toISOString(),
        messageCount: 0,
        isManaged: true,
      });
    } catch (err) {
      console.error("Error creating session:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/sessions/:id/messages - get paginated messages
  // By default returns the LATEST `limit` messages, not the earliest. This
  // matches the expected chat behavior: opening a session shows you the
  // bottom of the conversation, not the top. Pass `offset` (>= 0, from
  // the start of the messages array) to paginate backwards through older
  // history. Pass `tail=0` to opt into the old "first N from the start"
  // behavior for backwards compatibility with any client that wants it.
  app.get("/api/sessions/:id/messages", async (req, res) => {
    try {
      const { id } = req.params;
      const tail = req.query.tail !== "0";
      const explicitLimit = parseInt(req.query.limit as string, 10);
      const limit = Math.min(Number.isFinite(explicitLimit) ? explicitLimit : 200, 1000);
      const explicitOffset = parseInt(req.query.offset as string, 10);
      const hasExplicitOffset = Number.isFinite(explicitOffset);

      const sessionsDir = sessionPool.sessionsDir;
      const filePath = await findSessionFile(sessionsDir, id);

      if (!filePath) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      // For tail mode we need the total message count to compute the
      // offset. For explicit-offset mode we can skip the second read.
      let messages: Message[];
      if (tail && !hasExplicitOffset) {
        const total = await countMessages(filePath);
        // Total counts the body lines (header subtracted). readMessages
        // also subtracts the header, so the same indexing applies.
        const start = Math.max(0, total - limit);
        messages = await readMessages(filePath, id, limit, start);
      } else {
        const offset = hasExplicitOffset ? explicitOffset : 0;
        messages = await readMessages(filePath, id, limit, offset);
      }
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

      // Kill any running pi process for this session so it stops writing
      // to the file we're about to delete.
      try {
        await sessionPool.kill(id);
      } catch (err) {
        console.error("Error killing pi process for deleted session:", err);
      }
      // Remove from webui-owned set so a recreated session doesn't inherit
      // the deleted session's ownership.
      sessionPool.unmarkSessionOwned(id);

      // Delete the session file immediately
      await unlink(filePath);

      res.json({ ok: true });
    } catch (err) {
      console.error("Error deleting session:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/sessions/:id/model — set the model for this session
  // Writes a model_change entry to the JSONL (or queues an RPC if running)
  // and updates the in-memory model so subsequent prompts use it.
  app.post("/api/sessions/:id/model", async (req, res) => {
    try {
      const { id } = req.params;
      const { provider, model } = req.body ?? {};
      if (typeof provider !== "string" || typeof model !== "string" || !provider || !model) {
        res.status(400).json({ error: "provider and model are required strings" });
        return;
      }
      await sessionPool.setModel(id, provider, model);
      res.json({ ok: true, provider, model });
    } catch (err) {
      console.error("Error setting session model:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/sessions/:id/current-model
  // Returns the {provider, model} the session is currently using, by
  // scanning the JSONL for the most recent model_change entry. This is
  // the source of truth for "what model should the webui show in the
  // selector on initial load" — last model_change wins over the
  // assistant message's reported model and over settings.json defaults,
  // because model_change is what the user explicitly picked.
  app.get("/api/sessions/:id/current-model", async (req, res) => {
    try {
      const { id } = req.params;
      const filePath = await findSessionFile(sessionPool.sessionsDir, id);
      if (!filePath) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      const current = await readCurrentModel(filePath);
      if (!current) {
        res.json({ provider: null, model: null });
        return;
      }
      res.json(current);
    } catch (err) {
      console.error("Error reading current model:", err);
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

type Part =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; id: string; name: string; args: Record<string, unknown> }
  | { type: "toolResult"; toolCallId: string; content: string; isError?: boolean }
  | { type: "image"; mediaType: string; data: string };

interface Message {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "toolResult";
  parts: Part[];
  timestamp: string;
  model?: string;
  provider?: string;
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
  const allLines = lines.slice(1);

  // Filter to only message entries FIRST (Bug 1 fix: filter before pagination)
  const messageOnly = allLines.filter((line) => {
    try {
      const entry = JSON.parse(line);
      return entry.type === "message" && entry.message;
    } catch {
      return false;
    }
  });

  // Then paginate
  const paginatedLines = messageOnly.slice(offset, offset + limit);

  const messages: Message[] = [];
  for (const line of paginatedLines) {
    try {
      const entry = JSON.parse(line);
      // Already filtered above, but double-check
      if (entry.type !== "message" || !entry.message) continue;

      const inner = entry.message;
      const role = inner.role;
      if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;

      // Build parts array from inner.content
      const parts: Part[] = [];
      if (role === "toolResult") {
        // toolResult entries: content may be [{type:"toolResult", toolCallId, content, isError}]
        // or [{type:"text", text:"..."}]. Extract the toolResult part from content array.
        if (Array.isArray(inner.content)) {
          const tr = inner.content.find((c: { type: string }) => c.type === "toolResult");
          if (tr) {
            parts.push({
              type: "toolResult",
              toolCallId: tr.toolCallId ?? inner.toolCallId ?? "unknown",
              content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content ?? ""),
              isError: tr.isError,
            });
          } else {
            // Fallback: extract text content
            const text = inner.content.filter((c: { type: string }) => c.type === "text").map((c: { text?: string }) => c.text ?? "").join("");
            parts.push({ type: "toolResult", toolCallId: inner.toolCallId ?? "unknown", content: text });
          }
        } else {
          parts.push({ type: "toolResult", toolCallId: inner.toolCallId ?? "unknown", content: typeof inner.content === "string" ? inner.content : "" });
        }
      } else if (Array.isArray(inner.content)) {
        for (const c of inner.content) {
          if (c.type === "text") parts.push({ type: "text", text: c.text ?? "" });
          else if (c.type === "thinking") parts.push({ type: "thinking", text: c.text ?? "" });
          else if (c.type === "toolCall") parts.push({ type: "toolCall", id: c.id, name: c.name, args: c.arguments ?? c.args ?? {} });
          else if (c.type === "image") parts.push({ type: "image", mediaType: c.mediaType, data: c.data });
        }
      } else if (typeof inner.content === "string") {
        parts.push({ type: "text", text: inner.content });
      }

      const msg: Message = {
        id: entry.id ?? crypto.randomUUID(),
        sessionId,
        role,
        parts,
        timestamp: entry.timestamp ?? new Date().toISOString(),
      };

      // For assistant messages, extract usage, model, and provider.
      // Provider is needed for the model selector — settings may list a
      // different defaultProvider than what was actually used in this
      // session (e.g. user switched mid-session, or models.json is out
      // of date), and we want the badge + selector to reflect reality.
      if (role === "assistant") {
        const usage = extractUsage(line);
        if (usage) msg.usage = usage;
        if (inner.model) msg.model = inner.model;
        if (inner.provider) msg.provider = inner.provider;
      }

      messages.push(msg);
    } catch {
      // Skip invalid JSON lines
    }
  }

  return messages;
}

/**
 * Return the session title.
 * Priority:
 *   1. `s.name` from the JSONL header (set by older pi versions or by tools)
 *   2. `sessionPool.getSessionName` (in-memory, populated from
 *      `session_info_changed` RPC events for currently-running webui sessions)
 *   3. The latest `session_info` line in the JSONL file (source of truth for
 *      any session that has been titled at least once, even across server
 *      restarts or for sessions owned by the TUI)
 * Returns empty string when no title has ever been set.
 */
async function deriveTitle(s: SessionHeader & { sessionFile: string }, sessionPool: SessionPool): Promise<string> {
  return (
    s.name ??
    sessionPool.getSessionName(s.id) ??
    (await readLatestSessionInfoName(s.sessionFile)) ??
    ""
  );
}

/**
 * Read the most recent `session_info` entry from a session JSONL file
 * and return its `name` field, if any.
 *
 * Reading the whole file for every session on every list request is fine
 * in practice: even very large sessions are tens of MB and we read the
 * content once per list refresh, which is user-paced.
 */
async function readLatestSessionInfoName(sessionFile: string): Promise<string | undefined> {
  try {
    const content = await readFile(sessionFile, "utf-8");
    // Walk lines from the end — the most recent `session_info` is the
    // current title. Keep scanning across intervening `message` entries
    // because a session_info event can be interleaved with messages.
    // Bound the scan so a corrupted file can't make us read megabytes.
    const lines = content.split("\n");
    const maxScan = Math.min(lines.length, 2000);
    for (let i = lines.length - 1; i >= lines.length - maxScan; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as { type?: string; name?: string };
        if (obj.type === "session_info" && typeof obj.name === "string" && obj.name.length > 0) {
          return obj.name;
        }
        // The header is `type: "session"` — only the first line has it, so
        // hitting it means we've scanned past the end of the body.
        if (obj.type === "session") break;
      } catch {
        continue;
      }
    }
  } catch {
    // File unreadable; treat as no name
  }
  return undefined;
}

/**
 * Count the number of message entries in a session JSONL file.
 * Filters out non-message lines (header, model_change, thinking_level_change,
 * session_info, etc.) so the count matches what `readMessages` returns
 * element-by-element. This is critical for tail-mode pagination: using
 * "body line count" would overshoot by however many non-message entries
 * the file has.
 * Returns 0 on error.
 */
async function countMessages(sessionFile: string): Promise<number> {
  try {
    const content = await readFile(sessionFile, "utf-8");
    const lines = content.split("\n");
    let count = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "message" && obj.message) {
          const role = obj.message.role;
          if (role === "user" || role === "assistant" || role === "toolResult") {
            count++;
          }
        }
      } catch {
        // skip
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * TUI session files are named `<ISO timestamp>_<uuid>.jsonl`
 * (e.g. `2026-06-02T15-20-09.141Z_34022d26-...jsonl`).
 * Webui session files are named `<uuid>.jsonl` (crypto.randomUUID() output).
 * This helper detects TUI origin purely from the filename so the UI can
 * mark them as read-only / non-interactive.
 */
function isTuiSession(sessionFile: string): boolean {
  const base = sessionFile.split("/").pop() ?? "";
  // TUI files start with a YYYY-MM-DDT prefix and contain `Z_` separator
  // before the UUID. The time portion uses `:` or `-` depending on the
  // TUI version, so accept both.
  return /^\d{4}-\d{2}-\d{2}T[\d:.\-]+Z_/.test(base);
}

/**
 * Scan a session's JSONL tail for the most recent `model_change` entry
 * and return its {provider, model}. Returns undefined if no model_change
 * exists (e.g. a brand-new session, or a TUI session that never went
 * through the webui's set_model RPC).
 *
 * Only the last 2000 lines are scanned — that's enough for any session
 * a user would realistically open, and keeps the per-request cost
 * bounded for huge TUI sessions.
 */
async function readCurrentModel(
  filePath: string,
): Promise<{ provider: string; model: string } | undefined> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return undefined;
  }
  const allLines = content.split("\n").filter((l) => l.trim());
  const lines = allLines.slice(-2000);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry && entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") {
        return { provider: entry.provider, model: entry.modelId };
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}
