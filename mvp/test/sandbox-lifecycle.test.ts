import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_SANDBOX_NAME,
  DEFAULT_SESSION_MS,
  MAX_SESSION_MS,
  SandboxBusyError,
  agentSandboxParams,
  withAgentSandbox,
  type AgentSandboxParams,
  type SandboxClient,
} from "../src/sandbox/lifecycle.ts";
import { SandboxPolicyError, type SandboxLike } from "../src/sandbox/operations.ts";
import type { createVercelSandboxClient } from "../src/sandbox/vercel-client.ts";

/** A fake sandbox whose lock behaves like the real shell command: mkdir is atomic, old locks can be taken over. */
class FakeLockedSandbox implements SandboxLike {
  held = false;
  heldAgeMinutes = 0;
  commands: { cmd: string; args?: string[] }[] = [];
  failRelease = false;
  forceExit: number | null | undefined;

  fs = {
    readFile: async () => Buffer.alloc(0),
    writeFile: async () => {},
    mkdir: async () => undefined,
    access: async () => {},
    realpath: async (path: string) => path,
  };

  runCommand: SandboxLike["runCommand"] = async (params) => {
    this.commands.push({ cmd: params.cmd, args: params.args });
    if (params.cmd === "sh") {
      if (this.forceExit !== undefined) return { exitCode: this.forceExit };
      const staleMinutes = Number(/-mmin \+(\d+)/.exec(params.args?.[1] ?? "")?.[1]);
      if (!this.held) {
        this.held = true;
        this.heldAgeMinutes = 0;
        return { exitCode: 0 };
      }
      if (this.heldAgeMinutes > staleMinutes) {
        this.heldAgeMinutes = 0;
        return { exitCode: 0 };
      }
      return { exitCode: 75 };
    }
    if (params.cmd === "rmdir") {
      if (this.failRelease) throw new Error("release failed");
      this.held = false;
      return { exitCode: 0 };
    }
    return { exitCode: 0 };
  };
}

class FakeClient implements SandboxClient {
  calls: AgentSandboxParams[] = [];
  constructor(public sandbox = new FakeLockedSandbox()) {}
  async getOrCreate(params: AgentSandboxParams) {
    this.calls.push(params);
    return this.sandbox;
  }
}

describe("agentSandboxParams", () => {
  it("defaults to one named, persistent, one-vCPU sandbox with outbound traffic denied", () => {
    expect(agentSandboxParams()).toEqual({
      name: AGENT_SANDBOX_NAME,
      persistent: true,
      timeout: DEFAULT_SESSION_MS,
      resources: { vcpus: 1 },
      networkPolicy: "deny-all",
      keepLastSnapshots: { count: 1, expiration: 7 * 24 * 60 * 60 * 1000 },
    });
  });

  it("keeps the session under the 45 minute Hobby cap, and never below one minute", () => {
    expect(MAX_SESSION_MS).toBeLessThan(45 * 60 * 1000);
    expect(agentSandboxParams({ sessionMs: 99 * 60 * 60 * 1000 }).timeout).toBe(MAX_SESSION_MS);
    expect(agentSandboxParams({ sessionMs: 1 }).timeout).toBe(60_000);
    expect(agentSandboxParams({ sessionMs: 10 * 60 * 1000 }).timeout).toBe(10 * 60 * 1000);
    expect(() => agentSandboxParams({ sessionMs: Number.NaN })).toThrow(SandboxPolicyError);
    expect(() => agentSandboxParams({ sessionMs: Number.POSITIVE_INFINITY })).toThrow(SandboxPolicyError);
  });

  it("limits vCPUs to 1 or 2", () => {
    expect(agentSandboxParams({ vcpus: 2 }).resources.vcpus).toBe(2);
    for (const vcpus of [0, 3, 1.5, -1, Number.NaN]) {
      expect(() => agentSandboxParams({ vcpus })).toThrow(SandboxPolicyError);
    }
  });

  it("accepts only a plain lowercase name", () => {
    expect(agentSandboxParams({ name: "my-agent-2" }).name).toBe("my-agent-2");
    for (const name of ["", "Bad_Name", "-lead", "has space", "x".repeat(64), "a/b", "../x"]) {
      expect(() => agentSandboxParams({ name })).toThrow(SandboxPolicyError);
    }
  });

  it("turns an exact-domain list into an allowlist, and offers no way to allow everything", () => {
    expect(agentSandboxParams({ egressAllow: ["Registry.NPMJS.org", "*.npmjs.org", "registry.npmjs.org"] }).networkPolicy).toEqual({
      allow: ["registry.npmjs.org", "*.npmjs.org"],
    });
    expect(agentSandboxParams({ egressAllow: [] }).networkPolicy).toBe("deny-all");
    for (const bad of ["*", "*.*.com", "http://example.com", "example.com/path", "example.com:443", "localhost", "", " example.com", "exa mple.com", "-x.com"]) {
      expect(() => agentSandboxParams({ egressAllow: ["good.example.com", bad] }), bad).toThrow(SandboxPolicyError);
    }
  });
});

