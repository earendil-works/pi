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
import { join, dirname, resolve } from "node:path";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod/v3";

// ============================================================================
// Config
// ============================================================================

const TOKEN = process.env.SATELLITE_TOKEN || "";
const PORT = parseInt(process.env.SATELLITE_PORT || "29001", 10);

if (!TOKEN) {
  console.error("ERROR: SATELLITE_TOKEN environment variable is required");
  process.exit(1);
}

// ============================================================================
// Logging
// ============================================================================

const LOG_FILE = "/tmp/satellite.log";

try { mkdirSync("/tmp", { recursive: true }); } catch { /* ignore */ }

function log(msg: string): void {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  const line = `[${ts}] ${msg}`;
  console.error(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch { /* ignore */ }
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
const REMOTE_EXEC_SCHEMA = z.discriminatedUnion("tool", [
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
]);

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
    path: z.string(),
    limit: z.number().optional(),
  }),
};

// ============================================================================
// Tool Handlers
// ============================================================================

async function handleReadFile(args: { path: string; offset?: number; limit?: number }) {
  const t0 = Date.now();
  try {
    let content = await readFile(args.path, "utf-8");

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

    log(`read_file ${args.path} → ok ${Date.now() - t0}ms (${content.length} bytes${result.truncated ? `, truncated: ${result.outputLines}/${result.totalLines} lines` : ""})`);
    return { content: textContent(result.text + continuation) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`read_file ${args.path} → error ${Date.now() - t0}ms: ${msg}`);
    return { content: textContent(`Error: ${msg}`), isError: true };
  }
}

async function handleWriteFile(args: { path: string; content: string }) {
  const t0 = Date.now();
  try {
    return await withFileQueue(args.path, async () => {
      await mkdir(dirname(args.path), { recursive: true });
      await writeFile(args.path, args.content, "utf-8");
      const bytes = Buffer.byteLength(args.content, "utf-8");
      log(`write_file ${args.path} → ok ${Date.now() - t0}ms (${bytes} bytes)`);
      return { content: textContent(`Successfully wrote ${bytes} bytes to ${args.path}`) };
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`write_file ${args.path} → error ${Date.now() - t0}ms: ${msg}`);
    return { content: textContent(`Error: ${msg}`), isError: true };
  }
}

async function handleEditFile(args: { path: string; edits: Array<{ oldText: string; newText: string }> }) {
  const t0 = Date.now();
  try {
    return await withFileQueue(args.path, async () => {
      let content = await readFile(args.path, "utf-8");

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

      await writeFile(args.path, content, "utf-8");

      const diff = generateDiff(args.edits);
      log(`edit_file ${args.path} → ok ${Date.now() - t0}ms (${args.edits.length} edits)`);
      return { content: textContent(`Successfully replaced ${args.edits.length} block(s) in ${args.path}.\n\n${diff}`) };
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`edit_file ${args.path} → error ${Date.now() - t0}ms: ${msg}`);
    return { content: textContent(`Error: ${msg}`), isError: true };
  }
}

async function handleBash(
  args: { command: string; timeout?: number; cwd?: string },
  abortSignal?: AbortSignal,
  progressCtx?: ProgressContext,
) {
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

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (args.timeout !== undefined && args.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        cleanup();
      }, args.timeout * 1000);
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
    if (timedOut) output.push(`Command timed out after ${args.timeout} seconds`);

    const raw = output.join("\n") || "(no output)";

    if (snapshot.truncated && snapshot.tempPath) {
      try { await writeFile(snapshot.tempPath, raw, "utf-8"); } catch { /* ignore */ }
    }

    log(`bash "${args.command.slice(0, 80)}" → ${exitCode === 0 ? "ok" : "error"} ${duration}ms${snapshot.truncated ? ` (truncated: ${snapshot.outputLines}/${snapshot.totalLines} lines)` : ""}${timedOut ? " (timed out)" : ""}`);

    return { content: textContent(raw) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`bash "${args.command.slice(0, 80)}" → error ${Date.now() - t0}ms: ${msg}`);
    return { content: textContent(`Error: ${msg}`), isError: true };
  }
}

async function handleListDir(args: { path: string; limit?: number }) {
  const t0 = Date.now();
  try {
    const maxEntries = args.limit || MAX_LS_ENTRIES;
    const dirEntries = await readdir(args.path, { withFileTypes: true });

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

    log(`list_dir ${args.path} → ok ${Date.now() - t0}ms (${dirEntries.length} entries)`);
    return { content: textContent(output || "(empty directory)") };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`list_dir ${args.path} → error ${Date.now() - t0}ms: ${msg}`);
    return { content: textContent(`Error: ${msg}`), isError: true };
  }
}

// ============================================================================
// Tool Router
// ============================================================================

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const TOOL_HANDLERS: Record<string, (
  args: Record<string, unknown>,
  abortSignal?: AbortSignal,
  progressCtx?: ProgressContext,
) => Promise<ToolResult>> = {
  read_file: (args) => handleReadFile(args as { path: string; offset?: number; limit?: number }),
  write_file: (args) => handleWriteFile(args as { path: string; content: string }),
  edit_file: (args) => handleEditFile(args as { path: string; edits: Array<{ oldText: string; newText: string }> }),
  bash: (args, abortSignal, progressCtx) => handleBash(
    args as { command: string; timeout?: number; cwd?: string },
    abortSignal,
    progressCtx,
  ),
  list_dir: (args) => handleListDir(args as { path: string; limit?: number }),
};

// ============================================================================
// MCP Server Factory
// ============================================================================

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "satellite",
    version: "3.0.0",
  });

  server.registerTool(
    "remote_exec",
    {
      description: "Run file and shell operations on the remote HPC server. Choose one operation by setting the tool parameter:\n\n- bash: execute a shell command (command, optional timeout in ms, optional cwd)\n- read_file: read file contents (path, optional offset, optional limit)\n- write_file: create or overwrite a file (path, content)\n- edit_file: apply text edits (path, edits[{oldText, newText}])\n- list_dir: list directory entries (default path \".\", optional limit, default 500)",
      inputSchema: REMOTE_EXEC_SCHEMA,
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

      const result = await handler(toolArgs, extra.signal, progressCtx);
      log(`remote_exec → ${tool} ${Date.now() - t0}ms`);
      return result;
    }
  );

  return server;
}

// ============================================================================
// HTTP Server
// ============================================================================

const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

function checkAuth(req: Request): boolean {
  const auth = req.headers.get("Authorization");
  return auth === `Bearer ${TOKEN}`;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
};

log(`Satellite MCP Server v3.0.0 starting on port ${PORT}`);

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
      return Response.json({ status: "ok", version: "3.0.0" }, { headers: corsHeaders });
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
        } else if (!sessionId && isInitializeRequest(body)) {
          // New initialization request
          const newSessionId = randomUUID();
          transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => newSessionId,
            onsessioninitialized: (sid) => {
              transports.set(sid, transport);
              log(`Session initialized: ${sid}`);
            },
          });
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && transports.has(sid)) {
              transports.delete(sid);
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
