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
import { readdir, readFile, writeFile, mkdir, stat, realpath, open } from "node:fs/promises";
import { join, dirname, resolve, basename } from "node:path";
import { appendFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod/v3";

// ============================================================================
// Intent Detection (Bash Guardrail)
// ============================================================================

/**
 * Detects file operation intent from bash commands.
 * Order matters: first match wins.
 */
export function detectIntent(command: string): "read_file" | "edit_file" | "write_file" | "find_files" | "grep_files" | "list_dir" | null {
  // Guard: reject pipeline/redirect commands (not direct file ops)
  // Do this BEFORE grep/find patterns but AFTER write_file (which uses > redirect)
  if (/[|<]/.test(command)) return null;
  if (/^cat\s+[^\s|;<>&]+$/.test(command)) return "read_file";
  if (/^sed\s+-i\b/.test(command)) return "edit_file";
  if (/^(echo|printf)\s+.*>\s*\S+/.test(command)) return "write_file";
  if (/^(ls|ll|dir)\b/.test(command)) return "list_dir";
  if (/\bfind\s+/.test(command)) return "find_files";
  if (/\bgrep\s+/.test(command)) return "grep_files";
  return null;
}

// ============================================================================
// Guardrail Retry Counter (per-turn, per-intent)
// ============================================================================

export type GuardrailIntent = "read_file" | "edit_file" | "write_file" | "find_files" | "grep_files" | "list_dir";
export type TurnId = number | string;

const guardrailCounters = new Map<TurnId, Partial<Record<GuardrailIntent, number>>>();

export function getGuardrailCount(turnId: TurnId, intent: GuardrailIntent): number {
  return guardrailCounters.get(turnId)?.[intent] ?? 0;
}

export function incrementGuardrail(turnId: TurnId, intent: GuardrailIntent): number {
  const current = getGuardrailCount(turnId, intent);
  const next = current + 1;
  if (!guardrailCounters.has(turnId)) {
    guardrailCounters.set(turnId, {});
  }
  guardrailCounters.get(turnId)![intent] = next;
  return next;
}

export function resetGuardrail(turnId: TurnId): void {
  guardrailCounters.delete(turnId);
}

/**
 * Returns guidance text for a detected bash intent.
 * The path extraction is naive (last token) — enough for guardrail hints.
 */
function getGuidanceMessage(intent: GuardrailIntent, command: string): string {
  const path = command.split(/\s+/).pop() || "<path>";
  switch (intent) {
    case "read_file":
      return `Prefer read_file over bash cat. Use tool=read_file, path='${path}' for offset/limit/truncation support.`;
    case "edit_file":
      return `Prefer edit_file over bash sed -i. Use tool=edit_file, path='${path}', edits=[{oldText, newText}] for fuzzy matching and diff feedback.`;
    case "write_file":
      return `Prefer write_file over bash echo/printf. Use tool=write_file, path='${path}', content=... for atomic writes.`;
    case "find_files":
      return `Prefer find_files over bash find. Use tool=find_files, pattern='<glob>', path='${path}' for fd with proper limit/truncation.`;
    case "grep_files":
      return `Prefer grep_files over bash grep. Use tool=grep_files, pattern='<regex>', path='${path}' for rg with proper limit/truncation.`;
    case "list_dir":
      return `Prefer list_dir over bash ls. Use tool=list_dir, path='${command.match(/(?:^|\s)(?:\/[\w./-]+|~[^\s]*|\.[^\s]*)/)?.[0] ?? path}' for structured output, entry limit, and shell-escape safety.`;
  }
}

// ============================================================================
// Config
// ============================================================================

const VERSION = "3.0.0";
const TOKEN = process.env.SATELLITE_TOKEN || "";
const PORT = parseInt(process.env.SATELLITE_PORT || "29001", 10);
const RAW_PATH_PATTERN = process.env.SATELLITE_PATH_PATTERN || "";
const REMOTE_PATH_PATTERN: RegExp | null = RAW_PATH_PATTERN
  ? new RegExp(RAW_PATH_PATTERN)
  : null;
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

if (!TOKEN) {
  console.error("ERROR: SATELLITE_TOKEN environment variable is required");
  process.exit(1);
}

// ============================================================================
// Path Scope (Layer B — server-side enforcement of remotePathPattern)
// ============================================================================

/**
 * Server-side enforcement of the path pattern declared in mcp.json.
 * Mirrors the client-side `remotePathPattern` (Layer A) so that a jailbroken
 * or hallucinating model cannot read/write outside the intended scope.
 *
 * Behavior:
 * - No pattern set → no enforcement (backward compatible).
 * - Resolves the path to its absolute, symlink-free form (realpath), then
 *   tests the regex. `..` traversal and symlink redirects are caught here
 *   because realpath collapses them before the regex runs.
 * - For non-existent paths (e.g. write_file to a new file), falls back to
 *   resolve() and validates the *parent directory* instead, so an attacker
 *   can't claim a new path under /etc/.
 *
 * Returns the safe (resolved) path on success. Throws on violation so the
 * per-handler try/catch turns it into a guidance error.
 */
async function ensureRemotePath(inputPath: string): Promise<string> {
  if (!REMOTE_PATH_PATTERN) return inputPath;

  const resolveTarget = async (p: string): Promise<string> => {
    const real = await realpath(p).catch(() => resolve(p));
    return real;
  };

  // Try the path itself first.
  let target = await resolveTarget(inputPath);
  let realExists = existsSync(target);

  if (!realExists) {
    // File doesn't exist yet (e.g. write_file creating a new file).
    // Validate the parent directory against the pattern instead, so the
    // new file inherits the parent's scope.
    const parent = dirname(target);
    if (parent && parent !== target) {
      const parentReal = await realpath(parent).catch(() => resolve(parent));
      target = `${parentReal}/${basename(target)}`;
    }
  }

  if (!REMOTE_PATH_PATTERN.test(target)) {
    throw new Error(
      `Path access denied: '${target}' is outside the allowed scope ` +
      `(pattern: ${RAW_PATH_PATTERN}). Configure the satellite server with ` +
      `a broader SATELLITE_PATH_PATTERN, or use bash to access this path.`
    );
  }
  return target;
}

/**
 * Scan a bash command for path-like tokens and validate each one against
 * the pattern. Returns the first violation found, or null if clean.
 * Conservative — matches absolute paths and `~user` / `~/...` prefixes.
 */
async function validateBashCommand(command: string): Promise<string | null> {
  if (!REMOTE_PATH_PATTERN) return null;

  // Skip when shell-builtin / assignment / variable expansion (so we don't
  // false-positive on $PATH, ${HOME}, etc.)
  // Match: /<word>(/<word>)* or ~/... or ~<user>/...
  const candidates = new Set<string>();
  const abs = command.match(/(?<![\w/$\\])(\/[\w.\-]+(?:\/[\w.\-]+)*)/g) ?? [];
  for (const a of abs) candidates.add(a);
  const home = command.match(/(?<![\w]~)(~(?:\/[\w.\-]+(?:[\w.\-/]+)?|[A-Za-z0-9_]+(?:[\w.\-/]+)?))/g) ?? [];
  for (const h of home) candidates.add(h);

  for (const c of candidates) {
    try {
      // For ~ we expand manually since bash -c would do it at runtime.
      const expanded = c.startsWith("~")
        ? c.replace(/^~/, process.env.HOME ?? "")
        : c;
      const real = await realpath(expanded).catch(() => resolve(expanded));
      if (!REMOTE_PATH_PATTERN.test(real)) {
        return `Path access denied: '${real}' (from '${c}' in command) is outside the allowed scope ` +
               `(pattern: ${RAW_PATH_PATTERN}).`;
      }
    } catch { /* ignore individual failures, keep scanning */ }
  }
  return null;
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
    limit: z.number().optional().default(500),
  }),
  z.object({
    tool: z.literal("grep_files"),
    pattern: z.string(),
    path: z.string().optional().default("."),
    glob: z.string().optional(),
    limit: z.number().optional().default(500),
  }),
  z.object({
    tool: z.literal("transfer_file"),
    direction: z.enum(["upload", "download"]),
    local_path: z.string(),
    remote_path: z.string(),
    content: z.string().optional(), // only used for "download" direction
  }),
]);