describe("withAgentSandbox", () => {
  it("finds or creates the one sandbox with the safe settings, runs the work, and returns its value", async () => {
    const client = new FakeClient();
    const result = await withAgentSandbox(client, async (sandbox) => {
      expect(sandbox).toBe(client.sandbox);
      return "done";
    });
    expect(result).toBe("done");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toEqual(agentSandboxParams());
  });

  it("asks for the same sandbox every time and never a differently named one", async () => {
    const client = new FakeClient();
    await withAgentSandbox(client, async () => 1);
    await withAgentSandbox(client, async () => 2);
    await withAgentSandbox(client, async () => 3);
    expect(client.calls.map((call) => call.name)).toEqual([AGENT_SANDBOX_NAME, AGENT_SANDBOX_NAME, AGENT_SANDBOX_NAME]);
  });

  it("holds the lock while the work runs and releases it afterwards", async () => {
    const client = new FakeClient();
    let heldDuring = false;
    await withAgentSandbox(client, async () => {
      heldDuring = client.sandbox.held;
    });
    expect(heldDuring).toBe(true);
    expect(client.sandbox.held).toBe(false);
  });

  it("releases the lock and passes the error on when the work fails", async () => {
    const client = new FakeClient();
    await expect(
      withAgentSandbox(client, async () => {
        throw new Error("turn failed");
      }),
    ).rejects.toThrow("turn failed");
    expect(client.sandbox.held).toBe(false);
  });

  it("refuses with SandboxBusyError while another turn holds the lock, and does not release the other turn's lock", async () => {
    const client = new FakeClient();
    client.sandbox.held = true;
    client.sandbox.heldAgeMinutes = 1;
    let ran = false;
    await expect(
      withAgentSandbox(client, async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(SandboxBusyError);
    expect(ran).toBe(false);
    expect(client.sandbox.held).toBe(true);
    expect(client.sandbox.commands.some((command) => command.cmd === "rmdir")).toBe(false);
  });

  it("takes over a lock older than the stale age, and respects a custom stale age", async () => {
    const stale = new FakeClient();
    stale.sandbox.held = true;
    stale.sandbox.heldAgeMinutes = 30;
    await expect(withAgentSandbox(stale, async () => "ok")).resolves.toBe("ok");

    const custom = new FakeClient();
    custom.sandbox.held = true;
    custom.sandbox.heldAgeMinutes = 30;
    await expect(withAgentSandbox(custom, async () => "ok", { lockStaleMs: 60 * 60 * 1000 })).rejects.toBeInstanceOf(SandboxBusyError);
  });

  it("treats any unexpected lock result as a failure to lock, not permission to run", async () => {
    for (const exit of [1, 2, 127, null]) {
      const client = new FakeClient();
      client.sandbox.forceExit = exit;
      let ran = false;
      await expect(
        withAgentSandbox(client, async () => {
          ran = true;
        }),
      ).rejects.toThrow(/lock/i);
      expect(ran).toBe(false);
    }
  });

  it("does not let a failed release hide the work's result", async () => {
    const client = new FakeClient();
    client.sandbox.failRelease = true;
    await expect(withAgentSandbox(client, async () => "result")).resolves.toBe("result");
  });

  it("rejects bad settings before touching the sandbox", async () => {
    const client = new FakeClient();
    await expect(withAgentSandbox(client, async () => 1, { lockStaleMs: 0 })).rejects.toBeInstanceOf(SandboxPolicyError);
    await expect(withAgentSandbox(client, async () => 1, { lockStaleMs: Number.NaN })).rejects.toBeInstanceOf(SandboxPolicyError);
    await expect(withAgentSandbox(client, async () => 1, { name: "Bad Name" })).rejects.toBeInstanceOf(SandboxPolicyError);
    await expect(withAgentSandbox(client, async () => 1, { egressAllow: ["*"] })).rejects.toBeInstanceOf(SandboxPolicyError);
    expect(client.calls).toEqual([]);
  });

  it("issues only fixed lock commands", async () => {
    const client = new FakeClient();
    await withAgentSandbox(client, async () => 1);
    expect(client.sandbox.commands.map((command) => command.cmd)).toEqual(["sh", "rmdir"]);
    expect(client.sandbox.commands[0]?.args?.[1]).toContain("mkdir /tmp/nlt-agent.lock");
  });
});

describe("real client", () => {
  it("has the SandboxClient shape (checked by the type checker)", () => {
    const factory: typeof createVercelSandboxClient = (() => ({ getOrCreate: async () => new FakeLockedSandbox() })) as never;
    const client: SandboxClient = factory();
    expect(typeof client.getOrCreate).toBe("function");
  });
});

/** Runs the lock commands in a real shell on this machine, to check the script itself, not a model of it. */
class ShellSandbox extends FakeLockedSandbox {
  runCommand: SandboxLike["runCommand"] = async (params) => {
    const result = spawnSync(params.cmd, params.args ?? [], { encoding: "utf8" });
    return { exitCode: result.status };
  };
}

describe("the lock script in a real shell", () => {
  const LOCK = "/tmp/nlt-agent.lock";
  const clean = () => rmSync(LOCK, { recursive: true, force: true });
  afterEach(clean);

  it("takes the lock, blocks a second turn while it is held, and frees it afterwards", async () => {
    clean();
    const client = new FakeClient(new ShellSandbox());
    let heldInside = false;
    let secondTurn: unknown;
    await withAgentSandbox(client, async () => {
      heldInside = existsSync(LOCK);
      secondTurn = await withAgentSandbox(client, async () => "should not run").catch((error) => error);
    });
    expect(heldInside).toBe(true);
    expect(secondTurn).toBeInstanceOf(SandboxBusyError);
    expect(existsSync(LOCK)).toBe(false);
    await expect(withAgentSandbox(client, async () => "again")).resolves.toBe("again");
    expect(existsSync(LOCK)).toBe(false);
  });

  it("takes over a lock that has been held longer than the stale age, and not before", async () => {
    clean();
    mkdirSync(LOCK);
    const client = new FakeClient(new ShellSandbox());
    // Fresh lock: busy.
    await expect(withAgentSandbox(client, async () => "no")).rejects.toBeInstanceOf(SandboxBusyError);
    expect(existsSync(LOCK)).toBe(true);
    // Lock last touched 30 minutes ago, default stale age is 15: taken over, then released.
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    utimesSync(LOCK, thirtyMinutesAgo, thirtyMinutesAgo);
    await expect(withAgentSandbox(client, async () => "yes")).resolves.toBe("yes");
    expect(existsSync(LOCK)).toBe(false);
    // A lock 30 minutes old is still respected when the configured stale age is longer.
    mkdirSync(LOCK);
    utimesSync(LOCK, thirtyMinutesAgo, thirtyMinutesAgo);
    await expect(withAgentSandbox(client, async () => "no", { lockStaleMs: 60 * 60 * 1000 })).rejects.toBeInstanceOf(SandboxBusyError);
  });
});
