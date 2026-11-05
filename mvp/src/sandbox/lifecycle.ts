/**
 * Lifecycle for the agent's one sandbox.
 *
 * The owner's Vercel plan allows one sandbox (and Hobby caps a session at 45 minutes), so the agent uses
 * exactly one fixed-name, persistent sandbox that is found or created on demand, never one per
 * conversation, and runs at most one turn in it at a time. The settings here are deliberately small:
 * one vCPU, outbound network limited to a short list of named domains, a bounded session length.
 *
 * This module is written against a small `SandboxClient` interface. It never imports the Vercel SDK, never
 * reads credentials, and nothing in the application calls it yet. The real client is in `vercel-client.ts`.
 */

import { randomUUID } from "node:crypto";
import { SandboxPolicyError, type SandboxLike } from "./operations.ts";

/** The one sandbox's name. It identifies the sandbox within the Vercel project, so it is stable on purpose. */
export const AGENT_SANDBOX_NAME = "nlt-agent";

/** Hobby caps a session at 45 minutes; stay clear of the cap. */
export const MAX_SESSION_MS = 40 * 60 * 1000;
export const DEFAULT_SESSION_MS = 30 * 60 * 1000;
const MIN_SESSION_MS = 60 * 1000;

/** Longest a turn may hold the lock before it is considered abandoned. */
export const DEFAULT_LOCK_STALE_MS = 15 * 60 * 1000;

const DEFAULT_LOCK_PATH = "/tmp/nlt-agent.lock";
const LOCK_PATH_PATTERN = /^\/tmp(\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}){1,2}$/;
const BUSY_EXIT_CODE = 75;
const SNAPSHOT_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;

/** Thrown when a turn outlived its deadline and did not stop. The lock is left to expire, not released. */
export class SandboxTurnTimeoutError extends Error {
  constructor() {
    super("The sandbox turn did not stop at its deadline");
    this.name = "SandboxTurnTimeoutError";
  }
}

/** Thrown when another turn holds the sandbox. The caller should tell the user to wait, not retry in a loop. */
export class SandboxBusyError extends Error {
  constructor() {
    super("The sandbox is busy with another turn");
    this.name = "SandboxBusyError";
  }
}

export type AgentNetworkPolicy = "deny-all" | "allow-all" | { allow: string[] };

/**
 * Named groups of exact domains the sandbox may reach. Owner decision (2026-11-05): outbound access is allowed
 * for package installs and public git clones. No credentials are placed in the sandbox, so these domains give
 * read access to public content; they do not give a way to publish or push.
 */
export const EGRESS_PRESETS = {
  packages: ["registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org"],
  git: ["github.com", "codeload.github.com", "*.githubusercontent.com"],
} as const;
export type EgressPreset = keyof typeof EGRESS_PRESETS;

/** What the agent's sandbox may reach when the caller does not say otherwise. */
export const DEFAULT_AGENT_EGRESS: readonly EgressPreset[] = ["packages", "git"];

export interface AgentSandboxParams {
  name: string;
  persistent: true;
  /** Session length in ms. */
  timeout: number;
  resources: { vcpus: number };
  networkPolicy: AgentNetworkPolicy;
  keepLastSnapshots: { count: number; expiration: number };
}

