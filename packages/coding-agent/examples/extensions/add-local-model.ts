/**
 * add-local-model.ts
 *
 * Extension: Register a local/run model via interactive prompts.
 *
 * Usage: Type `/add-local-model` in the pi prompt bar.
 *
 * Flow:
 *  1. Endpoint URL  (e.g. http://localhost:11434/v1)
 *  2. API Key       (optional, press Enter to skip)
 *  3. Model Name    (e.g. llama3.1, mistral-small, etc.)
 *  4. Context Window (number of tokens, or "auto" to query the endpoint)
 *
 * The model is registered immediately using pi.registerProvider().
 * It does NOT modify ~/.pi/agent/models.json.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("add-local-model", {
    description: "Add a local/run model by endpoint URL",
    handler: async (_args, ctx) => {
      // --- 1. Endpoint URL ---
      const endpoint = await ctx.ui.input(
        "Endpoint URL",
        "e.g. http://localhost:11434/v1",
      );
      if (!endpoint) return;

      // --- 2. API Key (optional) ---
      const apiKey = (await ctx.ui.input("API Key (optional)", "press Enter to skip")) || "sk-placeholder";

      // --- 3. Model Name ---
      const modelName = await ctx.ui.input("Model Name", "e.g. llama3.1");
      if (!modelName) return;

      // --- 4. Context Window (with auto-detect) ---
      const contextInput = await ctx.ui.input(
        "Context Window (tokens, or 'auto')",
        "128000",
      );
      let contextWindow = 128_000;

      if (contextInput?.toLowerCase() === "auto") {
        try {
          const url = new URL(endpoint);
          url.pathname = "/v1/models";
          const res = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
          const json = await res.json();
          const models = json.data as Array<{ id: string; max_tokens?: number; context_window?: number }>;
          const found = models.find((m) => m.id === modelName);
          contextWindow = found?.context_window ?? found?.max_tokens ?? 128_000;
        } catch {
          ctx.ui.notify("Could not auto-detect context window, using default", "info");
        }
      } else if (contextInput) {
        contextWindow = Number(contextInput);
      }

      // --- Register the provider ---
      const providerId = `local-${endpoint.replace(/[^a-z0-9]/gi, "-")}`;

      pi.registerProvider(providerId, {
        baseUrl: endpoint,
        apiKey,
        api: "openai-completions",
        models: [
          {
            id: modelName,
            name: modelName,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow,
            maxTokens: 8192,
          },
        ],
      });

      ctx.ui.notify(`Registered ${modelName} on ${endpoint}`, "info");
    },
  });
}