/**
 * Flat schema for MCP `tools/list` introspection.
 *
 * The MCP SDK's `normalizeObjectSchema` discards `z.discriminatedUnion` and `z.union`
 * (it only recognizes `z.object` with a `.shape` field), so registering the strict
 * REMOTE_EXEC_SCHEMA directly produces an empty `{ type: "object", properties: {} }`
 * in the tools/list response — agents cannot discover sub-ops from it.
 *
 * This flat z.object exposes all sub-op names via the `tool` enum so the agent
 * can see the discriminated union's variants. Runtime validation in
 * `REMOTE_EXEC_SCHEMA` is unaffected — we still call `.parse(args)` against the
 * strict schema inside the handler, so this is a display-only fallback.
 */
export const REMOTE_EXEC_INPUT_SCHEMA = z.object({
  tool: z.enum([
    "bash",
    "read_file",
    "write_file",
    "edit_file",
    "list_dir",
    "find_files",
    "grep_files",
    "transfer_file",
  ]),
  command: z.string().optional(),
  timeout: z.number().optional(),
  cwd: z.string().optional(),
  // Apply the same defaults as REMOTE_EXEC_SCHEMA so the MCP SDK's
  // pre-validation (using this flat schema) matches runtime behavior.
  path: z.string().optional().default("."),
  offset: z.number().optional(),
  limit: z.number().optional().default(500),
  content: z.string().optional(),
  edits: z.array(z.object({
    oldText: z.string(),
    newText: z.string(),
  })).optional(),
  pattern: z.string().optional(),
  glob: z.string().optional(),
  direction: z.enum(["upload", "download"]).optional(),
  local_path: z.string().optional(),
  remote_path: z.string().optional(),
}).passthrough(); // Accept unknown root keys (e.g. nested "args" wrapper) so
                 // our handler can return a guidance error instead of the
                 // SDK's terse "root: must not have additional properties".

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

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