export interface AgentSandboxOptions {
  /** Session length in ms, clamped to 1 minute .. `MAX_SESSION_MS`. Default 30 minutes. */
  sessionMs?: number;
  /** Virtual CPUs, 1 or 2. Default 1, to keep the plan's allowance. */
  vcpus?: number;
  /**
   * Named groups of allowed domains. Default `DEFAULT_AGENT_EGRESS` (package registries and GitHub). Pass an empty
   * list, with no `egressAllow`, to deny all outbound traffic.
   */
  egressPresets?: readonly EgressPreset[];
  /**
   * Extra exact domains the sandbox may reach (for example `registry.npmjs.org` or `*.npmjs.org`), added to the
   * presets. This list stays least-privilege; use `egressAll` to allow every host.
   */
  egressAllow?: readonly string[];
  /**
   * Allow all outbound traffic. Off unless a caller sets it explicitly; the owner asked for this as an option
   * (2026-11-05). It overrides the presets and `egressAllow`. The default stays the named allowlist. With no
   * credentials in the sandbox this exposes nothing to read, but it lets the agent send anything it can see
   * (the workspace) to any host, so it should be a deliberate, per-environment choice.
   * Caller contract: only the agent route may set this, derived from an owner-set per-environment flag; model output
   * and tools must never reach it. Nothing here records who set it, so the route should log the effective policy.
   */
  egressAll?: boolean;
  /**
   * How long a lock may sit before another turn may take it over, in ms. A turn is told to stop (its signal
   * aborts) at 80% of this, so it has stopped before the lock can be taken over.
   */
  lockStaleMs?: number;
  /**
   * Absolute time (epoch ms) by which the whole invocation must have settled, set by the route at entry. Setup
   * stages are cut off at it, and the turn is aborted early enough to stop and settle by it. Without it the
   * turn gets a fresh window of 80% of the stale age after setup.
   */
  deadlineAt?: number;
  /** Where the lock lives inside the sandbox. One or two plain path segments under /tmp. Tests use this; callers normally do not. */
  lockPath?: string;
}

// A hostname, or a "*." wildcard in front of one. Not "*", not a scheme, port, path or whitespace.
const DOMAIN_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function presetDomains(presets: readonly EgressPreset[]): string[] {
  const domains: string[] = [];
  for (const preset of presets) {
    if (!Object.hasOwn(EGRESS_PRESETS, preset)) throw new SandboxPolicyError(`Unknown egress preset: ${String(preset)}`);
    domains.push(...EGRESS_PRESETS[preset]);
  }
  return domains;
}

function validateEgress(domains: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const domain of domains) {
    if (typeof domain !== "string" || !DOMAIN_PATTERN.test(domain)) {
      throw new SandboxPolicyError(`Not an allowed egress domain: ${String(domain)}`);
    }
    unique.add(domain.toLowerCase());
  }
  return [...unique];
}

/** Builds the settings for the agent's sandbox, refusing anything outside the safe envelope. */
export function agentSandboxParams(options: AgentSandboxOptions = {}): AgentSandboxParams {
  // The name is fixed: a different name would make getOrCreate build a second sandbox.
  const name = AGENT_SANDBOX_NAME;

  const requested = options.sessionMs ?? DEFAULT_SESSION_MS;
  if (!Number.isFinite(requested)) throw new SandboxPolicyError("Invalid session length");
  const timeout = Math.min(Math.max(Math.floor(requested), MIN_SESSION_MS), MAX_SESSION_MS);

  const vcpus = options.vcpus ?? 1;
  if (!Number.isInteger(vcpus) || vcpus < 1 || vcpus > 2) throw new SandboxPolicyError("vcpus must be 1 or 2");

  if (options.egressAll !== undefined && typeof options.egressAll !== "boolean") {
    throw new SandboxPolicyError("egressAll must be true or false");
  }
  // In allow-all mode the preset and domain lists are unused, so they are not validated (and cannot misdirect an error).
  const egress =
    options.egressAll === true
      ? []
      : validateEgress([...presetDomains(options.egressPresets ?? DEFAULT_AGENT_EGRESS), ...(options.egressAllow ?? [])]);
  const networkPolicy: AgentNetworkPolicy = options.egressAll === true ? "allow-all" : egress.length > 0 ? { allow: egress } : "deny-all";

  return {
    name,
    persistent: true,
    timeout,
    resources: { vcpus },
    networkPolicy,
    keepLastSnapshots: { count: 1, expiration: SNAPSHOT_EXPIRATION_MS },
  };
}

/** What the lifecycle needs of a sandbox beyond running tools: changing its outbound policy. */
export interface AgentSandbox extends SandboxLike {
  updateNetworkPolicy(policy: AgentNetworkPolicy): Promise<unknown>;
}

export interface SandboxClient {
  /** Finds the sandbox by name, resuming it if stopped, or creates it with these settings. Never creates a second. */
  getOrCreate(params: AgentSandboxParams): Promise<AgentSandbox>;
}

