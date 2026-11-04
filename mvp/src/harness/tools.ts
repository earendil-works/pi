// Vendored from NeuroLift-Technologies/asfdk-harness src/tools.ts @ f28136d1cece7f5dd20734020346075efc2f6d9d
// Only change from upstream: relative import specifiers use .ts (repo check:ts-imports). Do not edit otherwise: re-sync from upstream. See mvp/src/harness/README.md.
import { Type, type Static } from "typebox";
import type { AsfdkHarness } from "./harness.ts";
import {
  Channel,
  InteractionType,
  canExposeSensitiveGovernanceTools,
  resolveToolSeamChannel,
  summarizeFoundationResponse,
} from "./harness.ts";
import {
  createProtocolSnapshot,
  formatProtocolSystemPrompt,
  getThirdPartyProtocolProfiles,
  type GovernanceProtocolContext,
} from "./protocols.ts";

export const AssessTextParams = Type.Object({
  text: Type.String({ description: "Free-text content to assess through ASFDK." }),
  context: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional contextual metadata." })),
  channel: Type.Optional(
    Type.Union(
      [
        Type.Literal(Channel.USER_INPUT),
        Type.Literal(Channel.MODEL_OUTPUT),
        Type.Literal(Channel.TOOL_RESULT),
        Type.Literal(Channel.SYSTEM),
        Type.Literal(Channel.UNKNOWN),
      ],
      { description: "Channel the assessment arrives on (D4). user_input is rejected at the tool seam." },
    ),
  ),
});

export const PreferencesParams = Type.Object({
  preferences: Type.Record(Type.String(), Type.Unknown(), {
    description: "Candidate TOI/user preference object to validate/update through ASFDK.",
  }),
});

export type AssessTextInput = Static<typeof AssessTextParams>;
export type PreferencesInput = Static<typeof PreferencesParams>;

export interface AsfdkToolSkill {
  /** Pi tool this skill maps to; kept 1:1 with the tools returned by createAsfdkTools(). */
  toolName: string;
  id: string;
  name: string;
  description: string;
  tags: string[];
  /** MCP resource alias for this tool, if available */
  mcpResourceAlias?: string;
}

export const SENSITIVE_GOVERNANCE_TOOL_NAMES = new Set([
  "asfdk_governance_summary",
  "asfdk_authority_chain",
  "asfdk_governance_raw",
]);

export function isSensitiveGovernanceToolName(toolName: string): boolean {
  return SENSITIVE_GOVERNANCE_TOOL_NAMES.has(toolName);
}

/**
 * Canonical catalog mapping every Pi tool candidate to its A2A AgentSkill metadata.
 * Sensitive governance entries are filtered at runtime by createAsfdkTools() and A2A
 * card generation so advertised skills stay in sync with the active tool set.
 */
export const ASFDK_TOOL_SKILLS: AsfdkToolSkill[] = [
  {
    toolName: "asfdk_status",
    id: "asfdk.status",
    name: "ASFDK status",
    description: "Inspect foundation health, governance state, and loaded protocol context.",
    tags: ["asfdk", "status", "health", "governance"],
  },
  {
    toolName: "asfdk_protocol_status",
    id: "asfdk.protocol_status",
    name: "ASFDK protocol status",
    description: "Inspect local TOI/OTOI resolution and non-MCP protocol loading.",
    tags: ["asfdk", "protocols", "toi", "otoi"],
  },
  {
    toolName: "asfdk_interop_protocols",
    id: "asfdk.interop_protocols",
    name: "ASFDK interop protocols",
    description: "Inspect third-party interoperability protocol targets and MCP exclusion status.",
    tags: ["asfdk", "interop", "a2a", "protocols"],
  },
  {
    toolName: "asfdk_a2a_agent_card",
    id: "asfdk.a2a_agent_card",
    name: "ASFDK A2A agent card",
    description: "Generate a TOI/OTOI-governed A2A Agent Card for the current harness state.",
    tags: ["asfdk", "a2a", "agent-card", "discovery"],
  },
  {
    toolName: "asfdk_assess_text",
    id: "asfdk.assess_text",
    name: "ASFDK assess text",
    description: "Run governed text assessment through the active ASFDK foundation.",
    tags: ["asfdk", "assessment", "governance", "safety"],
  },
  {
    toolName: "asfdk_update_preferences",
    id: "asfdk.update_preferences",
    name: "ASFDK update preferences",
    description: "Validate and update user preferences through TOI/OTOI enforcement.",
    tags: ["asfdk", "preferences", "toi", "otoi"],
  },
  {
    toolName: "asfdk_governance_summary",
    id: "asfdk.governance_summary",
    name: "ASFDK governance summary",
    description: "Get a human-readable summary of the current governance state and authority structure. Use governance file before file search.",
    tags: ["asfdk", "governance", "summary", "authority"],
    mcpResourceAlias: "asfdk-governance://summary",
  },
  {
    toolName: "asfdk_authority_chain",
    id: "asfdk.authority_chain",
    name: "ASFDK authority chain",
    description: "Inspect the current authority chain, decision makers, and escalation paths. Use governance file before file search.",
    tags: ["asfdk", "authority", "escalation", "governance"],
    mcpResourceAlias: "asfdk-governance://authority-chain",
  },
  {
    toolName: "asfdk_governance_raw",
    id: "asfdk.governance_raw",
    name: "ASFDK governance raw",
    description: "Get raw governance protocol data including TOI, OTOI, and policy documents. Use governance file before file search.",
    tags: ["asfdk", "governance", "raw", "debug"],
    mcpResourceAlias: "asfdk-governance://status",
  },
];

