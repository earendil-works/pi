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

import asfdkPiHarness, { AsfdkHarness, Channel } from "@neurolift-technologies/asfdk-harness";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { FoundationResponse, HealthCheckResult } from "@neurolift-technologies/asfdk";

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

/** Crisis levels that require human escalation before any agent turn may run. */
const BLOCKING_CRISIS_LEVELS: ReadonlySet<string> = new Set(["RED", "BLACK"]);

function toRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function extractCrisisLevel(
  interaction: FoundationResponse | undefined,
  emotionalState: unknown,
): string | null {
  const content = toRecord(interaction?.content);
  const rrt = toRecord(content.rrt);
  const level = rrt.crisisLevel;
  if (typeof level === "string") {
    return level;
  }
  const state = toRecord(emotionalState);
  const stateLevel = state.crisisLevel ?? state.level;
  return typeof stateLevel === "string" ? stateLevel : null;
}

function hasHighRiskState(state: Record<string, unknown>): boolean {
  return (
    Boolean(state.explicitSuicidalIdeation) ||
    Boolean(state.selfHarmIndicators) ||
    Boolean(state.inabilityToEnsureSafety)
  );
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
  if (governed.crisisLevel && governed.crisisLevel !== "GREEN") {
    blocks.push(
      `[RRT Advocate] Crisis level: ${governed.crisisLevel}${governed.blockedReason ? ` — ${governed.blockedReason}` : ""}`,
    );
  }
  if (governed.continuity) {
    blocks.push(`[Sleepwalker Continuity] ${JSON.stringify(governed.continuity)}`);
  }
  return blocks;
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
    governedTurn: async (input: GovernedTurnInput): Promise<GovernedTurnResult> => {
      const assessment = await harness.assessText(
        input.prompt,
        input.context ?? {},
        input.channel ?? Channel.UNKNOWN,
      );
      const interaction = assessment.interaction;
      const emotionalState = assessment.emotionalState;
      const crisisLevel = extractCrisisLevel(interaction, emotionalState);
      const highRisk =
        BLOCKING_CRISIS_LEVELS.has(crisisLevel ?? "") || hasHighRiskState(toRecord(emotionalState));
      const interactionFailed = interaction?.success === false;
      const allowed = !highRisk && !interactionFailed;

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
        blockedReason: allowed
          ? null
          : highRisk
            ? `Crisis intervention required before agent turn execution (level: ${crisisLevel ?? "unknown"})`
            : "Governance assessment failed before agent turn execution",
      };
    },
  };
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
        governance: governed.governance,
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
