import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_API_URL, bindGatewayModel, runAgentTurn, type AgentRunnerDeps, type ModelBinding } from "../src/agent/runner.ts";
import { NoFreeModelError, type GatewayCatalogModel } from "../src/gateway/free-models.ts";
import type { AgentSandbox, AgentSandboxParams, SandboxClient } from "../src/sandbox/lifecycle.ts";
import type { SandboxLike } from "../src/sandbox/operations.ts";

const TOKEN = "test-token-should-never-reach-the-sandbox";
const FREE: GatewayCatalogModel = { id: "synthetic/free-model", type: "language", context_window: 32_000, pricing: { input: "0", output: "0" } };

/** A sandbox that records everything sent to it and models the lock scripts. */
class RecordingSandbox implements AgentSandbox {
  held = false;
  commands: { cmd: string; args?: string[]; cwd?: string; env?: Record<string, string> }[] = [];
  fsCalls: string[] = [];
  policies: unknown[] = [];
  files = new Map<string, Buffer>();

  fs = {
    readFile: async (path: string) => {
      this.fsCalls.push(`read ${path}`);
      const data = this.files.get(path);
      if (!data) throw new Error("ENOENT");
      return data;
    },
    writeFile: async (path: string, data: string | Buffer | Uint8Array) => {
      this.fsCalls.push(`write ${path}`);
      this.files.set(path, Buffer.from(data));
    },
    mkdir: async (path: string) => {
      this.fsCalls.push(`mkdir ${path}`);
      return undefined;
    },
    access: async (_path: string) => {},
    realpath: async (path: string) => path,
  };

  updateNetworkPolicy = async (policy: unknown) => {
    this.policies.push(policy);
  };

  runCommand: SandboxLike["runCommand"] = async (params) => {
    this.commands.push({ cmd: params.cmd, args: params.args, cwd: params.cwd, env: params.env });
    const script = params.args?.[1] ?? "";
    if (params.cmd === "sh" && script.includes("mkdir")) {
      if (this.held) return { exitCode: 75 };
      this.held = true;
      return { exitCode: 0 };
    }
    if (params.cmd === "sh" && script.includes("rm -rf")) {
      this.held = false;
      return { exitCode: 0 };
    }
    if (params.cmd === "test") return { exitCode: 1 };
    if (params.cmd === "bash") params.stdout?.write(Buffer.from("hello from the sandbox\n"));
    return { exitCode: 0 };
  };
}

class Client implements SandboxClient {
  calls: AgentSandboxParams[] = [];
  constructor(public sandbox = new RecordingSandbox()) {}
  async getOrCreate(params: AgentSandboxParams) {
    this.calls.push(params);
    return this.sandbox;
  }
}