// ============================================================================
// CWD State (maintained across tool calls)
// ============================================================================

let bashCwd = "/";

// ============================================================================
// File Mutation Queue (serialize concurrent writes to same file)
// ============================================================================

const fileQueues = new Map<string, Promise<void>>();

async function withFileQueue<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = await realpath(path).catch(() => resolve(path));
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

class OutputAccumulator {
  private chunks: Buffer[] = [];
  private decoder = new TextDecoder("utf-8", { fatal: false });
  private totalRawBytes = 0;
  private totalDecodedBytes = 0;
  private totalLines = 0;
  private tail = "";
  private tempPath?: string;
  private tempFd?: Awaited<ReturnType<typeof open>>;

  append(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.totalRawBytes += chunk.length;

    const decoded = this.decoder.decode(chunk, { stream: true });
    this.tail += decoded;
    this.totalDecodedBytes += Buffer.byteLength(decoded, "utf-8");
    this.totalLines += (decoded.match(/\n/g) || []).length;

    const maxRolling = MAX_BYTES * 2;
    if (this.tail.length > maxRolling) {
      this.tail = this.tail.slice(-maxRolling);
    }

    if (!this.tempPath && (this.totalRawBytes > MAX_BYTES || this.totalDecodedBytes > MAX_BYTES || this.totalLines > MAX_LINES)) {
      this.tempPath = `/tmp/satellite-bash-${Date.now()}.log`;
      this.flushToTempFile();
    }
  }

  private async flushToTempFile(): Promise<void> {
    if (!this.tempPath) return;
    try {
      this.tempFd = await open(this.tempPath, "w");
      for (const chunk of this.chunks) {
        await this.tempFd.write(chunk);
      }
      this.chunks = [];
    } catch { /* ignore */ }
  }

  async finish(): Promise<void> {
    const remaining = this.decoder.decode();
    if (remaining) {
      this.tail += remaining;
      this.totalDecodedBytes += Buffer.byteLength(remaining, "utf-8");
      this.totalLines += (remaining.match(/\n/g) || []).length;
    }

    if (this.tempPath && this.tempFd && this.chunks.length > 0) {
      for (const chunk of this.chunks) {
        await this.tempFd.write(chunk);
      }
      this.chunks = [];
    }

    if (this.tempFd) {
      await this.tempFd.close();
      this.tempFd = undefined;
    }
  }

