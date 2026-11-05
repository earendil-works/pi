import { describe, expect, it, vi } from "vitest";
import { gateWorkDir } from "../src/agent/gate-workdir.ts";
import {
  AGENT_FUNCTION_MAX_DURATION_MS,
  AGENT_LOCK_STALE_MS,
  AGENT_REQUEST_BUDGET_MS,
  MAX_AGENT_MODEL_LENGTH,
  type AgentResponse,
  type AgentRouteDeps,
  agentEnabled,
  egressAllEnabled,
  handleAgentRequest,
} from "../src/agent/route.ts";
import type { AgentRunnerDeps, AgentTurnInput, AgentTurnResult } from "../src/agent/runner.ts";

function makeResponse() {
  const out = { status: 0, json: undefined as unknown, headers: {} as Record<string, string>, chunks: [] as string[], ended: false };
  const response: AgentResponse = {
    setHeader(name, value) {
      out.headers[name] = value;
    },
    status(code) {
      out.status = code;
      return {
        json(body) {
          out.json = body;
        },
      };
    },
    write(chunk) {
      out.chunks.push(chunk);
    },
    end() {
      out.ended = true;
    },
  };
  return { out, response };
}

function makeDeps(env: AgentRouteDeps["env"], result?: AgentTurnResult | (() => Promise<AgentTurnResult>)) {
  const createDeps = vi.fn((_options: { egressAll: boolean }) => ({}) as AgentRunnerDeps);
  const run = vi.fn(async (_deps: AgentRunnerDeps, input: AgentTurnInput): Promise<AgentTurnResult> => {
    input.onToolStart?.("bash");
    input.onText?.("hi");
    if (typeof result === "function") return result();
    return result ?? { status: "completed", text: "hi", model: "free/model" };
  });
  const log = vi.fn();
  const deps: AgentRouteDeps = { env, createDeps, run, log, authorize: () => true };
  return { deps, createDeps, run, log };
}

const on = { NLT_AGENT_ENABLED: "1" };
const post = (body: unknown) => ({ method: "POST", body });

describe("agent route flags", () => {
  it("is off unless the flag is exactly 1", () => {
    for (const value of [undefined, "", "0", "true", "yes", "11"]) {
      expect(agentEnabled({ NLT_AGENT_ENABLED: value })).toBe(false);
      expect(egressAllEnabled({ NLT_AGENT_EGRESS_ALL: value })).toBe(false);
    }
    expect(agentEnabled(on)).toBe(true);
    expect(egressAllEnabled({ NLT_AGENT_EGRESS_ALL: "1" })).toBe(true);
  });
});

