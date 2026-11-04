// Vendored from NeuroLift-Technologies/asfdk-harness src/protocols.ts @ f28136d1cece7f5dd20734020346075efc2f6d9d
// Changes from upstream: relative import specifiers use .ts (repo check:ts-imports), and readOptionalFile reads once
// instead of access()+readFile() (CodeQL js/file-system-race). Do not edit otherwise: re-sync from upstream. See mvp/src/harness/README.md.
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAsfdk } from "./asfdk-runtime.ts";

type ToiDocument = any;
type OtoiCharter = any;
type EffectivePolicy = any;

export type IntegrationProtocol =
  | "local-toi-file"
  | "local-otoi-charter"
  | "otoi-honor-resolution"
  | "pi-extension-hooks"
  | "sdk-cli-runner"
  | "asfdk-tool-policy";

export type ThirdPartyProtocolStatus = "target" | "adapter-candidate" | "watchlist" | "separate-owner";

export interface ThirdPartyProtocolProfile {
  id: "a2a" | "acp" | "ag-ui" | "openapi" | "nlip-openfloor" | "mcp";
  name: string;
  layer: "agent-to-agent" | "agent-to-user" | "agent-to-api" | "conversation" | "agent-to-tool";
  status: ThirdPartyProtocolStatus;
  direction: "inbound" | "outbound" | "bidirectional";
  transport: string;
  discovery: string;
  harnessSurface: string;
  mcpBoundary: string;
  sourceUrl: string;
  notes: string[];
}

export interface ProtocolLoadOptions {
  cwd?: string;
  toiPath?: string;
  otoiPath?: string;
  /** Inline TOI JSON string — bypasses filesystem read (used in Workers environment). */
  toiContent?: string;
  /** Inline OTOI JSON string — bypasses filesystem read (used in Workers environment). */
  otoiContent?: string;
}

export interface GovernanceProtocolContext {
  cwd: string;
  toiPath: string;
  otoiPath: string;
  protocols: IntegrationProtocol[];
  diagnostics: string[];
  personalToi?: ToiDocument;
  charter?: OtoiCharter;
  effectivePolicy?: EffectivePolicy;
  effectiveToi?: ToiDocument;
  devOtoi?: Record<string, unknown>;
}

export type PromptMode = "compact" | "full";

export interface GovernanceProtocolSnapshot {
  cwd: string;
  paths: {
    toi: string;
    otoi: string;
  };
  protocols: IntegrationProtocol[];
  diagnostics: string[];
  toi?: {
    tier?: string;
    author?: string;
    communication?: Record<string, unknown>;
    privacy?: Record<string, unknown>;
    agency?: Record<string, unknown>;
    ethicalPillars?: string[];
  };
  otoi?: {
    version?: string;
    agents: string[];
    tiers: string[];
    enforcement?: Record<string, unknown>;
    conflicts: number;
    devOtoiDocumentId?: string;
  };
  thirdPartyProtocols: ThirdPartyProtocolProfile[];
}

export async function loadGovernanceProtocols(options: ProtocolLoadOptions = {}): Promise<GovernanceProtocolContext> {
  const { otoi, toi } = await loadAsfdk();
  const cwd = resolve(options.cwd ?? process.cwd());
  const configuredToiPath = options.toiPath ?? process.env.ASFDK_TOI_PATH;
  const toiPath = configuredToiPath
    ? resolveProtocolPath(cwd, configuredToiPath)
    : await resolveDefaultToiPath(cwd);
  const otoiPath = resolveProtocolPath(cwd, options.otoiPath ?? process.env.ASFDK_OTOI_PATH ?? ".otoi");
  const protocols: IntegrationProtocol[] = ["pi-extension-hooks", "sdk-cli-runner", "asfdk-tool-policy"];
  const diagnostics: string[] = [];

  let personalToi: ToiDocument | undefined;
  let charter: OtoiCharter | undefined;
  let effectivePolicy: EffectivePolicy | undefined;

  const toiText = options.toiContent ?? (await readOptionalFile(toiPath));
  if (toiText === undefined) {
    diagnostics.push(`No .toi document found at ${toiPath}`);
  } else {
    try {
      personalToi = toi.parseToi(toiText);
      protocols.push("local-toi-file");
    } catch (error) {
      diagnostics.push(`Failed to parse .toi at ${toiPath}: ${formatError(error)}`);
    }
  }

  const otoiText = options.otoiContent ?? (await readOptionalFile(otoiPath));
  if (otoiText === undefined) {
    diagnostics.push(`No .otoi charter found at ${otoiPath}`);
  } else {
    try {
      charter = otoi.parseCharter(JSON.parse(otoiText));
      protocols.push("local-otoi-charter");
      effectivePolicy = await otoi.honor(charter, {
        loadSource: (uri) => {
          // When inline TOI content is available, serve it for any .toi source URI
          // instead of hitting the filesystem (required in Workers environment).
          if (options.toiContent && (uri.endsWith(".toi") || uri.endsWith(".toi.default"))) {
            return Promise.resolve(options.toiContent);
          }
          return readFile(resolveSourceUri(dirname(otoiPath), uri), "utf8");
        },
      });
      protocols.push("otoi-honor-resolution");
    } catch (error) {
      diagnostics.push(`Failed to honor .otoi at ${otoiPath}: ${formatError(error)}`);
    }
  }

  const isDefaultToi = toiPath.endsWith(".toi.default");
  const effectiveToi = !isDefaultToi && personalToi != null ? personalToi : effectivePolicy?.effective ?? personalToi;
  const devOtoi = extractDevOtoi(charter, effectiveToi);

  return {
    cwd,
    toiPath,
    otoiPath,
    protocols,
    diagnostics,
    personalToi,
    charter,
    effectivePolicy,
    effectiveToi,
    devOtoi,
  };
}

