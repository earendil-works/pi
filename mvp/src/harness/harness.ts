// Vendored from NeuroLift-Technologies/asfdk-harness src/harness.ts @ 5488262c96d97026b27703d6580da65c2bcb1fb6
// Only change from upstream: relative import specifiers use .ts (repo check:ts-imports). Do not edit otherwise: re-sync from upstream. See mvp/src/harness/README.md.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  Channel,
  FoundationMode,
  InteractionType,
  type FoundationResponse,
  type HealthCheckResult,
  type NeuroLiftFoundation,
} from "@neurolift-technologies/asfdk";
import {
  createProtocolSnapshot,
  formatProtocolSystemPrompt,
  loadGovernanceProtocols,
  type GovernanceProtocolContext,
  type GovernanceProtocolSnapshot,
  type PromptMode,
} from "./protocols.ts";
import { createA2AAgentCard, type A2AAgentCard } from "./a2a.ts";
import { loadAsfdk } from "./asfdk-runtime.ts";

// Re-export the shared provenance surface so tools.ts / mcp-server.ts / tests
// consume ONE canonical enum set from the harness boundary (plan C5/L1).
export { Channel, FoundationMode, InteractionType };
export type { FoundationResponse, HealthCheckResult };

export interface AsfdkHarnessOptions {
  userId?: string;
  sessionId?: string;
  mode?: FoundationMode;
  cwd?: string;
  toiPath?: string;
  otoiPath?: string;
  /** Inline TOI JSON string — bypasses filesystem read (used in Workers environment). */
  toiContent?: string;
  /** Inline OTOI JSON string — bypasses filesystem read (used in Workers environment). */
  otoiContent?: string;
  /** Public A2A service endpoint URL advertised on the generated Agent Card. */
  a2aUrl?: string;
  /** Protocol system prompt verbosity: compact (default, ~5 lines) or full (verbose). */
  promptMode?: PromptMode;
}

export interface TextAssessment {
  interaction: FoundationResponse;
  emotionalState: unknown;
}

export class AsfdkHarness {
  readonly userId: string;
  readonly sessionId: string;
  readonly mode: FoundationMode;
  readonly cwd: string;
  readonly toiPath: string | undefined;
  readonly otoiPath: string | undefined;
  readonly toiContent: string | undefined;
  readonly otoiContent: string | undefined;
  readonly a2aUrl: string | undefined;
  readonly promptMode: PromptMode;

  #foundation: NeuroLiftFoundation | undefined;
  #protocolContext: GovernanceProtocolContext | undefined;

  constructor(options: AsfdkHarnessOptions = {}) {
    this.userId = options.userId ?? process.env.ASFDK_USER_ID ?? "asfdk-user";
    this.sessionId = options.sessionId ?? process.env.ASFDK_SESSION_ID ?? randomUUID();
    const envMode = process.env.ASFDK_MODE;
    const resolvedOption = parseFoundationMode(options.mode as string | undefined);
    const resolvedEnv = parseFoundationMode(envMode);
    // T16 fail-loud: an explicit but unrecognized ASFDK_MODE must not silently
    // degrade to UNIFIED — surfacing the misconfiguration beats running with
    // the wrong Solidarity posture.
    if (envMode && !resolvedEnv) {
      throw new Error(
        `Unrecognized foundation mode: '${envMode}'. Valid modes: ${Object.values(FoundationMode).join(", ")}`,
      );
    }
    this.mode = resolvedOption ?? resolvedEnv ?? FoundationMode.UNIFIED;
    this.cwd = options.cwd ?? process.cwd();
    this.toiPath = options.toiPath ?? process.env.ASFDK_TOI_PATH;
    this.otoiPath = options.otoiPath ?? process.env.ASFDK_OTOI_PATH;
    this.toiContent = options.toiContent ?? process.env.ASFDK_TOI_CONTENT;
    this.otoiContent = options.otoiContent ?? process.env.ASFDK_OTOI_CONTENT;
    this.a2aUrl = options.a2aUrl ?? process.env.ASFDK_A2A_URL;
    this.promptMode = options.promptMode ?? parsePromptMode(process.env.ASFDK_PROMPT_MODE) ?? "compact";
  }

