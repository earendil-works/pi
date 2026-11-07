/**
 * Embedding runner for the memory layer. Runs `embed.py` inside a Vercel Sandbox using
 * `BAAI/bge-small-en-v1.5` ONNX int8 weights pre-installed by the owner at EMBED_MODEL_DIR.
 *
 * The model must be installed manually once by the owner into the persistent sandbox before
 * enabling NLT_MEMORY_ENABLED=1. See docs/superpowers/specs/2026-11-06-neon-pgvector-memory-design.md §9.
 *
 * This module never creates a sandbox, acquires a lock, or reads credentials. The caller
 * supplies a SandboxLike handle (either the agent turn's already-locked sandbox, or a handle
 * acquired by /api/embed with a short-wait lock).
 *
 * Text is written to a temp file via the sandbox fs API (not shell args) and passed to
 * embed.py via stdin redirect. The temp file is removed after the script exits.
 *
 * Returns null on any failure — callers fall back to pg_trgm text similarity.
 */

import { Writable } from "node:stream";
import type { SandboxLike } from "../sandbox/operations.ts";

export const EMBED_MODEL_DIR = "/vercel/sandbox/models/bge-small";
export const EMBED_SCRIPT_PATH = `${EMBED_MODEL_DIR}/embed.py`;
export const EMBED_VECTOR_DIM = 384;
export const EMBED_TIMEOUT_MS = 15_000;

export interface EmbedRunner {
  embed(text: string, sandbox: SandboxLike, timeoutMs?: number): Promise<number[] | null>;
}

/** Validates that raw is a finite float array of exactly EMBED_VECTOR_DIM elements. */
export function validateVector(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length !== EMBED_VECTOR_DIM) return null;
  if (!raw.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  return raw as number[];
}

export function createEmbedRunner(): EmbedRunner {
  return {
    async embed(text, sandbox, timeoutMs = EMBED_TIMEOUT_MS) {
      if (typeof text !== "string" || text.length === 0) return null;
      // Use a timestamp+random suffix so concurrent embed calls don't collide.
      const tmpPath = `/tmp/nlt-embed-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
      try {
        // Write text via fs API (not a shell argument) to avoid injection.
        await sandbox.fs.writeFile(tmpPath, text);

        let out = "";
        const sink = new Writable({
          write(chunk: Buffer, _enc, done) {
            out += chunk.toString("utf8");
            done();
          },
        });

        // Pass text via stdin redirect from the temp file. Both paths are fixed
        // constants or generated safe names — no user text reaches the shell args.
        const run = await sandbox.runCommand({
          cmd: "bash",
          args: ["-c", `python3 "${EMBED_SCRIPT_PATH}" < "${tmpPath}"`],
          stdout: sink,
          timeoutMs,
        });

        if (run.exitCode !== 0) return null;
        const trimmed = out.trim();
        if (!trimmed) return null;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return null;
        }
        return validateVector(parsed);
      } catch {
        return null;
      } finally {
        // Best-effort cleanup of the temp file; failure is silent.
        sandbox.runCommand({ cmd: "rm", args: ["-f", "--", tmpPath], timeoutMs: 5_000 }).catch(() => undefined);
      }
    },
  };
}
