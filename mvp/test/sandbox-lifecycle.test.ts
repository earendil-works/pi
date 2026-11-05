import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  ACQUIRE_SCRIPT as ACQUIRE_FOR_TEST,
  AGENT_SANDBOX_NAME,
  DEFAULT_AGENT_EGRESS,
  DEFAULT_SESSION_MS,
  EGRESS_PRESETS,
  MAX_SESSION_MS,
  SandboxBusyError,
  SandboxTurnTimeoutError,
  agentSandboxParams,
  withAgentSandbox,
  type AgentSandbox,
  type AgentSandboxParams,
  type SandboxClient,
} from "../src/sandbox/lifecycle.ts";
import { SandboxPolicyError, type SandboxLike } from "../src/sandbox/operations.ts";
import type { createVercelSandboxClient } from "../src/sandbox/vercel-client.ts";

/** A fake sandbox whose lock behaves like the real shell command: one holder, old locks can be taken over. */
class FakeLockedSandbox implements AgentSandbox {
  held = false;
  heldAgeSeconds = 0;
  owner = "";
  commands: { cmd: string; args?: string[] }[] = [];
  policies: unknown[] = [];
  failRelease = false;
  failPolicy = false;
  forceExit: number | null | undefined;

  fs = {
    readFile: async () => Buffer.alloc(0),
    writeFile: async () => {},
    mkdir: async () => undefined,
    access: async () => {},
    realpath: async (path: string) => path,
  };

  updateNetworkPolicy = async (policy: unknown) => {
    if (this.failPolicy) throw new Error("policy update failed");
    this.policies.push(policy);
  };