/**
 * Takes the lock with one shell command. Exit 0 means acquired; exit 75 means another turn holds it; any other
 * exit is a failure to lock. The lock is a directory holding the owner's token.
 *
 * A lock older than the stale age is taken over under a second, short-lived mutex (`<lock>.reap`, also made with
 * the atomic `mkdir`): only the process holding it may judge the lock stale, re-check its age, and replace it.
 * Two takeovers therefore cannot interleave. A reap mutex left behind by a killed process expires on the same
 * age. One window remains, a few milliseconds wide: if the owner releases and a new turn acquires between the
 * re-check and the removal, the new lock is removed. The turn deadline (see `withAgentSandbox`) bounds the cost.
 * All values arrive as positional arguments, never interpolated into the script.
 */
export const ACQUIRE_SCRIPT = [
  'L="$1"; T="$2"; S="$3"; M="$1.reap"',
  'age() { m=$(stat -c %Y "$1" 2>/dev/null) || return 1; echo $(( $(date +%s) - m )); }',
  'take() { if mkdir "$L" 2>/dev/null; then printf %s "$T" > "$L/owner" && return 0; rmdir "$L" 2>/dev/null; return 1; fi; return 2; }',
  'take; r=$?; [ "$r" -eq 0 ] && exit 0; [ "$r" -eq 1 ] && exit 1',
  'if [ ! -d "$L" ]; then take; r=$?; [ "$r" -eq 0 ] && exit 0; [ -d "$L" ] && exit 75; exit 1; fi',
  'a=$(age "$L") || exit 75',
  '[ "$a" -gt "$S" ] || exit 75',
  'if ! mkdir "$M" 2>/dev/null; then',
  '  c=$(age "$M") || exit 75',
  '  [ "$c" -gt "$S" ] && rmdir "$M" 2>/dev/null',
  '  exit 75',
  'fi',
  'a=$(age "$L") || { rmdir "$M" 2>/dev/null; exit 75; }',
  'if [ "$a" -gt "$S" ]; then rm -rf "$L"; take; r=$?; rmdir "$M" 2>/dev/null; [ "$r" -eq 0 ] && exit 0; [ "$r" -eq 1 ] && exit 1; exit 75; fi',
  'rmdir "$M" 2>/dev/null',
  'exit 75',
].join("\n");

/** Releases the lock only if it still carries this turn's token. */
const RELEASE_SCRIPT = '[ "$(cat "$1/owner" 2>/dev/null)" = "$2" ] && rm -rf "$1"; exit 0';

/** Rejects with `SandboxTurnTimeoutError` if `work` has not settled by `deadlineAt`. The work itself is not cancelled. */
export function withinDeadline<T>(work: Promise<T>, deadlineAt: number | undefined): Promise<T> {
  if (deadlineAt === undefined) return work;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    work.catch((error: unknown) => {
      console.warn(`withinDeadline: work failed after the deadline (${error instanceof Error ? error.name : "unknown"})`);
    });
    return Promise.reject(new SandboxTurnTimeoutError());
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      work.catch((error: unknown) => {
        console.warn(`withinDeadline: work failed after the deadline (${error instanceof Error ? error.name : "unknown"})`);
      });
      reject(new SandboxTurnTimeoutError());
    }, remaining);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Releases the lock only if it still carries this turn's token, logging the outcome for timed-out reconciliation. */
async function reconcileTimedOutAcquire(sandbox: SandboxLike, lockPath: string, token: string): Promise<void> {
  try {
    const released = await sandbox.runCommand({
      cmd: "sh",
      args: ["-c", RELEASE_SCRIPT, "sh", lockPath, token],
      timeoutMs: 15_000,
    });
    console.warn(`withinDeadline: reconciled a late lock acquire (release exit ${String(released.exitCode)})`);
  } catch (error) {
    console.warn(
      `withinDeadline: could not reconcile a late lock acquire (${error instanceof Error ? error.name : "unknown"})`,
    );
  }
}

/**
 * Runs `fn` with the agent's sandbox while holding its lock, and releases the lock if this turn still owns it.
 * Throws `SandboxBusyError` without running `fn` if another turn holds it.
 *
 * `fn` receives an AbortSignal that aborts at 80% of the stale age. It must stop its work when the signal aborts
 * (the agent runner passes it to the model and the tools). If it has not settled shortly after, this throws
 * `SandboxTurnTimeoutError` and leaves the lock to expire rather than releasing it under a running turn.
 * The sandbox network policy is applied after the lock is held, so a turn that is refused never changes it.
 */
