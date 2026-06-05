#!/usr/bin/env bun
/**
 * Satellite MCP Server (HTTP)
 *
 * An MCP server that exposes remote file and shell tools via HTTP transport.
 * Deploys on the remote server as a persistent process.
 *
 * Exposes a single `remote_exec` tool that routes to 5 predefined tools:
 * read_file, write_file, edit_file, bash, list_dir.
 *
 * 1:1 feature parity with local pi tools:
 * - Bash: streaming output, process tree killing, abort signal, OutputAccumulator
 * - Read: offset/limit, BOM handling, head truncation
 * - Write: file mutation queue, abort signal
 * - Edit: multi-edit, fuzzy matching, BOM/line-ending handling, diff output
 * - List: entry limit, byte truncation, name/ format
 *
 * Usage:
 *   SATELLITE_TOKEN=your-secret SATELLITE_PORT=29001 ./satellite-server
 *
 * Health check: GET /health
 * MCP endpoint: POST/GET/DELETE /mcp
 */

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, dirname, resolve, basename } from "node:path";
import { appendFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod/v3";
import { REMOTE_EXEC_INPUT_SCHEMA } from "./schema.ts";
import {
  canonicalize,
  isParentTraversal,
  killProcessTree,
  waitForChildProcess,
  OutputAccumulator,
  truncateHead,
  MAX_LINES as _MAX_LINES,
  MAX_BYTES as _MAX_BYTES,
} from "./utils.ts";

// ============================================================================
// Config
// ============================================================================

const VERSION = "3.0.0";
const TOKEN = process.env.SATELLITE_TOKEN || "";
const PORT = parseInt(process.env.SATELLITE_PORT || "29001", 10);
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 min — sweep stale sessions on access
const DEFAULT_BASH_TIMEOUT_SEC = 30;

// --version short-circuit (before token check so it works in CI)
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(`satellite-server v${VERSION}`);
  process.exit(0);
}

if (!TOKEN) {
  console.error("ERROR: SATELLITE_TOKEN environment variable is required");
  process.exit(1);
}

// ============================================================================
// Path Scope (server-side canonicalization + last-line .. block)
//
// Scope policy is the client's job (personal-assistant reads
// remotePathPattern from mcp.json, rejects out-of-scope calls pre-flight).
// The server keeps two thin, no-opinion defenses:
//   1. canonicalize() — resolves .. and symlinks so file ops behave
//      consistently regardless of input form. Cheap (<1ms), no policy.
//   2. blockParentTraversal() — refuses any path whose realpath still
//      contains ".." segments. Belt-and-suspenders in case a future
//      handler forgets to canonicalize.
// Both are unconditional — no config, no SATELLITE_PATH_PATTERN env.
// ============================================================================
// (canonicalize, isParentTraversal, killProcessTree, waitForChildProcess,
//  OutputAccumulator, truncateHead are imported from ./utils.ts)

if (!TOKEN) {
  console.error("ERROR: SATELLITE_TOKEN environment variable is required");
  process.exit(1);
}

// ============================================================================
// Logging
// ============================================================================

const LOG_FILE = "/tmp/satellite.log";
const LOG_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

try { mkdirSync("/tmp", { recursive: true }); } catch { /* ignore */ }

let logBytes = 0;

/**
 * Mask obvious secrets (private keys, bearer tokens, KEY=VAL env pairs,
 * password=...) in log output. The remote server's stdout/stderr gets
 * captured to /tmp/satellite-stdout.log, so any literal the user echoes
 * via bash(cat ~/.ssh/id_rsa) would otherwise land in the log on disk.
 */
function scrubSecrets(s: string): string {
  return s
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[PRIVATE_KEY]")
    .replace(/\/\.ssh\/id_[a-z0-9_]+/gi, "/.ssh/id_[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]")
    .replace(/(?<![\w.])([A-Z][A-Z0-9_]{2,})=([^\s,;&|]+)/g, "$1=[REDACTED]")
    .replace(/(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*([^\s,;&|]+)/gi, "$1=[REDACTED]");
}

function log(msg: string, sessionId?: string): void {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  const prefix = sessionId ? ` session=${sessionId.slice(0, 8)}` : "";
  const line = `[${ts}]${prefix} ${scrubSecrets(msg)}`;
  console.error(line);
  try {
    if (logBytes > LOG_MAX_BYTES) {
      // Truncate log file when it grows past the cap (cheap rotation)
      try { unlinkSync(LOG_FILE); } catch { /* ignore */ }
      logBytes = 0;
    }
    appendFileSync(LOG_FILE, line + "\n");
    logBytes += Buffer.byteLength(line, "utf-8") + 1;
  } catch { /* ignore */ }
}

// ============================================================================
// Constants
// ============================================================================

const SHELL = "/bin/bash";
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const MAX_LS_ENTRIES = 500;
const PROGRESS_THROTTLE_MS = 100;
const KEEPALIVE_INTERVAL_MS = 10_000; // Send progress notification every 10s to prevent idle TCP disconnect

// Remote exec tool input schema - discriminated union of all sub-operations
export const REMOTE_EXEC_SCHEMA = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("bash"),
    command: z.string(),
    timeout: z.number().optional(),
    cwd: z.string().optional(),
  }),
  z.object({
    tool: z.literal("read_file"),
    path: z.string(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
  z.object({
    tool: z.literal("write_file"),
    path: z.string(),
    content: z.string(),
  }),
  z.object({
    tool: z.literal("edit_file"),
    path: z.string(),
    edits: z.array(z.object({
      oldText: z.string(),
      newText: z.string(),
    })),
  }),
  z.object({
    tool: z.literal("list_dir"),
    path: z.string().optional().default("."),
    limit: z.number().optional().default(500),
  }),
  z.object({
    tool: z.literal("find_files"),
    pattern: z.string(),
    path: z.string().optional().default("."),
    limit: z.number().optional().default(1000),
  }),
  z.object({
    tool: z.literal("grep_files"),
    pattern: z.string(),
    path: z.string().optional().default("."),
    glob: z.string().optional(),
    limit: z.number().optional().default(500),
    ignoreCase: z.boolean().optional().default(false),
    literal: z.boolean().optional().default(false),
    context: z.number().optional().default(0),
  }),
  z.object({
    tool: z.literal("transfer_file"),
    direction: z.enum(["remote_to_local", "local_to_remote"]),
    local_path: z.string(),
    remote_path: z.string(),
    content: z.string().optional(), // only used for "local_to_remote" direction
  }),
]);

// REMOTE_EXEC_INPUT_SCHEMA is imported from ./schema.ts — kept separate so
// the personal-assistant client can import it for e2e tests of the
// transfer_file hook (validating against the real schema, not a copy).

// ============================================================================
// Progress Context (for keepalive heartbeat during long-running tools)
// ============================================================================

interface ProgressContext {
  sendNotification: (notification: Record<string, unknown>) => Promise<void>;
  progressToken: string | number;
}

async function sendProgress(ctx: ProgressContext, progress: number, total?: number, message?: string): Promise<void> {
  try {
    await ctx.sendNotification({
      method: "notifications/progress",
      params: { progressToken: ctx.progressToken, progress, total, message } as Record<string, unknown>,
    });
  } catch { /* ignore notification errors */ }
}

// ============================================================================
// Helpers
// ============================================================================

function textContent(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text }];
}

