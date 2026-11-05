import type { Sandbox } from "@vercel/sandbox";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SANDBOX_NETWORK_POLICY,
  SandboxPolicyError,
  createSandboxToolOperations,
  type SandboxLike,
  type SandboxOperationsOptions,
} from "../src/sandbox/operations.ts";

/** In-memory stand-in for a sandbox: files, directories, symlinks, and a scripted command runner. */
class FakeSandbox implements SandboxLike {
  files = new Map<string, Buffer>();
  dirs = new Set<string>(["/ws"]);
  links = new Map<string, string>();
  commands: Parameters<SandboxLike["runCommand"]>[0][] = [];
  script: { stdout?: string; stderr?: string; exitCode?: number | null; fail?: Error } = {};
  reads: string[] = [];
  statFail = false;
  statOutput: string | undefined;
  writes: string[] = [];

  private resolve(path: string): string {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = `${current}/${part}`;
      const target = this.links.get(current);
      if (target !== undefined) current = target;
    }
    return current || "/";
  }

  fs = {
    readFile: async (path: string) => {
      this.reads.push(path);
      const data = this.files.get(this.resolve(path));
      if (!data) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
      return data;
    },
    writeFile: async (path: string, data: string | Buffer | Uint8Array) => {
      this.writes.push(path);
      this.files.set(this.resolve(path), Buffer.from(data));
    },
    mkdir: async (path: string) => {
      this.dirs.add(this.resolve(path));
      return undefined;
    },
    access: async (path: string) => {
      const real = this.resolve(path);
      if (!this.files.has(real) && !this.dirs.has(real)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    realpath: async (path: string) => {
      const real = this.resolve(path);
      if (!this.files.has(real) && !this.dirs.has(real)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return real;
    },
  };

  runCommand: SandboxLike["runCommand"] = async (params) => {
    if (params.cmd === "stat") {
      // The size probe made before a read. Not recorded as an agent command.
      const data = this.files.get(this.resolve(params.args?.[3] ?? ""));
      if (this.statFail || !data) return { exitCode: 1 };
      params.stdout?.write(Buffer.from(`${this.statOutput ?? data.byteLength}\n`));
      return { exitCode: 0 };
    }
    this.commands.push(params);
    if (this.script.fail) throw this.script.fail;
    if (this.script.stdout) params.stdout?.write(Buffer.from(this.script.stdout));
    if (this.script.stderr) params.stderr?.write(Buffer.from(this.script.stderr));
    return { exitCode: this.script.exitCode === undefined ? 0 : this.script.exitCode };
  };
}

function setup(options: Partial<SandboxOperationsOptions> = {}) {
  const sandbox = new FakeSandbox();
  sandbox.files.set("/ws/a.txt", Buffer.from("hello"));
  const ops = createSandboxToolOperations(sandbox, { root: "/ws", ...options });
  return { sandbox, ops };
}

const rejects = (promise: Promise<unknown>) => expect(promise).rejects.toBeInstanceOf(SandboxPolicyError);

describe("limits and probes", () => {
  it("rejects limits that are not non-negative integers", () => {
    const sandbox = new FakeSandbox();
    for (const bad of [Number.NaN, Infinity, -1, 1.5]) {
      expect(() => createSandboxToolOperations(sandbox, { root: "/ws", maxReadBytes: bad })).toThrow(SandboxPolicyError);
      expect(() => createSandboxToolOperations(sandbox, { root: "/ws", maxWriteBytes: bad })).toThrow(SandboxPolicyError);
    }
  });

  it("checks a file's size before transferring it", async () => {
    const { sandbox, ops } = setup({ maxReadBytes: 3 });
    await rejects(ops.read.readFile("a.txt"));
    expect(sandbox.reads).toEqual([]);
  });

  it("refuses to read when the size cannot be determined", async () => {
    const { sandbox, ops } = setup();
    sandbox.statFail = true;
    await rejects(ops.read.readFile("a.txt"));
    sandbox.statFail = false;
    sandbox.statOutput = "not a number";
    await rejects(ops.read.readFile("a.txt"));
    expect(sandbox.reads).toEqual([]);
  });

  it("reviews where a link really points, so a link cannot hide a sensitive file", async () => {
    const { sandbox, ops } = setup();
    sandbox.files.set("/ws/.env", Buffer.from("SECRET=1"));
    sandbox.links.set("/ws/safe.txt", "/ws/.env");
    await rejects(ops.read.readFile("safe.txt"));
    await rejects(ops.write.writeFile("safe.txt", "x"));
    expect(sandbox.reads).toEqual([]);
  });
});

describe("compatibility", () => {
  it("a real @vercel/sandbox Sandbox satisfies SandboxLike (checked by the type checker)", () => {
    const accepts = (sandbox: Sandbox): SandboxLike => sandbox;
    expect(typeof accepts).toBe("function");
  });

  it("new sandboxes deny outbound traffic unless the caller chooses otherwise", () => {
    expect(DEFAULT_SANDBOX_NETWORK_POLICY).toBe("deny-all");
  });

  it("refuses a missing, relative, or filesystem-root workspace", () => {
    const sandbox = new FakeSandbox();
    for (const root of ["/", "", "ws", "//", "/ws\0"]) {
      expect(() => createSandboxToolOperations(sandbox, { root })).toThrow(SandboxPolicyError);
    }
  });
});

describe("file paths stay inside the workspace", () => {
  it("reads inside the root, by absolute or relative path", async () => {
    const { ops } = setup();
    expect((await ops.read.readFile("/ws/a.txt")).toString()).toBe("hello");
    expect((await ops.read.readFile("a.txt")).toString()).toBe("hello");
    await expect(ops.read.access("a.txt")).resolves.toBeUndefined();
  });

  it("rejects paths outside the root and never touches the sandbox filesystem", async () => {
    const { sandbox, ops } = setup();
    sandbox.files.set("/etc/passwd", Buffer.from("root"));
    for (const path of ["/etc/passwd", "/ws/../etc/passwd", "../etc/passwd", "/ws-evil/x", "", "/ws/a\0.txt"]) {
      await rejects(ops.read.readFile(path));
      await rejects(ops.edit.readFile(path));
      await rejects(ops.write.writeFile(path, "x"));
    }
    expect(sandbox.reads).toEqual([]);
    expect(sandbox.writes).toEqual([]);
  });

  it("rejects a symlink inside the root that points outside it", async () => {
    const { sandbox, ops } = setup();
    sandbox.dirs.add("/etc");
    sandbox.files.set("/etc/passwd", Buffer.from("root"));
    sandbox.links.set("/ws/link", "/etc");
    await rejects(ops.read.readFile("/ws/link/passwd"));
    await rejects(ops.read.access("/ws/link/passwd"));
    await rejects(ops.edit.readFile("/ws/link/passwd"));
    expect(sandbox.reads).toEqual([]);
  });

  it("allows a symlink that stays inside the root", async () => {
    const { sandbox, ops } = setup();
    sandbox.dirs.add("/ws/real");
    sandbox.files.set("/ws/real/f.txt", Buffer.from("ok"));
    sandbox.links.set("/ws/alias", "/ws/real");
    expect((await ops.read.readFile("/ws/alias/f.txt")).toString()).toBe("ok");
  });

  it("rejects creating a file under a symlinked directory that leads outside, even when the file does not exist yet", async () => {
    const { sandbox, ops } = setup();
    sandbox.dirs.add("/tmp");
    sandbox.links.set("/ws/out", "/tmp");
    await rejects(ops.write.writeFile("/ws/out/new.txt", "x"));
    await rejects(ops.write.mkdir("/ws/out/deeper"));
    expect(sandbox.writes).toEqual([]);
    expect(sandbox.files.has("/tmp/new.txt")).toBe(false);
  });

  it("works when the workspace root itself is a symlink", async () => {
    const sandbox = new FakeSandbox();
    sandbox.dirs.add("/data/ws");
    sandbox.dirs.add("/data/other");
    sandbox.files.set("/data/ws/a", Buffer.from("in"));
    sandbox.files.set("/data/other/b", Buffer.from("out"));
    sandbox.links.set("/ws", "/data/ws");
    const ops = createSandboxToolOperations(sandbox, { root: "/ws" });
    expect((await ops.read.readFile("/ws/a")).toString()).toBe("in");
    // The link lives at its real location, because /ws itself resolves to /data/ws.
    sandbox.links.set("/data/ws/escape", "/data/other");
    await rejects(ops.read.readFile("/ws/escape/b"));
    expect(sandbox.reads).toEqual(["/data/ws/a"]);
  });

  it("writes and creates directories inside the root", async () => {
    const { sandbox, ops } = setup();
    await ops.write.mkdir("/ws/src");
    await ops.write.writeFile("/ws/src/new.ts", "export {};\n");
    expect(sandbox.files.get("/ws/src/new.ts")?.toString()).toBe("export {};\n");
    await ops.edit.writeFile("a.txt", "changed");
    expect(sandbox.files.get("/ws/a.txt")?.toString()).toBe("changed");
  });

  it("fails closed when the workspace root cannot be resolved", async () => {
    const sandbox = new FakeSandbox();
    sandbox.dirs.delete("/ws");
    const ops = createSandboxToolOperations(sandbox, { root: "/ws" });
    await expect(ops.read.readFile("/ws/a.txt")).rejects.toThrow();
    expect(sandbox.reads).toEqual([]);
  });
});

describe("harness policy applies to every call", () => {
  it("blocks sensitive file names inside the workspace for read, write and edit", async () => {
    const { sandbox, ops } = setup();
    sandbox.files.set("/ws/.env", Buffer.from("SECRET=1"));
    sandbox.files.set("/ws/id_rsa", Buffer.from("key"));
    await rejects(ops.read.readFile("/ws/.env"));
    await rejects(ops.read.readFile("/ws/id_rsa"));
    await rejects(ops.edit.readFile("/ws/.env"));
    await rejects(ops.write.writeFile("/ws/.env", "x"));
    await rejects(ops.edit.writeFile("/ws/.env", "x"));
    expect(sandbox.reads).toEqual([]);
    expect(sandbox.writes).toEqual([]);
  });

  it("blocks dangerous commands without running them", async () => {
    const { sandbox, ops } = setup();
    for (const command of ["sudo ls", "rm -rf /", "cat .env", "dd if=/dev/zero of=/dev/sda"]) {
      await rejects(ops.bash.exec(command, "/ws", { onData: () => {} }));
    }
    expect(sandbox.commands).toEqual([]);
  });

  it("asks the reviewer with the tool name and the confined absolute path, and obeys a refusal", async () => {
    const review = vi.fn((_tool: string, _input: Record<string, unknown>) => ({
      allow: false,
      severity: "block" as const,
      reason: "no",
    }));
    const { sandbox, ops } = setup({ review });
    await rejects(ops.read.readFile("a.txt"));
    await rejects(ops.write.writeFile("b.txt", "x"));
    await rejects(ops.edit.access("a.txt"));
    await rejects(ops.bash.exec("ls", "/ws", { onData: () => {} }));
    expect(review.mock.calls.map(([tool]) => tool)).toEqual(["read", "write", "edit", "bash"]);
    expect(review.mock.calls[0]?.[1]).toEqual({ path: "/ws/a.txt" });
    expect(review.mock.calls[3]?.[1]).toEqual({ command: "ls" });
    expect(sandbox.reads).toEqual([]);
    expect(sandbox.commands).toEqual([]);
  });

  it("treats anything other than allow:true as a refusal", async () => {
    const { sandbox, ops } = setup({ review: (() => ({ severity: "allow" })) as never });
    await rejects(ops.read.readFile("a.txt"));
    expect(sandbox.reads).toEqual([]);
  });
});

describe("commands", () => {
  it("runs through bash in the confined working directory and returns the exit code", async () => {
    const { sandbox, ops } = setup();
    sandbox.script = { exitCode: 3 };
    const result = await ops.bash.exec("ls -la", "/ws", { onData: () => {} });
    expect(result).toEqual({ exitCode: 3 });
    expect(sandbox.commands[0]).toMatchObject({ cmd: "bash", args: ["-c", "ls -la"], cwd: "/ws" });
  });

  it("never forwards the caller's environment, only the configured fixed one", async () => {
    const hostEnv = { VERCEL_OIDC_TOKEN: "token", AI_GATEWAY_API_KEY: "key", SECRET: "x" };
    const first = setup();
    await first.ops.bash.exec("ls", "/ws", { onData: () => {}, env: hostEnv });
    expect(first.sandbox.commands[0]?.env).toBeUndefined();

    const second = setup({ commandEnv: { CI: "1" } });
    await second.ops.bash.exec("ls", "/ws", { onData: () => {}, env: hostEnv });
    expect(second.sandbox.commands[0]?.env).toEqual({ CI: "1" });
    expect(JSON.stringify(second.sandbox.commands)).not.toContain("token");
  });

  it("rejects a working directory outside the workspace and an empty command", async () => {
    const { sandbox, ops } = setup();
    await rejects(ops.bash.exec("ls", "/etc", { onData: () => {} }));
    await rejects(ops.bash.exec("ls", "/ws/../etc", { onData: () => {} }));
    await rejects(ops.bash.exec("   ", "/ws", { onData: () => {} }));
    expect(sandbox.commands).toEqual([]);
  });

  it("streams stdout and stderr to onData as Buffers", async () => {
    const { sandbox, ops } = setup();
    sandbox.script = { stdout: "hello\n", stderr: "warn\n" };
    const chunks: Buffer[] = [];
    await ops.bash.exec("run", "/ws", { onData: (data) => chunks.push(data) });
    expect(chunks.every((chunk) => Buffer.isBuffer(chunk))).toBe(true);
    expect(Buffer.concat(chunks).toString()).toBe("hello\nwarn\n");
  });

  it("caps forwarded output", async () => {
    const { sandbox, ops } = setup({ maxOutputBytes: 10 });
    sandbox.script = { stdout: "x".repeat(25) };
    let total = 0;
    await ops.bash.exec("run", "/ws", { onData: (data) => (total += data.byteLength) });
    expect(total).toBe(10);
  });

  it("applies a default timeout, converts seconds to ms, and caps the maximum", async () => {
    const { sandbox, ops } = setup({ defaultTimeoutMs: 30_000, maxTimeoutMs: 60_000 });
    await ops.bash.exec("a", "/ws", { onData: () => {} });
    await ops.bash.exec("b", "/ws", { onData: () => {}, timeout: 5 });
    await ops.bash.exec("c", "/ws", { onData: () => {}, timeout: 99_999 });
    await ops.bash.exec("d", "/ws", { onData: () => {}, timeout: 0 });
    await ops.bash.exec("e", "/ws", { onData: () => {}, timeout: Number.NaN });
    expect(sandbox.commands.map((command) => command.timeoutMs)).toEqual([30_000, 5000, 60_000, 30_000, 30_000]);
  });

  it("passes the abort signal through", async () => {
    const { sandbox, ops } = setup();
    const controller = new AbortController();
    await ops.bash.exec("ls", "/ws", { onData: () => {}, signal: controller.signal });
    expect(sandbox.commands[0]?.signal).toBe(controller.signal);
  });

  it("reports a null exit code as it is, and lets sandbox errors surface instead of looking like success", async () => {
    const { sandbox, ops } = setup();
    sandbox.script = { exitCode: null };
    await expect(ops.bash.exec("ls", "/ws", { onData: () => {} })).resolves.toEqual({ exitCode: null });
    sandbox.script = { fail: new Error("sandbox unavailable") };
    await expect(ops.bash.exec("ls", "/ws", { onData: () => {} })).rejects.toThrow("sandbox unavailable");
  });

  it("uses a Writable sink for output", async () => {
    const { sandbox, ops } = setup();
    await ops.bash.exec("ls", "/ws", { onData: () => {} });
    expect(sandbox.commands[0]?.stdout).toBeInstanceOf(Writable);
    expect(sandbox.commands[0]?.stderr).toBe(sandbox.commands[0]?.stdout);
  });
});

describe("size limits", () => {
  it("rejects reading a file over the limit", async () => {
    const { sandbox, ops } = setup({ maxReadBytes: 5 });
    sandbox.files.set("/ws/big.txt", Buffer.alloc(10, "a"));
    await rejects(ops.read.readFile("big.txt"));
    await rejects(ops.edit.readFile("big.txt"));
    expect((await ops.read.readFile("a.txt")).toString()).toBe("hello");
  });

  it("rejects writing content over the limit, counting bytes not characters", async () => {
    const { sandbox, ops } = setup({ maxWriteBytes: 4 });
    await rejects(ops.write.writeFile("w.txt", "hello"));
    await rejects(ops.edit.writeFile("a.txt", "héllo"));
    await rejects(ops.write.writeFile("w.txt", "ééé"));
    expect(sandbox.writes).toEqual([]);
    await ops.write.writeFile("w.txt", "four");
    expect(sandbox.writes).toEqual(["/ws/w.txt"]);
  });
});