  snapshot(): { content: string; truncated: boolean; totalLines: number; outputLines: number; tempPath?: string } {
    const lines = this.tail.split("\n");
    if (this.tail.endsWith("\n")) lines.pop();

    if (this.totalLines <= MAX_LINES && this.totalDecodedBytes <= MAX_BYTES) {
      return {
        content: this.tail,
        truncated: false,
        totalLines: this.totalLines,
        outputLines: this.totalLines,
        tempPath: this.tempPath,
      };
    }

    const kept: string[] = [];
    let bytes = 0;
    let truncatedBy: "lines" | "bytes" = "lines";
    for (let i = lines.length - 1; i >= 0 && kept.length < MAX_LINES; i--) {
      const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (kept.length > 0 ? 1 : 0);
      if (bytes + lineBytes > MAX_BYTES) { truncatedBy = "bytes"; break; }
      kept.unshift(lines[i]);
      bytes += lineBytes;
    }
    if (kept.length >= MAX_LINES && bytes <= MAX_BYTES) truncatedBy = "lines";

    const text = kept.join("\n");
    const startLine = this.totalLines - kept.length + 1;
    const suffix = truncatedBy === "lines"
      ? `[Showing lines ${startLine}-${this.totalLines} of ${this.totalLines}. Full output saved to ${this.tempPath}]`
      : `[Showing last ${bytes} of ${this.totalDecodedBytes} bytes. Full output saved to ${this.tempPath}]`;

    return {
      content: text + "\n\n" + suffix,
      truncated: true,
      totalLines: this.totalLines,
      outputLines: kept.length,
      tempPath: this.tempPath,
    };
  }
}

// ============================================================================
// Process Tree Killing
// ============================================================================

function killProcessTree(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch { /* already dead */ }
  }
}

// ============================================================================
// waitForChildProcess (handles stream draining)
// ============================================================================

async function waitForChildProcess(proc: ChildProcess): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    let resolved = false;
    const done = (code: number | null) => {
      if (!resolved) {
        resolved = true;
        resolve(code);
      }
    };

    proc.on("close", (code) => done(code));
    proc.on("error", () => done(null));
  });
}

// ============================================================================
// Truncation (matches built-in: 2000 lines or 50KB)
// ============================================================================

function truncateHead(content: string, maxLines = MAX_LINES, maxBytes = MAX_BYTES): { text: string; truncated: boolean; totalLines: number; outputLines: number } {
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { text: content, truncated: false, totalLines, outputLines: totalLines };
  }

  const kept: string[] = [];
  let bytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  for (let i = 0; i < lines.length && kept.length < maxLines; i++) {
    const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (kept.length > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) { truncatedBy = "bytes"; break; }
    kept.push(lines[i]);
    bytes += lineBytes;
  }
  if (kept.length >= maxLines && bytes <= maxBytes) truncatedBy = "lines";

  const text = kept.join("\n");
  const suffix = truncatedBy === "lines"
    ? `[Showing first ${kept.length} of ${totalLines} lines (${maxLines} line limit). Use offset to continue.]`
    : `[Showing first ${bytes} of ${totalBytes} bytes (${maxBytes} byte limit). Use offset to continue.]`;

  return { text: text + "\n\n" + suffix, truncated: true, totalLines, outputLines: kept.length };
}

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
  }),
  transfer_file: z.object({
    direction: z.enum(["upload", "download"]),
    local_path: z.string(),
    remote_path: z.string(),
    content: z.string().optional(),
  }),
};

// ============================================================================
// Tool Handlers
// ============================================================================