// ============================================================================
// File Mutation Queue (serialize concurrent writes to same file)
// ============================================================================

const fileQueues = new Map<string, Promise<void>>();

async function withFileQueue<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = await canonicalize(path);
  const prev = fileQueues.get(key) || Promise.resolve();
  let result: T;
  const current = prev.then(fn, fn).then((r) => { result = r; }).finally(() => {
    if (fileQueues.get(key) === current) {
      fileQueues.delete(key);
    }
  });
  fileQueues.set(key, current);
  await current;
  return result!;
}

// ============================================================================
// OutputAccumulator (streaming output management for bash)
// ============================================================================

// ============================================================================
// Fuzzy Matching (for edit tool)
// ============================================================================

function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014\u2015]/g, '-')
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function findFuzzyMatch(content: string, searchText: string): number {
  const exactIdx = content.indexOf(searchText);
  if (exactIdx !== -1) return exactIdx;

  const normalizedContent = normalizeForMatch(content);
  const normalizedSearch = normalizeForMatch(searchText);
  const normalizedIdx = normalizedContent.indexOf(normalizedSearch);
  if (normalizedIdx !== -1) {
    let origPos = 0;
    let normPos = 0;
    while (normPos < normalizedIdx && origPos < content.length) {
      normPos++;
      origPos++;
      while (origPos < content.length && normPos < normalizedContent.length &&
             normalizeForMatch(content[origPos]) !== normalizedContent[normPos]) {
        origPos++;
      }
    }
    return origPos;
  }

  return -1;
}

// ============================================================================
// Diff Generation (for edit tool)
// ============================================================================

function generateDiff(edits: Array<{ oldText: string; newText: string }>): string {
  const parts: string[] = [];
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const oldLines = edit.oldText.split("\n");
    const newLines = edit.newText.split("\n");

    parts.push(`--- Edit ${i + 1}`);
    parts.push(`+++ Edit ${i + 1}`);
    for (const line of oldLines) parts.push(`- ${line}`);
    for (const line of newLines) parts.push(`+ ${line}`);
  }
  return parts.join("\n");
}

// ============================================================================
// Tool Validation Schemas
// ============================================================================

