// Vendored from NeuroLift-Technologies/asfdk-harness src/a2a.ts @ 5488262c96d97026b27703d6580da65c2bcb1fb6
// Only change from upstream: relative import specifiers use .ts (repo check:ts-imports). Do not edit otherwise: re-sync from upstream. See mvp/src/harness/README.md.
import { createProtocolSnapshot, type GovernanceProtocolContext, type ThirdPartyProtocolProfile } from "./protocols.ts";
import { ASFDK_TOOL_SKILLS, isSensitiveGovernanceToolName } from "./tools.ts";

export interface A2ASkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

/**
 * A2A capability extension (vendor namespace). Used to advertise NeuroLift TOI/OTOI
 * governance features without polluting the standard top-level AgentCard fields.
 */
export interface A2AAgentExtension {
  uri: string;
  description?: string;
  required: boolean;
  params?: Record<string, unknown>;
}

export interface A2AAgentCardOptions {
  agentId?: string;
  agentName?: string;
  description?: string;
  url?: string;
  version?: string;
  protocolVersion?: string;
  preferredTransport?: "JSONRPC";
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  streaming?: boolean;
  pushNotifications?: boolean;
  includeSensitiveGovernanceTools?: boolean;
}

export interface A2AAgentCard {
  kind: "a2a-agent-card";
  protocolVersion: string;
  id: string;
  name: string;
  description: string;
  version: string;
  url: string;
  preferredTransport: "JSONRPC";
  defaultInputModes: string[];
  defaultOutputModes: string[];
  discovery: {
    protocol: "A2A";
    mechanism: "Agent Card";
  };
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
    extensions: A2AAgentExtension[];
  };
  governance: {
    toiPath: string;
    otoiPath: string;
    toiAuthor?: string;
    privacy?: Record<string, unknown>;
    agency?: Record<string, unknown>;
    guardrails: string[];
    authority: {
      finalDecisionMaker?: string;
      escalationRule?: string;
    };
    otoi: {
      version?: string;
      agents: string[];
      tiers: string[];
      enforcement?: Record<string, unknown>;
      conflicts: number;
    } | undefined;
  };
  skills: A2ASkill[];
  interopProtocols: Array<Pick<ThirdPartyProtocolProfile, "id" | "name" | "layer" | "status" | "discovery" | "harnessSurface">>;
  metadata: {
    generatedAt: string;
    cwd: string;
    protocolSurface: string[];
    diagnostics: string[];
  };
}

const A2A_PROTOCOL_VERSION = "0.3.0";
const NLT_GOVERNANCE_EXTENSION_URI = "https://neurolift.tech/a2a/extensions/governance";
const DEFAULT_A2A_MODES = ["text/plain", "application/json"];

export function createA2AAgentCard(
  context: GovernanceProtocolContext,
  options: A2AAgentCardOptions = {},
): A2AAgentCard {
  const snapshot = createProtocolSnapshot(context);
  const interopProtocols = snapshot.thirdPartyProtocols.filter((protocol) => protocol.status !== "separate-owner");
  const skills = buildA2ASkills(options.includeSensitiveGovernanceTools ?? false);
  const authority = asRecord(context.devOtoi?.authority);

  const diagnostics = [...context.diagnostics];
  const url = options.url ?? (typeof process !== "undefined" ? process.env.ASFDK_A2A_URL : undefined) ?? "";
  if (!url) {
    diagnostics.push(
      "A2A Agent Card has no service endpoint URL; set ASFDK_A2A_URL or pass options.url. The card is emitted without a callable endpoint.",
    );
  }

  return {
    kind: "a2a-agent-card",
    protocolVersion: options.protocolVersion ?? A2A_PROTOCOL_VERSION,
    id: options.agentId ?? "asfdk-harness",
    name: options.agentName ?? "ASFDK Harness",
    description:
      options.description ??
      "Governed Pi harness for TOI/OTOI-aware agent delegation and third-party interoperability.",
    version: options.version ?? "0.1.0",
    url,
    preferredTransport: options.preferredTransport ?? "JSONRPC",
    defaultInputModes: options.defaultInputModes ?? [...DEFAULT_A2A_MODES],
    defaultOutputModes: options.defaultOutputModes ?? [...DEFAULT_A2A_MODES],
    discovery: {
      protocol: "A2A",
      mechanism: "Agent Card",
    },
    capabilities: {
      streaming: options.streaming ?? false,
      pushNotifications: options.pushNotifications ?? false,
      stateTransitionHistory: false,
      extensions: [
        {
          uri: NLT_GOVERNANCE_EXTENSION_URI,
          description: "NeuroLift TOI/OTOI governance capabilities exposed by the ASFDK harness.",
          required: false,
          params: {
            agentToAgentDelegation: true,
            governedTaskExecution: true,
            humanInTheLoopApprovals: true,
            privacyFiltering: true,
          },
        },
      ],
    },
    governance: {
      toiPath: context.toiPath,
      otoiPath: context.otoiPath,
      toiAuthor: context.effectiveToi?.identity?.author,
      privacy: toPlainRecord(context.effectiveToi?.privacy),
      agency: toPlainRecord(context.effectiveToi?.agency),
      guardrails: stringArray(context.devOtoi?.guardrails),
      authority: {
        finalDecisionMaker: stringValue(authority?.final_decision_maker),
        escalationRule: stringValue(authority?.principle) ?? stringValue(authority?.escalation_rule),
      },
      otoi: context.effectivePolicy
        ? {
            version: context.charter?.$otoi,
            agents: context.effectivePolicy.agents.map((agent: any) => agent.id),
            tiers: context.effectivePolicy.tiers,
            enforcement: { ...context.effectivePolicy.enforcement },
            conflicts: context.effectivePolicy.conflicts.length,
          }
        : undefined,
    },
    skills,
    interopProtocols,
    metadata: {
      generatedAt: new Date().toISOString(),
      cwd: context.cwd,
      protocolSurface: snapshot.protocols,
      diagnostics,
    },
  };
}

export function getA2ASkillIds(options: Pick<A2AAgentCardOptions, "includeSensitiveGovernanceTools"> = {}): string[] {
  return buildA2ASkills(options.includeSensitiveGovernanceTools ?? false).map((skill) => skill.id);
}

function buildA2ASkills(includeSensitiveGovernanceTools: boolean): A2ASkill[] {
  // Derived from the Pi tool catalog and filtered by the same gate as runtime tool exposure.
  return ASFDK_TOOL_SKILLS.filter(
    (skill) => includeSensitiveGovernanceTools || !isSensitiveGovernanceToolName(skill.toolName),
  ).map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: [...skill.tags],
  }));
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

function toPlainRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return record ? { ...record } : undefined;
}
