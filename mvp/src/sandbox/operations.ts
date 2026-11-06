/**
 * Sandbox-backed tool operations for the NLT Coding Agent.
 *
 * The Pi coding-agent tools (bash, read, write, edit, ls, find) take swappable "operations" objects. These
 * implementations run them inside a Vercel Sandbox instead of on the machine that hosts the agent loop.
 *
 * Authority model (see AGENTS.md): the sandbox is the execution environment ("AgentOS" stand-in), not an
 * authority. It does not decide what the agent may do. Every call is first reviewed by the harness policy
 * (`reviewToolCall`), and these operations add their own containment on top:
 *   - file paths are confined to one workspace root, including after symlink resolution;
 *   - the host process environment is never forwarded into the sandbox;
 *   - every command has a timeout, and output and file sizes are capped;
 *   - anything unexpected is an error, never a pass (fail closed).
 *
 * This module only builds operations around a sandbox handle it is given. It never creates a sandbox,
 * reads credentials, or opens a network connection, and nothing in the application calls it yet.
 */

import { posix } from "node:path";
import { Writable } from "node:stream";
import type {
  BashOperations,
  EditOperations,
  FindOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { reviewToolCall, type ToolPolicyDecision } from "../harness/policy.ts";

/** The part of a Vercel Sandbox these operations use. A real `Sandbox` satisfies it (checked in the tests). */
export interface SandboxLike {
  runCommand(params: {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdout?: Writable;
    stderr?: Writable;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<{ exitCode: number | null }>;
  fs: {
    readFile(path: string): Promise<Buffer>;
    writeFile(path: string, data: string | Buffer | Uint8Array): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined | void>;
    access(path: string): Promise<void>;
    realpath(path: string): Promise<string>;
  };
}

/** Thrown when a call is refused. The call was not run. */
export class SandboxPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPolicyError";
  }
}

export interface SandboxOperationsOptions {
  /** Absolute workspace directory inside the sandbox. All file paths and the command cwd must stay inside it. */
  root: string;
  /** Reviews a tool call before it runs. Defaults to the vendored harness `reviewToolCall`. */
  review?: (toolName: string, input: Record<string, unknown>) => ToolPolicyDecision;
  /** Largest file read, in bytes. Default 10 MiB. */
  maxReadBytes?: number;
  /** Largest file write, in bytes. Default 2 MiB. */
  maxWriteBytes?: number;
  /** Timeout applied to a command that does not ask for one, in ms. Default 2 minutes. */
  defaultTimeoutMs?: number;
  /** Longest timeout a command may ask for, in ms. Default 10 minutes. */
  maxTimeoutMs?: number;
  /** Most command output forwarded to the agent, in bytes. Output beyond this is dropped. Default 1 MiB. */
  maxOutputBytes?: number;
  /**
   * Fixed environment for commands, for example `{ CI: "1" }`. Defaults to none. The caller's environment is
   * never forwarded, so host secrets cannot reach the sandbox through the shell tool.
   */
  commandEnv?: Record<string, string>;
}

export interface SandboxToolOperations {
  bash: BashOperations;
  read: ReadOperations;
  write: WriteOperations;
  edit: EditOperations;
  ls: LsOperations;
  find: FindOperations;
}

/** Deepest directory the `find` tool will descend, so a pathological tree cannot loop the walk. */
const FIND_MAX_DEPTH = 64;

/** Converts a pi glob pattern (`**`, `*`, `?`) to a regular expression; `**` spans directory separators. */
function globToRegExp(pattern: string): RegExp {
  let source = "^";
  const segments = pattern.split("/");
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      source += last ? ".*" : "(?:.*/)?";
      return;
    }
    source += segment.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
    if (!last) source += "/";
  });
  return new RegExp(`${source}$`);
}

const DEFAULTS = {
  maxReadBytes: 10 * 1024 * 1024,
  maxWriteBytes: 2 * 1024 * 1024,
  defaultTimeoutMs: 2 * 60 * 1000,
  maxTimeoutMs: 10 * 60 * 1000,
  maxOutputBytes: 1024 * 1024,
} as const;