describe("handleAgentRequest", () => {
  it("answers 404 and touches nothing when disabled", async () => {
    const { deps, createDeps, run, log } = makeDeps({});
    const { out, response } = makeResponse();
    await handleAgentRequest(post({ prompt: "hello" }), response, deps);
    expect(out.status).toBe(404);
    expect(createDeps).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("answers 401 and runs nothing without a signed-in owner, but still 404 when disabled", async () => {
    const closed = makeDeps(on);
    closed.deps.authorize = () => false;
    const r = makeResponse();
    await handleAgentRequest(post({ prompt: "hi" }), r.response, closed.deps);
    expect(r.out.status).toBe(401);
    expect(closed.createDeps).not.toHaveBeenCalled();
    expect(closed.run).not.toHaveBeenCalled();
    expect(closed.log).not.toHaveBeenCalled();

    const off = makeDeps({});
    off.deps.authorize = () => false;
    const o = makeResponse();
    await handleAgentRequest(post({ prompt: "hi" }), o.response, off.deps);
    expect(o.out.status).toBe(404);
  });

  it("rejects non-POST and bad bodies without running", async () => {
    const { deps, run } = makeDeps(on);
    const get = makeResponse();
    await handleAgentRequest({ method: "GET" }, get.response, deps);
    expect(get.out.status).toBe(405);
    expect(get.out.headers.Allow).toBe("POST");
    for (const body of [undefined, {}, { prompt: "" }, { prompt: "  " }, { prompt: 5 }, "not json", { prompt: "x".repeat(8001) }]) {
      const r = makeResponse();
      await handleAgentRequest(post(body), r.response, deps);
      expect(r.out.status).toBe(400);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("passes a valid model id to the run, trimmed, and treats absent or blank as automatic", async () => {
    const { deps, run } = makeDeps(on);
    for (const [body, expected] of [
      [{ prompt: "hi", model: "synthetic/free-model" }, "synthetic/free-model"],
      [{ prompt: "hi", model: "  synthetic/free-model  " }, "synthetic/free-model"],
      [{ prompt: "hi" }, undefined],
      [{ prompt: "hi", model: "" }, undefined],
      [{ prompt: "hi", model: "   " }, undefined],
      [JSON.stringify({ prompt: "hi", model: "synthetic/free-model" }), "synthetic/free-model"],
    ] as const) {
      run.mockClear();
      const r = makeResponse();
      await handleAgentRequest(post(body), r.response, deps);
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[1].model).toBe(expected);
    }
  });

  it("rejects a model that is not a string or is too long, without running", async () => {
    const { deps, run } = makeDeps(on);
    for (const model of [null, 5, true, {}, ["a"], "x".repeat(MAX_AGENT_MODEL_LENGTH + 1)]) {
      const r = makeResponse();
      await handleAgentRequest(post({ prompt: "hi", model }), r.response, deps);
      expect(r.out.status).toBe(400);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("streams text, tool and a final done event", async () => {
    const { deps, run } = makeDeps(on);
    const { out, response } = makeResponse();
    await handleAgentRequest(post({ prompt: "list files" }), response, deps);
    expect(out.headers["Content-Type"]).toContain("application/x-ndjson");
    expect(out.headers["Cache-Control"]).toBe("no-store");
    const events = out.chunks.map((chunk) => JSON.parse(chunk));
    expect(events).toEqual([
      { type: "tool", name: "bash" },
      { type: "text", delta: "hi" },
      { type: "done", status: "completed", model: "free/model" },
    ]);
    expect(out.ended).toBe(true);
    expect(run.mock.calls[0]?.[1].prompt).toBe("list files");
  });

  it("writes tool and text events while the run is pending, then ends after release", async () => {
    const { deps } = makeDeps(on);
    let releaseRun: (() => void) | undefined;
    const runPromise = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    deps.run = async (_runnerDeps: AgentRunnerDeps, input: AgentTurnInput): Promise<AgentTurnResult> => {
      input.onToolStart?.("bash");
      input.onText?.("hi");
      await runPromise;
      return { status: "completed", text: "hi", model: "free/model" };
    };
    const { out, response } = makeResponse();
    const pending = handleAgentRequest(post({ prompt: "list files" }), response, deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(out.chunks.map((chunk) => JSON.parse(chunk))).toEqual([
      { type: "tool", name: "bash" },
      { type: "text", delta: "hi" },
    ]);
    expect(out.ended).toBe(false);
    releaseRun?.();
    await pending;
    expect(out.ended).toBe(true);
  });

  it("uses the allowlist by default and logs it without the prompt", async () => {
    const { deps, createDeps, log } = makeDeps(on);
    await handleAgentRequest(post({ prompt: "secret-prompt-text" }), makeResponse().response, deps);
    expect(createDeps).toHaveBeenCalledWith({ egressAll: false });
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("allowlist:packages,git");
    expect(line).not.toContain("secret-prompt-text");
  });

  it("logs each turn's outcome and reason, without the prompt or the model's text", async () => {
    const reason = "Gateway returned 401 for https://ai-gateway.example/v1/chat?key=abc123 with Authorization: Bearer sk-test-0123456789abcdef";
    const failed = makeDeps(on, { status: "error", reason });
    const browser = makeResponse();
    await handleAgentRequest(post({ prompt: "secret-prompt-text" }), browser.response, failed.deps);
    const line = JSON.parse(String(failed.log.mock.calls.at(-1)?.[0]));
    expect(line.event).toBe("agent_turn_done");
    expect(line.status).toBe("error");
    expect(line.reason).toContain("Gateway returned 401");
    for (const leaked of ["abc123", "sk-test-0123456789abcdef"]) expect(line.reason).not.toContain(leaked);
    // The browser's copy of the reason is the owner's diagnostic and is not changed by the log redaction.
    const doneEvent = JSON.parse(browser.out.chunks.at(-1) as string);
    expect(doneEvent.reason).toBe(reason);

    const ok = makeDeps(on);
    await handleAgentRequest(post({ prompt: "secret-prompt-text" }), makeResponse().response, ok.deps);
    const done = String(ok.log.mock.calls.at(-1)?.[0]);
    expect(JSON.parse(done)).toEqual({ event: "agent_turn_done", status: "completed", model: "free/model" });
    for (const call of [...failed.log.mock.calls, ...ok.log.mock.calls]) {
      expect(String(call[0])).not.toContain("secret-prompt-text");
      expect(String(call[0])).not.toContain('"hi"');
    }
  });

  it("enables egressAll only from the owner flag, never the request body", async () => {
    const withBody = makeDeps(on);
    await handleAgentRequest(post({ prompt: "hi", egressAll: true, network: "allow-all" }), makeResponse().response, withBody.deps);
    expect(withBody.createDeps).toHaveBeenCalledWith({ egressAll: false });

    const flagged = makeDeps({ ...on, NLT_AGENT_EGRESS_ALL: "1" });
    await handleAgentRequest(post({ prompt: "hi" }), makeResponse().response, flagged.deps);
    expect(flagged.createDeps).toHaveBeenCalledWith({ egressAll: true });
    expect(String(flagged.log.mock.calls[0]?.[0])).toContain("allow-all");
  });

  it("reports a blocked gate verdict in the done event", async () => {
    const { deps } = makeDeps(on, { status: "blocked", reason: "Crisis intervention required", crisisLevel: "critical" });
    const { out, response } = makeResponse();
    await handleAgentRequest(post({ prompt: "hi" }), response, deps);
    expect(JSON.parse(out.chunks.at(-1) as string)).toEqual({
      type: "done",
      status: "blocked",
      reason: "Crisis intervention required",
      crisisLevel: "critical",
    });
  });

  it("turns a thrown runner into a generic error event", async () => {
    const { deps } = makeDeps(on, async () => {
      throw new Error("token=abc123 leaked");
    });
    const { out, response } = makeResponse();
    await handleAgentRequest(post({ prompt: "hi" }), response, deps);
    const last = out.chunks.at(-1) as string;
    expect(JSON.parse(last)).toEqual({ type: "done", status: "error", reason: "Agent turn failed" });
    expect(last).not.toContain("abc123");
  });

  it("answers 503 when the dependencies cannot be built", async () => {
    const { deps } = makeDeps(on);
    deps.createDeps = () => {
      throw new Error("no credentials");
    };
    const { out, response } = makeResponse();
    await handleAgentRequest(post({ prompt: "hi" }), response, deps);
    expect(out.status).toBe(503);
    expect(out.chunks).toEqual([]);
  });

  it("aborts the turn when the client disconnects before the response ends", async () => {
    let closeListener: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    const { deps } = makeDeps(on);
    deps.run = async (_d, input) => {
      signal = input.signal;
      closeListener?.();
      return { status: "aborted", reason: "aborted" };
    };
    const { response } = makeResponse();
    response.on = (_event, listener) => {
      closeListener = listener;
    };
    await handleAgentRequest(post({ prompt: "hi" }), response, deps);
    expect(signal?.aborted).toBe(true);
  });
});

describe("function and lock timing", () => {
  it("settles the whole abort-plus-grace window inside the function limit, and expires locks after it", async () => {
    const { readFileSync } = await import("node:fs");
    const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    const maxDurationMs = config.functions["api/agent.ts"].maxDuration * 1000;
    expect(maxDurationMs).toBe(AGENT_FUNCTION_MAX_DURATION_MS);
    // withAgentSandbox: deadline = 80% of the stale age, grace = 10%.
    const settledBy = AGENT_LOCK_STALE_MS * 0.8 + AGENT_LOCK_STALE_MS * 0.1;
    expect(settledBy).toBeLessThan(maxDurationMs);
    expect(AGENT_LOCK_STALE_MS).toBeGreaterThan(maxDurationMs);
    // The request budget is measured from route entry and leaves room for the final write and release.
    expect(AGENT_REQUEST_BUDGET_MS).toBeLessThanOrEqual(maxDurationMs - 30_000);
  });

  it("gives every turn an absolute deadline measured from route entry", async () => {
    const { deps, run } = makeDeps(on);
    deps.now = () => 1_000_000;
    await handleAgentRequest(post({ prompt: "hi" }), makeResponse().response, deps);
    expect(run.mock.calls[0]?.[1].deadlineAt).toBe(1_000_000 + AGENT_REQUEST_BUDGET_MS);
  });
});

describe("gateWorkDir", () => {
  it("picks one directory per process and never changes it again", async () => {
    const start = process.cwd();
    try {
      const { realpathSync } = await import("node:fs");
      const results = await Promise.all(Array.from({ length: 20 }, async () => {
        const dir = gateWorkDir();
        return { dir, cwd: process.cwd() };
      }));
      const first = results[0] as { dir: string; cwd: string };
      for (const result of results) {
        expect(result.dir).toBe(first.dir);
        expect(realpathSync(result.cwd)).toBe(realpathSync(first.dir));
      }
      expect(gateWorkDir()).toBe(first.dir);
    } finally {
      process.chdir(start);
    }
  });
});
