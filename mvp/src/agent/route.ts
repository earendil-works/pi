/**
 * The agent route, as a testable function.
 *
 * `api/agent.ts` wires this to the real gate, sandbox and gateway. Everything here takes its dependencies
 * as arguments so the tests run offline.
 *
 * Off by default. The route does nothing, and touches none of its dependencies, unless the owner has set
 * `NLT_AGENT_ENABLED=1` in that environment. `egressAll` comes only from `NLT_AGENT_EGRESS_ALL=1`, also
 * set by the owner; the request body cannot change it. The effective network policy is logged on every turn.
 *
 * The response streams newline-delimited JSON: `{type:"text"}`, `{type:"tool"}`, then one `{type:"done"}`.
 * The prompt is never echoed or logged.
 */
import type { AgentRunnerDeps, AgentTurnInput, AgentTurnResult } from "./runner.ts";
import { DEFAULT_AGENT_EGRESS } from "../sandbox/lifecycle.ts";

export const MAX_AGENT_PROMPT_LENGTH = 8000;

export interface AgentRequest {
  method?: string;
  body?: unknown;
}

export interface AgentResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(body: unknown): unknown };
  write(chunk: string): unknown;
  end(): unknown;
  on?(event: "close", listener: () => void): unknown;
  writableEnded?: boolean;
}

export interface AgentRouteEnv {
  NLT_AGENT_ENABLED?: string;
  NLT_AGENT_EGRESS_ALL?: string;
}

export interface AgentRouteDeps {
  env: AgentRouteEnv;
  /** Builds the runner dependencies. Called only after the route is known to be enabled. */
  createDeps: (options: { egressAll: boolean }) => AgentRunnerDeps;
  run: (deps: AgentRunnerDeps, input: AgentTurnInput) => Promise<AgentTurnResult>;
  log: (line: string) => void;
}

export function agentEnabled(env: AgentRouteEnv): boolean {
  return env.NLT_AGENT_ENABLED === "1";
}

export function egressAllEnabled(env: AgentRouteEnv): boolean {
  return env.NLT_AGENT_EGRESS_ALL === "1";
}

function readPrompt(body: unknown): string | null {
  let parsed = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const prompt = (parsed as Record<string, unknown>).prompt;
  return typeof prompt === "string" && prompt.trim().length > 0 && prompt.length <= MAX_AGENT_PROMPT_LENGTH
    ? prompt
    : null;
}

function describeResult(result: AgentTurnResult): Record<string, unknown> {
  switch (result.status) {
    case "completed":
      return { status: "completed", model: result.model };
    case "blocked":
      return { status: "blocked", reason: result.reason, crisisLevel: result.crisisLevel };
    case "no_free_model":
    case "aborted":
    case "error":
      return { status: result.status, reason: result.reason };
    default:
      return { status: result.status };
  }
}

export async function handleAgentRequest(
  request: AgentRequest,
  response: AgentResponse,
  deps: AgentRouteDeps,
): Promise<void> {
  response.setHeader("Cache-Control", "no-store");

  if (!agentEnabled(deps.env)) {
    response.status(404).json({ error: "Not found" });
    return;
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }
  const prompt = readPrompt(request.body);
  if (prompt === null) {
    response
      .status(400)
      .json({ error: `Body must be JSON with a non-empty "prompt" string of at most ${MAX_AGENT_PROMPT_LENGTH} characters` });
    return;
  }

  const egressAll = egressAllEnabled(deps.env);
  deps.log(
    JSON.stringify({
      event: "agent_turn",
      network: egressAll ? "allow-all" : `allowlist:${DEFAULT_AGENT_EGRESS.join(",")}`,
    }),
  );

  const controller = new AbortController();
  response.on?.("close", () => {
    if (response.writableEnded !== true) controller.abort();
  });
  const send = (event: Record<string, unknown>) => {
    response.write(`${JSON.stringify(event)}\n`);
  };

  let runnerDeps: AgentRunnerDeps;
  try {
    runnerDeps = deps.createDeps({ egressAll });
  } catch {
    response.status(503).json({ error: "Agent unavailable" });
    return;
  }

  response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  let result: AgentTurnResult;
  try {
    result = await deps.run(runnerDeps, {
      prompt,
      signal: controller.signal,
      onText: (delta) => send({ type: "text", delta }),
      onToolStart: (name) => send({ type: "tool", name }),
    });
  } catch {
    result = { status: "error", reason: "Agent turn failed" };
  }
  send({ type: "done", ...describeResult(result) });
  response.end();
}
