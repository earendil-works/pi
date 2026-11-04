/**
 * NLT Coding Agent MVP application entry point.
 *
 * Builds the MVP governed coding agent by composing the ASFDK Solidarity
 * Framework harness (vendored under ./harness) with the `@earendil-works/pi-coding-agent`
 * runtime.
 *
 * Governance boundary:
 * - The harness owns governance state, protocol resolution (TOI/OTOI), tool
 *   policy, and the assessment/governance/continuity pipeline.
 * - The coding-agent runtime owns agent turns, tools, sessions, and execution.
 * - The MVP application owns the request lifecycle and agent composition.
 */

import asfdkPiHarness, { AsfdkHarness } from "./harness/extension.ts";
import { Channel } from "./harness/harness.ts";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { rrt, type FoundationResponse, type HealthCheckResult } from "@neurolift-technologies/asfdk";
import {
  createNltCodingAgent,
  type GovernedTurnInput,
  type GovernedTurnResult,
  type NltCodingAgent,
  type NltCodingAgentConfig,
} from "./governed-agent.ts";

export { createNltCodingAgent };
export type { GovernedTurnInput, GovernedTurnResult, NltCodingAgent, NltCodingAgentConfig };

export interface NltCodingTurnResult extends GovernedTurnResult {
  /** Final assistant text produced by the coding-agent runtime, when allowed. */
  response: string | null;
  /** Post-turn governance + continuity bookkeeping captured after execution. */
  postTurn: {
    governance: Record<string, unknown>;
    continuity: Record<string, unknown> | null;
    governedAt: Date;
  };
}

function buildPreflightBlocks(governed: GovernedTurnResult): string[] {
  const blocks: string[] = [];
  const interaction = governed.interaction;
  blocks.push(
    `[ASFDK Authority] ${JSON.stringify({
      componentsInvolved: interaction?.componentsInvolved ?? [],
      responseType: interaction?.responseType ?? null,
      allowed: governed.allowed,
    })}`,
  );
  if (governed.crisisLevel && governed.crisisLevel !== rrt.CrisisLevel.GREEN) {
    blocks.push(
      `[RRT Advocate] Crisis level: ${governed.crisisLevel}${governed.blockedReason ? ` — ${governed.blockedReason}` : ""}`,
    );
  }
  if (governed.continuity) {
    blocks.push(`[Sleepwalker Continuity] ${JSON.stringify(governed.continuity)}`);
  }
  return blocks;
}

/**
 * Runs one coding-agent turn under the NLT governance boundary.
 *
 * Flow:
 *  1. Assess the prompt through the ASFDK harness (crisis / governance / continuity).
 *  2. If the assessment blocks (RED/BLACK crisis or failed governance), do not run the
 *     agent turn — return the blocked result with a refusal reason.
 *  3. If allowed, execute the turn through the pi-coding-agent runtime with the ASFDK
 *     harness extension loaded, and return the final assistant response.
 */
export async function runNltCodingTurn(input: GovernedTurnInput & { cwd?: string }): Promise<NltCodingTurnResult> {
  const agent = createNltCodingAgent({
    userId: input.userId,
    sessionId: input.sessionId,
    mode: input.mode,
    cwd: input.cwd,
  });

  const governed = await agent.governedTurn({
    prompt: input.prompt,
    userId: input.userId,
    sessionId: input.sessionId,
    mode: input.mode,
    cwd: input.cwd,
    context: input.context,
    channel: input.channel,
  });

  if (!governed.allowed) {
    return {
      ...governed,
      response: null,
      postTurn: {
        governance: { ...governed.governance, response: null },
        continuity: governed.continuity,
        governedAt: new Date(),
      },
    };
  }

  const cwd = input.cwd ?? process.cwd();
  const governedExtension: ExtensionFactory = (pi) => {
    pi.on("before_agent_start", async (event) => {
      if (event.messageType !== "user") {
        return;
      }
      const protocolSystemPrompt = await agent.harness.protocolSystemPrompt();
      const blocks = buildPreflightBlocks(governed);
      const systemPrompt = [event.systemPrompt, protocolSystemPrompt, ...blocks]
        .filter((part) => part.length > 0)
        .join("\n\n");
      return { systemPrompt };
    });
  };

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    extensionFactories: [governedExtension, asfdkPiHarness],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    resourceLoader,
    sessionManager: SessionManager.create(cwd),
  });

  let responseText = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      responseText += event.assistantMessageEvent.delta;
    }
  });

  try {
    await session.prompt(input.prompt);
  } finally {
    unsubscribe();
    await session.dispose();
  }

  return {
    ...governed,
    response: responseText,
    postTurn: {
      governance: { ...governed.governance, response: responseText },
      continuity: governed.continuity,
      governedAt: new Date(),
    },
  };
}

export { AsfdkHarness, Channel };
export type { FoundationResponse, HealthCheckResult };