function requireRoot(root: string): string {
  if (typeof root !== "string" || !posix.isAbsolute(root) || root.includes("\0")) {
    throw new SandboxPolicyError("The sandbox workspace root must be an absolute path");
  }
  const normalized = posix.normalize(root).replace(/\/+$/, "");
  // "/" would make "inside the workspace" mean everything.
  if (normalized === "" || normalized === "/") {
    throw new SandboxPolicyError("The sandbox workspace root must not be the filesystem root");
  }
  return normalized;
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function requireLimit(name: string, value: number): number {
  // NaN and fractions would otherwise make the size comparisons false and let oversized data through.
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SandboxPolicyError(`${name} must be a non-negative integer`);
  }
  return value;
}

export function createSandboxToolOperations(
  sandbox: SandboxLike,
  options: SandboxOperationsOptions,
): SandboxToolOperations {
  const root = requireRoot(options.root);
  const review = options.review ?? reviewToolCall;
  const maxReadBytes = requireLimit("maxReadBytes", options.maxReadBytes ?? DEFAULTS.maxReadBytes);
  const maxWriteBytes = requireLimit("maxWriteBytes", options.maxWriteBytes ?? DEFAULTS.maxWriteBytes);
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULTS.defaultTimeoutMs;
  const maxTimeoutMs = options.maxTimeoutMs ?? DEFAULTS.maxTimeoutMs;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULTS.maxOutputBytes;
  const commandEnv = options.commandEnv ? { ...options.commandEnv } : undefined;

  let realRootPromise: Promise<string> | undefined;
  const realRoot = (): Promise<string> => {
    realRootPromise ??= sandbox.fs.realpath(root).then(
      (resolved) => posix.normalize(resolved),
      (error: unknown) => {
        // Do not cache a failure: a transient error must not make every later call fail.
        realRootPromise = undefined;
        throw error;
      },
    );
    return realRootPromise;
  };

  function authorize(toolName: string, input: Record<string, unknown>): void {
    const decision = review(toolName, input);
    if (decision.allow !== true) {
      throw new SandboxPolicyError(decision.reason ?? `Blocked by policy: ${toolName}`);
    }
  }

  /** Lexical check: an absolute or relative path that stays under the root once normalized. */
  function confine(path: string): string {
    if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
      throw new SandboxPolicyError("Invalid path");
    }
    const absolute = posix.isAbsolute(path) ? path : posix.join(root, path);
    const normalized = posix.normalize(absolute).replace(/\/+$/, "") || "/";
    if (!within(root, normalized)) {
      throw new SandboxPolicyError(`Path is outside the sandbox workspace: ${path}`);
    }
    return normalized;
  }

  /**
   * Resolves symlinks for the path, or for its nearest existing ancestor when the path does not exist yet
   * (a file about to be created), and requires the result to stay inside the real workspace root. Returns the
   * lexical path and the resolved one; the resolved path is the one that is authorized and used for I/O.
   *
   * This is a check made just before use, not an atomic check-and-use: the sandbox SDK takes a path and resolves
   * it again. The sandbox, not this check, is the security boundary (see the README).
   */
  async function confineReal(path: string): Promise<{ lexical: string; real: string }> {
    const lexical = confine(path);
    const base = await realRoot();
    let probe = lexical;
    let suffix = "";
    // Bounded by path depth, so the walk upward can never loop even if a check above is wrong.
    for (let remaining = lexical.split("/").length; remaining > 0; remaining -= 1) {
      try {
        const resolved = posix.normalize(await sandbox.fs.realpath(probe));
        if (!within(base, resolved)) {
          throw new SandboxPolicyError(`Path resolves outside the sandbox workspace: ${path}`);
        }
        return { lexical, real: suffix ? posix.join(resolved, suffix) : resolved };
      } catch (error) {
        if (error instanceof SandboxPolicyError) throw error;
        // A link that points nowhere resolves to nothing, so climbing past it would let a write create its target.
        if (await isSymlink(probe)) throw new SandboxPolicyError(`Path is a link that does not resolve: ${path}`);
        if (probe === root) throw error;
        suffix = suffix ? posix.join(posix.basename(probe), suffix) : posix.basename(probe);
        probe = posix.dirname(probe);
        // The walk upward may never leave the workspace.
        if (!within(root, probe)) {
          throw new SandboxPolicyError(`Path is outside the sandbox workspace: ${path}`);
        }
      }
    }
    throw new SandboxPolicyError(`Could not resolve path inside the sandbox workspace: ${path}`);
  }

  async function isSymlink(path: string): Promise<boolean> {
    const result = await sandbox.runCommand({ cmd: "test", args: ["-L", path], timeoutMs: 15_000 });
    return result.exitCode === 0;
  }

  /** Reviews both the path as given and where it really points, so a link cannot hide a sensitive target. */
  function authorizePath(toolName: string, paths: { lexical: string; real: string }): void {
    authorize(toolName, { path: paths.lexical });
    if (paths.real !== paths.lexical) authorize(toolName, { path: paths.real });
  }

  async function prepareRead(path: string, toolName: "read" | "edit"): Promise<string> {
    const paths = await confineReal(path);
    authorizePath(toolName, paths);
    return paths.real;
  }

  /** File size in bytes, asked of the sandbox before any content is transferred. Unknown is an error. */
  async function sizeOf(path: string): Promise<number> {
    let out = "";
    const collect = new Writable({
      write(chunk: Buffer, _encoding, done) {
        out += chunk.toString("utf8");
        done();
      },
    });
    const probe = await sandbox.runCommand({ cmd: "stat", args: ["-c", "%s", "--", path], stdout: collect, timeoutMs: 15_000 });
    const size = Number(out.trim());
    if (probe.exitCode !== 0 || !/^\d+$/.test(out.trim()) || !Number.isSafeInteger(size)) {
      throw new SandboxPolicyError(`Could not determine the size of: ${path}`);
    }
    return size;
  }

  async function readCapped(path: string): Promise<Buffer> {
    if ((await sizeOf(path)) > maxReadBytes) {
      throw new SandboxPolicyError(`File is larger than the ${maxReadBytes} byte read limit: ${path}`);
    }
    const data = await sandbox.fs.readFile(path);
    // The file may have grown since the probe.
    if (data.byteLength > maxReadBytes) {
      throw new SandboxPolicyError(`File is larger than the ${maxReadBytes} byte read limit: ${path}`);
    }
    return data;
  }

  async function writeCapped(path: string, content: string, toolName: "write" | "edit"): Promise<void> {
    if (Buffer.byteLength(content, "utf8") > maxWriteBytes) {
      throw new SandboxPolicyError(`Content is larger than the ${maxWriteBytes} byte write limit`);
    }
    const paths = await confineReal(path);
    authorizePath(toolName, paths);
    await sandbox.fs.writeFile(paths.real, content);
  }

  const bash: BashOperations = {
    async exec(command, cwd, execOptions) {
      if (typeof command !== "string" || command.trim().length === 0) {
        throw new SandboxPolicyError("Empty command");
      }
      if (execOptions.signal?.aborted) throw new Error("aborted");
      authorize("bash", { command });
      const dir = await confineReal(cwd);
      authorizePath("bash", dir);
      const workDir = dir.real;

      // Never forward the caller's environment (execOptions.env): it comes from the host process.
      let timeoutMs = defaultTimeoutMs;
      if (execOptions.timeout !== undefined) {
        const requested = execOptions.timeout > 0 ? execOptions.timeout * 1000 : defaultTimeoutMs;
        timeoutMs = Math.min(requested, maxTimeoutMs);
      }

      let forwarded = 0;
      const sink = new Writable({
        write(chunk: Buffer, _encoding, done) {
          const remaining = maxOutputBytes - forwarded;
          if (remaining > 0) {
            const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
            forwarded += slice.byteLength;
            execOptions.onData(Buffer.from(slice));
          }
          done();
        },
      });

      const finished = await sandbox.runCommand({
        cmd: "bash",
        args: ["-c", command],
        cwd: workDir,
        env: commandEnv,
        stdout: sink,
        stderr: sink,
        signal: execOptions.signal,
        timeoutMs,
      });
      return { exitCode: finished.exitCode };
    },
  };

  const read: ReadOperations = {
    async readFile(path) {
      return readCapped(await prepareRead(path, "read"));
    },
    async access(path) {
      await sandbox.fs.access(await prepareRead(path, "read"));
    },
    // Image detection is left out on purpose: it would be another read path to review.
  };

  const write: WriteOperations = {
    async writeFile(path, content) {
      await writeCapped(path, content, "write");
    },
    async mkdir(dir) {
      const paths = await confineReal(dir);
      authorizePath("write", paths);
      await sandbox.fs.mkdir(paths.real, { recursive: true });
    },
  };

  const edit: EditOperations = {
    async readFile(path) {
      return readCapped(await prepareRead(path, "edit"));
    },
    async writeFile(path, content) {
      await writeCapped(path, content, "edit");
    },
    async access(path) {
      await sandbox.fs.access(await prepareRead(path, "edit"));
    },
  };

  /** Confines a discovery tool's path to the workspace root and reviews it,
   * returning the validated/resolved path that callers must use for I/O. */
  async function authorizeDiscovery(toolName: string, path: string): Promise<string> {
    const paths = await confineReal(path);
    authorizePath(toolName, paths);
    return paths.real;
  }

  async function isDirectory(path: string): Promise<boolean> {
    const result = await sandbox.runCommand({ cmd: "test", args: ["-d", path], timeoutMs: 15_000 });
    return result.exitCode === 0;
  }

  /** Lists one directory inside the workspace through the sandbox shell, as entry names. */
  async function listDirectory(path: string, timeoutMs = 15_000): Promise<string[]> {
    const entries = await new Promise<string>((resolve, reject) => {
      let out = "";
      const sink = new Writable({
        write(chunk: Buffer, _encoding, done) {
          out += chunk.toString("utf8");
          done();
        },
      });
      sandbox
        .runCommand({
          cmd: "ls",
          args: ["-1", "--", path],
          cwd: path,
          stdout: sink,
          stderr: sink,
          timeoutMs,
        })
        .then(
          (result) => {
            if (result.exitCode !== 0) reject(new Error(`Could not list the directory: ${path}`));
            else resolve(out);
          },
          reject,
        );
    });
    return entries.split("\n").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  }

  const ls: LsOperations = {
    async exists(path) {
      const real = await authorizeDiscovery("ls", path);
      try {
        await sandbox.fs.access(real);
        return true;
      } catch {
        return false;
      }
    },
    async stat(path) {
      const real = await authorizeDiscovery("ls", path);
      const directory = await isDirectory(real);
      return { isDirectory: () => directory };
    },
    async readdir(path) {
      const real = await authorizeDiscovery("ls", path);
      return listDirectory(real);
    },
  };

  const find: FindOperations = {
    async exists(path) {
      const real = await authorizeDiscovery("find", path);
      try {
        await sandbox.fs.access(real);
        return true;
      } catch {
        return false;
      }
    },
    async glob(pattern, cwd, { ignore, limit }) {
      const realCwd = await authorizeDiscovery("find", cwd);
      const matcher = globToRegExp(pattern);
      const ignored = ignore.map(globToRegExp);
      // Patterns without a directory separator (e.g., "*.ts") use recursive
      // basename matching: they match any file with that basename at any depth.
      const basenameMatcher = pattern.includes("/") ? null : matcher;
      const results: string[] = [];
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (results.length >= limit) return;
        const entries = await listDirectory(dir);
        for (const entry of entries) {
          const child = dir === "/" ? `/${entry}` : `${dir}/${entry}`;
          // Re-confine each discovered path so `..` entries cannot escape the workspace root.
          let confined: string;
          try {
            confined = confine(child);
          } catch {
            continue; // lexical confinement failure (e.g., `..` escaping)
          }
          const relativePath =
            realCwd === "/" ? confined.slice(1) : confined.slice(realCwd.length + 1);
          if (ignored.some((re) => re.test(relativePath))) continue;
          // Match globs against paths relative to the search directory (Pi
          // semantics). Basename-only patterns (no "/") also match against the
          // entry name at any depth (recursive basename semantics).
          const matches =
            (basenameMatcher ? basenameMatcher.test(entry) : false) ||
            matcher.test(relativePath);
          if (matches) {
            results.push(confined);
            if (results.length >= limit) return;
          }
          // Resolve symlinks and authorize each discovered directory before
          // descending, so a symlink target outside the workspace is never
          // traversed.
          if (depth < FIND_MAX_DEPTH) {
            try {
              const resolved = await confineReal(child);
              // Regular files are never descended into (a file is not a valid cwd).
              if (!(await isDirectory(resolved.real))) continue;
              await walk(resolved.real, depth + 1);
            } catch {
              // Symlink target outside workspace or unresolvable — skip.
              continue;
            }
          }
        }
      };
      await walk(realCwd, 0);
      return results;
    },
  };

  return { bash, read, write, edit, ls, find };
}

/** Network policy for a new sandbox when the caller does not choose one. Outbound traffic is denied. */
export const DEFAULT_SANDBOX_NETWORK_POLICY = "deny-all" as const;
