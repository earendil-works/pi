/**
 * Governed agent composition for the NLT Coding Agent MVP.
 *
 * Wraps the vendored ASFDK harness and the governed-turn gate. This module deliberately
 * does not import the coding-agent runtime, so it (and its tests) do not require the
 * workspace packages to be built.
 */

import { Channel, AsfdkHarness } from "./harness/harness.ts";
import type { FoundationResponse, HealthCheckResult } from "@neurolift-technologies/asfdk";
import { evaluateGate } from "./gate.ts";

export interface NltCodingAgentConfig {
  userId?: string;
  sessionId?: string;
  mode?: string;
  cwd?: string;
  toiPath?: string;
  otoiPath?: string;
  toiContent?: string;
  otoiContent?: string;
}

export interface GovernedTurnInput {
  prompt: string;
  userId?: string;
  sessionId?: string;
  mode?: string;
  cwd?: string;
  context?: Record<string, unknown>;
  channel?: Channel;
}

export interface GovernedTurnResult {
  allowed: boolean;
  crisisLevel: string | null;
  interaction: FoundationResponse;
  emotionalState: unknown;
  governance: Record<string, unknown>;
  continuity: Record<string, unknown> | null;
  blockedReason: string | null;
}

export interface NltCodingAgent {
  readonly harness: AsfdkHarness;
  readonly mode: string;
  assessText(
    text: string,
    context?: Record<string, unknown>,
    channel?: Channel,
  ): Promise<{ interaction: FoundationResponse; emotionalState: unknown }>;
  healthCheck(): Promise<HealthCheckResult>;
  status(): Promise<Record<string, unknown>>;
  protocolSnapshot(): Promise<Record<string, unknown>>;
  protocolSystemPrompt(): Promise<string>;
  foundation(): Promise<unknown>;
  governedTurn(input: GovernedTurnInput): Promise<GovernedTurnResult>;
}

export function createNltCodingAgent(config: NltCodingAgentConfig = {}): NltCodingAgent {
  const harness = new AsfdkHarness({
    userId: config.userId,
    sessionId: config.sessionId,
    mode: config.mode as never,
    cwd: config.cwd,
    toiPath: config.toiPath,
    otoiPath: config.otoiPath,
    toiContent: config.toiContent,
    otoiContent: config.otoiContent,
  });

  return {
    harness,
    mode: "UNIFIED",
    assessText: (text, context, channel) => harness.assessText(text, context ?? {}, channel ?? Channel.UNKNOWN),
    healthCheck: () => harness.healthCheck(),
    status: () => harness.status(),
    protocolSnapshot: async () => (await harness.protocolSnapshot()) as unknown as Record<string, unknown>,
    protocolSystemPrompt: () => harness.protocolSystemPrompt(),
    foundation: () => harness.foundation(),
    governedTurn: async (input: GovernedTurnInput): Promise<GovernedTurnResult> => {
      const assessment = await harness.assessText(
        input.prompt,
        input.context ?? {},
        input.channel ?? Channel.UNKNOWN,
      );
      const interaction = assessment.interaction;
      const emotionalState = assessment.emotionalState;
      const { allowed, crisisLevel, blockedReason } = evaluateGate(interaction, emotionalState);

      const governance: Record<string, unknown> = {
        componentsInvolved: interaction?.componentsInvolved ?? [],
        responseType: interaction?.responseType ?? null,
      };

      const continuity = (emotionalState ?? null) as Record<string, unknown> | null;

      return {
        allowed,
        crisisLevel,
        interaction,
        emotionalState,
        governance,
        continuity,
        blockedReason,
      };
    },
  };
}
