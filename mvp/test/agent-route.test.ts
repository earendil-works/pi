import { describe, expect, it, vi } from "vitest";
import {
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
  const deps: AgentRouteDeps = { env, createDeps, run, log };
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

  it("uses the allowlist by default and logs it without the prompt", async () => {
    const { deps, createDeps, log } = makeDeps(on);
    await handleAgentRequest(post({ prompt: "secret-prompt-text" }), makeResponse().response, deps);
    expect(createDeps).toHaveBeenCalledWith({ egressAll: false });
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("allowlist:packages,git");
    expect(line).not.toContain("secret-prompt-text");
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
