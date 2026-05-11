/**
 * GBrain Memory Extension
 *
 * Integrates gbrain semantic memory with the Pi coding agent lifecycle:
 * - before_agent_start: queries gbrain for relevant memories, injects into context
 * - session_shutdown: extracts session state and persists to gbrain
 * - session_compact: indexes compaction summaries to gbrain
 * - /save-memory: manual trigger to save current session context
 */

import type { ExtensionAPI, ExtensionContext, SessionMessageEntry, SessionEntry } from "@earendil-works/pi-coding-agent";

const GBRAIN_CLI = "gbrain";
const MEMORY_NAMESPACE = "pi-sessions";
const MEMORY_TAG = "coding-agent";

// ---------------------------------------------------------------------------
// gbrain CLI helpers
// ---------------------------------------------------------------------------

async function runGbrain(ctx: ExtensionContext, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const result = await ctx.exec(GBRAIN_CLI, args, { cwd: ctx.cwd, timeout: 10_000 });
    return { ok: result.code === 0, stdout: result.stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

async function isGbrainAvailable(ctx: ExtensionContext): Promise<boolean> {
  const result = await runGbrain(ctx, ["--version"]);
  return result.ok;
}

// ---------------------------------------------------------------------------
// Memory retrieval (before_agent_start)
// ---------------------------------------------------------------------------

async function queryMemories(ctx: ExtensionContext, prompt: string): Promise<string | null> {
  const available = await isGbrainAvailable(ctx);
  if (!available) return null;

  // Search for relevant memories using the user's prompt
  const searchResult = await runGbrain(ctx, [
    "search",
    prompt,
    "--limit",
    "5",
    "--source",
    MEMORY_NAMESPACE,
  ]);
  if (!searchResult.ok || !searchResult.stdout.trim()) {
    return null;
  }

  // Format memories into a context block
  const memories = searchResult.stdout.trim();
  return [
    "<gbrain-memory-context>",
    "Relevant past context for this project:",
    memories,
    "</gbrain-memory-context>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Memory persistence (session_shutdown / manual save)
// ---------------------------------------------------------------------------

async function extractAndSaveSession(ctx: ExtensionContext, reason: string): Promise<void> {
  const available = await isGbrainAvailable(ctx);
  if (!available) return;

  try {
    const entries = ctx.sessionManager.getEntries();
    if (!entries || entries.length === 0) return;

    // Extract user messages and compaction summaries
    const userMessages: string[] = [];
    const assistantMessages: string[] = [];
    const compactionSummaries: string[] = [];

    for (const entry of entries) {
      if (entry.type === "message") {
        const msgEntry = entry as SessionMessageEntry;
        const msg = msgEntry.message;
        if (msg.role === "user") {
          const content = typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content.map((c: any) => (c.type === "text" ? c.text : "")).join(" ").slice(0, 200)
              : "";
          if (content.trim()) {
            userMessages.push(content.trim().slice(0, 300));
          }
        } else if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.trim()) {
          assistantMessages.push(msg.content.trim().slice(0, 200));
        }
      } else if (entry.type === "compaction" && entry.summary) {
        compactionSummaries.push(entry.summary.slice(0, 500));
      }
    }

    // Build session summary
    const summaryParts: string[] = [];
    summaryParts.push(`# Session Summary — ${reason}`);
    summaryParts.push(`Date: ${new Date().toISOString()}`);
    summaryParts.push(`Branch: ${ctx.sessionManager.getCwd().split("/").pop() ?? "unknown"}`);
    summaryParts.push(`Entries: ${entries.length}`);
    summaryParts.push("");

    if (compactionSummaries.length > 0) {
      summaryParts.push("## Compaction Summaries");
      for (const s of compactionSummaries) {
        summaryParts.push(s);
        summaryParts.push("");
      }
    }

    if (userMessages.length > 0) {
      summaryParts.push("## User Prompts");
      for (const msg of userMessages.slice(-8)) {
        summaryParts.push(`- ${msg}`);
      }
      summaryParts.push("");
    }

    const summary = summaryParts.join("\n");
    const slug = `session-${Date.now()}-${reason}`;

    await runGbrain(ctx, [
      "put",
      `${MEMORY_NAMESPACE}/${MEMORY_TAG}/${slug}`,
      summary,
    ]);
  } catch {
    // Best-effort — silent failure
  }
}

async function indexCompactionSummary(ctx: ExtensionContext, summary: string): Promise<void> {
  const available = await isGbrainAvailable(ctx);
  if (!available) return;

  try {
    const slug = `compaction-${Date.now()}`;
    await runGbrain(ctx, [
      "put",
      `${MEMORY_NAMESPACE}/compactions/${slug}`,
      `# Compaction Summary\n\n${summary}`,
    ]);
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function gbrainMemoryExtension(pi: ExtensionAPI): void {
  // ---- before_agent_start: inject memories into system prompt ----
  pi.on("before_agent_start", async (event, ctx) => {
    const memoryBlock = await queryMemories(ctx, event.prompt);
    if (!memoryBlock) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${memoryBlock}`,
    };
  });

  // ---- session_shutdown: auto-save session memory ----
  pi.on("session_shutdown", async (event, ctx) => {
    await extractAndSaveSession(ctx, event.reason);
  });

  // ---- session_compact: index compaction summaries ----
  pi.on("session_compact", async (event, ctx) => {
    await indexCompactionSummary(ctx, event.compactionEntry.summary);
  });

  // ---- /save-memory: manual trigger ----
  pi.registerCommand("save-memory", {
    description: "Save current session context to gbrain memory",
    async handler(_args, ctx) {
      ctx.ui.notify("Saving session context to gbrain...", "info");
      await extractAndSaveSession(ctx, "manual-save");
      ctx.ui.notify("Session context saved to gbrain memory", "info");
    },
  });
}
