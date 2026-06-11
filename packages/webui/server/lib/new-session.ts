import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export interface NewSessionResult {
  sessionId: string;
  sessionFile: string;
}

/**
 * Spawn a new pi session via `pi --mode rpc --new-session --cwd <cwd>`.
 *
 * On success: parses `{type: "session_created", sessionId: "..."}` from stdout
 * and returns {sessionId, sessionFile}.
 *
 * On failure (timeout, non-zero exit, ENOENT, invalid JSON): falls back to
 * generating a random UUID and writing a minimal session header JSONL file.
 *
 * @param cwd - Working directory for the new session
 * @param opts.timeoutMs - Timeout in ms (default: 5000)
 * @param opts.sessionsDir - Override for sessions directory (default: computed from cwd)
 * @returns Promise<{sessionId, sessionFile}>
 */
export async function spawnPiNewSession(
  cwd: string,
  opts: { timeoutMs?: number; sessionsDir?: string } = {},
): Promise<NewSessionResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const sessionsDir = opts.sessionsDir ?? getSessionsDir(cwd);

  try {
    const result = await spawnPiSessionInternal(cwd, timeoutMs, sessionsDir);
    return result;
  } catch (reason) {
    // Fallback to UUID-based session
    return createFallbackSession(cwd, reason, sessionsDir);
  }
}

async function spawnPiSessionInternal(cwd: string, timeoutMs: number, sessionsDir: string): Promise<NewSessionResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let gotNonSessionOutput = false;

    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error(`timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    const args = ["--mode", "rpc", "--new-session", "--cwd", cwd];
    const proc = spawn("pi", args, {
      shell: false,
      timeout: timeoutMs,
      env: { ...process.env, PATH: `${process.env.HOME}/.npm-global/bin:${process.env.PATH}` },
    });

    let stdoutBuffer = "";

    proc.stdout.on("data", (chunk: string | Buffer) => {
      if (settled) return;
      stdoutBuffer += typeof chunk === "string" ? chunk : chunk.toString();

      // Look for a complete JSON line
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex + 1);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "session_created" && parsed.sessionId) {
            if (!settled) {
              settled = true;
              clearTimeout(timeoutId);
              const sessionFile = join(sessionsDir, `${parsed.sessionId}.jsonl`);
              resolve({ sessionId: parsed.sessionId, sessionFile });
            }
          } else if (parsed.type !== undefined) {
            // Got some other valid JSON type, mark that we got output
            gotNonSessionOutput = true;
          }
        } catch {
          // Got something that wasn't valid JSON
          gotNonSessionOutput = true;
        }
      }
    });

    proc.on("error", (err: Error & { code?: string }) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        reject(err);
      }
    });

    proc.once("exit", (code: number | null) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        // Determine the failure reason based on what we observed
        if (gotNonSessionOutput) {
          reject(new Error("invalid JSON output from pi"));
        } else {
          reject(new Error(`process exited with code ${code ?? "null"}`));
        }
      }
    });
  });
}

export function getSessionsDir(cwd: string): string {
  const sessionsBase = process.env.PI_SESSIONS_DIR ?? join(homedir(), ".pi", "agent", "sessions");
  const resolved = resolvePath(cwd);
  // Encoding must match pi core's getDefaultSessionDirPath:
  // resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")
  const safeCwd = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(sessionsBase, safeCwd);
}

function getTimestamp(): string {
  return new Date().toISOString();
}

async function createFallbackSession(
  cwd: string,
  reason: unknown,
  sessionsDir: string,
): Promise<NewSessionResult> {
  const sessionId = randomUUID();
  const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);

  await mkdir(sessionsDir, { recursive: true });

  const header = {
    type: "session",
    id: sessionId,
    timestamp: getTimestamp(),
    cwd,
  };

  await writeFile(sessionFile, JSON.stringify(header) + "\n");

  console.warn("pi --new-session failed, fallback to UUID:", reason);

  return { sessionId, sessionFile };
}