const TOOL_SCHEMAS = {
  read_file: z.object({
    path: z.string(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
  write_file: z.object({
    path: z.string(),
    content: z.string(),
  }),
  edit_file: z.object({
    path: z.string(),
    edits: z.array(z.object({
      oldText: z.string(),
      newText: z.string(),
    })),
  }),
  bash: z.object({
    command: z.string(),
    timeout: z.number().optional(),
    cwd: z.string().optional(),
  }),
  list_dir: z.object({
    path: z.string().optional().default("."),
    limit: z.number().optional(),
  }),
  find_files: z.object({
    pattern: z.string(),
    path: z.string().optional(),
    limit: z.number().optional(),
  }),
  grep_files: z.object({
    pattern: z.string(),
    path: z.string().optional(),
    glob: z.string().optional(),
    limit: z.number().optional(),
    ignoreCase: z.boolean().optional(),
    literal: z.boolean().optional(),
    context: z.number().optional(),
  }),
  transfer_file: z.object({
    direction: z.enum(["remote_to_local", "local_to_remote"]),
    local_path: z.string(),
    remote_path: z.string(),
    content: z.string().optional(), // only used for "local_to_remote" direction
  }),
};

// ============================================================================
// Image MIME Detection
// ============================================================================
//
// Detects common image formats by extension and returns the corresponding
// MIME type. Mirrors the supported types in the local pi `read` tool
// (jpg/png/gif/webp). No resize — HPC may lack `sharp`; images are returned
// at original size. If an image exceeds MAX_IMAGE_BYTES, the handler returns
// a hint to use `transfer_file` for inspection.

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

function detectImageMime(filePath: string): string | undefined {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext];
}

// ============================================================================
// Tool Handlers
// ============================================================================

async function handleReadFile(args: { path: string; offset?: number; limit?: number }, sessionId: number | string = 0) {
  const t0 = Date.now();
  try {
    const safePath = await canonicalize(args.path);
    if (isParentTraversal(safePath)) {
      throw new Error(`Path '${args.path}' resolves to '${safePath}' with parent-traversal segments`);
    }

    // Image fast path: detect MIME, read as binary, return as image content.
    const mimeType = detectImageMime(args.path);
    if (mimeType) {
      const buffer = await readFile(safePath);
      if (buffer.byteLength > MAX_IMAGE_BYTES) {
        log(`read_file ${args.path} → ok image skipped ${Date.now() - t0}ms (${buffer.byteLength} bytes > ${MAX_IMAGE_BYTES})`, String(sessionId));
        return {
          content: [{
            type: "text" as const,
            text: `Image too large to inline (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB > ${MAX_IMAGE_BYTES / 1024 / 1024}MB). Use bash: file ${args.path}; or transfer_file to local then view.`,
          }],
        };
      }
      log(`read_file ${args.path} → ok image ${Date.now() - t0}ms (${buffer.byteLength} bytes ${mimeType})`, String(sessionId));
      return {
        content: [
          { type: "text" as const, text: `Read image file [${mimeType}, ${(buffer.byteLength / 1024).toFixed(1)}KB]` },
          { type: "image" as const, data: buffer.toString("base64"), mimeType },
        ],
      };
    }

    let content = await readFile(safePath, "utf-8");

    if (content.charCodeAt(0) === 0xFEFF) {
      content = content.slice(1);
    }

    let lines = content.split("\n");
    if (content.endsWith("\n")) lines.pop();

    const startLine = Math.max(0, (args.offset || 1) - 1);
    const endLine = args.limit ? startLine + args.limit : lines.length;
    const selectedLines = lines.slice(startLine, endLine);

    const result = truncateHead(selectedLines.join("\n"));

    let continuation = "";
    if (endLine < lines.length) {
      continuation = `\n[${lines.length - endLine} more lines. Use offset=${endLine + 1} to continue.]`;
    }

    log(`read_file ${args.path} → ok ${Date.now() - t0}ms (${content.length} bytes${result.truncated ? `, truncated: ${result.outputLines}/${result.totalLines} lines` : ""})`, String(sessionId));
    return { content: textContent(result.text + continuation) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`read_file ${args.path} → error ${Date.now() - t0}ms: ${msg}`, String(sessionId));
    return { content: textContent(`Error: ${msg}`), isError: true };
  }
}

async function handleWriteFile(args: { path: string; content: string }, sessionId: number | string = 0) {
  const t0 = Date.now();
  try {
    const safePath = await canonicalize(args.path);
    if (isParentTraversal(safePath)) {
      throw new Error(`Path '${args.path}' resolves to '${safePath}' with parent-traversal segments`);
    }
    return await withFileQueue(safePath, async () => {
      await mkdir(dirname(safePath), { recursive: true });
      await writeFile(safePath, args.content, "utf-8");
      const bytes = Buffer.byteLength(args.content, "utf-8");
      log(`write_file ${args.path} → ok ${Date.now() - t0}ms (${bytes} bytes)`, String(sessionId));
      return { content: textContent(`Successfully wrote ${bytes} bytes to ${args.path}`) };
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`write_file ${args.path} → error ${Date.now() - t0}ms: ${msg}`, String(sessionId));
    return { content: textContent(`Error: ${msg}`), isError: true };
  }
}

export async function handleTransferFile(args: { direction: "remote_to_local" | "local_to_remote"; local_path: string; remote_path: string; content?: string }, sessionId: number | string = 0) {
  const t0 = Date.now();
  // direction semantics:
  //   remote_to_local: server reads remote_path and returns content.
  //     Client (personal-assistant) hook captures the result, writes to
  //     local_path, and replaces the content with a metadata message so
  //     bytes never enter LLM context.
  //   local_to_remote: client hook reads local_path and injects `content`
  //     into the MCP call before it leaves the agent process. Bytes flow
  //     over the MCP transport, not through the LLM.
  const echo = `direction=${args.direction}, local=${args.local_path}, remote=${args.remote_path}\n`;

  try {
    if (args.direction === "remote_to_local") {
      const safeRemote = await canonicalize(args.remote_path);
      if (isParentTraversal(safeRemote)) {
        throw new Error(`Path '${args.remote_path}' resolves to '${safeRemote}' with parent-traversal segments`);
      }
      const content = await readFile(safeRemote, "utf-8");
      log(`transfer_file remote_to_local ${args.remote_path} → ok ${Date.now() - t0}ms (${content.length} bytes)`, String(sessionId));
      return { content: textContent(echo + content) };
    } else if (args.direction === "local_to_remote") {
      if (args.content === undefined) {
        return { content: textContent(echo + "Error: local_to_remote requires content field. The client (personal-assistant) should inject this from the local file before the MCP call."), isError: true };
      }
      const safeRemote = await canonicalize(args.remote_path);
      if (isParentTraversal(safeRemote)) {
        throw new Error(`Path '${args.remote_path}' resolves to '${safeRemote}' with parent-traversal segments`);
      }
      const content = args.content;
      return await withFileQueue(safeRemote, async () => {
        await mkdir(dirname(safeRemote), { recursive: true });
        await writeFile(safeRemote, content, "utf-8");
        const bytes = Buffer.byteLength(content, "utf-8");
        log(`transfer_file local_to_remote ${args.remote_path} → ok ${Date.now() - t0}ms (${bytes} bytes)`, String(sessionId));
        return { content: textContent(echo + `Successfully wrote ${bytes} bytes to ${args.remote_path}`) };
      });
    } else {
      return { content: textContent(echo + `Error: unknown direction '${args.direction}'. Use 'remote_to_local' or 'local_to_remote'.`), isError: true };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`transfer_file ${args.direction} ${args.remote_path} → error ${Date.now() - t0}ms: ${msg}`, String(sessionId));
    return { content: textContent(echo + `Error: ${msg}`), isError: true };
  }
}

type EditArgs = { path: string; edits: Array<{ oldText: string; newText: string }> };

/**
 * Compatibility shim for known model input mistakes. Mirrors the local
 * pi edit tool's `prepareEditArguments`:
 *  - Some models (Opus 4.6, GLM-5.1) send `edits` as a JSON string.
 *  - Some models send a single edit as {oldText, newText} at the root
 *    instead of inside `edits[]`.
 */
function prepareEditArguments(input: unknown): EditArgs | { error: string } {
  if (!input || typeof input !== "object") {
    return { error: "edit_file input must be an object with `path` and `edits[]`" };
  }
  const args = input as Record<string, unknown>;

  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
    } catch {
      return { error: "edits is a string but not valid JSON" };
    }
  }

  if (!Array.isArray(args.edits)) {
    if (typeof args.oldText === "string" && typeof args.newText === "string") {
      args.edits = [{ oldText: args.oldText, newText: args.newText }];
      delete args.oldText;
      delete args.newText;
    } else {
      return { error: "edits must be an array (or supply oldText/newText at root for a single edit)" };
    }
  }

  if ((args.edits as unknown[]).length === 0) {
    return { error: "edits must contain at least one replacement" };
  }

  return args as unknown as EditArgs;
}

/**
 * Detect the file's dominant line ending (\n, \r\n, or \r) so edits can be
 * applied in normalized form and the original ending restored on write.
 * Local pi's edit-diff.ts uses the same approach.
 */
function detectLineEnding(text: string): "\n" | "\r\n" | "\r" {
  const crlf = (text.match(/\r\n/g) || []).length;
  const cr = (text.match(/(?<!\r)\r(?!\n)/g) || []).length;
  if (crlf > cr) return "\r\n";
  if (cr > crlf) return "\r";
  return "\n";
}

function restoreLineEndings(text: string, ending: "\n" | "\r\n" | "\r"): string {
  // text is currently LF-normalized; restore to original.
  if (ending === "\n") return text;
  if (ending === "\r\n") return text.replace(/\n/g, "\r\n");
  return text.replace(/\n/g, "\r");
}

async function handleEditFile(rawArgs: { path: string; edits: Array<{ oldText: string; newText: string }> }, sessionId: number | string = 0) {
  const t0 = Date.now();
  const prep = prepareEditArguments(rawArgs);
  if ("error" in prep) {
    return { content: textContent(`Error: ${prep.error}`), isError: true };
  }
  const args = prep;
  try {
    const safePath = await canonicalize(args.path);
    if (isParentTraversal(safePath)) {
      throw new Error(`Path '${args.path}' resolves to '${safePath}' with parent-traversal segments`);
    }
    return await withFileQueue(safePath, async () => {
      let content = await readFile(safePath, "utf-8");

      // Strip BOM before matching (model never includes BOM in oldText).
      const hasBOM = content.charCodeAt(0) === 0xFEFF;
      if (hasBOM) content = content.slice(1);

      // Detect and normalize line endings.
      const lineEnding = detectLineEnding(content);
      if (lineEnding !== "\n") content = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

      for (let i = 0; i < args.edits.length; i++) {
        const edit = args.edits[i];

        if (!edit.oldText) {
          return { content: textContent(`Error: Edit ${i + 1} has empty oldText`), isError: true };
        }

        const count = content.split(edit.oldText).length - 1;
        if (count > 1) {
          return { content: textContent(`Error: Edit ${i + 1} oldText appears ${count} times. Provide more context to make it unique.`), isError: true };
        }

        const pos = findFuzzyMatch(content, edit.oldText);
        if (pos === -1) {
          return { content: textContent(`Error: Edit ${i + 1} oldText not found: ${edit.oldText.slice(0, 80)}...`), isError: true };
        }

        if (edit.oldText === edit.newText) {
          return { content: textContent(`Error: Edit ${i + 1} oldText and newText are identical`), isError: true };
        }

        content = content.slice(0, pos) + edit.newText + content.slice(pos + edit.oldText.length);
      }

      // Restore original line endings and BOM.
      if (lineEnding !== "\n") content = restoreLineEndings(content, lineEnding);
      if (hasBOM) content = "\uFEFF" + content;

      await writeFile(safePath, content, "utf-8");

      const diff = generateDiff(args.edits);
      log(`edit_file ${args.path} → ok ${Date.now() - t0}ms (${args.edits.length} edits)`, String(sessionId));
      return { content: textContent(`Successfully replaced ${args.edits.length} block(s) in ${args.path}.\n\n${diff}`) };
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`edit_file ${args.path} → error ${Date.now() - t0}ms: ${msg}`, String(sessionId));
    return { content: textContent(`Error: ${msg}`), isError: true };
  }
}

export async function handleBash(
  args: { command: string; timeout?: number; cwd?: string },
  abortSignal?: AbortSignal,
  progressCtx?: ProgressContext,
) {
  let workDir = args.cwd || "/";
  const t0 = Date.now();

  try {
    if (!existsSync(workDir)) {
      return { content: textContent(`Error: Working directory does not exist: ${workDir}`), isError: true };
    }

    if (abortSignal?.aborted) {
      return { content: textContent("Command aborted"), isError: true };
    }

    const proc = spawn(SHELL, ["-c", args.command], {
      cwd: workDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pgid = proc.pid;
    const accumulator = new OutputAccumulator();

    proc.stdout?.on("data", (chunk: Buffer) => accumulator.append(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => accumulator.append(chunk));

    // Keepalive heartbeat — periodically flush SSE to prevent idle TCP disconnect
    let heartbeatCounter = 0;
    let heartbeatFinished = false;
    const heartbeatTimer = progressCtx
      ? setInterval(() => {
          if (heartbeatFinished) return;
          heartbeatCounter++;
          sendProgress(progressCtx, heartbeatCounter, undefined, "heartbeat");
        }, KEEPALIVE_INTERVAL_MS)
      : undefined;

    const stopHeartbeat = () => {
      if (heartbeatTimer) {
        heartbeatFinished = true;
        clearInterval(heartbeatTimer);
      }
    };

    const cleanup = () => {
      stopHeartbeat();
      if (pgid) killProcessTree(pgid);
    };

    if (abortSignal) {
      if (abortSignal.aborted) cleanup();
      else abortSignal.addEventListener("abort", cleanup, { once: true });
    }

    const timeoutSec = args.timeout ?? DEFAULT_BASH_TIMEOUT_SEC;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutSec > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        cleanup();
      }, timeoutSec * 1000);
    }

    const exitCode = await waitForChildProcess(proc);
    stopHeartbeat();
    if (timer) clearTimeout(timer);

    await accumulator.finish();

    const duration = Date.now() - t0;

    const snapshot = accumulator.snapshot();
    const output: string[] = [];
    if (snapshot.content) output.push(snapshot.content);
    if (exitCode !== 0 && exitCode !== null) output.push(`exit code: ${exitCode}`);
    if (timedOut) output.push(`Command exceeded ${timeoutSec}s timeout. Use timeout=<seconds> for longer tasks.`);

    const raw = output.join("\n") || "(no output)";

    if (snapshot.truncated && snapshot.tempPath) {
      try { await writeFile(snapshot.tempPath, raw, "utf-8"); } catch { /* ignore */ }
    }

    log(`bash "${args.command.slice(0, 80)}" → ${exitCode === 0 ? "ok" : "error"} ${duration}ms${snapshot.truncated ? ` (truncated: ${snapshot.outputLines}/${snapshot.totalLines} lines)` : ""}${timedOut ? " (timed out)" : ""}`);

    const isError = timedOut || (exitCode !== 0 && exitCode !== null);
    if (isError) {
      return { content: textContent(raw), isError: true };
    }
    return { content: textContent(raw) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`bash "${args.command.slice(0, 80)}" → error ${Date.now() - t0}ms: ${msg}`);
    return { content: textContent(`Error: ${msg}`), isError: true };
  }
}

async function handleListDir(args: { path: string; limit?: number }, sessionId: number | string = 0) {
  const t0 = Date.now();
  try {
    const safePath = await canonicalize(args.path);
    if (isParentTraversal(safePath)) {
      throw new Error(`Path '${args.path}' resolves to '${safePath}' with parent-traversal segments`);
    }
    const maxEntries = args.limit || MAX_LS_ENTRIES;
    const dirEntries = await readdir(safePath, { withFileTypes: true });

    dirEntries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    const limited = dirEntries.slice(0, maxEntries);

    const formatted: string[] = [];
    for (const entry of limited) {
      const suffix = entry.isDirectory() ? "/" : "";
      formatted.push(entry.name + suffix);
    }

    let output = formatted.join("\n");

    if (dirEntries.length > maxEntries) {
      output += `\n\n[${dirEntries.length - maxEntries} entries limit reached. Use limit=${maxEntries * 2} for more]`;
    }

    const result = truncateHead(output, Number.MAX_SAFE_INTEGER, MAX_BYTES);
    if (result.truncated) {
      output = result.text;
    }

    log(`list_dir ${args.path} → ok ${Date.now() - t0}ms (${dirEntries.length} entries)`, String(sessionId));
    return { content: textContent(output || "(empty directory)") };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`list_dir ${args.path} → error ${Date.now() - t0}ms: ${msg}`, String(sessionId));
    return { content: textContent(`Error: ${msg}`), isError: true };
  }
}

// Run fd to search for files. Returns relative paths (mirroring local pi
// find tool). Errors from fd are surfaced; missing-fd is detected from
// spawn ENOENT in proc.on("error").
async function runFd(pattern: string, searchPath: string, limit: number): Promise<{ output: string; truncated: boolean; fdMissing: boolean }> {
  return new Promise((resolve) => {
    // Build fd args. --full-path is required when pattern contains "/" so
    // path-containing patterns like "src/**/*.ts" match correctly.
    const args: string[] = [
      "--glob",
      "--color=never",
      "--hidden",
      "--no-require-git",
      "--max-results",
      String(limit),
    ];
    let effectivePattern = pattern;
    if (pattern.includes("/")) {
      args.push("--full-path");
      if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
        effectivePattern = `**/${pattern}`;
      }
    }
    args.push("--", effectivePattern, searchPath);

    const proc = spawn("fd", args, { stdio: ["ignore", "pipe", "pipe"] });
    const lines: string[] = [];
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line) lines.push(line);
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        resolve({ output: "", truncated: false, fdMissing: true });
        return;
      }
      resolve({ output: `Error: ${err.message}`, truncated: false, fdMissing: false });
    });
    proc.on("close", (code) => {
      // Relativize paths against searchPath (local find tool behavior).
      const relative = lines.map((p) => {
        if (p.startsWith(searchPath + "/")) return p.slice(searchPath.length + 1);
        return p;
      });
      const rawOutput = relative.join("\n");
      const truncated = truncateHead(rawOutput, Number.MAX_SAFE_INTEGER, MAX_BYTES);
      const out = truncated.text + (stderr.trim() ? `\n[fd stderr]: ${stderr.trim()}` : "");
      void code; // fd exits non-zero on limit hit, that's not an error
      resolve({ output: out, truncated: truncated.truncated, fdMissing: false });
    });
  });
}