  async start(): Promise<void> {
    if (this.#foundation) return;
    // Pre-create .swp_storage so the sleepwalker-protocol's ContinuityManager
    // doesn't throw EPERM on a read-only assessment. The external package tries
    // mkdir on construction; handle permission denial gracefully by falling back
    // to a temp directory.
    try {
      mkdirSync(join(this.cwd, ".swp_storage"), { recursive: true });
    } catch {
      try {
        mkdirSync("/tmp/.swp_storage", { recursive: true });
      } catch {
        // Neither CWD nor /tmp is writable — assessment will degrade
        // gracefully via the processInteraction error boundary.
      }
    }
    const { createFoundation } = await loadAsfdk();
    this.#foundation = await createFoundation(this.userId, this.mode);
  }

  async shutdown(): Promise<void> {
    await this.#foundation?.shutdown();
    this.#foundation = undefined;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const foundation = await this.foundation();
    return foundation.healthCheck();
  }

  async status(): Promise<Record<string, unknown>> {
    const foundation = await this.foundation();
    const [status, protocols] = await Promise.all([foundation.getSystemStatus(), this.protocolSnapshot()]);

    // Redact local filesystem paths unless in development mode
    const redactedProtocols =
      this.mode === FoundationMode.DEVELOPMENT ? protocols : this.redactProtocolPaths(protocols);

    return { ...status, protocols: redactedProtocols };
  }

  async assessText(text: string, context: Record<string, unknown> = {}, channel?: Channel): Promise<TextAssessment> {
    const foundation = await this.foundation();
    const resolvedChannel = resolveChannel(channel);
    let emotionalState: unknown = null;
    try {
      emotionalState = await foundation.assessEmotionalState(text, context, resolvedChannel);
    } catch (error) {
      emotionalState = { error: "emotional-assessment-unavailable", detail: String(error) };
    }

    try {
      const interaction = await foundation.processInteraction({
        timestamp: new Date(),
        interactionType: InteractionType.EMOTIONAL_ASSESSMENT,
        data: { text, emotionalState },
        userId: this.userId,
        sessionId: this.sessionId,
        context,
        channel: resolvedChannel,
      });
      if (interaction?.content?.error) {
        interaction.success = false;
      }
      return { interaction, emotionalState };
    } catch (error) {
      return {
        interaction: {
          success: false,
          responseType: InteractionType.EMOTIONAL_ASSESSMENT,
          componentsInvolved: ["asfdk_foundation"],
          content: { error: { component: "asfdk_foundation", message: String(error) }, data: { text } },
          timestamp: new Date(),
        },
        emotionalState,
      };
    }
  }

  async processInteraction(
    interactionType: InteractionType,
    data: Record<string, unknown>,
    context: Record<string, unknown> = {},
    channel?: Channel,
  ): Promise<FoundationResponse> {
    const foundation = await this.foundation();
    try {
      const response = await foundation.processInteraction({
        timestamp: new Date(),
        interactionType,
        data,
        userId: this.userId,
        sessionId: this.sessionId,
        context,
        channel: resolveChannel(channel),
      });
      // Bug B: set success=false when any component reported an error
      if (response?.content?.error) {
        return { ...response, success: false };
      }
      return response;
    } catch (error) {
      // Bug A: return structured response instead of throwing on foundation failure
      return {
        success: false,
        responseType: interactionType,
        componentsInvolved: ["asfdk_foundation"],
        content: {
          error: { component: "asfdk_foundation", message: String(error) },
          data,
        },
        timestamp: new Date(),
      };
    }
  }

  async updatePreferences(preferences: Record<string, unknown>): Promise<void> {
    const foundation = await this.foundation();
    await foundation.updatePreferences(preferences);
  }

  async protocolContext(cwd?: string, force = false): Promise<GovernanceProtocolContext> {
    const targetCwd = cwd ?? this.#protocolContext?.cwd ?? this.cwd;
    if (!force && this.#protocolContext?.cwd === targetCwd) return this.#protocolContext;
    this.#protocolContext = await loadGovernanceProtocols({
      cwd: targetCwd,
      toiPath: this.toiPath,
      otoiPath: this.otoiPath,
      toiContent: this.toiContent,
      otoiContent: this.otoiContent,
    });
    return this.#protocolContext;
  }

  async protocolSnapshot(cwd?: string): Promise<GovernanceProtocolSnapshot> {
    return createProtocolSnapshot(await this.protocolContext(cwd));
  }

  async protocolSystemPrompt(cwd?: string, promptMode?: PromptMode): Promise<string> {
    return formatProtocolSystemPrompt(await this.protocolContext(cwd), promptMode ?? this.promptMode);
  }

  async a2aAgentCard(cwd?: string): Promise<A2AAgentCard> {
    return createA2AAgentCard(await this.protocolContext(cwd), {
      agentId: "asfdk-harness",
      agentName: "ASFDK Harness",
      url: this.a2aUrl,
      includeSensitiveGovernanceTools: canExposeSensitiveGovernanceTools(this.mode),
    });
  }

