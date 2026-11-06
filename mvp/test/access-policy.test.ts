import { describe, expect, it, vi } from "vitest";
import { validateResume, resolveTurnEgress, presetHosts } from "../src/access/policy.ts";
import type { AccessStore } from "../src/access/store.ts";

const prompt = "fix the bug in app.ts";

function store(over: Partial<AccessStore> = {}): AccessStore {
  return {
    listGrants: async () => [],
    createRequest: async () => ({ id: "x" }),
    decide: async () => ({ status: "denied" }),
    removeGrant: async () => false,
    consumeResumeGrants: async () => ({ hosts: [], ignored: [] }),
    ...over,
  };
}

describe("validateResume", () => {
  it("accepts a valid resume whose task is a prefix of prompt", () => {
    const v = validateResume({ task: "fix the bug", grants: [{ id: "11111111-1111-4111-8111-111111111111", nonce: "abc" }] }, prompt);
    expect(v.ok).toBe(true);
  });
  it("rejects missing prefix, bad shape, too many grants", () => {
    expect(validateResume({ task: "other", grants: [] }, prompt).ok).toBe(false);
    expect(validateResume({ task: "fix", grants: Array(4).fill({ id: "i", nonce: "n" }) }, prompt).ok).toBe(false);
    expect(validateResume(null, prompt).ok).toBe(false);
    expect(validateResume({ task: "fix", grants: [{ id: 1, nonce: "n" }] }, prompt).ok).toBe(false);
  });
});

describe("resolveTurnEgress", () => {
  it("includes presets and always-allowed grants; fails closed on lookup error", async () => {
    const log = vi.fn();
    const s = store({ listGrants: async () => [{ host: "example.com", createdAt: "t" }] });
    const r = await resolveTurnEgress({ store: s, owner: "o", conversationId: undefined, resume: undefined, log });
    expect(r.egressAllow).toContain("example.com");
    expect(presetHosts().every((h) => r.allowedHosts.has(h.toLowerCase()))).toBe(true);
    expect(r.allowedHosts.has("example.com")).toBe(true);

    const bad = store({ listGrants: async () => { throw new Error("db"); } });
    const r2 = await resolveTurnEgress({ store: bad, owner: "o", conversationId: undefined, resume: undefined, log });
    expect(r2.lookupError).toBe(true);
    expect(r2.egressAllow).toEqual(presetHosts());
    expect(log).toHaveBeenCalled();
  });
  it("consumes resume grants and logs ignored; adds consumed hosts", async () => {
    const log = vi.fn();
    const s = store({
      consumeResumeGrants: async () => ({ hosts: ["extra.example"], ignored: [{ id: "x", reason: "no_match" }] }),
    });
    const r = await resolveTurnEgress({
      store: s, owner: "o", conversationId: "11111111-1111-4111-8111-111111111111",
      resume: { task: "fix", grants: [{ id: "11111111-1111-4111-8111-111111111112", nonce: "n" }] }, log,
    });
    expect(r.allowedHosts.has("extra.example")).toBe(true);
    expect(r.ignored).toHaveLength(1);
    expect(JSON.stringify(log.mock.calls)).toContain("access_resume_ignored");
  });
});
