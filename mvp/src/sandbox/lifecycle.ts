/**
 * Lifecycle for the agent's one sandbox.
 *
 * The owner's Vercel plan allows one sandbox (and Hobby caps a session at 45 minutes), so the agent uses
 * exactly one fixed-name, persistent sandbox that is found or created on demand, never one per
 * conversation, and runs at most one turn in it at a time. The settings here are deliberately small:
 * one vCPU, outbound network denied unless the caller lists exact domains, a bounded session length.
 *
 * This module is written against a small `SandboxClient` interface. It never imports the Vercel SDK, never
 * reads credentials, and nothing in the application calls it yet. The real client is in `vercel-client.ts`.
 */

import { SandboxPolicyError, type SandboxLike } from "./operations.ts";

/** The one sandbox's name. It identifies the sandbox within the Vercel project, so it is stable on purpose. */
export const AGENT_SANDBOX_NAME = "nlt-agent";

/** Hobby caps a session at 45 minutes; stay clear of the cap. */
export const MAX_SESSION_MS = 40 * 60 * 1000;
export const DEFAULT_SESSION_MS = 30 * 60 * 1000;
const MIN_SESSION_MS = 60 * 1000;

/** Longest a turn may hold the lock before it is considered abandoned. */
export const DEFAULT_LOCK_STALE_MS = 15 * 60 * 1000;

const LOCK_PATH = "/tmp/nlt-agent.lock";
const BUSY_EXIT_CODE = 75;
const SNAPSHOT_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;

/** Thrown when another turn holds the sandbox. The caller should tell the user to wait, not retry in a loop. */
export class SandboxBusyError extends Error {
  constructor() {
    super("The sandbox is busy with another turn");
    this.name = "SandboxBusyError";
  }
}

export type AgentNetworkPolicy = "deny-all" | { allow: string[] };

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
  /** Sandbox name. Default `AGENT_SANDBOX_NAME`. Lowercase letters, digits and dashes. */
  name?: string;
  /** Session length in ms, clamped to 1 minute .. `MAX_SESSION_MS`. Default 30 minutes. */
  sessionMs?: number;
  /** Virtual CPUs, 1 or 2. Default 1, to keep the plan's allowance. */
  vcpus?: number;
  /**
   * Exact domains the sandbox may reach (for example `registry.npmjs.org` or `*.npmjs.org`). Default: none,
   * so all outbound traffic is denied. There is deliberately no way to allow everything.
   */
  egressAllow?: readonly string[];
  /** How long a turn may hold the lock before it is treated as abandoned, in ms. */
  lockStaleMs?: number;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
// A hostname, or a "*." wildcard in front of one. Not "*", not a scheme, port, path or whitespace.
const DOMAIN_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

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
  const name = options.name ?? AGENT_SANDBOX_NAME;
  if (!NAME_PATTERN.test(name)) throw new SandboxPolicyError(`Invalid sandbox name: ${name}`);

  const requested = options.sessionMs ?? DEFAULT_SESSION_MS;
  if (!Number.isFinite(requested)) throw new SandboxPolicyError("Invalid session length");
  const timeout = Math.min(Math.max(Math.floor(requested), MIN_SESSION_MS), MAX_SESSION_MS);

  const vcpus = options.vcpus ?? 1;
  if (!Number.isInteger(vcpus) || vcpus < 1 || vcpus > 2) throw new SandboxPolicyError("vcpus must be 1 or 2");

  const egress = options.egressAllow ? validateEgress(options.egressAllow) : [];
  const networkPolicy: AgentNetworkPolicy = egress.length > 0 ? { allow: egress } : "deny-all";

  return {
    name,
    persistent: true,
    timeout,
    resources: { vcpus },
    networkPolicy,
    keepLastSnapshots: { count: 1, expiration: SNAPSHOT_EXPIRATION_MS },
  };
}

export interface SandboxClient {
  /** Finds the sandbox by name, resuming it if stopped, or creates it with these settings. Never creates a second. */
  getOrCreate(params: AgentSandboxParams): Promise<SandboxLike>;
}

/**
 * Takes the lock with one shell command. Exit 0 means acquired; exit 75 means another turn holds it.
 * `mkdir` is atomic, and a lock older than the stale age is taken over. The command contains only fixed text
 * and a validated integer, never model or user input.
 */
function acquireCommand(staleMs: number): string[] {
  const staleMinutes = Math.max(1, Math.ceil(staleMs / 60_000));
  const script = [
    `if mkdir ${LOCK_PATH} 2>/dev/null; then exit 0; fi`,
    `if [ -n "$(find ${LOCK_PATH} -maxdepth 0 -mmin +${staleMinutes} 2>/dev/null)" ]; then`,
    `  rmdir ${LOCK_PATH} 2>/dev/null; mkdir ${LOCK_PATH} 2>/dev/null && exit 0`,
    `fi`,
    `exit ${BUSY_EXIT_CODE}`,
  ].join("\n");
  return ["-c", script];
}

/**
 * Runs `fn` with the agent's sandbox while holding its lock, and always releases the lock. Throws
 * `SandboxBusyError` without running `fn` if another turn holds it.
 */
export async function withAgentSandbox<T>(
  client: SandboxClient,
  fn: (sandbox: SandboxLike) => Promise<T>,
  options: AgentSandboxOptions = {},
): Promise<T> {
  const params = agentSandboxParams(options);
  const staleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  if (!Number.isFinite(staleMs) || staleMs <= 0) throw new SandboxPolicyError("Invalid lock stale age");

  const sandbox = await client.getOrCreate(params);

  const acquired = await sandbox.runCommand({ cmd: "sh", args: acquireCommand(staleMs), timeoutMs: 15_000 });
  if (acquired.exitCode === BUSY_EXIT_CODE) throw new SandboxBusyError();
  // Anything other than a clean acquire is a failure to lock, not permission to proceed.
  if (acquired.exitCode !== 0) throw new Error(`Could not take the sandbox lock (exit ${String(acquired.exitCode)})`);

  try {
    return await fn(sandbox);
  } finally {
    // Best effort: a failed release must not hide the turn's own result or error. The stale age recovers it.
    await sandbox
      .runCommand({ cmd: "rmdir", args: [LOCK_PATH], timeoutMs: 15_000 })
      .catch(() => undefined);
  }
}