  async foundation(): Promise<NeuroLiftFoundation> {
    if (!this.#foundation) await this.start();
    if (!this.#foundation) throw new Error("ASFDK foundation failed to initialize");
    return this.#foundation;
  }

  /**
   * Redact local filesystem paths from protocol snapshot for security
   * Replaces absolute paths with placeholders unless in development mode
   */
  redactProtocolPaths(snapshot: GovernanceProtocolSnapshot): GovernanceProtocolSnapshot {
    // Create a deep copy to avoid mutating the original
    const redacted: GovernanceProtocolSnapshot = {
      cwd: this.redactPath(snapshot.cwd),
      paths: {
        toi: this.redactPath(snapshot.paths.toi),
        otoi: this.redactPath(snapshot.paths.otoi),
      },
      protocols: [...snapshot.protocols],
      diagnostics: snapshot.diagnostics.map((diagnostic) =>
        typeof diagnostic === "string" ? this.redactPathInString(diagnostic) : diagnostic,
      ),
      toi: snapshot.toi,
      otoi: snapshot.otoi,
      thirdPartyProtocols: [...snapshot.thirdPartyProtocols],
    };

    return redacted;
  }

  /**
   * Redact a single filesystem path
   * Replaces absolute paths with [REDACTED_PATH] unless in development mode
   */
  redactPath(path: string): string {
    // Don't redact in development mode
    if (this.mode === FoundationMode.DEVELOPMENT) return path;

    // Check if this looks like an absolute path
    if (
      typeof path === "string" &&
      (path.startsWith("/") ||
        (path.length > 1 && path[1] === ":" && (path[2] === "\\" || path[2] === "/")))
    ) {
      return "[REDACTED_PATH]";
    }

    return path;
  }

  /**
   * Redact paths within a string (for diagnostics)
   * Preserves the rest of the message while redacting any paths
   */
  redactPathInString(text: string): string {
    // Don't redact in development mode
    if (this.mode === FoundationMode.DEVELOPMENT) return text;

    return text
      .replace(/(^|[\s([{:;,"'])((?:\/[A-Za-z0-9._-]+){2,})(?=$|[\s)\]}:;,"'])/g, "$1[REDACTED_PATH]")
      .replace(/\b[A-Za-z]:\\[A-Za-z0-9._-]+(?:\\[A-Za-z0-9._-]+)+\b/g, "[REDACTED_PATH]");
  }
}

export function canExposeSensitiveGovernanceTools(mode: FoundationMode): boolean {
  return mode === FoundationMode.DEVELOPMENT || process.env.ASFDK_GOVERNANCE_TOOLS === "approved";
}

const LEGACY_FOUNDATION_MODES: Record<string, FoundationMode> = {
  "crisis-only": FoundationMode.CRISIS_ONLY,
  "continuity-only": FoundationMode.CONTINUITY_ONLY,
  "framework-only": FoundationMode.FRAMEWORK_ONLY,
};

export function parseFoundationMode(value: string | undefined): FoundationMode | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if ((Object.values(FoundationMode) as string[]).includes(normalized)) {
    return normalized as FoundationMode;
  }
  // Legacy 0.1.x dashed spellings map onto the canonical foundation enum (H4/I4).
  return LEGACY_FOUNDATION_MODES[normalized];
}

const CHANNEL_VALUES = new Set<string>(Object.values(Channel) as string[]);

/**
 * Coerces an arbitrary runtime value to the shared Channel enum. Exact closed
 * members pass through; every malformed value collapses to UNKNOWN. Never
 * elevates (D2/D4) — mirrors the foundation's normalizeChannel so the harness
 * boundary enforces the same invariant even though the package does not export
 * that helper.
 */
function resolveChannel(value: unknown): Channel {
  return typeof value === "string" && CHANNEL_VALUES.has(value) ? (value as Channel) : Channel.UNKNOWN;
}

/**
 * Tool-seam channel resolver (D4). Tools run on behalf of the model, never the
 * user, so USER_INPUT must not be assertable at a tool seam: it is rejected
 * loudly with warn telemetry. Every other value resolves through resolveChannel
 * (malformed → UNKNOWN, never elevated).
 */
export function resolveToolSeamChannel(channel: unknown, warn: (message: string) => void = console.warn): Channel {
  const resolved = resolveChannel(channel);
  if (resolved === Channel.USER_INPUT) {
    warn("ASFDK D4: tool-seam channel 'user_input' rejected — tools must not assert user input provenance.");
    throw new Error(
      "Tool-seam channel 'user_input' is not allowed (D4): user_input provenance is assignable only at harness-code seams (e.g. /asfdk-assess).",
    );
  }
  return resolved;
}

export function parsePromptMode(value: string | undefined): PromptMode | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "compact" || normalized === "full") return normalized;
  return undefined;
}

export function summarizeFoundationResponse(response: FoundationResponse): string {
  return JSON.stringify(
    {
      success: response.success,
      responseType: response.responseType,
      componentsInvolved: response.componentsInvolved,
      content: response.content,
      timestamp: response.timestamp,
    },
    null,
    2,
  );
}