export async function handleFindFiles(args: { pattern: string; path?: string; limit?: number }, sessionId: number | string = 0) {
  const t0 = Date.now();
  const searchPath = args.path || ".";
  const limit = args.limit || 1000;

  // Canonicalize the search path; reject parent-traversal.
  const safePath = await canonicalize(searchPath);
  if (isParentTraversal(safePath)) {
    log(`find_files ${args.pattern} → error parent-traversal ${Date.now() - t0}ms`, String(sessionId));
    return { content: textContent(`Error: path '${searchPath}' resolves to '${safePath}' with parent-traversal segments`), isError: true };
  }

  const result = await runFd(args.pattern, safePath, limit);

  if (result.fdMissing) {
    log(`find_files ${args.pattern} → error fd not found ${Date.now() - t0}ms`, String(sessionId));
    return {
      content: textContent("fd not found on remote server. Install with: apt install fd-find"),
      isError: true,
    };
  }

  log(`find_files ${args.pattern} ${searchPath} → ok ${Date.now() - t0}ms (${result.truncated ? "truncated" : "full"})`, String(sessionId));
  return { content: textContent(result.output || "No files found matching pattern") };
}

// Per-line truncation cap for grep matches (matches local pi's GREP_MAX_LINE_LENGTH).
const GREP_MAX_LINE_LENGTH = 500;

