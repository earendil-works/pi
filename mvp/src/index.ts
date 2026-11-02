/**
 * NLT Coding Agent MVP application entry point.
 *
 * Builds the MVP governed coding agent by composing the ASFDK Solidarity
 * Framework harness (`asfdk-harness`) with the `@earendil-works/pi-coding-agent`
 * runtime.
 *
 * Governance boundary:
 * - The harness owns governance state, protocol resolution (TOI/OTOI), tool
 *   policy, and the assessment/governance/continuity pipeline.
 * - The coding-agent runtime owns agent turns, tools, sessions, and execution.
 * - The MVP application owns the request lifecycle and agent composition.
 */

import { AsfdkHarness, Channel } from "@neurolift-technologies/asfdk-harness";
import type {
  FoundationResponse,
  HealthCheckResult,
} from "@neurolift-technologies/asfdk";

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
    protocolSnapshot: async () => (await harness.protocolSnapshot()) as Record<string, unknown>,
    protocolSystemPrompt: () => harness.protocolSystemPrompt(),
    foundation: () => harness.foundation(),
  };
}

export { AsfdkHarness, Channel };
export type { FoundationResponse, HealthCheckResult };