  runCommand: SandboxLike["runCommand"] = async (params) => {
    this.commands.push({ cmd: params.cmd, args: params.args });
    const [, script, , , token, staleSeconds] = params.args ?? [];
    if (script?.includes("mkdir")) {
      if (this.forceExit !== undefined) return { exitCode: this.forceExit };
      if (!this.held || this.heldAgeSeconds > Number(staleSeconds)) {
        this.held = true;
        this.heldAgeSeconds = 0;
        this.owner = token ?? "";
        return { exitCode: 0 };
      }
      return { exitCode: 75 };
    }
    if (script?.includes("rm -rf")) {
      if (this.failRelease) throw new Error("release failed");
      if (this.held && this.owner === params.args?.[4]) this.held = false;
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
  it("defaults to one named, persistent, one-vCPU sandbox that can reach only package registries and GitHub", () => {
    expect(agentSandboxParams()).toEqual({
      name: AGENT_SANDBOX_NAME,
      persistent: true,
      timeout: DEFAULT_SESSION_MS,
      resources: { vcpus: 1 },
      networkPolicy: { allow: [...EGRESS_PRESETS.packages, ...EGRESS_PRESETS.git] },
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

  it("always uses the one fixed name, even if a caller tries to pass another", () => {
    expect(agentSandboxParams().name).toBe(AGENT_SANDBOX_NAME);
    expect(agentSandboxParams({ name: "other" } as never).name).toBe(AGENT_SANDBOX_NAME);
  });

  it("allows all outbound traffic only when asked to, and refuses non-boolean values", () => {
    const allowlist = { allow: [...EGRESS_PRESETS.packages, ...EGRESS_PRESETS.git] };
    expect(agentSandboxParams().networkPolicy).toEqual(allowlist);
    expect(agentSandboxParams({ egressAll: true }).networkPolicy).toBe("allow-all");
    expect(agentSandboxParams({ egressAll: false }).networkPolicy).toEqual(allowlist);
    // It overrides presets and extra domains, and unused lists are not validated in this mode.
    expect(agentSandboxParams({ egressAll: true, egressPresets: [], egressAllow: ["example.org"] }).networkPolicy).toBe("allow-all");
    expect(agentSandboxParams({ egressAll: true, egressAllow: ["*"], egressPresets: ["nope" as never] }).networkPolicy).toBe("allow-all");
    expect(() => agentSandboxParams({ egressAll: false, egressAllow: ["*"] })).toThrow(SandboxPolicyError);
    expect(() => agentSandboxParams({ egressAll: "yes" as never })).toThrow(SandboxPolicyError);
  });

  it("allows outbound traffic to the default presets only, and denies everything when asked to", () => {
    expect([...DEFAULT_AGENT_EGRESS]).toEqual(["packages", "git"]);
    expect(agentSandboxParams({ egressPresets: [] }).networkPolicy).toBe("deny-all");
    expect(agentSandboxParams({ egressPresets: [], egressAllow: [] }).networkPolicy).toBe("deny-all");
    expect(agentSandboxParams({ egressPresets: ["git"] }).networkPolicy).toEqual({ allow: [...EGRESS_PRESETS.git] });
  });

  it("adds extra exact domains to the presets, lowercased and without duplicates", () => {
    expect(agentSandboxParams({ egressPresets: [], egressAllow: ["Registry.NPMJS.org", "*.npmjs.org", "registry.npmjs.org"] }).networkPolicy).toEqual({
      allow: ["registry.npmjs.org", "*.npmjs.org"],
    });
    const merged = agentSandboxParams({ egressPresets: ["git"], egressAllow: ["github.com", "example.org"] }).networkPolicy;
    expect(merged).toEqual({ allow: ["github.com", "codeload.github.com", "*.githubusercontent.com", "example.org"] });
  });

  it("refuses unknown presets and any domain that would widen access beyond an exact host", () => {
    expect(() => agentSandboxParams({ egressPresets: ["everything" as never] })).toThrow(SandboxPolicyError);
    expect(() => agentSandboxParams({ egressPresets: ["__proto__" as never] })).toThrow(SandboxPolicyError);
    expect(() => agentSandboxParams({ egressPresets: ["constructor" as never] })).toThrow(SandboxPolicyError);
    for (const bad of ["*", "*.*.com", "http://example.com", "example.com/path", "example.com:443", "localhost", "", " example.com", "exa mple.com", "-x.com"]) {
      expect(() => agentSandboxParams({ egressAllow: ["good.example.com", bad] }), bad).toThrow(SandboxPolicyError);
    }
  });

  it("every preset domain is itself a valid exact host", () => {
    for (const domains of Object.values(EGRESS_PRESETS)) {
      expect(() => agentSandboxParams({ egressPresets: [], egressAllow: [...domains] })).not.toThrow();
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
    client.sandbox.heldAgeSeconds = 60;
    let ran = false;
    await expect(
      withAgentSandbox(client, async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(SandboxBusyError);
    expect(ran).toBe(false);
    expect(client.sandbox.held).toBe(true);
    expect(client.sandbox.commands).toHaveLength(1);
  });

  it("takes over a lock older than the stale age, and respects a custom stale age", async () => {
    const stale = new FakeClient();
    stale.sandbox.held = true;
    stale.sandbox.heldAgeSeconds = 30 * 60;
    await expect(withAgentSandbox(stale, async () => "ok")).resolves.toBe("ok");

    const custom = new FakeClient();
    custom.sandbox.held = true;
    custom.sandbox.heldAgeSeconds = 30 * 60;
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
    await expect(withAgentSandbox(client, async () => 1, { lockPath: "/etc/passwd" })).rejects.toBeInstanceOf(SandboxPolicyError);
    await expect(withAgentSandbox(client, async () => 1, { lockPath: "/tmp/a b" })).rejects.toBeInstanceOf(SandboxPolicyError);
    await expect(withAgentSandbox(client, async () => 1, { lockPath: "/tmp/../etc" })).rejects.toBeInstanceOf(SandboxPolicyError);
    await expect(withAgentSandbox(client, async () => 1, { egressAllow: ["*"] })).rejects.toBeInstanceOf(SandboxPolicyError);
    await expect(withAgentSandbox(client, async () => 1, { egressPresets: ["nope" as never] })).rejects.toBeInstanceOf(SandboxPolicyError);
    expect(client.calls).toEqual([]);
  });

  it("issues only fixed lock scripts, with every value passed as an argument and never spliced into the script", async () => {
    const client = new FakeClient();
    await withAgentSandbox(client, async () => 1, { lockPath: "/tmp/test-lock" });
    const [acquire, release] = client.sandbox.commands;
    expect(acquire?.cmd).toBe("sh");
    expect(release?.cmd).toBe("sh");
    expect(acquire?.args?.slice(3, 4)).toEqual(["/tmp/test-lock"]);
    expect(acquire?.args?.[1]).not.toContain("/tmp/test-lock");
    expect(acquire?.args?.[1]).not.toContain(acquire?.args?.[4] ?? "?");
    expect(release?.args?.[1]).not.toContain(release?.args?.[4] ?? "?");
    expect(release?.args?.[4]).toBe(acquire?.args?.[4]);
  });

  it("applies the turn's network policy only after taking the lock, and never when it is refused", async () => {
    const client = new FakeClient();
    await withAgentSandbox(client, async (sandbox) => {
      expect((sandbox as FakeLockedSandbox).policies).toEqual([agentSandboxParams().networkPolicy]);
    });
    const busy = new FakeClient();
    busy.sandbox.held = true;
    await expect(withAgentSandbox(busy, async () => 1)).rejects.toBeInstanceOf(SandboxBusyError);
    expect(busy.sandbox.policies).toEqual([]);
  });

  it("applies allow-all to the sandbox each turn when asked, and deny-all when no egress is allowed", async () => {
    const all = new FakeClient();
    await withAgentSandbox(all, async () => 1, { egressAll: true });
    expect(all.calls[0]?.networkPolicy).toBe("allow-all");
    expect(all.sandbox.policies).toEqual(["allow-all"]);
    const none = new FakeClient();
    await withAgentSandbox(none, async () => 1, { egressPresets: [] });
    expect(none.sandbox.policies).toEqual(["deny-all"]);
  });

  it("releases the lock and does not run the work if applying the network policy fails", async () => {
    const client = new FakeClient();
    client.sandbox.failPolicy = true;
    let ran = false;
    await expect(withAgentSandbox(client, async () => { ran = true; })).rejects.toThrow("policy update");
    expect(ran).toBe(false);
    expect(client.sandbox.held).toBe(false);
  });

  it("does not release a lock that another turn now owns", async () => {
    const client = new FakeClient();
    await withAgentSandbox(client, async () => {
      client.sandbox.owner = "someone-else";
    });
    expect(client.sandbox.held).toBe(true);
  });

  it("aborts the turn's signal before the lock can be taken over, and releases once the turn stops", async () => {
    const client = new FakeClient();
    let aborted = false;
    await expect(
      withAgentSandbox(
        client,
        (_sandbox, signal) =>
          new Promise<string>((resolve) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              resolve("stopped");
            });
          }),
        { lockStaleMs: 100 },
      ),
    ).resolves.toBe("stopped");
    expect(aborted).toBe(true);
    expect(client.sandbox.held).toBe(false);
  });

  it("keeps the lock, and says so, when a turn ignores its deadline", async () => {
    const client = new FakeClient();
    await expect(withAgentSandbox(client, () => new Promise<never>(() => undefined), { lockStaleMs: 100 })).rejects.toBeInstanceOf(
      SandboxTurnTimeoutError,
    );
    expect(client.sandbox.held).toBe(true);
  });
});

describe("invocation deadline", () => {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  it("cuts off a slow getOrCreate at the deadline and never runs the work", async () => {
    const client = new FakeClient();
    client.getOrCreate = async () => {
      await sleep(200);
      return client.sandbox;
    };
    let ran = false;
    const started = Date.now();
    await expect(
      withAgentSandbox(client, async () => {
        ran = true;
      }, { deadlineAt: Date.now() + 40 }),
    ).rejects.toBeInstanceOf(SandboxTurnTimeoutError);
    expect(Date.now() - started).toBeLessThan(150);
    expect(ran).toBe(false);
  });

  it("cuts off a slow lock acquire and a slow network-policy update", async () => {
    for (const slow of ["acquire", "policy"] as const) {
      const client = new FakeClient();
      const inner = client.sandbox;
      if (slow === "policy") inner.updateNetworkPolicy = async () => sleep(200);
      else {
        const run = inner.runCommand;
        inner.runCommand = async (params) => {
          if (params.args?.[1]?.includes("mkdir")) await sleep(200);
          return run(params);
        };
      }
      let ran = false;
      await expect(
        withAgentSandbox(client, async () => {
          ran = true;
        }, { deadlineAt: Date.now() + 40 }),
      ).rejects.toBeInstanceOf(SandboxTurnTimeoutError);
      expect(ran).toBe(false);
    }
  });

  it("does not start the turn when setup used the budget, and releases the lock it took", async () => {
    const client = new FakeClient();
    client.sandbox.updateNetworkPolicy = async () => sleep(60);
    let ran = false;
    // Grace is 10% of the stale age (10 ms here): after a 60 ms policy update only ~0 ms is left to abort.
    await expect(
      withAgentSandbox(client, async () => {
        ran = true;
      }, { lockStaleMs: 100, deadlineAt: Date.now() + 65 }),
    ).rejects.toBeInstanceOf(SandboxTurnTimeoutError);
    expect(ran).toBe(false);
    expect(client.sandbox.held).toBe(false);
  });

  it("reconciles a lock acquired after the deadline so a timed-out turn does not orphan the lock", async () => {
    const client = new FakeClient();
    const inner = client.sandbox.runCommand.bind(client.sandbox);
    let releaseCalls = 0;
    client.sandbox.runCommand = async (params) => {
      if (params.args?.[1]?.includes("mkdir")) {
        await new Promise<void>((resolve) => setTimeout(resolve, 80));
      }
      if (params.args?.[1]?.includes("rm -rf")) releaseCalls += 1;
      return inner(params);
    };
    await expect(withAgentSandbox(client, async () => "ran", { deadlineAt: Date.now() + 20 })).rejects.toBeInstanceOf(
      SandboxTurnTimeoutError,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 140));
    expect(client.sandbox.held).toBe(false);
    expect(releaseCalls).toBeGreaterThanOrEqual(1);
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
  // A private directory made by mkdtemp (mode 0700, unpredictable name); the lock lives inside it.
  const DIR = mkdtempSync(join(tmpdir(), "nlt-lock-"));
  const LOCK = `${DIR}/lock`;
  const clean = () => {
    rmSync(LOCK, { recursive: true, force: true });
    rmSync(`${LOCK}.reap`, { recursive: true, force: true });
    for (const leftover of readdirSync(DIR).filter((name) => name.startsWith("lock.reap."))) {
      rmSync(`${DIR}/${leftover}`, { recursive: true, force: true });
    }
  };
  afterEach(clean);
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));
  const turn = <T>(client: SandboxClient, fn: Parameters<typeof withAgentSandbox<T>>[1], extra: object = {}) =>
    withAgentSandbox(client, fn, { lockPath: LOCK, ...extra });
  const longAgo = (seconds: number) => new Date(Date.now() - seconds * 1000);

  it("takes the lock, blocks a second turn while it is held, and frees it afterwards", async () => {
    clean();
    const client = new FakeClient(new ShellSandbox());
    let heldInside = false;
    let secondTurn: unknown;
    await turn(client, async () => {
      heldInside = existsSync(LOCK);
      secondTurn = await turn(client, async () => "should not run").catch((error) => error);
    });
    expect(heldInside).toBe(true);
    expect(secondTurn).toBeInstanceOf(SandboxBusyError);
    expect(existsSync(LOCK)).toBe(false);
    await expect(turn(client, async () => "again")).resolves.toBe("again");
    expect(existsSync(LOCK)).toBe(false);
  });

  it("takes over a lock held longer than the stale age, to the second, and not before", async () => {
    clean();
    mkdirSync(LOCK);
    const client = new FakeClient(new ShellSandbox());
    // Fresh lock: busy.
    await expect(turn(client, async () => "no")).rejects.toBeInstanceOf(SandboxBusyError);
    expect(existsSync(LOCK)).toBe(true);
    // 100 seconds old with a 60 second stale age: taken over, then released. (Whole-minute rounding would refuse.)
    utimesSync(LOCK, longAgo(100), longAgo(100));
    await expect(turn(client, async () => "yes", { lockStaleMs: 60_000 })).resolves.toBe("yes");
    expect(existsSync(LOCK)).toBe(false);
    // 30 minutes old with the default 15 minute stale age: taken over.
    mkdirSync(LOCK);
    utimesSync(LOCK, longAgo(30 * 60), longAgo(30 * 60));
    await expect(turn(client, async () => "yes")).resolves.toBe("yes");
    // A lock 30 minutes old is still respected when the configured stale age is longer.
    mkdirSync(LOCK);
    utimesSync(LOCK, longAgo(30 * 60), longAgo(30 * 60));
    await expect(turn(client, async () => "no", { lockStaleMs: 60 * 60 * 1000 })).rejects.toBeInstanceOf(SandboxBusyError);
  });

  it("does not report busy when the lock directory cannot be made and does not exist", async () => {
    clean();
    writeFileSync(LOCK, "a file in the way");
    const client = new FakeClient(new ShellSandbox());
    const error = await turn(client, async () => "no").catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SandboxBusyError);
    expect(String(error)).toMatch(/lock/i);
  });

  it("releases only a lock that still carries its own token", async () => {
    clean();
    const client = new FakeClient(new ShellSandbox());
    await turn(client, async () => {
      // Another turn took the lock over while this one was running.
      writeFileSync(`${LOCK}/owner`, "someone-else");
    });
    expect(existsSync(LOCK)).toBe(true);
    expect(readFileSync(`${LOCK}/owner`, "utf8")).toBe("someone-else");
  });

  it("lets only one of several simultaneous reclaimers win a stale lock", async () => {
    for (let round = 0; round < 5; round += 1) {
      clean();
      mkdirSync(LOCK);
      utimesSync(LOCK, longAgo(3600), longAgo(3600));
      const args = (token: string) => ["-c", ACQUIRE_FOR_TEST, "sh", LOCK, token, "60"];
      const runs = await Promise.all(
        Array.from({ length: 8 }, (_, index) => new Promise<number | null>((resolve) => {
          const child = spawn("sh", args(`t${index}`));
          child.on("close", (code) => resolve(code));
        })),
      );
      expect(runs.filter((code) => code === 0)).toHaveLength(1);
      expect(runs.every((code) => code === 0 || code === 75)).toBe(true);
    }
  });
});