function truncateLine(line: string): string {
  if (line.length <= GREP_MAX_LINE_LENGTH) return line;
  return `${line.slice(0, GREP_MAX_LINE_LENGTH)}... [truncated]`;
}

// Run rg to search file contents. Returns line-formatted matches; truncates
// per-line to GREP_MAX_LINE_LENGTH; kills rg early when limit is reached
// (mirrors local pi grep tool).
async function runRg(
  pattern: string,
  searchPath: string,
  glob: string | undefined,
  limit: number,
  ignoreCase: boolean,
  literal: boolean,
  context: number,
): Promise<{ output: string; truncated: boolean; rgMissing: boolean; limitReached: boolean }> {
  return new Promise((resolve) => {
    const args: string[] = ["--no-heading", "--line-number", "--color=never", "--hidden"];
    if (ignoreCase) args.push("-i");
    if (literal) args.push("-F");
    if (glob) args.push("--glob", glob);
    if (context > 0) args.push("-C", String(context));
    args.push("--", pattern, searchPath);

    const proc = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const lines: string[] = [];
    let stderr = "";
    let killedDueToLimit = false;

    proc.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (!line) continue;
        if (lines.length >= limit) {
          killedDueToLimit = true;
          if (!proc.killed) proc.kill();
          return;
        }
        lines.push(truncateLine(line));
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        resolve({ output: "", truncated: false, rgMissing: true, limitReached: false });
        return;
      }
      resolve({ output: `Error: ${err.message}`, truncated: false, rgMissing: false, limitReached: false });
    });
    proc.on("close", () => {
      const rawOutput = lines.join("\n");
      const truncated = truncateHead(rawOutput, Number.MAX_SAFE_INTEGER, MAX_BYTES);
      const out = truncated.text + (stderr.trim() ? `\n[rg stderr]: ${stderr.trim()}` : "");
      resolve({ output: out, truncated: truncated.truncated, rgMissing: false, limitReached: killedDueToLimit });
    });
  });
}