export function formatGovernanceSummary(protocolContext: GovernanceProtocolContext): string {
  return formatProtocolSystemPrompt(protocolContext);
}

export function buildGovernanceAuthorityInfo(protocolContext: GovernanceProtocolContext) {
  const snapshot = createProtocolSnapshot(protocolContext);
  const authority = asRecord(protocolContext.devOtoi?.authority);

  return {
    finalDecisionMaker: stringValue(authority?.final_decision_maker),
    escalationRule: stringValue(authority?.principle) ?? stringValue(authority?.escalation_rule),
    guardrails: stringArray(protocolContext.devOtoi?.guardrails),
    agents: snapshot.otoi?.agents ?? [],
    tiers: snapshot.otoi?.tiers ?? [],
  };
}

export function buildGovernanceRawData(protocolContext: GovernanceProtocolContext) {
  return {
    toi: protocolContext.personalToi,
    otoiCharter: protocolContext.charter,
    effectivePolicy: protocolContext.effectivePolicy,
    effectiveToi: protocolContext.effectiveToi,
    devOtoi: protocolContext.devOtoi,
    diagnostics: protocolContext.diagnostics,
  };
}

export function createAsfdkTools(harness: AsfdkHarness) {
  return [
    {
      name: "asfdk_status",
      label: "ASFDK Status",
      description: "Return ASFDK foundation status, component health, and non-MCP protocol status for the active Pi session.",
      promptSnippet: "Inspect ASFDK foundation mode, component activation, and health.",
      promptGuidelines: ["Use asfdk_status when the user asks about the active ASFDK/Solidarity layer."],
      parameters: Type.Object({}),
      async execute() {
        const [status, health] = await Promise.all([harness.status(), harness.healthCheck()]);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ status, health }, null, 2) }],
          details: { status, health },
        };
      },
    },
    {
      name: "asfdk_protocol_status",
      label: "ASFDK Protocol Status",
      description: "Return non-MCP TOI/OTOI integration protocol status for the active harness.",
      promptSnippet: "Inspect local .toi/.otoi protocol loading, OTOI resolution, and non-MCP integration surfaces.",
      promptGuidelines: [
        "Use asfdk_protocol_status when the user asks how the harness integrates TOI/OTOI without MCP.",
      ],
      parameters: Type.Object({}),
      async execute() {
        const protocols = await harness.protocolSnapshot();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(protocols, null, 2) }],
          details: protocols as unknown as Record<string, unknown>,
        };
      },
    },
    {
      name: "asfdk_interop_protocols",
      label: "ASFDK Interop Protocols",
      description: "Return third-party interoperability protocol targets and MCP exclusion status.",
      promptSnippet: "Inspect A2A, ACP, AG-UI, REST/OpenAPI, and other non-MCP third-party protocol targets.",
      promptGuidelines: [
        "Use asfdk_interop_protocols when the user asks about A2A or third-party protocol integration.",
      ],
      parameters: Type.Object({}),
      async execute() {
        const protocols = getThirdPartyProtocolProfiles();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(protocols, null, 2) }],
          details: { protocols },
        };
      },
    },
    {
      name: "asfdk_a2a_agent_card",
      label: "ASFDK A2A Agent Card",
      description: "Generate a TOI/OTOI-governed A2A Agent Card for the current harness state.",
      promptSnippet: "Inspect the generated A2A Agent Card for the current ASFDK harness.",
      promptGuidelines: [
        "Use asfdk_a2a_agent_card when the user asks how this harness would present itself to A2A peers.",
      ],
      parameters: Type.Object({}),
      async execute() {
        const card = await harness.a2aAgentCard();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(card, null, 2) }],
          details: card as unknown as Record<string, unknown>,
        };
      },
    },
    {
      name: "asfdk_assess_text",
      label: "ASFDK Assess Text",
      description: "Assess text through ASFDK's active Solidarity Framework components.",
      promptSnippet: "Run free-text content through ASFDK emotional/crisis/governance assessment.",
      promptGuidelines: [
        "Use asfdk_assess_text for governance preflight, emotional state assessment, or crisis-signal review.",
      ],
      parameters: AssessTextParams,
      async execute(_toolCallId: string, params: AssessTextInput) {
        const channel = resolveToolSeamChannel(params.channel, console.warn);
        const result = await harness.assessText(params.text, params.context ?? {}, channel);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: result as unknown as Record<string, unknown>,
        };
      },
    },
    {
      name: "asfdk_update_preferences",
      label: "ASFDK Update Preferences",
      description: "Validate/update a user preference object through the TOI/OTOI-enabled ASFDK foundation.",
      promptSnippet: "Validate or update user preferences through ASFDK TOI/OTOI enforcement.",
      promptGuidelines: ["Use asfdk_update_preferences only when the user explicitly asks to validate or update preferences."],
      parameters: PreferencesParams,
      async execute(_toolCallId: string, params: PreferencesInput) {
        await harness.updatePreferences(params.preferences);
        const response = await harness.processInteraction(InteractionType.PREFERENCE_UPDATE, params.preferences);
        return {
          content: [{ type: "text" as const, text: summarizeFoundationResponse(response) }],
          details: response as unknown as Record<string, unknown>,
        };
      },
    },
    {
      name: "asfdk_governance_summary",
      label: "ASFDK Governance Summary",
      description: "Get a human-readable summary of the current governance state and authority structure.",
      promptSnippet: "Inspect the current ASFDK governance state, authority chain, and decision-making structure.",
      promptGuidelines: [
        "Use asfdk_governance_summary when the user asks about governance structure, authority, or decision-making processes.",
      ],
      parameters: Type.Object({}),
      async execute() {
        const protocolContext = await harness.protocolContext();
        const summary = formatGovernanceSummary(protocolContext);
        return {
          content: [{ type: "text" as const, text: summary }],
          details: { summary },
        };
      },
    },
    {
      name: "asfdk_authority_chain",
      label: "ASFDK Authority Chain",
      description: "Inspect the current authority chain, decision makers, and escalation paths.",
      promptSnippet: "Inspect the ASFDK authority chain, final decision makers, and escalation rules.",
      promptGuidelines: [
        "Use asfdk_authority_chain when the user asks about authority, escalation paths, or decision-making processes.",
      ],
      parameters: Type.Object({}),
      async execute() {
        const protocolContext = await harness.protocolContext();
        const authorityInfo = buildGovernanceAuthorityInfo(protocolContext);

        return {
          content: [{ type: "text" as const, text: JSON.stringify(authorityInfo, null, 2) }],
          details: authorityInfo,
        };
      },
    },
    {
      name: "asfdk_governance_raw",
      label: "ASFDK Governance Raw",
      description: "Get raw governance protocol data including TOI, OTOI, and policy documents.",
      promptSnippet: "Inspect raw TOI, OTOI, and governance policy documents for debugging and development.",
      promptGuidelines: [
        "Use asfdk_governance_raw only for debugging, development, or when explicit raw governance data is requested.",
      ],
      parameters: Type.Object({}),
      async execute() {
        const protocolContext = await harness.protocolContext();
        const rawData = buildGovernanceRawData(protocolContext);

        return {
          content: [{ type: "text" as const, text: JSON.stringify(rawData, null, 2) }],
          details: rawData,
        };
      },
    },
  ].filter((tool) => {
    return !isSensitiveGovernanceToolName(tool.name) || canExposeSensitiveGovernanceTools(harness.mode);
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
