/**
 * Shared utilities for the satellite MCP server.
 *
 * Consolidates code that was previously inline in satellite-server.ts and
 * adds a realpath cache for HPC filesystems (NFS / Lustre) where each
 * realpath(3) syscall costs 50-200ms. Within a single server process, the
 * same path is canonicalized many times across handler invocations
 * (canonicalize at the top of each handler, plus realpath again inside
 * withFileQueue for the same path). Caching saves N-1 syscalls per
 * repeated path.
 *
 * This file is the only place in the satellite server that imports
 * `node:fs/promises` and `node:child_process` directly; consumers
 * (satellite-server.ts and future test/extension code) should import
 * from here so the public surface is small.
 */

import { realpath } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

// ============================================================================
// Path Canonicalization
// ============================================================================

/**
 * Module-level realpath cache. Keyed by raw input path (not canonical), so
 * `./hpc/foo` and `/hpc/foo` (same file) get separate cache entries — the
 * syscall still happens once per distinct input form, but the common case
 * (agent repeats the same path verbatim) is free.
 *
 * Bounded by REALPATH_CACHE_MAX (LRU eviction) so a long-running daemon
 * that processes N×10⁵ unique paths over its lifetime doesn't grow the
 * cache without bound.
 *
 * NOT invalidated on symlink changes. Symlink creation mid-session is rare
 * in HPC workflows; if it matters, callers can call clearRealpathCache().
 */
const REALPATH_CACHE_MAX = 10_000;
const realpathCache = new Map<string, string>();

export async function cachedRealpath(p: string): Promise<string> {
  const cached = realpathCache.get(p);
  if (cached !== undefined) {
    // Touch for LRU semantics: re-inserting moves the entry to the
    // end of the Map's iteration order. Combined with the size cap
    // below, the first-inserted (least recently used) entry is
    // evicted first.
    realpathCache.delete(p);
    realpathCache.set(p, cached);
    return cached;
  }
  const real = await realpath(p).catch(() => resolve(p));
  realpathCache.set(p, real);
  if (realpathCache.size > REALPATH_CACHE_MAX) {
    // Evict the oldest entry (first iterated by Map).
    const oldest = realpathCache.keys().next().value;
    if (oldest !== undefined) realpathCache.delete(oldest);
  }
  return real;
}

/**
 * Resolve a path to its canonical form. Falls back to plain `resolve(p)`
 * for non-existent paths (e.g. write_file to a new file) so callers can
 * still detect `..` traversal via isParentTraversal.
 */
export async function canonicalize(p: string): Promise<string> {
  return cachedRealpath(p);
}

/**
 * Reject any path whose realpath still contains `..` segments. Cheap regex
 * check that catches bypasses if a handler ever forgets to canonicalize.
 */
export function isParentTraversal(p: string): boolean {
  return /(^|\/)\.\.(\/|$)/.test(p);
}

// ============================================================================
// Process Tree Killing
// ============================================================================

/**
 * Kill an entire process group via the negative-PID SIGKILL trick. Falls
 * back to direct SIGKILL if the process is not a group leader. Mirrors
 * local pi's behavior in `packages/coding-agent/src/utils/shell.ts`.
 */
export function killProcessTree(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

// ============================================================================
// waitForChildProcess (handles stream draining)
// ============================================================================

/**
 * Wait for a child process to exit. Returns the exit code (null if killed
 * or failed). Mirrors local pi's `waitForChildProcess` in
 * `packages/coding-agent/src/utils/child-process.ts`. The "null on
 * error" behavior is intentional — callers that want a strict contract
 * can check `proc.killed` / `proc.signalCode` themselves.
 */
export async function waitForChildProcess(proc: ChildProcess): Promise<number | null> {
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
// Truncation (head-only; used by read_file / list_dir / find_files / grep_files)
// ============================================================================

export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;

export interface TruncationResult {
  text: string;
  truncated: boolean;
  totalLines: number;
  outputLines: number;
}

/**
 * Truncate content from the head (keep first N lines/bytes). Used by file
 * reads and directory listings. Mirrors local pi's
 * `truncateHead` in `packages/coding-agent/src/core/tools/truncate.ts`.
 */
export function truncateHead(
  content: string,
  maxLines: number = MAX_LINES,
  maxBytes: number = MAX_BYTES,
): TruncationResult {
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
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    kept.push(lines[i]);
    bytes += lineBytes;
  }
  if (kept.length >= maxLines && bytes <= maxBytes) truncatedBy = "lines";

  const text = kept.join("\n");
  const suffix = truncatedBy === "lines"
    ? `[Showing first ${kept.length} of ${totalLines} lines (${maxLines} line limit). Use offset to continue.]`
    : `[Showing first ${bytes} of ${totalBytes} bytes (${maxBytes} byte limit). Use offset to continue.]`;

  return {
    text: text + "\n\n" + suffix,
    truncated: true,
    totalLines,
    outputLines: kept.length,
  };
}

// ============================================================================
// OutputAccumulator (streaming output management for bash)
// ============================================================================

/**
 * Incrementally tracks streaming output with bounded memory. Decodes chunks
 * with a streaming UTF-8 decoder, keeps only a decoded tail for display
 * snapshots, and opens a temp file when the full output needs to be
 * preserved. Mirrors local pi's `OutputAccumulator` in
 * `packages/coding-agent/src/core/tools/output-accumulator.ts`.
 *
 * Key fix vs the previous satellite-server.ts version: the snapshot's
 * `totalLines` is computed from the *accumulator's* running count, not
 * from `tail.split("\n").length`. The previous version reported
 * "Showing lines 98001-100000 of 100000" when the actual kept content
 * might have been lines 95001-97000 (because tail was byte-capped to
 * 100KB, not line-capped). Now the label is accurate.
 */
export class OutputAccumulator {
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

    if (
      !this.tempPath &&
      (this.totalRawBytes > MAX_BYTES || this.totalDecodedBytes > MAX_BYTES || this.totalLines > MAX_LINES)
    ) {
      this.tempPath = `/tmp/satellite-bash-${Date.now()}-${randomBytes(4).toString("hex")}.log`;
      void this.flushToTempFile();
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
    } catch {
      /* ignore — temp file is best-effort */
    }
  }

  async finish(): Promise<void> {
    const remaining = this.decoder.decode();
    if (remaining) {
      this.tail += remaining;
      this.totalDecodedBytes += Buffer.byteLength(remaining, "utf-8");
      this.totalLines += (remaining.match(/\n/g) || []).length;
    }

    if (this.tempPath && this.tempFd) {
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

  snapshot(): {
    content: string;
    truncated: boolean;
    totalLines: number;
    outputLines: number;
    tempPath?: string;
  } {
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
      if (bytes + lineBytes > MAX_BYTES) {
        truncatedBy = "bytes";
        break;
      }
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
// Re-exports for convenience (saves consumers from importing node:path too)
// ============================================================================

export { join, dirname, basename };