export async function handleGrepFiles(
  args: {
    pattern: string;
    path?: string;
    glob?: string;
    limit?: number;
    ignoreCase?: boolean;
    literal?: boolean;
    context?: number;
  },
  sessionId: number | string = 0,
) {
  const t0 = Date.now();
  const searchPath = args.path || ".";
  const glob = args.glob;
  const limit = args.limit || 500;
  const ignoreCase = args.ignoreCase ?? false;
  const literal = args.literal ?? false;
  const context = args.context ?? 0;

  // Canonicalize the search path; reject parent-traversal.
  const safePath = await canonicalize(searchPath);
  if (isParentTraversal(safePath)) {
    log(`grep_files ${args.pattern} → error parent-traversal ${Date.now() - t0}ms`, String(sessionId));
    return { content: textContent(`Error: path '${searchPath}' resolves to '${safePath}' with parent-traversal segments`), isError: true };
  }

  const result = await runRg(args.pattern, safePath, glob, limit, ignoreCase, literal, context);

  if (result.rgMissing) {
    log(`grep_files ${args.pattern} → error rg not found ${Date.now() - t0}ms`, String(sessionId));
    return {
      content: textContent("ripgrep not found on remote server. Install with: apt install ripgrep"),
      isError: true,
    };
  }

  const notice = result.limitReached ? `\n\n[${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern]` : "";
  log(`grep_files ${args.pattern} ${searchPath} → ok ${Date.now() - t0}ms (${result.truncated ? "truncated" : "full"})`, String(sessionId));
  return { content: textContent((result.output || "No matches found") + notice) };
}