async function handleReadFile(args: { path: string; offset?: number; limit?: number }, sessionId: number | string = 0) {
  const t0 = Date.now();
  try {
    const safePath = await ensureRemotePath(args.path);
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
    const safePath = await ensureRemotePath(args.path);
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

export async function handleTransferFile(args: { direction: "upload" | "download"; local_path: string; remote_path: string; content?: string }, sessionId: number | string = 0) {
  const t0 = Date.now();
  // Echo direction/paths in the response so the model can self-verify it
  // didn't get direction/local/remote mixed up. Most common confusion:
  // `direction: "upload"` actually reads from remote_path, with the
  // agent writing the returned content to local_path on its own machine.
  const echo = `direction=${args.direction}, local=${args.local_path}, remote=${args.remote_path}\n`;

  try {
    const safeRemote = await ensureRemotePath(args.remote_path);
    if (args.direction === "upload") {
      // upload: server reads remote_path and returns content (agent writes to local_path)
      const content = await readFile(safeRemote, "utf-8");
      log(`transfer_file upload ${args.remote_path} → ok ${Date.now() - t0}ms (${content.length} bytes)`, String(sessionId));
      return { content: textContent(echo + content) };
    } else {
      // download: agent must pass content field; server writes to remote_path
      if (args.content === undefined) {
        return { content: textContent(echo + "Error: download requires content field"), isError: true };
      }
      const content = args.content;
      const result = await withFileQueue(safeRemote, async () => {
        await mkdir(dirname(safeRemote), { recursive: true });
        await writeFile(safeRemote, content, "utf-8");
        const bytes = Buffer.byteLength(content, "utf-8");
        log(`transfer_file download ${args.remote_path} → ok ${Date.now() - t0}ms (${bytes} bytes)`, String(sessionId));
        return { content: textContent(echo + `Successfully wrote ${bytes} bytes to ${args.remote_path}`) };
      });
      return result;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`transfer_file ${args.direction} ${args.remote_path} → error ${Date.now() - t0}ms: ${msg}`, String(sessionId));
    return { content: textContent(echo + `Error: ${msg}`), isError: true };
  }
}

async function handleEditFile(args: { path: string; edits: Array<{ oldText: string; newText: string }> }, sessionId: number | string = 0) {
  const t0 = Date.now();
  try {
    const safePath = await ensureRemotePath(args.path);
    return await withFileQueue(safePath, async () => {
      let content = await readFile(safePath, "utf-8");

      const hasBOM = content.charCodeAt(0) === 0xFEFF;
      if (hasBOM) content = content.slice(1);

      const hasCRLF = content.includes("\r\n");
      if (hasCRLF) content = content.replace(/\r\n/g, "\n");

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

      if (hasCRLF) content = content.replace(/\n/g, "\r\n");
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
  turnId: number | string = 0,
) {
  // Layer B guardrail: detect bash intent that should use a dedicated sub-op
  const intent = detectIntent(args.command);
  if (intent) {
    const id = turnId ?? 0;
    const count = getGuardrailCount(id, intent);

    if (count >= 2) {
      // Hard block on 3rd violation
      return {
        content: textContent(
          `Blocked: you have tried bash with similar intent 3 times. Use tool=${intent} instead.`
        ),
        isError: true,
      };
    }

    // Soft guidance for first 2 violations
    incrementGuardrail(id, intent);
    const guidance = getGuidanceMessage(intent, args.command);
    return {
      content: textContent(guidance),
      isError: true,
    };
  }

  // Layer C guardrail: scan bash command for path-like tokens that fall
  // outside the allowed scope. (Layer A is the client-side system prompt,
  // Layer B is the file sub-op realpath check above. This is Layer C for
  // arbitrary shell commands — last line of defense for `cat /etc/passwd`.)
  const pathViolation = await validateBashCommand(args.command);
  if (pathViolation) {
    log(`bash "${args.command.slice(0, 80)}" → blocked: ${pathViolation}`, String(turnId));
    return {
      content: textContent(pathViolation),
      isError: true,
    };
  }

  let workDir = args.cwd || bashCwd;
  const t0 = Date.now();

  try {
    if (!existsSync(workDir)) {
      if (args.cwd) {
        return { content: textContent(`Error: Working directory does not exist: ${workDir}`), isError: true };
      }
      workDir = "/";
      bashCwd = "/";
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

    if (args.command.includes("cd ")) {
      try {
        const testProc = spawn(SHELL, ["-c", `cd ${workDir} && ${args.command} && pwd`], { stdio: ["ignore", "pipe", "ignore"] });
        let newCwd = "";
        testProc.stdout?.on("data", (chunk: Buffer) => { newCwd += chunk.toString(); });
        await new Promise<void>((resolve) => {
          testProc.on("close", () => resolve());
          setTimeout(() => resolve(), 3000);
        });
        const lines = newCwd.trim().split("\n");
        const candidate = lines[lines.length - 1].trim();
        if (candidate && existsSync(candidate)) {
          try {
            const st = await stat(candidate);
            if (st.isDirectory()) bashCwd = candidate;
          } catch { /* not a directory or inaccessible */ }
        }
      } catch { /* ignore */ }
    }

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
    const safePath = await ensureRemotePath(args.path);
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

// Check if fd is available on the system
async function checkFdAvailable(): Promise<{ available: boolean; path?: string }> {
  return new Promise((resolve) => {
    const proc = spawn("which", ["fd"], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    proc.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    proc.on("close", (code) => {
      if (code === 0 && output.trim()) {
        resolve({ available: true, path: output.trim() });
      } else {
        resolve({ available: false });
      }
    });
    proc.on("error", () => resolve({ available: false }));
  });
}

// Run fd to search for files
async function runFd(pattern: string, path: string, limit: number): Promise<{ output: string; truncated: boolean }> {
  return new Promise((resolve) => {
    const args = ["--glob", "--hidden", "--no-require-git", "--max-depth", "10", pattern, path];
    const proc = spawn("fd", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    proc.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    proc.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    proc.on("close", (code) => {
      // Apply truncation
      const truncated = truncateHead(output, limit, MAX_BYTES);
      resolve({ output: truncated.text, truncated: truncated.truncated });
    });
    proc.on("error", () => resolve({ output: "", truncated: false }));
  });
}

export async function handleFindFiles(args: { pattern: string; path?: string; limit?: number }, sessionId: number | string = 0) {
  const t0 = Date.now();
  const searchPath = args.path || ".";
  const limit = args.limit || 500;

  // Check if fd is available
  const fdCheck = await checkFdAvailable();
  if (!fdCheck.available) {
    log(`find_files ${args.pattern} → error fd not found ${Date.now() - t0}ms`, String(sessionId));
    return {
      content: textContent("fd not found on remote server. Install with: apt install fd-find"),
      isError: true,
    };
  }

  // Validate the search path is inside the allowed scope.
  const safePath = await ensureRemotePath(searchPath);

  // Run fd to search for files
  const result = await runFd(args.pattern, safePath, limit);

  log(`find_files ${args.pattern} ${searchPath} → ok ${Date.now() - t0}ms (${result.truncated ? "truncated" : "full"})`, String(sessionId));
  return { content: textContent(result.output || "(no matches found)") };
}

// Check if rg is available on the system
async function checkRgAvailable(): Promise<{ available: boolean; path?: string }> {
  return new Promise((resolve) => {
    const proc = spawn("which", ["rg"], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    proc.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    proc.on("close", (code) => {
      if (code === 0 && output.trim()) {
        resolve({ available: true, path: output.trim() });
      } else {
        resolve({ available: false });
      }
    });
    proc.on("error", () => resolve({ available: false }));
  });
}

// Run rg to search for matches
async function runRg(pattern: string, path: string, glob: string | undefined, limit: number): Promise<{ output: string; truncated: boolean }> {
  return new Promise((resolve) => {
    const args = ["--no-heading", "--line-number", "--max-depth", "10", pattern, path];
    if (glob) {
      args.push("--glob", glob);
    }
    const proc = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    proc.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    proc.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    proc.on("close", (code) => {
      // Apply truncation
      const truncated = truncateHead(output, limit, MAX_BYTES);
      resolve({ output: truncated.text, truncated: truncated.truncated });
    });
    proc.on("error", () => resolve({ output: "", truncated: false }));
  });
}

export async function handleGrepFiles(args: { pattern: string; path?: string; glob?: string; limit?: number }, sessionId: number | string = 0) {
  const t0 = Date.now();
  const searchPath = args.path || ".";
  const glob = args.glob;
  const limit = args.limit || 500;

  // Check if rg is available
  const rgCheck = await checkRgAvailable();
  if (!rgCheck.available) {
    log(`grep_files ${args.pattern} → error rg not found ${Date.now() - t0}ms`, String(sessionId));
    return {
      content: textContent("ripgrep not found on remote server. Install with: apt install ripgrep"),
      isError: true,
    };
  }

  // Validate the search path is inside the allowed scope.
  const safePath = await ensureRemotePath(searchPath);

  // Run rg to search for matches
  const result = await runRg(args.pattern, safePath, glob, limit);

  log(`grep_files ${args.pattern} ${searchPath} → ok ${Date.now() - t0}ms (${result.truncated ? "truncated" : "full"})`, String(sessionId));
  return { content: textContent(result.output || "(no matches found)") };
}

// ============================================================================
// Tool Router
// ============================================================================

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const TOOL_HANDLERS: Record<string, (
  args: Record<string, unknown>,
  abortSignal?: AbortSignal,
  progressCtx?: ProgressContext,
  turnId?: number | string,
) => Promise<ToolResult>> = {
  read_file: (args, _s, _p, sid) => handleReadFile(args as { path: string; offset?: number; limit?: number }, sid),
  write_file: (args, _s, _p, sid) => handleWriteFile(args as { path: string; content: string }, sid),
  edit_file: (args, _s, _p, sid) => handleEditFile(args as { path: string; edits: Array<{ oldText: string; newText: string }> }, sid),
  bash: (args, abortSignal, progressCtx, turnId) => handleBash(
    args as { command: string; timeout?: number; cwd?: string },
    abortSignal,
    progressCtx,
    turnId,
  ),
  list_dir: (args, _s, _p, sid) => handleListDir(args as { path: string; limit?: number }, sid),
  find_files: (args, _s, _p, sid) => handleFindFiles(args as { pattern: string; path?: string; limit?: number }, sid),
  grep_files: (args, _s, _p, sid) => handleGrepFiles(args as { pattern: string; path?: string; glob?: string; limit?: number }, sid),
  transfer_file: (args, _s, _p, sid) => handleTransferFile(args as { direction: "upload" | "download"; local_path: string; remote_path: string; content?: string }, sid),
};

// ============================================================================
// Schema Guardrail
// ============================================================================

const SUB_OP_FIELD_NAMES = new Set([
  "command", "timeout", "cwd",
  "path", "offset", "limit",
  "content", "edits",
  "pattern", "glob",
  "direction", "local_path", "remote_path",
]);

/**
 * Detect common agent schema-confusion patterns before dispatch and return a
 * guidance error so the model can self-correct. Currently catches:
 *
 *   1. Nested "args" wrapper: { tool, args: { command } } — should be flat.
 *   2. "tool" missing entirely: { command } — model forgot the discriminator.
 *
 * Returns `null` if the shape looks fine and dispatch can proceed.
 */
function checkSchemaShape(args: Record<string, unknown> | undefined): ToolResult | null {
  if (!args || typeof args !== "object") return null;

  // (2) "tool" missing — the model probably wrapped it under "args" too.
  if (!("tool" in args)) {
    const sample = Object.keys(args).slice(0, 3).join(", ");
    return {
      content: [{
        type: "text",
        text: [
          "SCHEMA ERROR: missing required field \"tool\" at the root of remote_exec.",
          "",
          `You sent: { ${sample}${Object.keys(args).length > 3 ? ", ..." : ""} }`,
          "",
          "Every remote_exec call must include a \"tool\" field set to one of:",
          "  bash, read_file, write_file, edit_file, list_dir,",
          "  find_files, grep_files, transfer_file",
          "",
          "If you wrapped sub-op arguments under \"args\", flatten them — see the",
          "ARGUMENT SHAPE section of the tool description.",
        ].join("\n"),
      }],
      isError: true,
    };
  }

  // (1) Nested "args" wrapper — the most common model confusion.
  const nested = (args as Record<string, unknown>).args;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const recognized = Object.keys(nested as Record<string, unknown>)
      .filter((k) => SUB_OP_FIELD_NAMES.has(k));
    if (recognized.length > 0) {
      const toolName = String((args as Record<string, unknown>).tool);
      return {
        content: [{
          type: "text",
          text: [
            "SCHEMA ERROR: sub-op arguments must be FLATTENED to the root of the tool call.",
            "",
            `You sent: { tool: "${toolName}", args: { ${recognized.join(", ")} } }`,
            `Correct:  { tool: "${toolName}", ${recognized.map((k) => `${k}: ...`).join(", ")} }`,
            "",
            "Examples:",
            '  WRONG: remote_exec({ tool: "bash", args: { command: "ls" } })',
            '  RIGHT: remote_exec({ tool: "bash", command: "ls" })',
            '  WRONG: remote_exec({ tool: "read_file", args: { path: "/tmp/x" } })',
            '  RIGHT: remote_exec({ tool: "read_file", path: "/tmp/x" })',
          ].join("\n"),
        }],
        isError: true,
      };
    }
  }

  return null;
}

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
      description: "Run file and shell operations on the remote HPC server. Choose one operation by setting the tool parameter.\n\nGUIDANCE:\n- PREFER `read_file` over `bash(cat <path>)` — supports offset/limit/truncation\n- PREFER `write_file` over `bash(echo > <path>)` — auto-creates parent dirs, atomic\n- PREFER `edit_file` over `bash(sed -i)` — fuzzy matching, multi-edit, diff feedback\n- PREFER `find_files` over `bash(find ...)` — uses fd with proper limit/truncation\n- PREFER `grep_files` over `bash(grep ...)` — uses rg with proper limit/truncation\n- PREFER `list_dir` over `bash(ls)` — structured output, no shell escape issues\n- Use `bash` ONLY for actual shell operations (env, processes, scripts)\n- `transfer_file` moves files between local and remote (LLM context tokens are not used to carry file bytes)\n\nARGUMENT SHAPE — sub-op arguments are FLATTENED to the root of the tool call, NOT wrapped under \"args\":\n  WRONG: { tool: \"bash\", args: { command: \"ls\" } }\n  RIGHT: { tool: \"bash\", command: \"ls\" }\n  WRONG: { tool: \"read_file\", args: { path: \"/tmp/x\" } }\n  RIGHT: { tool: \"read_file\", path: \"/tmp/x\" }\n\nSUB-OPERATIONS:\n- bash: execute a shell command (command, optional timeout in seconds, optional cwd)\n- read_file: read file contents (path, optional offset, optional limit)\n- write_file: create or overwrite file (path, content)\n- edit_file: apply text edits (path, edits[{oldText, newText}])\n- list_dir: list directory entries (path defaults to '.', optional limit, default 500)\n- find_files: search files by glob (pattern, optional path, optional limit) — uses fd\n- grep_files: search file contents (pattern, optional path, optional glob, optional limit) — uses rg\n- transfer_file: move file between local and remote (direction='upload'|'download', local_path, remote_path). upload: server reads remote_path and returns content (agent writes to local_path). download: agent must pass `content` field; server writes to remote_path",
      inputSchema: REMOTE_EXEC_INPUT_SCHEMA,
    },
    async (args, extra) => {
      const t0 = Date.now();

      // ===== Schema guardrail =====
      // Catch the common agent failure pattern where the model passes
      // sub-op arguments nested under an "args" wrapper. The MCP SDK
      // would otherwise return "root: must not have additional properties",
      // which is too terse for the model to recover from.
      const schemaGate = checkSchemaShape(args);
      if (schemaGate) return schemaGate;

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
      resetGuardrail(sid);
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
// Transfer HTTP Handlers (Task 5.1)
// ============================================================================

/**
 * POST /transfer?path= — write body bytes to remote path
 * Auth check is performed by the caller (fetch handler).
 */
export async function handleTransferPost(req: Request): Promise<Response> {
  // Auth check (defense-in-depth, also done at fetch handler level)
  if (!checkAuth(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const path = url.searchParams.get("path");

  if (!path) {
    return Response.json({ error: "Missing path query parameter" }, { status: 400 });
  }

  try {
    const buffer = await req.arrayBuffer();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(buffer));
    return Response.json({ bytes: buffer.byteLength }, { headers: corsHeaders });
  } catch (err) {
    return Response.json({ error: `Failed to write file: ${err}` }, { status: 500 });
  }
}

/**
 * GET /transfer?path= — read file bytes from remote path
 * Auth check is performed by the caller (fetch handler).
 */
export async function handleTransferGet(req: Request): Promise<Response> {
  // Auth check (defense-in-depth, also done at fetch handler level)
  if (!checkAuth(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const path = url.searchParams.get("path");

  if (!path) {
    return Response.json({ error: "Missing path query parameter" }, { status: 400 });
  }

  try {
    const content = await readFile(path);
    return new Response(content, {
      headers: { ...corsHeaders, "Content-Type": "application/octet-stream" },
    });
  } catch (err) {
    return Response.json({ error: `Failed to read file: ${err}` }, { status: 500 });
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
};

log(`Satellite MCP Server v${VERSION} starting on port ${PORT}${REMOTE_PATH_PATTERN ? ` (path pattern: ${RAW_PATH_PATTERN})` : ""}`);

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
      return Response.json({ status: "ok", version: VERSION, pathPattern: RAW_PATH_PATTERN || null, sessions: transports.size }, { headers: corsHeaders });
    }

    // Metrics (no auth required — same trust model as /health)
    if (url.pathname === "/metrics") {
      return new Response(metricsText(), { headers: { ...corsHeaders, "Content-Type": "text/plain; version=0.0.4" } });
    }

    // Transfer endpoints (POST /transfer?path= and GET /transfer?path=)
    // These require auth, which is checked below
    if (url.pathname === "/transfer") {
      if (req.method === "POST") {
        return handleTransferPost(req);
      }
      if (req.method === "GET") {
        return handleTransferGet(req);
      }
      return new Response("Method Not Allowed", { status: 405 });
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
              resetGuardrail(sid); // release per-session guardrail counters
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