export function createProtocolSnapshot(context: GovernanceProtocolContext): GovernanceProtocolSnapshot {
  const effective = context.effectiveToi;
  return {
    cwd: context.cwd,
    paths: {
      toi: context.toiPath,
      otoi: context.otoiPath,
    },
    protocols: context.protocols,
    diagnostics: context.diagnostics,
    toi: effective
      ? {
          tier: effective.$tier,
          author: effective.identity?.author,
          communication: toPlainRecord(effective.communication),
          privacy: toPlainRecord(effective.privacy),
          agency: toPlainRecord(effective.agency),
          ethicalPillars: effective.ethical_pillars,
        }
      : undefined,
    otoi: context.effectivePolicy
      ? {
          version: context.charter?.$otoi,
            agents: context.effectivePolicy.agents.map((agent: any) => agent.id),
          tiers: context.effectivePolicy.tiers,
          enforcement: { ...context.effectivePolicy.enforcement },
          conflicts: context.effectivePolicy.conflicts.length,
          devOtoiDocumentId: stringValue(context.devOtoi?.document_id),
        }
      : undefined,
    thirdPartyProtocols: getThirdPartyProtocolProfiles(),
  };
}

export function formatProtocolSystemPrompt(
  context: GovernanceProtocolContext,
  promptMode: PromptMode = "compact",
): string {
  const snapshot = createProtocolSnapshot(context);

  if (promptMode === "compact") {
    const compactLines: string[] = [
      `ASFDK protocol layer active. Protocols: ${snapshot.protocols.join(", ")}.`,
    ];

    if (snapshot.toi) {
      compactLines.push(
        `TOI: author=${snapshot.toi.author ?? "unknown"}, tier=${snapshot.toi.tier ?? "unspecified"}`,
      );
    }

    if (snapshot.otoi) {
      const enforcement = snapshot.otoi.enforcement?.mode ?? "enforced";
      compactLines.push(
        `OTOI: agents=[${snapshot.otoi.agents.join(", ")}], enforcement=${enforcement}`,
      );
    }

    const guardrails = stringArray(asRecord(context.devOtoi)?.guardrails);
    if (guardrails.length) {
      compactLines.push(`Developer OTOI: ${guardrails.length} guardrails active`);
    }

    const authority = asRecord(asRecord(context.devOtoi)?.authority);
    const finalDecisionMaker = stringValue(authority?.final_decision_maker);
    const principle = stringValue(authority?.principle) ?? stringValue(authority?.escalation_rule);
    if (finalDecisionMaker) {
      compactLines.push(`Authority: ${finalDecisionMaker} — ${principle ?? "escalate instead of guessing"}`);
    }

    return compactLines.join("\n");
  }

  const lines = [
    "ASFDK local and third-party protocol registry layer is active.",
    "Use local file, Pi extension, SDK/CLI, ASFDK tool-policy, and approved third-party interop protocols. MCP work is owned by a separate active thread and should not be modified from this layer.",
    `Active protocols: ${snapshot.protocols.join(", ")}.`,
  ];

  if (snapshot.toi) {
    lines.push(
      "Resolved Terms of Interaction:",
      `- Author: ${snapshot.toi.author ?? "unknown"}`,
      `- Communication: ${formatRecord(snapshot.toi.communication)}`,
      `- Privacy floor: ${formatRecord(snapshot.toi.privacy)}`,
      `- Agency: ${formatRecord(snapshot.toi.agency)}`,
    );

    if (snapshot.toi.ethicalPillars?.length) {
      lines.push(`- Ethical pillars: ${snapshot.toi.ethicalPillars.join(", ")}`);
    }
  }

  if (snapshot.otoi) {
    lines.push(
      "Resolved Orchestration:",
      `- Agents bound: ${snapshot.otoi.agents.join(", ") || "none declared"}`,
      `- Tiers honored: ${snapshot.otoi.tiers.join(", ") || "none"}`,
      `- Enforcement: ${formatRecord(snapshot.otoi.enforcement)}`,
      `- Same-tier conflicts: ${snapshot.otoi.conflicts}`,
    );
  }

  const guardrails = stringArray(asRecord(context.devOtoi)?.guardrails);
  if (guardrails.length) {
    lines.push("Developer OTOI guardrails:");
    for (const guardrail of guardrails) lines.push(`- ${guardrail}`);
  }

  const authority = asRecord(asRecord(context.devOtoi)?.authority);
  const finalDecisionMaker = stringValue(authority?.final_decision_maker);
  const principle = stringValue(authority?.principle) ?? stringValue(authority?.escalation_rule);
  if (finalDecisionMaker || principle) {
    lines.push(
      "Developer OTOI authority:",
      `- Final decision maker: ${finalDecisionMaker ?? "unspecified"}`,
      `- Escalation rule: ${principle ?? "unspecified"}`,
    );
  }

  if (snapshot.diagnostics.length) {
    lines.push("Protocol diagnostics:");
    for (const diagnostic of snapshot.diagnostics) lines.push(`- ${diagnostic}`);
  }

  const thirdPartyTargets = snapshot.thirdPartyProtocols.filter((protocol) => protocol.status !== "separate-owner");
  if (thirdPartyTargets.length) {
    lines.push("Third-party interoperability focus:");
    for (const protocol of thirdPartyTargets) {
      lines.push(`- ${protocol.name}: ${protocol.layer}, ${protocol.status}, ${protocol.harnessSurface}`);
    }
  }

  return lines.join("\n");
}