// ============================================================================
// Tool Router
// ============================================================================

type ToolResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
};

const TOOL_HANDLERS: Record<string, (
  args: Record<string, unknown>,
  abortSignal?: AbortSignal,
  progressCtx?: ProgressContext,
  turnId?: number | string,
) => Promise<ToolResult>> = {
  read_file: (args, _s, _p, sid) => handleReadFile(args as { path: string; offset?: number; limit?: number }, sid),
  write_file: (args, _s, _p, sid) => handleWriteFile(args as { path: string; content: string }, sid),
  edit_file: (args, _s, _p, sid) => handleEditFile(args as { path: string; edits: Array<{ oldText: string; newText: string }> }, sid),
  bash: (args, abortSignal, progressCtx) => handleBash(
    args as { command: string; timeout?: number; cwd?: string },
    abortSignal,
    progressCtx,
  ),
  list_dir: (args, _s, _p, sid) => handleListDir(args as { path: string; limit?: number }, sid),
  find_files: (args, _s, _p, sid) => handleFindFiles(args as { pattern: string; path?: string; limit?: number }, sid),
  grep_files: (args, _s, _p, sid) => handleGrepFiles(
    args as {
      pattern: string;
      path?: string;
      glob?: string;
      limit?: number;
      ignoreCase?: boolean;
      literal?: boolean;
      context?: number;
    },
    sid,
  ),
  transfer_file: (args, _s, _p, sid) => handleTransferFile(args as { direction: "remote_to_local" | "local_to_remote"; local_path: string; remote_path: string; content?: string }, sid),
};

// ============================================================================
// MCP Server Factory
// ============================================================================

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "satellite",
    version: VERSION,
  });

  server.registerTool(
    "remote_exec",
    {
      description: "Run file and shell operations on the remote HPC server.\n\n# Common tasks — fields are flat at the root\n\nRead    { tool:\"read_file\",  path:\"...\" }\nEdit    { tool:\"edit_file\",  path:\"...\", edits:[{oldText,newText}] }\nWrite   { tool:\"write_file\", path:\"...\", content:\"...\" }\n        Pass content directly as a string, do NOT wrap it in a Python script.\nList    { tool:\"list_dir\",   path:\"...\" }\nSearch  { tool:\"find_files\", pattern:\"...\", path:\"...\" }\n        { tool:\"grep_files\", pattern:\"...\", path:\"...\", glob?:\"...\" }\nShell   { tool:\"bash\",       command:\"...\" }\n        Use only for env, processes, scripts. Prefer the dedicated ops above.\n\n# Move a local file to remote (no LLM context burn for the file bytes)\n\n  { tool:\"transfer_file\", direction:\"local_to_remote\",\n    local_path:\"<path on your machine>\",\n    remote_path:\"<path on HPC>\" }\n\n# Pull a remote file to local (no LLM context burn for the file bytes)\n\n  { tool:\"transfer_file\", direction:\"remote_to_local\",\n    remote_path:\"<path on HPC>\",\n    local_path:\"<path on your machine>\" }\n\n# Field reference\n\nSee the JSON schema for optional fields (offset, limit, timeout, glob, edits, etc.).",
      inputSchema: REMOTE_EXEC_INPUT_SCHEMA,
    },
    async (args, extra) => {
      const t0 = Date.now();

      const { tool, ...toolArgs } = args;

      log(`remote_exec → ${tool} ${JSON.stringify(toolArgs).slice(0, 200)}`);
      const handler = TOOL_HANDLERS[tool];
      if (!handler) {
        return { content: textContent(`Unknown tool: ${tool}`), isError: true };
      }

      const progressToken = (extra as any)._meta?.progressToken;
      const progressCtx: ProgressContext | undefined =
        progressToken !== undefined && (extra as any).sendNotification
          ? { sendNotification: (extra as any).sendNotification, progressToken }
          : undefined;

      const sessionId = (extra as any).sessionId ?? 0;

      const result = await handler(toolArgs, extra.signal, progressCtx, sessionId);
      const ms = Date.now() - t0;
      log(`remote_exec → ${tool} ${ms}ms`);
      metricInc(tool, result.isError ? "err" : "ok", ms);
      return result;
    }
  );

  return server;
}

// ============================================================================
// HTTP Server
// ============================================================================

const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
const sessionLastSeen = new Map<string, number>();

/**
 * Sweep stale sessions whose last access is older than SESSION_TTL_MS.
 * MCP transport.onclose fires on graceful DELETE only — TCP RST, network
 * drop, or client crash leave the session alive forever, leaking the
 * per-session guardrail counters (and a slot in the transports map).
 */
function sweepStaleSessions(): void {
  const now = Date.now();
  for (const [sid, lastSeen] of sessionLastSeen) {
    if (now - lastSeen > SESSION_TTL_MS) {
      const t = transports.get(sid);
      try { t?.close(); } catch { /* ignore */ }
      transports.delete(sid);
      sessionLastSeen.delete(sid);
      log(`Swept stale session: ${sid}`);
    }
  }
}