export async function withAgentSandbox<T>(
  client: SandboxClient,
  fn: (sandbox: SandboxLike, signal: AbortSignal) => Promise<T>,
  options: AgentSandboxOptions = {},
): Promise<T> {
  const params = agentSandboxParams(options);
  const staleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  if (!Number.isFinite(staleMs) || staleMs <= 0) throw new SandboxPolicyError("Invalid lock stale age");
  const lockPath = options.lockPath ?? DEFAULT_LOCK_PATH;
  if (!LOCK_PATH_PATTERN.test(lockPath)) throw new SandboxPolicyError("Invalid lock path");

  const staleSeconds = Math.max(1, Math.ceil(staleMs / 1000));
  const deadlineMs = Math.max(1, Math.floor(staleMs * 0.8));
  const graceMs = Math.max(1, Math.floor(staleMs * 0.1));
  const token = randomUUID();

  const { deadlineAt } = options;
  const sandbox = await withinDeadline(client.getOrCreate(params), deadlineAt);

  const acquiredWork = sandbox.runCommand({
    cmd: "sh",
    args: ["-c", ACQUIRE_SCRIPT, "sh", lockPath, token, String(staleSeconds)],
    timeoutMs: 15_000,
  });
  const acquired = await (async (): Promise<Awaited<typeof acquiredWork>> => {
    if (deadlineAt === undefined) return acquiredWork;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      void acquiredWork.then((result) => {
        if (result.exitCode === 0) void reconcileTimedOutAcquire(sandbox, lockPath, token);
      }).catch((error: unknown) => {
        console.warn(`withinDeadline: work failed after the deadline (${error instanceof Error ? error.name : "unknown"})`);
      });
      throw new SandboxTurnTimeoutError();
    }
    return new Promise<Awaited<typeof acquiredWork>>((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void acquiredWork.then((result) => {
          if (result.exitCode === 0) void reconcileTimedOutAcquire(sandbox, lockPath, token);
        }).catch((error: unknown) => {
          console.warn(`withinDeadline: work failed after the deadline (${error instanceof Error ? error.name : "unknown"})`);
        });
        reject(new SandboxTurnTimeoutError());
      }, remaining);
      acquiredWork.then(
        (value) => {
          clearTimeout(timer);
          if (!timedOut) resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          if (!timedOut) reject(error);
        },
      );
    });
  })();
  if (acquired.exitCode === BUSY_EXIT_CODE) throw new SandboxBusyError();
  // Anything other than a clean acquire is a failure to lock, not permission to proceed.
  if (acquired.exitCode !== 0) throw new Error(`Could not take the sandbox lock (exit ${String(acquired.exitCode)})`);

  let release = true;
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Existing sandboxes keep the policy they were created with, so state this turn's policy while holding the lock.
    await withinDeadline(sandbox.updateNetworkPolicy(params.networkPolicy), deadlineAt);

    // With an invocation deadline, abort early enough that the grace period also ends by it. If setup used the
    // whole budget the turn never starts, and the lock is released by the finally block.
    const abortAfterMs = deadlineAt === undefined ? deadlineMs : Math.min(deadlineMs, deadlineAt - graceMs - Date.now());
    if (abortAfterMs <= 0) throw new SandboxTurnTimeoutError();

    const turn = fn(sandbox, controller.signal);
    const overran = new Promise<"overran">((resolve) => {
      deadline = setTimeout(() => {
        controller.abort();
        graceTimer = setTimeout(() => resolve("overran"), graceMs);
      }, abortAfterMs);
    });
    const outcome = await Promise.race([turn.then((value) => ({ value }), (error: unknown) => ({ error })), overran]);
    if (outcome === "overran") {
      release = false;
      // The turn is still running; make sure a late rejection is not left unhandled.
      turn.catch(() => undefined);
      throw new SandboxTurnTimeoutError();
    }
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  } finally {
    clearTimeout(deadline);
    clearTimeout(graceTimer);
    if (release) {
      // Best effort: a failed release must not hide the turn's own result or error. The stale age recovers it.
      await sandbox
        .runCommand({ cmd: "sh", args: ["-c", RELEASE_SCRIPT, "sh", lockPath, token], timeoutMs: 15_000 })
        .catch(() => undefined);
    }
  }
}
