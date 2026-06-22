import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // ── Configuration ──
  const CONFIG = {
    flashModel: { provider: "deepseek", id: "deepseek-v4-flash" },
    proModel: { provider: "deepseek", id: "deepseek-v4-pro" },
    // Keywords/phrases that indicate a complex task needing the Pro model
    complexityKeywords: [
      "refactor", "architecture", "redesign", "restructure",
      "optimize", "performance", "migrate", "migration",
      "security", "audit", "vulnerability",
      "multi-file", "across multiple files",
      "dependency", "dependency graph",
      "analyze", "analysis",
    ],
    // Short, simple task indicators → Flash
    simplicityKeywords: [
      "typo", "spelling", "comment", "rename",
      "format", "prettier", "lint",
      "test", "unit test",
      "boilerplate",
    ],
  };

  let currentModel: string = "unknown";
  let flashUsageCount = 0;
  let proUsageCount = 0;

  // ── Track model changes ──
  pi.on("model_select", async (event) => {
    currentModel = `${event.model.provider}/${event.model.id}`;
    pi.events.emit("router:model_changed", currentModel);
  });

  // ── Register routing commands ──
  pi.registerCommand("route", {
    description: "Manually route to flash, pro, or auto mode",
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();
      if (mode === "flash") {
        const model = ctx.modelRegistry.find(
          CONFIG.flashModel.provider,
          CONFIG.flashModel.id
        );
        if (model) {
          await pi.setModel(model);
          ctx.ui.notify("→ Forced DeepSeek V4 Flash", "info");
        }
      } else if (mode === "pro") {
        const model = ctx.modelRegistry.find(
          CONFIG.proModel.provider,
          CONFIG.proModel.id
        );
        if (model) {
          await pi.setModel(model);
          ctx.ui.notify("→ Forced DeepSeek V4 Pro", "info");
        }
      } else if (mode === "status") {
        ctx.ui.notify(
          `Flash: ${flashUsageCount}x | Pro: ${proUsageCount}x | Current: ${currentModel}`,
          "info"
        );
      } else {
        ctx.ui.notify(
          "Usage: /route flash | /route pro | /route status",
          "info"
        );
      }
    },
  });

  // ── Auto-detect complexity and switch models ──
  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = event.prompt.toLowerCase();
    const lines = prompt.split("\n");

    // Score complexity
    let complexityScore = 0;

    // 1. Check for complexity keywords
    for (const kw of CONFIG.complexityKeywords) {
      if (prompt.includes(kw)) complexityScore += 2;
    }

    // 2. Check for simplicity keywords (negative)
    for (const kw of CONFIG.simplicityKeywords) {
      if (prompt.includes(kw)) complexityScore -= 1;
    }

    // 3. Long prompts with lots of code tend to be complex
    if (prompt.length > 800) complexityScore += 1;

    // 4. Many lines = multi-file or large task
    if (lines.length > 15) complexityScore += 1;

    // 5. Single line, short = probably simple
    if (lines.length <= 3 && prompt.length < 200) complexityScore -= 1;

    // Decide which model to use
    const usePro = complexityScore >= 2;

    const targetId = usePro ? CONFIG.proModel.id : CONFIG.flashModel.id;
    const targetProvider = usePro ? CONFIG.proModel.provider : CONFIG.flashModel.provider;

    // Only switch if different from current
    const currentId = currentModel.split("/").pop();
    if (currentId === targetId) return; // Already on the right model

    const model = ctx.modelRegistry.find(targetProvider, targetId);
    if (model) {
      await pi.setModel(model);
      if (usePro) proUsageCount++;
      else flashUsageCount++;

      ctx.ui.setStatus(
        "auto-router",
        usePro ? "⚡ Pro" : "⚡ Flash",
        "info"
      );
    }
  });

  // ── Show routing stats on session start ──
  pi.on("session_start", async () => {
    flashUsageCount = 0;
    proUsageCount = 0;
  });
}