function touchSession(sid: string): void {
  sessionLastSeen.set(sid, Date.now());
}

function checkAuth(req: Request): boolean {
  const auth = req.headers.get("Authorization");
  return auth === `Bearer ${TOKEN}`;
}

// ============================================================================
// Metrics (Prometheus text format)
// ============================================================================

/** Per-tool call counters and latency. Cheap to maintain, no external deps. */
const metrics = {
  startTime: Date.now(),
  counters: new Map<string, number>(),
  latencies: new Map<string, number[]>(),
};

function metricInc(tool: string, status: "ok" | "err", ms: number): void {
  metrics.counters.set(`${tool}_${status}_total`, (metrics.counters.get(`${tool}_${status}_total`) ?? 0) + 1);
  const arr = metrics.latencies.get(`${tool}_${status}`) ?? [];
  arr.push(ms);
  if (arr.length > 200) arr.shift(); // ring buffer of last 200
  metrics.latencies.set(`${tool}_${status}`, arr);
}

function metricsText(): string {
  const lines: string[] = [];
  lines.push(`# HELP satellite_uptime_seconds Server uptime`);
  lines.push(`# TYPE satellite_uptime_seconds gauge`);
  lines.push(`satellite_uptime_seconds ${((Date.now() - metrics.startTime) / 1000).toFixed(2)}`);
  lines.push(`# HELP satellite_sessions_active Active MCP sessions`);
  lines.push(`# TYPE satellite_sessions_active gauge`);
  lines.push(`satellite_sessions_active ${transports.size}`);
  lines.push(`# HELP satellite_tool_calls_total Total tool calls by tool and status`);
  lines.push(`# TYPE satellite_tool_calls_total counter`);
  for (const [k, v] of metrics.counters) {
    lines.push(`satellite_tool_calls_total{kind="${k}"} ${v}`);
  }
  lines.push(`# HELP satellite_tool_latency_ms Recent latency (avg of last 200 calls)`);
  lines.push(`# TYPE satellite_tool_latency_ms gauge`);
  for (const [k, arr] of metrics.latencies) {
    if (arr.length === 0) continue;
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    lines.push(`satellite_tool_latency_ms{kind="${k}"} ${avg.toFixed(1)}`);
  }
  return lines.join("\n") + "\n";
}

// ============================================================================
// CORS Headers (used by /health and /metrics)
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
};

log(`Satellite MCP Server v${VERSION} starting on port ${PORT}`);

const httpServer = (globalThis as any).Bun.serve({
  port: PORT,
  idleTimeout: 0, // Disable idle timeout for long-running SSH streams
  async fetch(req: Request) {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Health check (no auth required)
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", version: VERSION, sessions: transports.size }, { headers: corsHeaders });
    }

    // Metrics (no auth required — same trust model as /health)
    if (url.pathname === "/metrics") {
      return new Response(metricsText(), { headers: { ...corsHeaders, "Content-Type": "text/plain; version=0.0.4" } });
    }

    // Auth check for all other endpoints
    if (!checkAuth(req)) {
      return new Response("Unauthorized", { status: 401 });
    }

    // MCP endpoint
    if (url.pathname === "/mcp") {
      const sessionId = req.headers.get("mcp-session-id");

      if (req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body) {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32700, message: "Parse error" },
            id: null,
          }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        let transport: WebStandardStreamableHTTPServerTransport;

        if (sessionId && transports.has(sessionId)) {
          transport = transports.get(sessionId)!;
          touchSession(sessionId);
        } else if (!sessionId && isInitializeRequest(body)) {
          // New initialization request
          const newSessionId = randomUUID();
          transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => newSessionId,
            onsessioninitialized: (sid) => {
              transports.set(sid, transport);
              sessionLastSeen.set(sid, Date.now());
              log(`Session initialized: ${sid}`);
            },
          });
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && transports.has(sid)) {
              transports.delete(sid);
              sessionLastSeen.delete(sid);
              log(`Session closed: ${sid}`);
            }
          };

          const server = createMcpServer();
          await server.connect(transport);

          const response = await transport.handleRequest(req, { parsedBody: body });
          return response;
        } else {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: No valid session ID" },
            id: null,
          }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const response = await transport.handleRequest(req, { parsedBody: body });
        return response;
      }

      if (req.method === "GET") {
        if (!sessionId || !transports.has(sessionId)) {
          return new Response("Invalid or missing session ID", { status: 400 });
        }
        const transport = transports.get(sessionId)!;
        return transport.handleRequest(req);
      }

      if (req.method === "DELETE") {
        if (!sessionId || !transports.has(sessionId)) {
          return new Response("Invalid or missing session ID", { status: 400 });
        }
        const transport = transports.get(sessionId)!;
        return transport.handleRequest(req);
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

log(`Satellite MCP Server ready on port ${PORT}`);

// Sweep stale sessions every minute. Cancels the per-session counters
// leaked by clients that close the TCP connection without sending DELETE.
setInterval(sweepStaleSessions, 60_000).unref();

// Graceful shutdown
process.on("SIGINT", async () => {
  log("Shutting down...");
  for (const [sid, transport] of transports) {
    try {
      await transport.close();
    } catch { /* ignore */ }
  }
  transports.clear();
  httpServer.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  log("Shutting down...");
  for (const [sid, transport] of transports) {
    try {
      await transport.close();
    } catch { /* ignore */ }
  }
  transports.clear();
  httpServer.stop();
  process.exit(0);
});