export function getThirdPartyProtocolProfiles(): ThirdPartyProtocolProfile[] {
  return [
    {
      id: "a2a",
      name: "Agent2Agent (A2A)",
      layer: "agent-to-agent",
      status: "target",
      direction: "bidirectional",
      transport: "JSON-RPC 2.0 over HTTP(S), with optional SSE streaming and push notifications",
      discovery: "Agent Card",
      harnessSurface: "Expose asfdk-harness as a governed remote agent and consume remote A2A agents through TOI/OTOI preflight.",
      mcpBoundary: "Do not map A2A tasks to MCP tools; keep A2A as agent-to-agent delegation.",
      sourceUrl: "https://a2a-protocol.org/latest/",
      notes: [
        "Highest-priority external protocol for cross-framework agent delegation.",
        "Use ASFDK policy before accepting or delegating long-running tasks.",
        "Agent Card should advertise governance, escalation, and privacy posture without exposing private TOI contents.",
      ],
    },
    {
      id: "acp",
      name: "Agent Communication Protocol (ACP)",
      layer: "agent-to-agent",
      status: "adapter-candidate",
      direction: "bidirectional",
      transport: "RESTful HTTP API with synchronous, asynchronous, and streaming runs",
      discovery: "Agent Manifest and discovery endpoints",
      harnessSurface: "Provide a REST adapter for teams already using ACP/BeeAI while aligning migration with A2A.",
      mcpBoundary: "Do not use ACP's MCP adapter path in this harness.",
      sourceUrl: "https://agentcommunicationprotocol.dev/introduction/welcome",
      notes: [
        "ACP documentation now states ACP is part of A2A under the Linux Foundation.",
        "Useful for REST-native environments where JSON-RPC is not the preferred integration shape.",
        "Treat as compatibility adapter rather than the primary strategic target.",
      ],
    },
    {
      id: "ag-ui",
      name: "Agent User Interaction Protocol (AG-UI)",
      layer: "agent-to-user",
      status: "target",
      direction: "bidirectional",
      transport: "Event-based protocol over web transports such as HTTP and WebSockets",
      discovery: "Client/framework integration rather than agent-card discovery",
      harnessSurface: "Stream governed state, interrupts, approvals, and tool-result events to user-facing apps.",
      mcpBoundary: "Do not deliver AG-UI events via MCP resources or MCP Apps.",
      sourceUrl: "https://docs.ag-ui.com/introduction",
      notes: [
        "Best fit for frontend approval, interrupt, steering, and state visualization flows.",
        "Complements A2A: A2A delegates between agents; AG-UI keeps humans in the interaction loop.",
        "Use TOI privacy settings to filter event payloads before frontend delivery.",
      ],
    },
    {
      id: "openapi",
      name: "OpenAPI / REST facade",
      layer: "agent-to-api",
      status: "adapter-candidate",
      direction: "inbound",
      transport: "HTTP REST with OpenAPI 3.x description",
      discovery: "OpenAPI document",
      harnessSurface: "Expose a conventional governance/status API for non-agent systems and enterprise gateways.",
      mcpBoundary: "Do not auto-convert OpenAPI operations into MCP tools inside this package.",
      sourceUrl: "https://spec.openapis.org/oas/latest.html",
      notes: [
        "Not an agent protocol by itself, but important for enterprise systems that will not adopt A2A immediately.",
        "Good fit for status, audit, policy preview, and controlled assessment endpoints.",
      ],
    },
    {
      id: "nlip-openfloor",
      name: "NLIP / Open Floor conversation protocols",
      layer: "conversation",
      status: "watchlist",
      direction: "bidirectional",
      transport: "Conversation-level message protocols",
      discovery: "Protocol-specific participant metadata",
      harnessSurface: "Potential future bridge for voice/conversational assistant interoperability.",
      mcpBoundary: "Keep conversational routing separate from MCP tool/resource access.",
      sourceUrl: "https://voiceinteroperability.ai",
      notes: [
        "Track for conversational and voice-agent interoperability.",
        "Do not implement until a concrete target host or customer integration exists.",
      ],
    },
    {
      id: "mcp",
      name: "Model Context Protocol (MCP)",
      layer: "agent-to-tool",
      status: "separate-owner",
      direction: "bidirectional",
      transport: "JSON-RPC based tool/resource transport",
      discovery: "MCP server capabilities",
      harnessSurface: "Owned by THREAD-002 and the separate MCP-focused agent.",
      mcpBoundary: "Do not modify MCP implementation from Codex third-party protocol work.",
      sourceUrl: "https://modelcontextprotocol.io",
      notes: ["Tracked only to preserve ownership boundaries with THREAD-002."],
    },
  ];
}

function resolveProtocolPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

// NLT-Pi local change (CodeQL js/file-system-race): read once instead of access() then readFile(),
// which left a window between the check and the read. A missing or unreadable file is still
// reported as absent; any other error (for example reading a directory) still propagates.
const ABSENT_FILE_ERROR_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM"]);

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== undefined && ABSENT_FILE_ERROR_CODES.has(code)) {
      return undefined;
    }
    throw error;
  }
}

async function resolveDefaultToiPath(cwd: string): Promise<string> {
  const personalToiPath = resolveProtocolPath(cwd, ".toi");
  if (await fileExists(personalToiPath)) return personalToiPath;

  const defaultToiPath = resolveProtocolPath(cwd, ".toi.default");
  if (await fileExists(defaultToiPath)) return defaultToiPath;

  return personalToiPath;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveSourceUri(baseDir: string, uri: string): string {
  if (uri.startsWith("file://")) return fileURLToPath(uri);
  if (isAbsolute(uri)) return uri;
  return resolve(baseDir, uri);
}

function extractDevOtoi(
  charter: OtoiCharter | undefined,
  effectiveToi: ToiDocument | undefined,
): Record<string, unknown> | undefined {
  return asRecord(
    asRecord(charter)?.["x-nlt-dev-otoi"] ??
      asRecord(asRecord(effectiveToi?.custom)?.["x-nlt-dev-otoi"]) ??
      asRecord(asRecord(asRecord(effectiveToi?.custom)?.["x-neurolift-source"])?.org_developer_otoi),
  );
}

function formatRecord(record: Record<string, unknown> | undefined): string {
  if (!record) return "none declared";
  const entries = Object.entries(record).filter(([, value]) => value !== undefined);
  if (!entries.length) return "none declared";
  return entries.map(([key, value]) => `${key}=${String(value)}`).join(", ");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function toPlainRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return record ? { ...record } : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
