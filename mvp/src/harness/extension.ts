// Vendored from NeuroLift-Technologies/asfdk-harness src/index.ts @ f28136d1cece7f5dd20734020346075efc2f6d9d
// Trimmed: the MCP server and MCP HTTP server re-exports are omitted (not used by the MVP).
// Only change from upstream: relative import specifiers use .ts (repo check:ts-imports). Do not edit otherwise: re-sync from upstream. See mvp/src/harness/README.md.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AsfdkHarness, Channel } from "./harness.ts";
import { reviewToolCall } from "./policy.ts";
import { createAsfdkTools } from "./tools.ts";
import { getThirdPartyProtocolProfiles } from "./protocols.ts";

export default function asfdkPiHarness(pi: ExtensionAPI) {
  const harness = new AsfdkHarness();

  for (const tool of createAsfdkTools(harness)) {
    pi.registerTool(tool);
  }

  pi.on("session_start", async (_event, ctx) => {
    await harness.start();
    const protocols = await harness.protocolSnapshot(ctx.cwd);
    ctx.ui.setStatus("asfdk", `ASFDK:${harness.mode}`);
    ctx.ui.notify(`ASFDK harness active (${harness.mode}); protocols: ${protocols.protocols.length}`, "info");
  });

  pi.on("session_shutdown", async () => {
    await harness.shutdown();
  });

  // before_agent_start hook DISABLED — preflight no longer runs automatically on every turn.
  // ASFDK tools remain available for on-demand use via slash commands and tool calls.
  // To re-enable, uncomment the block below.

  pi.on("tool_call", async (event) => {
    const decision = reviewToolCall(event.toolName, event.input as Record<string, unknown>);
    if (!decision.allow) {
      return { block: true, reason: decision.reason ?? "Blocked by ASFDK harness policy" };
    }
    return undefined;
  });

  pi.registerCommand("asfdk-status", {
    description: "Show ASFDK foundation status and health.",
    handler: async (_args, ctx) => {
      const [status, health] = await Promise.all([harness.status(), harness.healthCheck()]);
      ctx.ui.notify(JSON.stringify({ status, health }, null, 2), "info");
    },
  });

  pi.registerCommand("asfdk-assess", {
    description: "Assess text through ASFDK: /asfdk-assess <text>",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /asfdk-assess <text>", "warning");
        return;
      }
      const assessment = await harness.assessText(args, { source: "pi.command" }, Channel.USER_INPUT);
      ctx.ui.notify(JSON.stringify(assessment, null, 2), "info");
    },
  });

  pi.registerCommand("asfdk-protocols", {
    description: "Show ASFDK protocol status, including A2A/third-party targets and MCP exclusion.",
    handler: async (_args, ctx) => {
      const protocols = await harness.protocolSnapshot(ctx.cwd);
      ctx.ui.notify(JSON.stringify(protocols, null, 2), "info");
    },
  });

  pi.registerCommand("asfdk-interop", {
    description: "Show third-party interoperability protocol targets.",
    handler: async (_args, ctx) => {
      ctx.ui.notify(JSON.stringify(getThirdPartyProtocolProfiles(), null, 2), "info");
    },
  });

  pi.registerCommand("asfdk-a2a-card", {
    description: "Show the generated A2A Agent Card for the current harness state.",
    handler: async (_args, ctx) => {
      const card = await harness.a2aAgentCard(ctx.cwd);
      ctx.ui.notify(JSON.stringify(card, null, 2), "info");
    },
  });
}

export { AsfdkHarness } from "./harness.ts";
export { createAsfdkTools } from "./tools.ts";
export { reviewToolCall } from "./policy.ts";
export {
  createProtocolSnapshot,
  formatProtocolSystemPrompt,
  loadGovernanceProtocols,
} from "./protocols.ts";
export { createA2AAgentCard } from "./a2a.ts";
export type {
  GovernanceProtocolContext,
  GovernanceProtocolSnapshot,
  IntegrationProtocol,
  ProtocolLoadOptions,
} from "./protocols.ts";
