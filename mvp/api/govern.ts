/**
 * Preview-only governance gate test endpoint.
 *
 * POST { "prompt": string } runs the prompt through the vendored ASFDK harness and the
 * governed-turn gate and returns the gate decision. It never starts the coding agent,
 * calls a model, or runs a tool.
 *
 * It stores no data durably. The ASFDK Sleepwalker component writes continuity files to a
 * relative `.swp_storage` directory under the process working directory; serverless function
 * directories are read-only, so the handler switches to the OS temp directory first. Those
 * files are ephemeral to the function instance, and each request uses its own user id so one
 * caller's state never influences another's.
 *
 * This is an observability and verification surface. Its response is not an ASFDK
 * authorization decision and must never be used to authorize a tool, model, or
 * execution request.
 *
 * It does not exist in production: when VERCEL_ENV is "production" it answers 404.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
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

  // The foundation's Sleepwalker storage path is relative to process.cwd() and cannot be configured,
  // and serverless function directories are read-only, so run from the writable temp directory.
  const workDir = tmpdir();
  const harness = new AsfdkHarness({ userId: `preview-gate-${randomUUID()}`, cwd: workDir });
  try {
    process.chdir(workDir);
    await harness.start();
    const { interaction, emotionalState } = await harness.assessText(prompt, {}, Channel.UNKNOWN);
    const decision = evaluateGate(interaction, emotionalState);
    // An assessment that could not run is a service failure (503), not a verdict (200).
    return response.status(decision.assessmentFailed ? 503 : 200).json({
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
