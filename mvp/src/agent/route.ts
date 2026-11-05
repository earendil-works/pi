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
import { redactForLog } from "./log-redact.ts";

export const MAX_AGENT_PROMPT_LENGTH = 8000;

/** Longest model id accepted from a client. Gateway ids are short; anything longer is not one. */
export const MAX_AGENT_MODEL_LENGTH = 200;

/** The function limit in `vercel.json`. A test checks the two agree. */
export const AGENT_FUNCTION_MAX_DURATION_MS = 300_000;

/**
 * Lock stale age for the route. The sandbox lifecycle aborts a turn at 80% of this (256 s) and allows a
 * further 10% (32 s) to stop, so a turn settles by 288 s, inside the function limit, and the lock is
 * released by the invocation itself. The stale age is above the function limit, so a lock older than it
 * can only belong to an invocation that Vercel already terminated.
 */
export const AGENT_LOCK_STALE_MS = 320_000;

/**
 * Time from route entry by which the whole invocation (gate, model lookup, sandbox acquire, lock, policy,
 * turn, release) must have settled. It leaves 30 s below the function limit for the final write and release.
 */
export const AGENT_REQUEST_BUDGET_MS = 270_000;

export interface AgentRequest {
  method?: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
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
  now?: () => number;
  /** True only for a signed-in owner. Required, so a route built without it cannot be reached by anyone. */
  authorize: (request: AgentRequest) => boolean;
}

/** Whether the owner enabled the agent route (`NLT_AGENT_ENABLED=1`). Fails closed: anything else is off. */
export function agentEnabled(env: AgentRouteEnv): boolean {
  return env.NLT_AGENT_ENABLED === "1";
}

/** Whether the owner allowed allow-all egress (`NLT_AGENT_EGRESS_ALL=1`). Fails closed: anything else keeps the allowlist. */
export function egressAllEnabled(env: AgentRouteEnv): boolean {
  return env.NLT_AGENT_EGRESS_ALL === "1";
}

/** Reads the prompt from a JSON body; rejects empty or over-long prompts. */
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

/**
 * Reads the optional `model` field. Returns undefined when absent or a blank string (automatic choice), the trimmed id
 * when valid, or null when present but not a usable string, including JSON null (the caller rejects the request).
 */
function readModel(body: unknown): string | undefined | null {
  let parsed = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const model = (parsed as Record<string, unknown>).model;
  if (model === undefined) return undefined;
  if (typeof model !== "string" || model.length > MAX_AGENT_MODEL_LENGTH) return null;
  const trimmed = model.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Maps a turn result to the NDJSON `done` event payload. */
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

/**
 * Handles one agent request end to end: off-by-default gate, validation, run, stream, done.
 */
export async function handleAgentRequest(
  request: AgentRequest,
  response: AgentResponse,
  deps: AgentRouteDeps,
): Promise<void> {
  const deadlineAt = (deps.now ?? Date.now)() + AGENT_REQUEST_BUDGET_MS;
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
  if (!deps.authorize(request)) {
    response.status(401).json({ error: "Sign in required" });
    return;
  }
  const prompt = readPrompt(request.body);
  if (prompt === null) {
    response
      .status(400)
      .json({ error: `Body must be JSON with a non-empty "prompt" string of at most ${MAX_AGENT_PROMPT_LENGTH} characters` });
    return;
  }

  const model = readModel(request.body);
  if (model === null) {
    response.status(400).json({ error: `"model" must be a string of at most ${MAX_AGENT_MODEL_LENGTH} characters` });
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
      model,
      signal: controller.signal,
      deadlineAt,
      onText: (delta) => send({ type: "text", delta }),
      onToolStart: (name) => send({ type: "tool", name }),
    });
  } catch {
    result = { status: "error", reason: "Agent turn failed" };
  }
  const done = describeResult(result);
  // The outcome goes to the server log so a failed turn can be diagnosed; the prompt and the model's text never do.
  deps.log(JSON.stringify({ event: "agent_turn_done", ...logSafeOutcome(done) }));
  send({ type: "done", ...done });
  response.end();
}

/**
 * The status, model and reason of a finished turn, for the server log. `status` is the stable category; the reason is
 * redacted (credentials, query strings, control characters) and shortened. The browser's copy is not changed.
 */
function logSafeOutcome(done: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { status: done.status };
  if (typeof done.model === "string") out.model = redactForLog(done.model);
  if (typeof done.reason === "string") out.reason = redactForLog(done.reason);
  return out;
}
