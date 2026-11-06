/**
 * Computes the egress allow-list for a turn: presets + owner's always-allowed grants + valid consumed resume grants.
 * Loaded after the gate passes and before the sandbox is touched. On lookup failure, returns presets only (fail closed)
 * and the caller logs `access_lookup_error`. Pure validation helpers live here too.
 */
import type { AccessStore } from "./store.ts";
import { DEFAULT_AGENT_EGRESS, EGRESS_PRESETS, type AgentSandboxOptions } from "../sandbox/lifecycle.ts";
import { taskHash } from "./hash.ts";

export interface ResumeGrantInput {
  id: string;
  nonce: string;
}

export interface ResumeInput {
  task: string;
  grants: ResumeGrantInput[];
}

export const MAX_RESUME_TASK_LENGTH = 8000;
export const MAX_RESUME_GRANTS = 3;

export function validateResume(input: unknown, prompt: string): { ok: true; resume: ResumeInput } | { ok: false; error: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "resume must be an object" };
  const r = input as Record<string, unknown>;
  if (typeof r.task !== "string" || r.task.length < 1 || r.task.length > MAX_RESUME_TASK_LENGTH) {
    return { ok: false, error: "resume.task must be a non-empty string" };
  }
  if (!prompt.startsWith(r.task)) return { ok: false, error: "resume.task must be a prefix of prompt" };
  if (!Array.isArray(r.grants) || r.grants.length > MAX_RESUME_GRANTS) {
    return { ok: false, error: `resume.grants must be an array of at most ${MAX_RESUME_GRANTS} items` };
  }
  const grants: ResumeGrantInput[] = [];
  for (const g of r.grants) {
    if (g === null || typeof g !== "object" || Array.isArray(g)) return { ok: false, error: "resume grant must be an object" };
    const gr = g as Record<string, unknown>;
    if (typeof gr.id !== "string" || typeof gr.nonce !== "string") return { ok: false, error: "resume grant needs id and nonce strings" };
    grants.push({ id: gr.id, nonce: gr.nonce });
  }
  return { ok: true, resume: { task: r.task, grants } };
}

export function presetHosts(): string[] {
  return DEFAULT_AGENT_EGRESS.flatMap((p) => [...EGRESS_PRESETS[p]]);
}

export interface EgressResolution {
  /** Domains to allow (exact/wildcard domains as accepted by lifecycle). */
  egressAllow: string[];
  /** All hosts considered allowed for this turn (for the access tool's "already allowed" check). Lowercased. */
  allowedHosts: Set<string>;
  ignored: { id: string; reason: string }[];
  lookupError?: boolean;
}

export async function resolveTurnEgress(options: {
  store: AccessStore | undefined;
  owner: string | undefined;
  conversationId: string | undefined;
  resume: ResumeInput | undefined;
  log: (line: string) => void;
}): Promise<EgressResolution> {
  const presets = presetHosts();
  const allowedHosts = new Set(presets.map((h) => h.toLowerCase()));
  const extra: string[] = [];
  const ignored: { id: string; reason: string }[] = [];
  if (!options.store || !options.owner) {
    return { egressAllow: presets, allowedHosts, ignored };
  }
  try {
    const grants = await options.store.listGrants(options.owner);
    for (const g of grants) {
      const h = g.host.toLowerCase();
      if (!allowedHosts.has(h)) { extra.push(g.host); allowedHosts.add(h); }
    }
    if (options.resume && options.conversationId) {
      const consumed = await options.store.consumeResumeGrants(options.owner, {
        conversationId: options.conversationId,
        resumeTask: options.resume.task,
        grants: options.resume.grants,
      });
      for (const ig of consumed.ignored) {
        options.log(JSON.stringify({ event: "access_resume_ignored", requestId: ig.id, reason: ig.reason }));
      }
      ignored.push(...consumed.ignored);
      for (const host of consumed.hosts) {
        const h = host.toLowerCase();
        if (!allowedHosts.has(h)) { extra.push(host); allowedHosts.add(h); }
      }
    }
  } catch {
    options.log(JSON.stringify({ event: "access_lookup_error", op: "resolve_egress" }));
    return { egressAllow: presets, allowedHosts: new Set(presets.map((h) => h.toLowerCase())), ignored, lookupError: true };
  }
  return { egressAllow: [...presets, ...extra], allowedHosts, ignored };
}

export function sandboxOptionsForEgress(egressAll: boolean, egressAllow: string[] | undefined): Pick<AgentSandboxOptions, "egressAll" | "egressPresets" | "egressAllow"> {
  if (egressAll) return { egressAll: true };
  // Pass full composed list via egressAllow and empty presets to avoid double-adding; lifecycle validates domains.
  if (egressAllow) return { egressAll: false, egressPresets: [], egressAllow };
  return { egressAll: false };
}