describe("runAgentTurn", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  function setup(overrides: Partial<AgentRunnerDeps> = {}) {
    const client = new Client();
    const faux = registerFauxProvider();
    cleanups.push(() => faux.unregister());
    const state = { tokenReads: 0, picks: 0, binds: 0, gated: [] as string[] };
    const deps: AgentRunnerDeps = {
      gate: async (prompt) => {
        state.gated.push(prompt);
        return { allowed: true, crisisLevel: "green" };
      },
      sandboxClient: client,
      gatewayToken: async () => {
        state.tokenReads += 1;
        return TOKEN;
      },
      pickModel: async () => {
        state.picks += 1;
        return FREE;
      },
      // Offline binding: the faux provider stands in for the gateway.
      bindModel: async (): Promise<ModelBinding> => {
        state.binds += 1;
        const dir = await mkdtemp(join(tmpdir(), "nlt-runner-test-"));
        const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
        const model = faux.getModel();
        modelRuntime.registerProvider(model.provider, {
          baseUrl: model.baseUrl,
          apiKey: "faux-key",
          api: model.api,
          models: [
            {
              id: model.id,
              name: model.name,
              api: model.api,
              reasoning: model.reasoning,
              input: model.input,
              cost: model.cost,
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
              baseUrl: model.baseUrl,
            },
          ],
        });
        return { modelRuntime, model: modelRuntime.getModel(model.provider, model.id)!, dispose: () => rm(dir, { recursive: true, force: true }) };
      },
      ...overrides,
    };
    return { client, faux, deps, state };
  }

  it("times out when the gate or model lookup outlives the invocation deadline, without touching the sandbox", async () => {
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const slowGate = setup({ gate: async () => { await sleep(200); return { allowed: true }; } });
    expect(await runAgentTurn(slowGate.deps, { prompt: "hi", deadlineAt: Date.now() + 40 })).toEqual({ status: "timed_out" });
    expect(slowGate.client.calls).toHaveLength(0);

    const slowPick = setup({ pickModel: async () => { await sleep(200); return FREE; } });
    expect(await runAgentTurn(slowPick.deps, { prompt: "hi", deadlineAt: Date.now() + 40 })).toEqual({ status: "timed_out" });
    expect(slowPick.client.calls).toHaveLength(0);
  });

  it("runs a turn and returns the model's text, with the gate first and the lock released", async () => {
    const { client, faux, deps, state } = setup();
    faux.setResponses([fauxAssistantMessage("All done.")]);
    const streamed: string[] = [];
    const result = await runAgentTurn(deps, { prompt: "say hi", onText: (delta) => streamed.push(delta) });
    expect(result).toEqual({ status: "completed", text: "All done.", model: FREE.id });
    expect(streamed.join("")).toBe("All done.");
    expect(state.gated).toEqual(["say hi"]);
    expect(client.sandbox.held).toBe(false);
    expect(client.sandbox.policies).toEqual([client.calls[0]?.networkPolicy]);
  });

  it("does not touch the sandbox, the catalog or the model when the gate blocks", async () => {
    const { client, deps, state } = setup({ gate: async () => ({ allowed: false, blockedReason: "crisis", crisisLevel: "critical" }) });
    const result = await runAgentTurn(deps, { prompt: "x" });
    expect(result).toEqual({ status: "blocked", reason: "crisis", crisisLevel: "critical" });
    expect(client.calls).toEqual([]);
    expect(state.picks + state.binds + state.tokenReads).toBe(0);
  });

  it("treats anything but a literal allowed: true as blocked, and a failing gate as blocked", async () => {
    for (const gate of [async () => ({}) as never, async () => ({ allowed: "true" }) as never, async () => null as never, async () => { throw new Error("down"); }]) {
      const { client, deps } = setup({ gate });
      const result = await runAgentTurn(deps, { prompt: "x" });
      expect(result.status).toBe("blocked");
      expect(client.calls).toEqual([]);
    }
  });

  it("does not run when no free model is available, and does not substitute one", async () => {
    const { client, deps, state } = setup({ pickModel: async () => { throw new NoFreeModelError("none"); } });
    expect(await runAgentTurn(deps, { prompt: "x" })).toEqual({ status: "no_free_model", reason: "none" });
    expect(client.calls).toEqual([]);
    expect(state.tokenReads + state.binds).toBe(0);
  });

  it("rejects an empty prompt before anything runs", async () => {
    const { client, deps, state } = setup();
    expect((await runAgentTurn(deps, { prompt: "   " })).status).toBe("error");
    expect(state.gated).toEqual([]);
    expect(client.calls).toEqual([]);
  });

  it("reports busy, without reading the credential or binding a model, when another turn holds the sandbox", async () => {
    const { client, deps, state } = setup();
    client.sandbox.held = true;
    expect(await runAgentTurn(deps, { prompt: "x" })).toEqual({ status: "busy" });
    expect(state.tokenReads + state.binds).toBe(0);
    expect(client.sandbox.held).toBe(true);
  });

  it("runs the model's tool calls inside the sandbox through the reviewed operations", async () => {
    const { client, faux, deps } = setup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo hello" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("write", { path: "notes.txt", content: "hi" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("finished"),
    ]);
    const tools: string[] = [];
    const result = await runAgentTurn(deps, { prompt: "do work", onToolStart: (name) => tools.push(name) });
    expect(result).toMatchObject({ status: "completed", text: "finished" });
    expect(tools).toEqual(["bash", "write"]);
    const bash = client.sandbox.commands.find((command) => command.cmd === "bash");
    expect(bash?.args).toEqual(["-c", "echo hello"]);
    expect(bash?.cwd).toBe("/vercel/sandbox");
    expect(client.sandbox.files.get("/vercel/sandbox/notes.txt")?.toString()).toBe("hi");
  });

  it("never lets a policy-blocked command reach the sandbox", async () => {
    const { client, faux, deps } = setup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "rm -rf /" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", { path: ".env" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("could not do that"),
    ]);
    const result = await runAgentTurn(deps, { prompt: "bad ideas" });
    expect(result).toMatchObject({ status: "completed", text: "could not do that" });
    expect(client.sandbox.commands.some((command) => command.cmd === "bash")).toBe(false);
    expect(client.sandbox.fsCalls.some((call) => call.startsWith("read "))).toBe(false);
  });

  it("keeps the gateway credential and the host environment out of the sandbox", async () => {
    const { client, faux, deps, state } = setup({ operations: { commandEnv: { CI: "1" } } });
    process.env.NLT_RUNNER_TEST_SECRET = "host-secret-value";
    cleanups.push(() => void delete process.env.NLT_RUNNER_TEST_SECRET);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "env" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("ok"),
    ]);
    await runAgentTurn(deps, { prompt: "show env" });
    expect(state.tokenReads).toBe(1);
    const everything = JSON.stringify({ commands: client.sandbox.commands, fs: client.sandbox.fsCalls, files: [...client.sandbox.files.keys()] });
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain("host-secret-value");
    expect(client.sandbox.commands.find((command) => command.cmd === "bash")?.env).toEqual({ CI: "1" });
  });

  it("does not offer the host's built-in tools to the model", async () => {
    const { client, faux, deps } = setup();
    // A tool the host would have but the sandbox does not provide.
    faux.setResponses([fauxAssistantMessage(fauxToolCall("grep", { pattern: "x" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
    const tools: string[] = [];
    await runAgentTurn(deps, { prompt: "search", onToolStart: (name) => tools.push(name) });
    expect(client.sandbox.commands.filter((command) => command.cmd !== "sh" && command.cmd !== "test")).toEqual([]);
  });

  it("disposes a late model binding when setup is cancelled after bind starts", async () => {
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const { client, deps, faux, state } = setup();
    faux.setResponses([fauxAssistantMessage("should not run")]);
    let disposed = 0;
    let releaseBind: (() => void) | undefined;
    const bindGate = new Promise<void>((resolve) => {
      releaseBind = resolve;
    });
    const controller = new AbortController();
    const inner = deps.bindModel!;
    deps.bindModel = async (model, token) => {
      const binding = await inner(model, token);
      const wrapped: ModelBinding = {
        ...binding,
        dispose: async () => {
          disposed += 1;
          await binding.dispose?.();
        },
      };
      controller.abort();
      await bindGate;
      return wrapped;
    };
    const result = await runAgentTurn(deps, { prompt: "x", signal: controller.signal });
    expect(result).toMatchObject({ status: "aborted" });
    releaseBind?.();
    await sleep(20);
    expect(disposed).toBe(1);
    expect(state.binds).toBe(1);
    expect(client.sandbox.held).toBe(false);
  });

  it("stops an active turn when the caller aborts mid-run", async () => {
    const { client, faux, deps } = setup();
    const controller = new AbortController();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "first.txt", content: "a" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo later" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("finished"),
    ]);
    const result = await runAgentTurn(deps, {
      prompt: "work",
      signal: controller.signal,
      onToolStart: () => controller.abort(),
    });
    expect(result.status).toBe("aborted");
    expect(client.sandbox.held).toBe(false);
    expect(client.sandbox.commands.some((command) => command.cmd === "bash")).toBe(false);
  });

  it("aborts setup stages after the lock is held and never calls the model or binds credentials", async () => {
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    for (const stage of ["token", "bind", "session"] as const) {
      const { client, deps, faux, state } = setup();
      faux.setResponses([fauxAssistantMessage("should not run")]);
      const controller = new AbortController();
      if (stage === "token") {
        deps.gatewayToken = async () => {
          setTimeout(() => controller.abort(), 10);
          await sleep(120);
          return TOKEN;
        };
      } else if (stage === "bind") {
        const inner = deps.bindModel!;
        deps.bindModel = async (model, token) => {
          setTimeout(() => controller.abort(), 10);
          await sleep(120);
          return inner(model, token);
        };
      } else {
        const original = client.sandbox.fs.access.bind(client.sandbox.fs);
        client.sandbox.fs.access = async (path: string) => {
          controller.abort();
          return original(path);
        };
      }
      const result = await runAgentTurn(deps, { prompt: "x", signal: controller.signal });
      expect(result).toMatchObject({ status: "aborted" });
      expect(client.sandbox.held).toBe(false);
      if (stage === "token") expect(state.binds).toBe(0);
    }
  });

  it("times out setup stages after the lock is held when the invocation deadline arrives", async () => {
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const { client, deps, faux, state } = setup();
    faux.setResponses([fauxAssistantMessage("should not run")]);
    deps.gatewayToken = async () => {
      await sleep(200);
      return TOKEN;
    };
    const result = await runAgentTurn(deps, { prompt: "x", deadlineAt: Date.now() + 60 });
    expect(result).toEqual({ status: "timed_out" });
    expect(state.binds).toBe(0);
    expect(client.sandbox.held).toBe(false);
  });

  it("does no setup at all for a request cancelled before it starts", async () => {
    const { client, deps, state } = setup();
    const controller = new AbortController();
    controller.abort();
    expect((await runAgentTurn(deps, { prompt: "x", signal: controller.signal })).status).toBe("aborted");
    expect(state.gated).toEqual([]);
    expect(client.calls).toEqual([]);
    expect(state.tokenReads + state.binds + state.picks).toBe(0);
  });

  it("reports a failed model run as an error, not as a completed turn", async () => {
    const { client, faux, deps } = setup();
    faux.setResponses([fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "upstream failed" })]);
    const result = await runAgentTurn(deps, { prompt: "x" });
    expect(result).toMatchObject({ status: "error" });
    expect((result as { reason: string }).reason).toContain("upstream failed");
    expect(client.sandbox.held).toBe(false);
  });

  it("releases the model binding when the turn fails", async () => {
    let disposed = 0;
    const { deps, faux } = setup();
    const inner = deps.bindModel!;
    deps.bindModel = async (model, token) => {
      const binding = await inner(model, token);
      return { ...binding, dispose: async () => { disposed += 1; await binding.dispose?.(); } };
    };
    faux.setResponses([fauxAssistantMessage("x", { stopReason: "error", errorMessage: "boom" })]);
    await runAgentTurn(deps, { prompt: "x" });
    expect(disposed).toBe(1);
  });

  it("L3: rejects an injected model that is not free", async () => {
    const priced: GatewayCatalogModel = { ...FREE, id: "synthetic/priced-model", pricing: { input: "0.01", output: "0" } };
    const { client, deps } = setup({
      pickModel: async () => priced,
    });
    const result = await runAgentTurn(deps, { prompt: "x" });
    expect(result.status).toBe("no_free_model");
    expect((result as { reason?: string }).reason).toContain("not a free model");
    expect(client.calls).toEqual([]);
  });

  it("passes the caller's requested model to the picker, and nothing when none was requested", async () => {
    const seen: (string | undefined)[] = [];
    const { deps, faux } = setup({
      pickModel: async (requested?: string) => {
        seen.push(requested);
        return FREE;
      },
    });
    faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
    await runAgentTurn(deps, { prompt: "x", model: "synthetic/free-model" });
    await runAgentTurn(deps, { prompt: "y" });
    expect(seen).toEqual(["synthetic/free-model", undefined]);
  });

  it("refuses without substituting when the requested model is not free right now", async () => {
    const { client, deps } = setup({
      pickModel: async (requested?: string) => {
        throw new NoFreeModelError(`The requested model is not a free model right now: ${requested}`);
      },
    });
    const result = await runAgentTurn(deps, { prompt: "x", model: "synthetic/priced-model" });
    expect(result.status).toBe("no_free_model");
    expect(client.calls).toEqual([]);
  });

  describe("default picker (no injected pickModel)", () => {
    const catalog = {
      data: [
        { id: "synthetic/priced-model", type: "language", tags: ["tool-use"], context_window: 32_000, pricing: { input: "0.1", output: "0.1" } },
        { id: "synthetic/free-model", type: "language", tags: ["tool-use"], context_window: 32_000, pricing: { input: "0", output: "0" } },
        { id: "synthetic/other-free-model", type: "language", tags: ["tool-use"], context_window: 64_000, pricing: { input: "0", output: "0" } },
      ],
    };
    const stubCatalog = () => {
      cleanups.push(() => void vi.unstubAllGlobals());
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify(catalog), { status: 200, headers: { "content-type": "application/json" } }));
    };

    it("refuses a requested model that is priced, without substituting a free one", async () => {
      stubCatalog();
      const { client, deps } = setup({ pickModel: undefined });
      const result = await runAgentTurn(deps, { prompt: "x", model: "synthetic/priced-model" });
      expect(result.status).toBe("no_free_model");
      expect(client.calls).toEqual([]);
    });

    it("refuses a requested model that is not listed at all", async () => {
      stubCatalog();
      const { client, deps } = setup({ pickModel: undefined });
      const result = await runAgentTurn(deps, { prompt: "x", model: "synthetic/unknown-model" });
      expect(result.status).toBe("no_free_model");
      expect(client.calls).toEqual([]);
    });

    it("uses the requested free model, not the catalog's best one", async () => {
      stubCatalog();
      const { deps, faux } = setup({ pickModel: undefined });
      faux.setResponses([fauxAssistantMessage("fine")]);
      const result = await runAgentTurn(deps, { prompt: "x", model: "synthetic/free-model" });
      expect(result).toMatchObject({ status: "completed", model: "synthetic/free-model" });
    });

    it("picks the best free model when none is requested", async () => {
      stubCatalog();
      const { deps, faux } = setup({ pickModel: undefined });
      faux.setResponses([fauxAssistantMessage("fine")]);
      const result = await runAgentTurn(deps, { prompt: "x" });
      expect(result).toMatchObject({ status: "completed", model: "synthetic/other-free-model" });
    });

    it("uses the owner's default model when none is requested", async () => {
      stubCatalog();
      const { deps, faux } = setup({ pickModel: undefined, preferredModels: ["synthetic/free-model"] });
      faux.setResponses([fauxAssistantMessage("fine")]);
      expect(await runAgentTurn(deps, { prompt: "x" })).toMatchObject({ status: "completed", model: "synthetic/free-model" });
    });

    it("keeps an explicit request over the owner's default", async () => {
      stubCatalog();
      const { deps, faux } = setup({ pickModel: undefined, preferredModels: ["synthetic/free-model"] });
      faux.setResponses([fauxAssistantMessage("fine")]);
      expect(await runAgentTurn(deps, { prompt: "x", model: "synthetic/other-free-model" })).toMatchObject({
        status: "completed",
        model: "synthetic/other-free-model",
      });
    });

    it("picks only from the owner's allow-list, and refuses a request outside it", async () => {
      stubCatalog();
      const { deps, faux } = setup({ pickModel: undefined, allowedModels: ["synthetic/free-model"] });
      faux.setResponses([fauxAssistantMessage("fine")]);
      expect(await runAgentTurn(deps, { prompt: "x" })).toMatchObject({ status: "completed", model: "synthetic/free-model" });
      const refused = await runAgentTurn(deps, { prompt: "y", model: "synthetic/other-free-model" });
      expect(refused.status).toBe("no_free_model");
    });
  });

  it("accepts an injected free model after re-validation", async () => {
    const { deps, faux } = setup({
      pickModel: async () => FREE,
    });
    faux.setResponses([fauxAssistantMessage("fine")]);
    const result = await runAgentTurn(deps, { prompt: "x" });
    expect(result).toMatchObject({ status: "completed", text: "fine" });
  });

  it("M1: creates a missing workspace root first, so the first turn still runs", async () => {
    const sandbox = new RecordingSandbox();
    let rootExists = false;
    const { access, realpath, mkdir } = sandbox.fs;
    sandbox.fs.access = async (path: string) => {
      if (path === "/vercel/sandbox" && !rootExists) throw new Error("ENOENT");
      return access(path);
    };
    sandbox.fs.realpath = async (path: string) => {
      if (path === "/vercel/sandbox" && !rootExists) throw new Error("ENOENT: realpath");
      return realpath(path);
    };
    sandbox.fs.mkdir = async (path: string) => {
      if (path === "/vercel/sandbox") rootExists = true;
      return mkdir(path);
    };
    const { deps, faux } = setup({ sandboxClient: new Client(sandbox) });
    faux.setResponses([fauxAssistantMessage("ok")]);
    const result = await runAgentTurn(deps, { prompt: "x" });
    expect(result).toMatchObject({ status: "completed", text: "ok" });
    expect(rootExists).toBe(true);
  });

  it("L1: bindGatewayModel registers an OpenAI-compatible provider", async () => {
    const binding = await bindGatewayModel(FREE, TOKEN);
    try {
      const model = binding.modelRuntime.getModel("nlt-gateway", FREE.id);
      expect(model).toMatchObject({
        id: FREE.id,
        provider: "nlt-gateway",
        api: "openai-completions",
        baseUrl: GATEWAY_API_URL,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: FREE.context_window,
      });
    } finally {
      await binding.dispose?.();
    }
  });
});
