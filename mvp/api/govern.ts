/**
 * Preview-only governance gate test endpoint.
 *
 * POST { "prompt": string } runs the prompt through the vendored ASFDK harness and the
 * governed-turn gate and returns the gate decision. It never starts the coding agent,
 * calls a model, or runs a tool, and it persists nothing.
 *
 * This is an observability and verification surface. Its response is not an ASFDK
 * authorization decision and must never be used to authorize a tool, model, or
 * execution request.
 *
 * It does not exist in production: when VERCEL_ENV is "production" it answers 404.
 */
import { evaluateGate } from "../src/gate.ts";
import { AsfdkHarness, Channel } from "../src/harness/harness.ts";

const MAX_PROMPT_LENGTH = 2000;

interface GovernRequest {
  method?: string;
  body?: unknown;
}

interface GovernResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(body: unknown): unknown };
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
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const prompt = (parsed as Record<string, unknown>).prompt;
  return typeof prompt === "string" && prompt.length > 0 && prompt.length <= MAX_PROMPT_LENGTH ? prompt : null;
}

export default async function handler(request: GovernRequest, response: GovernResponse) {
  response.setHeader("Cache-Control", "no-store");

  if (process.env.VERCEL_ENV === "production") {
    return response.status(404).json({ error: "Not found" });
  }

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const prompt = readPrompt(request.body);
  if (prompt === null) {
    return response.status(400).json({ error: `Body must be JSON with a non-empty "prompt" string of at most ${MAX_PROMPT_LENGTH} characters` });
  }

  // Serverless filesystems are read-only outside /tmp; the foundation writes continuity state to cwd.
  const harness = new AsfdkHarness({ userId: "preview-gate-test", cwd: "/tmp" });
  try {
    await harness.start();
    const { interaction, emotionalState } = await harness.assessText(prompt, {}, Channel.UNKNOWN);
    const decision = evaluateGate(interaction, emotionalState);
    return response.status(200).json({
      allowed: decision.allowed,
      crisisLevel: decision.crisisLevel,
      blockedReason: decision.blockedReason,
      componentsInvolved: interaction?.componentsInvolved ?? [],
      executionEnabled: false,
    });
  } catch {
    // Fail closed: an assessment that could not run is not a pass.
    return response.status(503).json({
      allowed: false,
      blockedReason: "Governance assessment unavailable",
      executionEnabled: false,
    });
  } finally {
    await harness.shutdown().catch(() => undefined);
  }
}
